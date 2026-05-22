"""
/posts 엔드포인트
- POST   /posts/fetch                       : URL fetch (캐시 + 하이브리드 저장)
- GET    /posts/{shortcode}                 : 캐시된 포스트 조회
- GET    /posts/{shortcode}/storage-status  : 백그라운드 저장 진행도
- GET    /posts                             : 최근 fetch된 포스트 목록
- DELETE /posts/{shortcode}/media           : 저장된 미디어 삭제 (저작권 대응)
"""
import logging
from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.schemas import (
    FetchRequest,
    PostResponse,
    StorageStatusResponse,
    DeleteMediaResponse,
)
from app.services import post_service, fetcher, url_parser

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/posts", tags=["posts"])


def _proxy_url_for(request: Request, source_url: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/media/proxy?url={quote(source_url, safe='')}"


def _to_response(
    post,
    from_cache: bool,
    request: Request,
    storage_pending: bool = False,
) -> PostResponse:
    media_payload = []
    for m in post.media_items:
        item = {
            "order_index": m.order_index,
            "media_type": m.media_type,
            "source_url": m.source_url,
            "stored_url": m.stored_url,
            "stored_size_bytes": m.stored_size_bytes,
            "stored_at": m.stored_at,
            "storage_status": m.storage_status,
            "storage_error": m.storage_error,
            "width": m.width,
            "height": m.height,
            "duration_seconds": m.duration_seconds,
            "thumbnail_url": m.thumbnail_url,
        }
        if settings.enable_media_proxy and m.source_url:
            item["proxy_url"] = _proxy_url_for(request, m.source_url)
        media_payload.append(item)

    overall = post_service.get_storage_status(post)["overall"]

    return PostResponse(
        id=post.id,
        ig_shortcode=post.ig_shortcode,
        ig_url=post.ig_url,
        content_type=post.content_type,
        author_username=post.author_username,
        author_id=post.author_id,
        caption=post.caption,
        like_count=post.like_count,
        comment_count=post.comment_count,
        posted_at=post.posted_at,
        fetched_at=post.fetched_at,
        media_items=media_payload,
        from_cache=from_cache,
        storage_pending=storage_pending or overall == "pending",
        storage_overall=overall,
    )


@router.post(
    "/fetch",
    response_model=PostResponse,
    status_code=status.HTTP_200_OK,
    summary="Instagram URL로부터 콘텐츠 fetch",
    description=(
        "단일 이미지는 동기 저장 (응답에 `stored_url` 즉시 포함)\n"
        "영상·캐러셀은 백그라운드 저장 (`storage_pending=true` 반환,\n"
        "이후 `GET /posts/{shortcode}/storage-status`로 폴링)"
    ),
)
def fetch_post_endpoint(
    request_body: FetchRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    try:
        post, from_cache, needs_bg = post_service.fetch_post(
            db=db,
            url=request_body.url,
            force_refresh=request_body.force_refresh,
            store_media=request_body.store_media,
        )
    except url_parser.InvalidInstagramURLError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(e))
    except fetcher.LoginRequiredError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(e))
    except fetcher.PrivateContentError as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=str(e))
    except fetcher.ContentNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(e))
    except fetcher.FetchError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(e))

    if needs_bg:
        # post.id 는 위 fetch_post 에서 commit 후 채워져 있음
        background_tasks.add_task(
            post_service.store_post_media_in_background, post.id
        )

    return _to_response(
        post, from_cache=from_cache, request=request, storage_pending=needs_bg
    )


@router.get(
    "/{shortcode}",
    response_model=PostResponse,
    summary="캐시된 포스트 조회",
)
def get_post_endpoint(
    shortcode: str,
    request: Request,
    db: Session = Depends(get_db),
):
    post = post_service.get_post_by_shortcode(db, shortcode)
    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"shortcode={shortcode} 인 포스트가 없습니다.",
        )
    return _to_response(post, from_cache=True, request=request)


@router.get(
    "/{shortcode}/storage-status",
    response_model=StorageStatusResponse,
    summary="저장 작업 진행도 (백그라운드 폴링용)",
    description=(
        "캐러셀/영상의 백그라운드 저장이 완료되었는지 확인합니다.\n"
        "응답의 `overall` 이 'completed'가 될 때까지 폴링하세요."
    ),
)
def get_storage_status_endpoint(
    shortcode: str,
    db: Session = Depends(get_db),
):
    post = post_service.get_post_by_shortcode(db, shortcode)
    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"shortcode={shortcode} 인 포스트가 없습니다.",
        )
    return post_service.get_storage_status(post)


@router.get(
    "",
    response_model=list[PostResponse],
    summary="최근 fetch된 포스트 목록",
)
def list_posts_endpoint(
    request: Request,
    limit: int = 20,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    posts = post_service.list_posts(db, limit=limit, offset=offset)
    return [_to_response(p, from_cache=True, request=request) for p in posts]


@router.post(
    "/{shortcode}/retry",
    response_model=StorageStatusResponse,
    summary="실패한 미디어 저장 재시도",
    description=(
        "이 포스트에서 storage_status='failed'인 미디어만 골라 백그라운드로 재시도합니다.\n"
        "fetch는 다시 호출하지 않고, 기존 source_url(IG CDN)을 재사용합니다.\n"
        "주의: IG CDN URL은 시간이 지나면 만료되므로, fetch 후 너무 오래 지났다면 force_refresh로 새 fetch를 권장."
    ),
)
def retry_endpoint(
    shortcode: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    post = post_service.get_post_by_shortcode(db, shortcode)
    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"shortcode={shortcode} 인 포스트가 없습니다.",
        )
    n = post_service.retry_failed_media(db, post)
    if n > 0:
        background_tasks.add_task(
            post_service.store_post_media_in_background, post.id
        )
    return post_service.get_storage_status(post)


@router.delete(
    "/{shortcode}/media",
    response_model=DeleteMediaResponse,
    summary="저장된 미디어 삭제 (저작권 대응)",
    description=(
        "Post 메타데이터는 유지하면서 영구 저장된 미디어 파일만 제거합니다. "
        "DB의 stored_url/stored_key 등도 함께 비워지고 storage_status는 'skipped'로 재설정됩니다."
    ),
)
def delete_media_endpoint(
    shortcode: str,
    db: Session = Depends(get_db),
):
    post = post_service.get_post_by_shortcode(db, shortcode)
    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"shortcode={shortcode} 인 포스트가 없습니다.",
        )
    n = post_service.delete_stored_media_for_post(db, post)
    return DeleteMediaResponse(
        shortcode=shortcode,
        deleted_count=n,
        detail=f"{n}개의 미디어를 삭제했습니다.",
    )
