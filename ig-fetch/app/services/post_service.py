"""
Post 도메인의 비즈니스 로직 (하이브리드 저장 모드).

저장 타이밍 정책:
  - 단일 이미지 1장      → 동기 저장 (응답 전에 stored_url까지 채움)
  - 영상 또는 미디어 ≥2개 → 백그라운드 저장 (storage_status='pending'으로 즉시 응답)

이렇게 분기하면:
  - 가장 흔한 케이스(피드 사진 한 장)는 사용자가 한 번의 요청으로 모든 걸 받음
  - 무거운 케이스(릴스, 캐러셀)는 응답 latency가 짧고, 폴링으로 완료 확인
"""
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import Post, Media
from app.services import fetcher, storage, url_parser

logger = logging.getLogger(__name__)


# ===== 핫 패스 헬퍼 =====

def _is_cache_valid(post: Post) -> bool:
    if post.fetched_at is None:
        return False
    age = datetime.utcnow() - post.fetched_at
    return age < timedelta(seconds=settings.cache_ttl_seconds)


def _should_store(store_media_flag: Optional[bool]) -> bool:
    if not storage.is_storage_enabled():
        return False
    if store_media_flag is False:
        return False
    return True


def _is_sync_eligible(media_items: list[dict]) -> bool:
    """
    동기 저장 가능 조건: 미디어 정확히 1개 + 이미지.
    영상은 크기가 커서 latency가 길고, 캐러셀은 N번 다운로드라 마찬가지로 길어진다.
    """
    return len(media_items) == 1 and media_items[0].get("media_type") == "image"


# ===== 동기 저장 (이미지 1장) =====

def _store_one_sync(shortcode: str, item: dict) -> None:
    """item 을 in-place로 업데이트하면서 결과를 채움."""
    item["storage_started_at"] = datetime.utcnow()
    try:
        result = storage.download_and_store(
            shortcode=shortcode,
            order_index=item["order_index"],
            source_url=item["source_url"],
            media_type=item["media_type"],
        )
    except Exception as e:
        logger.exception(f"동기 store 실패: {e}")
        item["storage_status"] = "failed"
        item["storage_error"] = str(e)[:500]
        return

    if result:
        item["stored_url"] = result.public_url
        item["stored_key"] = result.key
        item["storage_backend"] = settings.storage_backend.lower()
        item["stored_size_bytes"] = result.size_bytes
        item["stored_at"] = datetime.utcnow()
        item["storage_status"] = "completed"
    else:
        item["storage_status"] = "failed"
        item["storage_error"] = "다운로드 실패 (로그 확인)"


# ===== 백그라운드 저장 =====

def store_post_media_in_background(post_id: int) -> None:
    """
    FastAPI BackgroundTasks가 호출. 별도 DB 세션 사용 (요청 세션은 이미 닫혀 있음).

    pending 상태의 미디어만 골라 순차적으로 처리.
    각 항목 처리 후 즉시 커밋해서, 클라이언트가 폴링할 때 진행도가 누적되어 보이도록.
    """
    db = SessionLocal()
    try:
        post = db.query(Post).filter(Post.id == post_id).first()
        if not post:
            logger.warning(f"BG: post_id={post_id} 없음")
            return

        pending = [m for m in post.media_items if m.storage_status == "pending"]
        logger.info(
            f"BG store 시작: shortcode={post.ig_shortcode} pending={len(pending)}"
        )

        for m in pending:
            # 실제로 처리 시작 시각을 갱신 (큐잉 시각과 다를 수 있음)
            if not m.storage_started_at:
                m.storage_started_at = datetime.utcnow()
                db.commit()
            try:
                result = storage.download_and_store(
                    shortcode=post.ig_shortcode,
                    order_index=m.order_index,
                    source_url=m.source_url,
                    media_type=m.media_type,
                )
            except Exception as e:
                logger.exception(f"BG store 항목 실패 media_id={m.id}: {e}")
                m.storage_status = "failed"
                m.storage_error = str(e)[:500]
                db.commit()
                continue

            if result:
                m.stored_url = result.public_url
                m.stored_key = result.key
                m.storage_backend = settings.storage_backend.lower()
                m.stored_size_bytes = result.size_bytes
                m.stored_at = datetime.utcnow()
                m.storage_status = "completed"
                m.storage_error = None
            else:
                m.storage_status = "failed"
                m.storage_error = "다운로드 실패"
            db.commit()

        logger.info(f"BG store 완료: shortcode={post.ig_shortcode}")
    finally:
        db.close()


# ===== 저장 결과 DB 반영 =====

def _save_post(
    db: Session,
    shortcode: str,
    normalized_url: str,
    content_type: str,
    fetched_data: dict,
    existing: Optional[Post] = None,
) -> Post:
    if existing:
        post = existing
        post.media_items.clear()
        db.flush()
    else:
        post = Post(
            ig_shortcode=shortcode,
            ig_url=normalized_url,
            content_type=content_type,
        )
        db.add(post)

    post.author_username = fetched_data.get("author_username")
    post.author_id = fetched_data.get("author_id")
    post.caption = fetched_data.get("caption")
    post.like_count = fetched_data.get("like_count")
    post.comment_count = fetched_data.get("comment_count")
    post.posted_at = fetched_data.get("posted_at")
    post.raw_response = fetched_data.get("raw_response")
    post.fetched_at = datetime.utcnow()

    allowed = {
        "order_index", "media_type", "source_url",
        "stored_url", "stored_key", "storage_backend",
        "stored_size_bytes", "stored_at", "storage_started_at",
        "storage_status", "storage_error",
        "width", "height", "duration_seconds", "thumbnail_url",
    }
    for media_data in fetched_data["media_items"]:
        clean = {k: v for k, v in media_data.items() if k in allowed}
        post.media_items.append(Media(**clean))

    db.commit()
    db.refresh(post)
    return post


