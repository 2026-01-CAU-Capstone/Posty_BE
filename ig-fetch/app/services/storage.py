"""
미디어 영구 저장 백엔드.

전략:
- 추상 인터페이스 StorageBackend 위에 LocalStorageBackend / S3StorageBackend.
- settings.storage_backend 환경변수로 선택 (local | s3 | none).
- 'none'이면 파일 저장 없이 IG CDN 원본 URL만 사용.

저장 키 규칙:
  {shortcode}/{order_index}.{ext}
  예) Cxx7_abc/0.jpg, Cxx7_abc/1.mp4

이 규칙으로 같은 shortcode를 재fetch할 때 자연스럽게 덮어쓰기 됨.
"""
from __future__ import annotations

import logging
import mimetypes
import os
import shutil
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


# ===== 데이터 타입 =====

class StoredObject:
    """저장 후 반환되는 결과."""
    def __init__(
        self,
        *,
        key: str,                # 백엔드 내부 식별자 (S3 key 또는 로컬 상대경로)
        public_url: str,         # 클라이언트가 직접 GET 가능한 URL
        size_bytes: int,
        content_type: str,
    ):
        self.key = key
        self.public_url = public_url
        self.size_bytes = size_bytes
        self.content_type = content_type


class StorageError(Exception):
    pass


# ===== 추상 인터페이스 =====

class StorageBackend(ABC):
    @abstractmethod
    def upload_bytes(
        self,
        key: str,
        data: bytes,
        content_type: str,
    ) -> StoredObject:
        ...

    @abstractmethod
    def upload_stream(
        self,
        key: str,
        stream,                  # file-like, .read()
        content_type: str,
        size_hint: Optional[int] = None,
    ) -> StoredObject:
        ...

    @abstractmethod
    def delete(self, key: str) -> bool:
        """존재하지 않아도 True (idempotent). 실제 IO 에러일 때만 False."""
        ...


# ===== 로컬 디스크 백엔드 =====

class LocalStorageBackend(StorageBackend):
    """
    개발/시연용. settings.local_storage_dir 아래에 파일을 저장하고,
    같은 서버의 /static/ 경로로 노출.
    """
    def __init__(self, base_dir: Path, public_url_prefix: str):
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.public_url_prefix = public_url_prefix.rstrip("/")

    def _key_to_path(self, key: str) -> Path:
        # key는 'shortcode/0.jpg' 형태. 디렉토리 분리자만 OS에 맞게.
        p = self.base_dir / key
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def upload_bytes(self, key: str, data: bytes, content_type: str) -> StoredObject:
        path = self._key_to_path(key)
        path.write_bytes(data)
        return StoredObject(
            key=key,
            public_url=f"{self.public_url_prefix}/{key}",
            size_bytes=len(data),
            content_type=content_type,
        )

    def upload_stream(
        self,
        key: str,
        stream,
        content_type: str,
        size_hint: Optional[int] = None,
    ) -> StoredObject:
        path = self._key_to_path(key)
        total = 0
        with path.open("wb") as f:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
        return StoredObject(
            key=key,
            public_url=f"{self.public_url_prefix}/{key}",
            size_bytes=total,
            content_type=content_type,
        )

    def delete(self, key: str) -> bool:
        try:
            p = self._key_to_path(key)
            if p.exists():
                p.unlink()
            # 부모 디렉토리가 비었으면 정리 (best-effort)
            try:
                p.parent.rmdir()
            except OSError:
                pass
            return True
        except OSError as e:
            logger.error(f"로컬 삭제 실패 key={key}: {e}")
            return False


# ===== S3 백엔드 =====

