from datetime import datetime
from typing import Optional, List, Literal
from pydantic import BaseModel, Field


StorageStatus = Literal["skipped", "pending", "completed", "failed"]
OverallStorageStatus = Literal[
    "skipped", "pending", "completed", "failed", "partial"
]


# ===== Request =====

class FetchRequest(BaseModel):
    url: str = Field(..., description="Instagram 포스트 또는 릴스 URL")
    force_refresh: bool = Field(
        default=False, description="True면 캐시 무시하고 새로 fetch"
    )
    store_media: Optional[bool] = Field(
        default=None,
        description=(
            "미디어를 영구 저장할지. None이면 서버 기본값. "
            "False로 명시하면 이 요청에서는 저장 스킵."
        ),
    )


# ===== Response =====

class MediaResponse(BaseModel):
    order_index: int
    media_type: Literal["image", "video"]
    source_url: str
    proxy_url: Optional[str] = None
    stored_url: Optional[str] = None
    stored_size_bytes: Optional[int] = None
    stored_at: Optional[datetime] = None
    storage_status: StorageStatus = "skipped"
    storage_error: Optional[str] = None

    width: Optional[int] = None
    height: Optional[int] = None
    duration_seconds: Optional[float] = None
    thumbnail_url: Optional[str] = None

    model_config = {"from_attributes": True}


class PostResponse(BaseModel):
    id: int
    ig_shortcode: str
    ig_url: str
    content_type: Literal["post", "reel", "story"]
    author_username: Optional[str] = None
    author_id: Optional[str] = None
    caption: Optional[str] = None
    like_count: Optional[int] = None
    comment_count: Optional[int] = None
    posted_at: Optional[datetime] = None
    fetched_at: datetime
    media_items: List[MediaResponse] = []
    from_cache: bool = False

    # 백그라운드 저장 작업이 큐잉되었는지. True면 클라이언트가
    # /posts/{shortcode}/storage-status 로 폴링하면 됨.
    storage_pending: bool = False
    # 전체 저장 상태 요약 (개별 항목 status는 media_items 안에)
    storage_overall: OverallStorageStatus = "skipped"

    model_config = {"from_attributes": True}


class StorageStatusItem(BaseModel):
    order_index: int
    media_type: Literal["image", "video"]
    status: StorageStatus
    stored_url: Optional[str] = None
    error: Optional[str] = None


class StorageStatusResponse(BaseModel):
    shortcode: str
    overall: OverallStorageStatus
    total: int
    counts: dict[str, int]
    items: List[StorageStatusItem]


class DeleteMediaResponse(BaseModel):
    shortcode: str
    deleted_count: int
    detail: str


class ErrorResponse(BaseModel):
    detail: str
    error_code: Optional[str] = None