# ===== 메인 진입점 =====

def fetch_post(
    db: Session,
    url: str,
    force_refresh: bool = False,
    store_media: Optional[bool] = None,
) -> tuple[Post, bool, bool]:
    """
    Returns:
        (Post, from_cache, needs_background)
        needs_background=True 면 호출자가 BackgroundTasks에 store_post_media_in_background를 등록해야 함.
    """
    shortcode, content_type, normalized_url = url_parser.parse_instagram_url(url)
    logger.info(f"parsed: shortcode={shortcode}, type={content_type}")

    existing = db.query(Post).filter(Post.ig_shortcode == shortcode).first()

    # ----- 캐시 히트 -----
    if existing and not force_refresh and _is_cache_valid(existing):
        # 캐시는 있지만 저장 안 된 또는 실패한 항목이 있다면 백그라운드로 자동 재시도
        needs_bg = False
        if _should_store(store_media):
            missing = [
                m for m in existing.media_items
                if m.storage_status in ("skipped", "failed") and not m.stored_url
            ]
            if missing:
                now = datetime.utcnow()
                for m in missing:
                    m.storage_status = "pending"
                    m.storage_error = None
                    m.storage_started_at = now
                db.commit()
                needs_bg = True
                logger.info(
                    f"캐시 히트, 미저장/실패 {len(missing)}개 자동 재시도 큐잉"
                )
        logger.info(f"캐시 히트: {shortcode}")
        return existing, True, needs_bg

    # ----- 캐시 미스 → fetch -----
    logger.info(f"캐시 미스, fetch 시도: {shortcode}")
    try:
        fetched_data = fetcher.fetch_instagram_content(normalized_url)
    except fetcher.FetchError:
        if existing:
            logger.warning(f"fetch 실패했지만 만료된 캐시 사용: {shortcode}")
            return existing, True, False
        raise

    media_items = fetched_data["media_items"]
    needs_background = False

    if not _should_store(store_media):
        # 저장 안 함
        for item in media_items:
            item["storage_status"] = "skipped"
    elif _is_sync_eligible(media_items):
        # 단일 이미지 → 동기
        logger.info(f"단일 이미지 → 동기 저장: {shortcode}")
        _store_one_sync(shortcode, media_items[0])
    else:
        # 영상 또는 미디어 ≥2개 → 백그라운드
        logger.info(
            f"영상/캐러셀({len(media_items)}개) → 백그라운드 저장 큐잉: {shortcode}"
        )
        now = datetime.utcnow()
        for item in media_items:
            item["storage_status"] = "pending"
            item["storage_started_at"] = now
        needs_background = True

    post = _save_post(
        db=db,
        shortcode=shortcode,
        normalized_url=normalized_url,
        content_type=content_type,
        fetched_data=fetched_data,
        existing=existing,
    )
    return post, False, needs_background


# ===== 조회 / 삭제 =====

def get_post_by_shortcode(db: Session, shortcode: str) -> Optional[Post]:
    return db.query(Post).filter(Post.ig_shortcode == shortcode).first()


def list_posts(db: Session, limit: int = 20, offset: int = 0) -> list[Post]:
    return (
        db.query(Post)
        .order_by(Post.fetched_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )


def retry_failed_media(db: Session, post: Post) -> int:
    """
    이 포스트의 'failed' 상태 미디어를 'pending'으로 되돌려 백그라운드로 재시도.
    Returns: 재큐잉된 미디어 개수. 호출자가 BackgroundTasks에 등록해야 함.
    """
    if not storage.is_storage_enabled():
        return 0
    failed = [m for m in post.media_items if m.storage_status == "failed"]
    if not failed:
        return 0
    now = datetime.utcnow()
    for m in failed:
        m.storage_status = "pending"
        m.storage_error = None
        m.storage_started_at = now
    db.commit()
    logger.info(
        f"재시도 큐잉: shortcode={post.ig_shortcode}, count={len(failed)}"
    )
    return len(failed)


def delete_stored_media_for_post(db: Session, post: Post) -> int:
    """저장된 미디어 파일만 삭제. 메타데이터는 보존. 저작권 대응."""
    deleted = 0
    for m in post.media_items:
        if not m.stored_key:
            continue
        ok = storage.delete_stored(m.stored_key)
        if ok:
            m.stored_url = None
            m.stored_key = None
            m.storage_backend = None
            m.stored_size_bytes = None
            m.stored_at = None
            m.storage_started_at = None
            m.storage_status = "skipped"
            m.storage_error = None
            deleted += 1
    db.commit()
    return deleted


def get_storage_status(post: Post) -> dict:
    """
    포스트의 storage_status 집계.
    """
    statuses = [m.storage_status for m in post.media_items]
    total = len(statuses)
    counts = {
        s: statuses.count(s)
        for s in ("completed", "pending", "failed", "skipped")
    }
    if counts["pending"] > 0:
        overall = "pending"
    elif counts["failed"] > 0 and counts["completed"] == 0:
        overall = "failed"
    elif counts["completed"] == total:
        overall = "completed"
    elif counts["completed"] > 0 and counts["failed"] > 0:
        overall = "partial"
    else:
        overall = "skipped"

    return {
        "shortcode": post.ig_shortcode,
        "overall": overall,
        "total": total,
        "counts": counts,
        "items": [
            {
                "order_index": m.order_index,
                "media_type": m.media_type,
                "status": m.storage_status,
                "stored_url": m.stored_url,
                "error": m.storage_error,
            }
            for m in post.media_items
        ],
    }
