"""
시연용 시드 스크립트.

사용법:
    python -m scripts.seed_demo_urls
"""
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.database import SessionLocal, Base, engine
from app.services import post_service, fetcher, url_parser

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


DEMO_URLS = [
    # 예시 - 실제 시연용 URL로 교체할 것
    # "https://www.instagram.com/p/XXXXXXXXXXX/",
    # "https://www.instagram.com/reel/XXXXXXXXXXX/",
]


def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    if not DEMO_URLS:
        logger.warning("DEMO_URLS가 비어있습니다. 스크립트를 열어서 URL을 추가하세요.")
        return

    success, failed = 0, 0
    for url in DEMO_URLS:
        try:
            logger.info(f"fetch: {url}")
            post, from_cache = post_service.fetch_post(
                db=db, url=url, force_refresh=True
            )
            logger.info(
                f"  ✓ shortcode={post.ig_shortcode} "
                f"type={post.content_type} media={len(post.media_items)}"
            )
            success += 1
        except (url_parser.InvalidInstagramURLError, fetcher.FetchError) as e:
            logger.error(f"  ✗ 실패: {e}")
            failed += 1

    db.close()
    logger.info(f"=== 완료: 성공 {success}, 실패 {failed} ===")


if __name__ == "__main__":
    seed()
