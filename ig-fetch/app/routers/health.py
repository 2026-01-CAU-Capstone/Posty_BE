"""
헬스 체크 + 쿠키/스토리지 설정 진단 엔드포인트.
"""
from fastapi import APIRouter

from app.core.config import settings

router = APIRouter(tags=["health"])


@router.get("/health", summary="서버 상태 체크")
def health():
    cookies_mode = None
    if settings.cookies_file_path:
        cookies_mode = "cookies_file"
    elif settings.ig_sessionid:
        cookies_mode = "sessionid"

    storage_info = {"backend": settings.storage_backend}
    mode = settings.storage_backend.lower()
    if mode == "local":
        storage_info["dir"] = settings.local_storage_dir
        storage_info["public_url"] = settings.local_storage_public_url
    elif mode == "s3":
        storage_info["bucket"] = settings.s3_bucket
        storage_info["region"] = settings.s3_region
        storage_info["prefix"] = settings.s3_prefix
        storage_info["public_url_base"] = settings.s3_public_url_base

    return {
        "status": "ok",
        "ig_auth": {
            "configured": cookies_mode is not None,
            "mode": cookies_mode,
        },
        "cache_ttl_seconds": settings.cache_ttl_seconds,
        "media_proxy_enabled": settings.enable_media_proxy,
        "storage": storage_info,
        "media_retention_days": settings.media_retention_days,
    }
