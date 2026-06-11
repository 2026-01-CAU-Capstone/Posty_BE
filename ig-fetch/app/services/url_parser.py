"""
Instagram URL을 분석해서 shortcode와 컨텐츠 타입을 추출합니다.

지원하는 URL 패턴:
- https://www.instagram.com/p/{shortcode}/      (포스트)
- https://www.instagram.com/reel/{shortcode}/   (릴스)
- https://www.instagram.com/reels/{shortcode}/  (릴스 - 신규 URL)
- https://www.instagram.com/tv/{shortcode}/     (IGTV - 레거시)
- 짧은 형태(www. 없음), 쿼리스트링/슬래시 변형도 모두 처리.
"""
import re
from typing import Tuple, Literal
from urllib.parse import urlparse


ContentType = Literal["post", "reel", "story"]

_IG_PATH_RE = re.compile(
    r"^/(?P<kind>p|reel|reels|tv)/(?P<shortcode>[A-Za-z0-9_-]+)/?",
)


class InvalidInstagramURLError(ValueError):
    pass


def parse_instagram_url(url: str) -> Tuple[str, ContentType, str]:
    url = url.strip()
    if not url:
        raise InvalidInstagramURLError("URL이 비어있습니다.")

    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    parsed = urlparse(url)
    host = parsed.netloc.lower()

    if "instagram.com" not in host:
        raise InvalidInstagramURLError(f"Instagram URL이 아닙니다: {host}")

    match = _IG_PATH_RE.match(parsed.path)
    if not match:
        raise InvalidInstagramURLError(
            f"포스트/릴스 URL 형식이 아닙니다: {parsed.path}"
        )

    kind = match.group("kind")
    shortcode = match.group("shortcode")

    if kind in ("reel", "reels"):
        content_type: ContentType = "reel"
    else:
        content_type = "post"

    normalized_url = f"https://www.instagram.com/{kind}/{shortcode}/"
    return shortcode, content_type, normalized_url