class S3StorageBackend(StorageBackend):
    """
    boto3 기반 S3 백엔드.

    public_url 정책:
    - settings.s3_public_url_base 가 설정되어 있으면 그걸 prefix로 사용 (CloudFront 등).
    - 아니면 표준 https://{bucket}.s3.{region}.amazonaws.com/{key}.

    버킷의 객체는 public-read거나, CloudFront 앞단에서 접근 제어해야 함.
    이 코드는 ACL을 강제로 붙이지 않음 (대부분 버킷에서 Block Public Access가 켜져 있어서
    ACL이 막혀있기 때문). 버킷 정책이나 CloudFront로 접근 제어할 것을 권장.
    """
    def __init__(
        self,
        bucket: str,
        region: str,
        prefix: str = "",
        public_url_base: Optional[str] = None,
        endpoint_url: Optional[str] = None,
    ):
        # boto3는 무거우니 lazy import
        try:
            import boto3
            from botocore.config import Config
        except ImportError as e:
            raise StorageError(
                "S3 백엔드를 쓰려면 boto3가 필요합니다. "
                "pip install boto3"
            ) from e

        self.bucket = bucket
        self.region = region
        self.prefix = prefix.strip("/")
        self.public_url_base = (public_url_base or "").rstrip("/")
        self._client = boto3.client(
            "s3",
            region_name=region,
            endpoint_url=endpoint_url,  # MinIO 등 호환 스토리지 지원
            config=Config(
                retries={"max_attempts": 3, "mode": "standard"},
                s3={"addressing_style": "virtual"},
            ),
        )

    def _full_key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def _public_url(self, full_key: str) -> str:
        if self.public_url_base:
            return f"{self.public_url_base}/{full_key}"
        return (
            f"https://{self.bucket}.s3.{self.region}.amazonaws.com/{full_key}"
        )

    def upload_bytes(self, key: str, data: bytes, content_type: str) -> StoredObject:
        full_key = self._full_key(key)
        try:
            self._client.put_object(
                Bucket=self.bucket,
                Key=full_key,
                Body=data,
                ContentType=content_type,
                # CacheControl은 immutable 미디어이므로 길게.
                CacheControl="public, max-age=31536000, immutable",
            )
        except Exception as e:
            raise StorageError(f"S3 put_object 실패: {e}") from e

        return StoredObject(
            key=full_key,
            public_url=self._public_url(full_key),
            size_bytes=len(data),
            content_type=content_type,
        )

    def upload_stream(
        self,
        key: str,
        stream,
        content_type: str,
        size_hint: Optional[int] = None,
    ) -> StoredObject:
        full_key = self._full_key(key)
        # boto3 upload_fileobj는 자동으로 multipart 처리해줘서 큰 영상에 좋음
        try:
            self._client.upload_fileobj(
                Fileobj=stream,
                Bucket=self.bucket,
                Key=full_key,
                ExtraArgs={
                    "ContentType": content_type,
                    "CacheControl": "public, max-age=31536000, immutable",
                },
            )
        except Exception as e:
            raise StorageError(f"S3 upload_fileobj 실패: {e}") from e

        # size_hint를 신뢰하되, 없으면 head_object로 확인
        if size_hint is None:
            try:
                head = self._client.head_object(Bucket=self.bucket, Key=full_key)
                size_hint = head.get("ContentLength", 0)
            except Exception:
                size_hint = 0

        return StoredObject(
            key=full_key,
            public_url=self._public_url(full_key),
            size_bytes=size_hint,
            content_type=content_type,
        )

    def delete(self, key: str) -> bool:
        # 외부에서 key를 그대로 받았을 수도, full_key 형태로 받았을 수도 있어 둘 다 시도.
        candidates = {key}
        if self.prefix and not key.startswith(self.prefix + "/"):
            candidates.add(self._full_key(key))
        ok = True
        for k in candidates:
            try:
                self._client.delete_object(Bucket=self.bucket, Key=k)
            except Exception as e:
                logger.error(f"S3 delete 실패 key={k}: {e}")
                ok = False
        return ok


# ===== 'none' 백엔드 =====

class NoopStorageBackend(StorageBackend):
    """저장하지 않음. fetch만 하고 IG CDN 원본 URL을 그대로 쓸 때."""
    def upload_bytes(self, key, data, content_type) -> StoredObject:
        raise StorageError("storage backend가 'none'으로 설정되어 있습니다.")

    def upload_stream(self, key, stream, content_type, size_hint=None) -> StoredObject:
        raise StorageError("storage backend가 'none'으로 설정되어 있습니다.")

    def delete(self, key: str) -> bool:
        return True


# ===== 팩토리 =====

_backend: Optional[StorageBackend] = None


