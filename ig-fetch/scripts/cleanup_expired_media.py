"""
보관 기간이 지난 저장 미디어를 자동 정리하는 스크립트.

저작권 대응:
- settings.media_retention_days 보다 오래된 미디어를 백엔드에서 삭제하고
  DB의 stored_url/stored_key 등을 비운다.
- Post 메타데이터(캡션, 좋아요 등)는 보존된다.
- media_retention_days=0이면 아무 것도 하지 않는다.

사용법:
    python -m scripts.cleanup_expired_media
    # 또는 dry-run
    python -m scripts.cleanup_expired_media --dry-run

cron 예시 (매일 새벽 4시):
    0 4 * * * cd /app && /app/.venv/bin/python -m scripts.cleanup_expired_media
"""
import argparse
import logging
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import settings
from app.core.database import SessionLocal, Base, engine
from app.models import Media
from app.services import storage

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def cleanup(dry_run: bool = False) -> int:
    days = settings.media_retention_days
    if days <= 0:
        logger.info("media_retention_days=0 이므로 정리하지 않습니다.")
        return 0

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        cutoff = datetime.utcnow() - timedelta(days=days)
        # 'completed' 상태인 것만 정리 대상. 'failed'는 재시도 여지를 두고 건드리지 않음.
        candidates = (
            db.query(Media)
            .filter(Media.stored_at.isnot(None))
            .filter(Media.stored_at < cutoff)
            .filter(Media.storage_status == "completed")
            .all()
        )
        logger.info(
            f"정리 대상: {len(candidates)}개 (cutoff={cutoff.isoformat()})"
        )
        if dry_run:
            for m in candidates:
                logger.info(
                    f"  [dry-run] media id={m.id} key={m.stored_key} "
                    f"stored_at={m.stored_at}"
                )
            return len(candidates)

        deleted = 0
        for m in candidates:
            ok = storage.delete_stored(m.stored_key)
            if ok:
                m.stored_url = None
                m.stored_key = None
                m.storage_backend = None
                m.stored_size_bytes = None
                m.stored_at = None
                m.storage_status = "skipped"
                m.storage_error = None
                deleted += 1
            else:
                logger.warning(f"삭제 실패, DB 컬럼은 그대로 둠: media id={m.id}")
        db.commit()
        logger.info(f"정리 완료: {deleted}/{len(candidates)} 성공")
        return deleted
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    cleanup(dry_run=args.dry_run)
