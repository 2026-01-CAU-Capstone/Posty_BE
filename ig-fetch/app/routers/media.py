"""
/media/proxy?url=<encoded IG CDN url>

IG CDN URL을 그대로 프론트에 노출하면:
- IG가 Referer를 검사해서 외부에서 직접 로드시 403을 주는 경우가 많음
- 시간이 지나면 URL 자체가 만료됨 (fetch 후 ~1시간 정도)

이 엔드포인트는 서버가 대신 받아 다시 스트리밍해줘서 그 문제를 우회한다.
큰 영상은 chunk 단위로 흘려보내므로 메모리에 다 올리지 않는다.
"""
import logging
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from app.core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/media", tags=["media"])

# 보안: 임의의 URL을 우리 서버가 받아오게 두면 SSRF 위험.
# 그래서 IG CDN 도메인만 허용한다.
_ALLOWED_HOST_SUFFIXES = (
    ".cdninstagram.com",
    ".fbcdn.net",
    "scontent.cdninstagram.com",
)


def _is_allowed(url: str) -> bool:
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return False
    return any(host.endswith(s) or host == s.lstrip(".") for s in _ALLOWED_HOST_SUFFIXES)


@router.get(
    "/proxy",
    summary="IG CDN 미디어를 서버 경유로 받아오기",
    description=(
        "Instagram CDN의 이미지/영상 URL을 서버가 받아 다시 흘려보냅니다.\n"
        "IG의 Referer 검사를 우회하고, 프론트에서 안정적으로 로드할 수 있게 해줍니다.\n"
        "허용 도메인은 cdninstagram.com / fbcdn.net 만."
    ),
)
def media_proxy(url: str = Query(..., description="Instagram CDN URL")):
    if not _is_allowed(url):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="허용되지 않는 호스트입니다. IG CDN URL만 가능합니다.",
        )

    upstream_headers = {
        "User-Agent": settings.ig_user_agent,
        "Referer": "https://www.instagram.com/",
        "Accept": "*/*",
    }

    # 큰 파일을 위해 stream 모드. with 안에서 yield 해야 하므로 generator 패턴.
    client = httpx.Client(timeout=30.0, follow_redirects=True)
    try:
        upstream = client.send(
            client.build_request("GET", url, headers=upstream_headers),
            stream=True,
        )
    except httpx.RequestError as e:
        client.close()
        logger.error(f"미디어 upstream 요청 실패: {e}")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=f"upstream 실패: {e}")

    if upstream.status_code >= 400:
        upstream.close()
        client.close()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            detail=f"upstream HTTP {upstream.status_code}",
        )

    content_type = upstream.headers.get("content-type", "application/octet-stream")
    content_length = upstream.headers.get("content-length")

    def iter_bytes():
        try:
            for chunk in upstream.iter_bytes(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()
            client.close()

    response_headers = {
        # 1시간 캐시 (브라우저측). 미디어는 사실상 immutable이라 OK.
        "Cache-Control": "public, max-age=3600",
    }
    if content_length:
        response_headers["Content-Length"] = content_length

    return StreamingResponse(
        iter_bytes(),
        media_type=content_type,
        headers=response_headers,
    )
