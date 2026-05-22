"""
Instagram 포스트/릴스 메타데이터와 미디어 URL을 추출.

전략 (순서대로 시도):
1. yt-dlp + 쿠키          → Reels와 일부 Post에서 가장 안정적
2. IG web GraphQL fallback → Post(사진) 전용 fallback. yt-dlp가 실패할 때 사용.

쿠키 입력 경로:
- settings.ig_cookies_file (Netscape cookies.txt) - 권장
- settings.ig_sessionid (단일 쿠키 값) - 간편 모드

두 방식 다 미설정이면 비로그인으로 진행하고, 사진 Post는 거의 100% 실패합니다
(IG가 비로그인 GraphQL을 막아둬서 -- 이게 이 프로젝트가 처음 부딪힌 벽이었음).
"""
from __future__ import annotations

import json
import logging
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import yt_dlp

from app.core.config import settings

logger = logging.getLogger(__name__)


# ===== Errors =====

class FetchError(Exception):
    def __init__(self, message: str, error_code: str = "FETCH_FAILED"):
        super().__init__(message)
        self.error_code = error_code


class PrivateContentError(FetchError):
    def __init__(self, message: str = "비공개 콘텐츠는 fetch할 수 없습니다."):
        super().__init__(message, error_code="PRIVATE_CONTENT")


class ContentNotFoundError(FetchError):
    def __init__(self, message: str = "콘텐츠를 찾을 수 없습니다."):
        super().__init__(message, error_code="NOT_FOUND")


class LoginRequiredError(FetchError):
    """쿠키 미설정/만료로 인한 실패. 새 쿠키 추출을 안내한다."""
    def __init__(
        self,
        message: str = (
            "로그인이 필요합니다. 새 IG 계정의 쿠키를 .env에 설정하세요. "
            "(IG_COOKIES_FILE 또는 IG_SESSIONID)"
        ),
    ):
        super().__init__(message, error_code="LOGIN_REQUIRED")


# ===== Cookie helpers =====

def _sessionid_to_cookiefile(sessionid: str, ds_user_id: Optional[str]) -> Path:
    """
    sessionid 문자열 하나만 받아서 yt-dlp가 읽을 수 있는 Netscape cookies.txt를
    임시 파일로 생성한다. 매 fetch마다 새로 만들지 않도록 lru_cache 같은 것 쓰면 더 좋음.
    """
    # Netscape cookies.txt 포맷:
    # domain  flag  path  secure  expiration  name  value
    # 만료는 충분히 먼 미래로 (Unix epoch). secure=TRUE.
    expiration = "2147483647"  # 2038년
    lines = ["# Netscape HTTP Cookie File"]
    lines.append(
        f".instagram.com\tTRUE\t/\tTRUE\t{expiration}\tsessionid\t{sessionid}"
    )
    if ds_user_id:
        lines.append(
            f".instagram.com\tTRUE\t/\tTRUE\t{expiration}\tds_user_id\t{ds_user_id}"
        )

    f = tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", prefix="ig_cookies_", delete=False
    )
    f.write("\n".join(lines) + "\n")
    f.close()
    return Path(f.name)


def _resolve_cookies_file() -> Optional[Path]:
    """
    설정에서 사용할 쿠키 파일을 결정한다.
    1) IG_COOKIES_FILE 가 유효하면 그걸 사용
    2) 없으면 IG_SESSIONID로부터 임시 cookies.txt 생성
    3) 둘 다 없으면 None
    """
    cf = settings.cookies_file_path
    if cf:
        return cf
    if settings.ig_sessionid:
        return _sessionid_to_cookiefile(
            settings.ig_sessionid, settings.ig_ds_user_id
        )
    return None


# ===== yt-dlp path =====

