from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, ForeignKey, Float, BigInteger
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from app.core.database import Base


class Post(Base):
    """Instagram 포스트 또는 릴스의 메타데이터."""
    __tablename__ = "posts"

    id = Column(Integer, primary_key=True, index=True)
    ig_shortcode = Column(String(50), unique=True, nullable=False, index=True)
    ig_url = Column(Text, nullable=False)
    content_type = Column(String(20), nullable=False)

    author_username = Column(String(100), nullable=True)
    author_id = Column(String(50), nullable=True)

    caption = Column(Text, nullable=True)
    like_count = Column(BigInteger, nullable=True)
    comment_count = Column(BigInteger, nullable=True)

    raw_response = Column(JSONB, nullable=True)

    posted_at = Column(DateTime, nullable=True)
    fetched_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    media_items = relationship(
        "Media",
        back_populates="post",
        cascade="all, delete-orphan",
        order_by="Media.order_index",
    )


# storage_status 가능한 값:
#   'skipped'   - 저장 안 함 (STORAGE_BACKEND=none 또는 store_media=false)
#   'pending'   - 백그라운드 다운로드 대기/진행 중
#   'completed' - 성공적으로 stored_url 채워짐
#   'failed'    - 다운로드/업로드 실패 (재시도 가능)
STORAGE_STATUS_VALUES = ("skipped", "pending", "completed", "failed")


class Media(Base):
    """포스트에 포함된 개별 미디어 (이미지/영상 1개)."""
    __tablename__ = "media"

    id = Column(Integer, primary_key=True, index=True)
    post_id = Column(
        Integer,
        ForeignKey("posts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    order_index = Column(Integer, default=0, nullable=False)
    media_type = Column(String(20), nullable=False)

    # IG CDN 원본 URL (시간 지나면 만료)
    source_url = Column(Text, nullable=False)

    # ===== 영구 저장 =====
    # 영구 URL. 저장 완료된 경우에만 채워짐.
    stored_url = Column(Text, nullable=True)
    # 백엔드 내부 식별자 (S3 key 또는 로컬 상대경로). 삭제 시 사용.
    stored_key = Column(Text, nullable=True)
    # 어떤 백엔드에 저장됐는지 (local/s3).
    storage_backend = Column(String(20), nullable=True)
    stored_size_bytes = Column(BigInteger, nullable=True)
    stored_at = Column(DateTime, nullable=True)
    # 백그라운드 작업이 큐잉된 시각. 좀비 감지에 사용 (pending인데 너무 오래된 항목).
    storage_started_at = Column(DateTime, nullable=True)
    # 백그라운드 작업 상태 추적용
    storage_status = Column(String(20), default="skipped", nullable=False)
    storage_error = Column(Text, nullable=True)  # 실패 시 에러 메시지 저장

    # 메타데이터
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    duration_seconds = Column(Float, nullable=True)
    thumbnail_url = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    post = relationship("Post", back_populates="media_items")