def get_storage_backend() -> StorageBackend:
    """싱글톤. settings 기반으로 선택."""
    global _backend
    if _backend is not None:
        return _backend

    mode = settings.storage_backend.lower()
    if mode == "local":
        _backend = LocalStorageBackend(
            base_dir=Path(settings.local_storage_dir).resolve(),
            public_url_prefix=settings.local_storage_public_url,
        )
        logger.info(f"Storage: LOCAL at {settings.local_storage_dir}")
    elif mode == "s3":
        if not settings.s3_bucket:
            raise StorageError("STORAGE_BACKEND=s3 인데 S3_BUCKET이 비어있습니다.")
        _backend = S3StorageBackend(
            bucket=settings.s3_bucket,
            region=settings.s3_region,
            prefix=settings.s3_prefix or "",
            public_url_base=settings.s3_public_url_base,
            endpoint_url=settings.s3_endpoint_url,
        )
        logger.info(f"Storage: S3 bucket={settings.s3_bucket} region={settings.s3_region}")
    elif mode == "none":
        _backend = NoopStorageBackend()
        logger.info("Storage: NONE (미디어 영구 저장 안 함)")
    else:
        raise StorageError(f"알 수 없는 STORAGE_BACKEND: {mode}")

    return _backend


def is_storage_enabled() -> bool:
    return settings.storage_backend.lower() in ("local", "s3")


# ===== IG에서 다운로드 → 백엔드 업로드 =====

def _guess_extension(content_type: str, source_url: str) -> str:
    """확장자 추정. content-type 우선, 없으면 URL path."""
    ext = mimetypes.guess_extension(content_type.split(";")[0].strip()) if content_type else None
    if ext:
        # mimetypes는 image/jpeg → .jpe를 주는 경우가 있어 보정
        return {".jpe": ".jpg"}.get(ext, ext)
    # URL fallback
    path = urlparse(source_url).path
    _, dot, end = path.rpartition(".")
    return f".{end.lower()}" if dot and 1 <= len(end) <= 4 else ".bin"


def download_and_store(
    *,
    shortcode: str,
    order_index: int,
    source_url: str,
    media_type: str,            # "image" | "video"
) -> Optional[StoredObject]:
    """
    IG CDN에서 다운로드 → 백엔드에 업로드.
    백엔드가 'none'이면 None 반환.

    실패해도 예외 던지지 않고 None 반환 (저장 실패가 fetch 자체를 막지 않도록).
    """
    if not is_storage_enabled():
        return None

    backend = get_storage_backend()
    upstream_headers = {
        "User-Agent": settings.ig_user_agent,
        "Referer": "https://www.instagram.com/",
        "Accept": "*/*",
    }

    try:
        # 영상은 크기가 크니 stream으로, 이미지는 보통 작아서 한 번에.
        if media_type == "video":
            with httpx.Client(
                timeout=httpx.Timeout(60.0, read=120.0),
                follow_redirects=True,
            ) as client:
                with client.stream("GET", source_url, headers=upstream_headers) as resp:
                    if resp.status_code >= 400:
                        logger.warning(
                            f"IG CDN HTTP {resp.status_code} for {source_url[:80]}"
                        )
                        return None
                    content_type = resp.headers.get(
                        "content-type", "video/mp4"
                    )
                    size_hint = int(resp.headers.get("content-length") or 0) or None
                    ext = _guess_extension(content_type, source_url)
                    key = f"{shortcode}/{order_index}{ext}"

                    # httpx stream은 .read()가 안 되므로 임시 파일을 거치는 게 안전
                    import tempfile
                    with tempfile.SpooledTemporaryFile(max_size=10 * 1024 * 1024) as buf:
                        for chunk in resp.iter_bytes(chunk_size=64 * 1024):
                            buf.write(chunk)
                        buf.seek(0)
                        return backend.upload_stream(
                            key=key,
                            stream=buf,
                            content_type=content_type,
                            size_hint=size_hint,
                        )
        else:
            with httpx.Client(
                timeout=30.0, follow_redirects=True
            ) as client:
                resp = client.get(source_url, headers=upstream_headers)
                if resp.status_code >= 400:
                    logger.warning(
                        f"IG CDN HTTP {resp.status_code} for {source_url[:80]}"
                    )
                    return None
                content_type = resp.headers.get("content-type", "image/jpeg")
                ext = _guess_extension(content_type, source_url)
                key = f"{shortcode}/{order_index}{ext}"
                return backend.upload_bytes(
                    key=key,
                    data=resp.content,
                    content_type=content_type,
                )
    except httpx.RequestError as e:
        logger.error(f"미디어 다운로드 실패: {e}")
        return None
    except StorageError as e:
        logger.error(f"미디어 업로드 실패: {e}")
        return None
    except Exception as e:
        logger.exception(f"미디어 store 중 예기치 못한 오류: {e}")
        return None


def delete_stored(key: Optional[str]) -> bool:
    if not key:
        return True
    if not is_storage_enabled():
        return True
    backend = get_storage_backend()
    return backend.delete(key)