def _build_ydl_opts() -> Dict[str, Any]:
    opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": settings.ytdlp_timeout,
        "retries": settings.ytdlp_retries,
        "extract_flat": False,
        "format": "best[acodec!=none][vcodec!=none]/best/bestvideo/bestaudio",
        # 쿠키 추출한 브라우저와 같은 UA를 쓰는 게 IG의 fingerprint 체크를 통과하기 쉬움
        "http_headers": {"User-Agent": settings.ig_user_agent},
    }
    cookiefile = _resolve_cookies_file()
    if cookiefile:
        opts["cookiefile"] = str(cookiefile)
        logger.debug(f"yt-dlp using cookies: {cookiefile}")
    else:
        logger.warning(
            "쿠키가 설정되지 않았습니다. 사진 Post는 fetch에 실패할 가능성이 높습니다."
        )
    return opts


def _extract_media_from_entry(entry: Dict[str, Any], order: int) -> Dict[str, Any]:
    """yt-dlp의 단일 entry → 정규화 dict."""
    has_video = (
        entry.get("duration") is not None
        or (entry.get("vcodec") and entry.get("vcodec") != "none")
        or entry.get("ext") in ("mp4", "mov", "webm")
    )
    media_type = "video" if has_video else "image"

    source_url = entry.get("url")
    if not source_url and entry.get("formats"):
        source_url = entry["formats"][-1].get("url")

    if not source_url:
        raise FetchError(
            f"미디어 URL을 추출할 수 없습니다 (entry order={order})."
        )

    return {
        "order_index": order,
        "media_type": media_type,
        "source_url": source_url,
        "width": entry.get("width"),
        "height": entry.get("height"),
        "duration_seconds": entry.get("duration"),
        "thumbnail_url": entry.get("thumbnail"),
    }


def _parse_timestamp(ts: Any) -> Optional[datetime]:
    if ts is None:
        return None
    try:
        return datetime.utcfromtimestamp(int(ts))
    except (ValueError, TypeError):
        return None


def _fetch_via_ytdlp(url: str) -> Dict[str, Any]:
    """yt-dlp 1차 시도. 실패하면 적절한 FetchError 하위 클래스 raise."""
    logger.info(f"yt-dlp fetch 시작: {url}")

    try:
        with yt_dlp.YoutubeDL(_build_ydl_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        msg = str(e).lower()
        if "login required" in msg or "login" in msg or "rate-limit" in msg:
            raise LoginRequiredError() from e
        if "private" in msg:
            raise PrivateContentError() from e
        if "not found" in msg or "does not exist" in msg or "404" in msg:
            raise ContentNotFoundError() from e
        logger.error(f"yt-dlp DownloadError: {e}")
        raise FetchError(f"yt-dlp 다운로드 실패: {e}") from e
    except Exception as e:
        logger.exception("yt-dlp 예기치 않은 오류")
        raise FetchError(f"예기치 않은 오류: {e}") from e

    if info is None:
        raise ContentNotFoundError()

    entries = info.get("entries")
    if entries:
        media_items = [
            _extract_media_from_entry(entry, idx) for idx, entry in enumerate(entries)
        ]
    else:
        media_items = [_extract_media_from_entry(info, 0)]

    return {
        "author_username": info.get("uploader") or info.get("uploader_id"),
        "author_id": info.get("uploader_id"),
        "caption": info.get("description") or info.get("title"),
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count"),
        "posted_at": _parse_timestamp(info.get("timestamp")),
        "media_items": media_items,
        "raw_response": info,
    }


# ===== GraphQL fallback path =====
# IG가 비로그인 GraphQL을 막은 뒤로, 사진 Post는 yt-dlp가 종종 실패한다.
# 이때 로그인 쿠키를 가지고 직접 IG 페이지의 embedded JSON을 긁어오는 방법으로 우회 가능.
# 이 fallback은 쿠키가 있어야만 의미가 있음.

_SHORTCODE_FROM_URL_RE = re.compile(r"/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)")


def _shortcode_from_url(url: str) -> Optional[str]:
    m = _SHORTCODE_FROM_URL_RE.search(url)
    return m.group(1) if m else None


def _build_httpx_cookies() -> Dict[str, str]:
    """httpx에 쓸 쿠키 dict 구성."""
    cookies: Dict[str, str] = {}
    cf = settings.cookies_file_path
    if cf:
        # 매우 단순한 Netscape cookies.txt parser. yt-dlp가 쓰는 것보다 훨씬 작음.
        try:
            for raw in cf.read_text(encoding="utf-8").splitlines():
                if not raw or raw.startswith("#"):
                    continue
                parts = raw.split("\t")
                if len(parts) >= 7 and "instagram.com" in parts[0]:
                    cookies[parts[5]] = parts[6]
        except Exception as e:
            logger.warning(f"cookies.txt 파싱 실패: {e}")
    if settings.ig_sessionid and "sessionid" not in cookies:
        cookies["sessionid"] = settings.ig_sessionid
    if settings.ig_ds_user_id and "ds_user_id" not in cookies:
        cookies["ds_user_id"] = settings.ig_ds_user_id
    return cookies


def _normalize_ig_media_node(node: Dict[str, Any], order: int) -> Dict[str, Any]:
    """
    IG GraphQL 응답의 'media' 노드 하나 → 우리 스키마에 맞춘 dict.
    노드 모양은 캐러셀 항목이든 단일 미디어든 거의 동일하다.
    """
    is_video = bool(node.get("is_video") or node.get("video_url"))
    if is_video:
        source_url = node.get("video_url") or node.get("display_url")
        media_type = "video"
    else:
        source_url = node.get("display_url")
        media_type = "image"

    dims = node.get("dimensions") or {}
    return {
        "order_index": order,
        "media_type": media_type,
        "source_url": source_url,
        "width": dims.get("width"),
        "height": dims.get("height"),
        "duration_seconds": node.get("video_duration"),
        "thumbnail_url": node.get("display_url") if is_video else None,
    }


def _shortcode_to_media_id(shortcode: str) -> str:
    """
    IG shortcode (base64-ish) → media_id (decimal) 변환.
    IG의 mobile API는 media_id만 받는다. 알고리즘은 base64 → big-endian int.
    """
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    result = 0
    for ch in shortcode:
        result = result * 64 + alphabet.index(ch)
    return str(result)


def _build_ig_web_headers() -> Dict[str, str]:
    """
    IG가 정상 웹 클라이언트로 인식하도록 헤더를 풍부하게 구성.
    헤더가 모자라면 IG가 로그인 쿠키가 있어도 404로 응답하는 경우가 잦다.
    """
    return {
        "User-Agent": settings.ig_user_agent,
        "X-IG-App-ID": "936619743392459",  # IG 웹 클라이언트 공개 ID (고정)
        "X-ASBD-ID": "129477",              # IG 내부 빌드 식별자
        "X-IG-WWW-Claim": "0",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
        "Referer": "https://www.instagram.com/",
        "Origin": "https://www.instagram.com",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }


def _fetch_via_ig_web(url: str) -> Dict[str, Any]:
    """
    IG에서 로그인 쿠키로 미디어 정보 가져오기 (3단계 fallback).

    1) /p/{sc}/?__a=1&__d=dis            - 가벼운 JSON. 최근 IG가 자주 막는다.
    2) /api/v1/media/{media_id}/info/    - 모바일 API. 사진 Post에 가장 안정적.
    3) /p/{sc}/ HTML scraping            - 위 둘 다 실패 시 페이지 HTML에서 추출.

    쿠키가 없으면 즉시 LoginRequiredError.
    """
    cookies = _build_httpx_cookies()
    if "sessionid" not in cookies:
        raise LoginRequiredError(
            "fallback fetch에도 sessionid 쿠키가 필요합니다. "
            "IG_COOKIES_FILE 또는 IG_SESSIONID를 설정하세요."
        )

    shortcode = _shortcode_from_url(url)
    if not shortcode:
        raise FetchError("URL에서 shortcode를 추출하지 못했습니다.")

    headers = _build_ig_web_headers()

    client_kwargs = dict(
        cookies=cookies,
        headers=headers,
        timeout=settings.ytdlp_timeout,
        follow_redirects=True,
    )

    # ----- 시도 1: ?__a=1&__d=dis -----
    endpoint1 = f"https://www.instagram.com/p/{shortcode}/?__a=1&__d=dis"
    logger.info(f"IG web fallback 시도 1 (a=1): shortcode={shortcode}")
    try:
        with httpx.Client(**client_kwargs) as client:
            resp = client.get(endpoint1)
    except httpx.RequestError as e:
        resp = None
        logger.warning(f"a=1 endpoint 요청 실패: {e}")

    if resp is not None and resp.status_code == 200:
        try:
            data = resp.json()
            parsed = _parse_ig_web_response(data)
            if parsed:
                return parsed
            logger.info("a=1 응답 200이지만 미디어 노드 못 찾음 → 다음 fallback")
        except (json.JSONDecodeError, ValueError) as e:
            logger.info(f"a=1 응답 파싱 실패: {e} → 다음 fallback")
    elif resp is not None:
        logger.info(f"a=1 endpoint HTTP {resp.status_code} → 다음 fallback")

    # ----- 시도 2: /api/v1/media/{media_id}/info/ -----
    try:
        media_id = _shortcode_to_media_id(shortcode)
    except (ValueError, IndexError) as e:
        media_id = None
        logger.warning(f"shortcode → media_id 변환 실패: {e}")

    if media_id:
        endpoint2 = f"https://www.instagram.com/api/v1/media/{media_id}/info/"
        logger.info(f"IG web fallback 시도 2 (api/v1): media_id={media_id}")
        try:
            with httpx.Client(**client_kwargs) as client:
                resp = client.get(endpoint2)
        except httpx.RequestError as e:
            resp = None
            logger.warning(f"api/v1 요청 실패: {e}")

        if resp is not None and resp.status_code == 200:
            try:
                data = resp.json()
                parsed = _parse_ig_web_response(data)
                if parsed:
                    return parsed
                logger.info("api/v1 응답 200이지만 미디어 노드 못 찾음")
            except (json.JSONDecodeError, ValueError) as e:
                logger.info(f"api/v1 응답 파싱 실패: {e}")
        elif resp is not None:
            logger.info(f"api/v1 HTTP {resp.status_code}")
            if resp.status_code in (401, 403):
                raise LoginRequiredError(
                    "IG api/v1이 인증을 거부했습니다. 쿠키가 만료되었거나 계정이 차단됐을 수 있습니다."
                )

    # ----- 시도 3: HTML scraping -----
    endpoint3 = f"https://www.instagram.com/p/{shortcode}/"
    html_headers = dict(headers)
    # HTML 요청에는 X-Requested-With 등을 빼고 일반 페이지 요청처럼 가장
    for k in ("X-Requested-With", "Sec-Fetch-Dest", "Sec-Fetch-Mode", "Sec-Fetch-Site"):
        html_headers.pop(k, None)
    html_headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    html_headers["Sec-Fetch-Dest"] = "document"
    html_headers["Sec-Fetch-Mode"] = "navigate"
    html_headers["Sec-Fetch-Site"] = "none"

    logger.info(f"IG web fallback 시도 3 (HTML scrape): shortcode={shortcode}")
    try:
        with httpx.Client(
            cookies=cookies, headers=html_headers,
            timeout=settings.ytdlp_timeout, follow_redirects=True,
        ) as client:
            resp = client.get(endpoint3)
    except httpx.RequestError as e:
        raise FetchError(f"HTML scrape 요청 실패: {e}") from e

    if resp.status_code == 404:
        raise ContentNotFoundError()
    if resp.status_code in (401, 403):
        raise LoginRequiredError(
            "IG가 인증을 거부했습니다. 쿠키가 만료되었거나 차단됐을 수 있습니다."
        )
    if resp.status_code >= 400:
        raise FetchError(f"HTML scrape HTTP {resp.status_code}")

    parsed = _parse_ig_html(resp.text, shortcode)
    if parsed:
        return parsed

    raise FetchError(
        "모든 fallback 실패. IG 응답 포맷이 또 바뀌었거나 쿠키가 만료됐을 수 있습니다. "
        "쿠키를 다시 추출해서 재시도해보세요."
    )


def _parse_ig_web_response(data: Any) -> Optional[Dict[str, Any]]:
    """JSON 응답 → 정규화된 dict. 못 찾으면 None."""
    if not isinstance(data, dict):
        return None

    # 응답 모양 후보들:
    #   1) data['items'][0]
    #   2) data['graphql']['shortcode_media']
    #   3) data['data']['xdt_shortcode_media']  (최근 IG GraphQL 응답)
    media = None
    items = data.get("items")
    if items and isinstance(items, list):
        media = items[0]
    elif data.get("graphql", {}).get("shortcode_media"):
        media = data["graphql"]["shortcode_media"]
    elif data.get("data", {}).get("xdt_shortcode_media"):
        media = data["data"]["xdt_shortcode_media"]

    if not media:
        return None

    # 케이스 1: api/v1 또는 ?__a=1 의 items 응답
    if "image_versions2" in media or "carousel_media" in media or "video_versions" in media:
        media_items = _parse_items_endpoint(media)
        caption_obj = media.get("caption") or {}
        caption_text = caption_obj.get("text") if isinstance(caption_obj, dict) else None
        user = media.get("user") or {}
        return {
            "author_username": user.get("username"),
            "author_id": str(user.get("pk")) if user.get("pk") else None,
            "caption": caption_text,
            "like_count": media.get("like_count"),
            "comment_count": media.get("comment_count"),
            "posted_at": _parse_timestamp(media.get("taken_at")),
            "media_items": media_items,
            "raw_response": data,
        }

    # 케이스 2: graphql shortcode_media
    if "edge_sidecar_to_children" in media or "display_url" in media:
        media_items = _parse_graphql_node(media)
        owner = media.get("owner") or {}
        edges = media.get("edge_media_to_caption", {}).get("edges") or []
        caption_text = edges[0]["node"]["text"] if edges else None
        return {
            "author_username": owner.get("username"),
            "author_id": str(owner.get("id")) if owner.get("id") else None,
            "caption": caption_text,
            "like_count": (
                media.get("edge_media_preview_like", {}).get("count")
                or media.get("edge_liked_by", {}).get("count")
            ),
            "comment_count": media.get("edge_media_to_parent_comment", {}).get("count"),
            "posted_at": _parse_timestamp(media.get("taken_at_timestamp")),
            "media_items": media_items,
            "raw_response": data,
        }

    return None


def _parse_ig_html(html: str, shortcode: str) -> Optional[Dict[str, Any]]:
    """
    IG 페이지 HTML에서 embedded JSON을 추출.
    IG는 페이지 안에 여러 형태로 데이터를 임베드한다:
      <script type="application/ld+json">  - 가장 구조화됨, 캡션·이미지 URL 들어있음
      <script>window._sharedData = {...}</script>  - 구버전, 요즘은 잘 없음
    """
    import re

    # 시도 A: application/ld+json (가장 안정적)
    ld_match = re.search(
        r'<script type="application/ld\+json"[^>]*>(.*?)</script>',
        html, re.DOTALL,
    )
    if ld_match:
        try:
            ld = json.loads(ld_match.group(1))
            return _parse_ld_json(ld, shortcode, html)
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            logger.debug(f"ld+json 파싱 실패: {e}")

    # 시도 B: _sharedData (구버전)
    sd_match = re.search(
        r'window\._sharedData\s*=\s*({.*?});</script>',
        html, re.DOTALL,
    )
    if sd_match:
        try:
            sd = json.loads(sd_match.group(1))
            media = (
                sd.get("entry_data", {})
                  .get("PostPage", [{}])[0]
                  .get("graphql", {})
                  .get("shortcode_media")
            )
            if media:
                return _parse_ig_web_response({"graphql": {"shortcode_media": media}})
        except (json.JSONDecodeError, KeyError, TypeError, IndexError) as e:
            logger.debug(f"_sharedData 파싱 실패: {e}")

    return None


def _parse_ld_json(ld: Any, shortcode: str, html: str) -> Optional[Dict[str, Any]]:
    """
    application/ld+json 응답 파싱.
    구조 예시 (단일 사진):
        {
          "@type": "ImageObject",
          "contentUrl": "https://scontent.../...jpg",
          "author": {"alternateName": "@username", "identifier": {"value": "12345"}},
          "caption": "...",
          "interactionStatistic": [{"interactionType": "...LikeAction", "userInteractionCount": 123}]
        }
    캐러셀이나 영상은 contentUrl이 배열이거나 video 객체일 수도 있음.
    """
    # ld가 리스트로 오는 경우도 있음
    if isinstance(ld, list):
        ld = next((x for x in ld if isinstance(x, dict)), None)
    if not isinstance(ld, dict):
        return None

    author = ld.get("author") or {}
    username = author.get("alternateName", "").lstrip("@") if isinstance(author, dict) else None
    author_id_obj = author.get("identifier") if isinstance(author, dict) else None
    author_id = (
        author_id_obj.get("value") if isinstance(author_id_obj, dict)
        else (str(author_id_obj) if author_id_obj else None)
    )
    caption = ld.get("caption") or ld.get("articleBody") or ld.get("description")

    # 좋아요 수
    like_count = None
    for stat in ld.get("interactionStatistic", []) or []:
        if not isinstance(stat, dict):
            continue
        itype = str(stat.get("interactionType", ""))
        if "Like" in itype:
            like_count = stat.get("userInteractionCount")
            break

    posted_at = _parse_timestamp_iso(ld.get("uploadDate") or ld.get("datePublished"))

    # 미디어 추출
    media_items: List[Dict[str, Any]] = []

    # video 객체가 있으면 그게 우선 (릴스)
    video = ld.get("video")
    if video:
        videos = video if isinstance(video, list) else [video]
        for idx, v in enumerate(videos):
            if not isinstance(v, dict):
                continue
            url_v = v.get("contentUrl") or v.get("url")
            if url_v:
                media_items.append({
                    "order_index": idx,
                    "media_type": "video",
                    "source_url": url_v,
                    "width": v.get("width"),
                    "height": v.get("height"),
                    "duration_seconds": None,
                    "thumbnail_url": v.get("thumbnailUrl"),
                })

    # image 객체
    if not media_items:
        image = ld.get("image")
        if image:
            images = image if isinstance(image, list) else [image]
            for idx, img in enumerate(images):
                if isinstance(img, dict):
                    url_i = img.get("url") or img.get("contentUrl")
                    w, h = img.get("width"), img.get("height")
                elif isinstance(img, str):
                    url_i = img
                    w = h = None
                else:
                    continue
                if url_i:
                    media_items.append({
                        "order_index": idx,
                        "media_type": "image",
                        "source_url": url_i,
                        "width": w,
                        "height": h,
                        "duration_seconds": None,
                        "thumbnail_url": None,
                    })

    # contentUrl 단일
    if not media_items:
        content_url = ld.get("contentUrl")
        if content_url:
            is_video = ld.get("@type") in ("VideoObject", "Movie")
            media_items.append({
                "order_index": 0,
                "media_type": "video" if is_video else "image",
                "source_url": content_url,
                "width": ld.get("width"),
                "height": ld.get("height"),
                "duration_seconds": None,
                "thumbnail_url": ld.get("thumbnailUrl") if is_video else None,
            })

    if not media_items:
        return None

    return {
        "author_username": username,
        "author_id": author_id,
        "caption": caption,
        "like_count": like_count,
        "comment_count": None,  # ld+json에는 보통 없음
        "posted_at": posted_at,
        "media_items": media_items,
        "raw_response": {"source": "ld+json", "ld": ld},
    }


def _parse_timestamp_iso(s: Any) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    try:
        # IG는 보통 "2024-01-15T12:34:56.000Z" 또는 ISO 8601
        s_clean = s.rstrip("Z").split(".")[0]
        return datetime.fromisoformat(s_clean)
    except (ValueError, TypeError):
        return None


def _parse_items_endpoint(item: Dict[str, Any]) -> List[Dict[str, Any]]:
    """data['items'][0] 케이스 파서."""
    # 캐러셀
    if item.get("carousel_media"):
        out = []
        for idx, child in enumerate(item["carousel_media"]):
            out.append(_item_child_to_media(child, idx))
        return out
    return [_item_child_to_media(item, 0)]


def _item_child_to_media(child: Dict[str, Any], order: int) -> Dict[str, Any]:
    media_type_num = child.get("media_type")  # 1=image, 2=video, 8=carousel
    is_video = media_type_num == 2 or bool(child.get("video_versions"))

    if is_video and child.get("video_versions"):
        # 가장 고화질이 보통 첫번째
        source_url = child["video_versions"][0].get("url")
    else:
        # image_versions2.candidates 중 첫번째가 보통 원본 해상도
        cands = (child.get("image_versions2") or {}).get("candidates") or []
        source_url = cands[0].get("url") if cands else None

    width = child.get("original_width")
    height = child.get("original_height")
    if (not width or not height) and (child.get("image_versions2") or {}).get("candidates"):
        c0 = child["image_versions2"]["candidates"][0]
        width = c0.get("width")
        height = c0.get("height")

    return {
        "order_index": order,
        "media_type": "video" if is_video else "image",
        "source_url": source_url,
        "width": width,
        "height": height,
        "duration_seconds": child.get("video_duration"),
        "thumbnail_url": (
            (child.get("image_versions2") or {}).get("candidates", [{}])[0].get("url")
            if is_video else None
        ),
    }


def _parse_graphql_node(node: Dict[str, Any]) -> List[Dict[str, Any]]:
    """graphql['shortcode_media'] 케이스 파서."""
    children = (node.get("edge_sidecar_to_children") or {}).get("edges") or []
    if children:
        return [_normalize_ig_media_node(edge["node"], idx) for idx, edge in enumerate(children)]
    return [_normalize_ig_media_node(node, 0)]


# ===== Public API =====

def fetch_instagram_content(url: str) -> Dict[str, Any]:
    """
    Instagram URL → 정규화된 콘텐츠 dict.

    1차로 yt-dlp를 시도하고, LoginRequired/일반 FetchError가 나면
    IG web fallback을 시도한다. fallback도 실패하면 마지막 예외를 그대로 raise.
    """
    try:
        return _fetch_via_ytdlp(url)
    except (LoginRequiredError, FetchError) as primary_err:
        # ContentNotFound / Private은 fallback해봤자 결과가 같음.
        if isinstance(primary_err, (ContentNotFoundError, PrivateContentError)):
            raise

        # 쿠키가 아예 없으면 fallback이 어차피 LoginRequiredError를 던질 거니까
        # 그냥 primary 에러를 LoginRequired로 명확히 바꿔서 raise.
        if not (settings.cookies_file_path or settings.ig_sessionid):
            raise LoginRequiredError() from primary_err

        logger.info(
            f"yt-dlp 실패 ({primary_err.error_code}: {primary_err}), "
            "IG web fallback 시도"
        )
        try:
            return _fetch_via_ig_web(url)
        except FetchError as fallback_err:
            logger.error(
                f"fallback도 실패: {fallback_err.error_code}: {fallback_err}"
            )
            # primary가 LoginRequired였으면 그게 더 정확한 신호니까 그걸 우선.
            if isinstance(primary_err, LoginRequiredError):
                raise primary_err
            raise fallback_err