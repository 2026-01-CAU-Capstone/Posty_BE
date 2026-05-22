"""
환경변수 기반 설정 (.env 파일에서 자동 로드).

쿠키 관련 옵션:
- IG_COOKIES_FILE: cookies.txt 파일 경로 (Netscape 포맷). 브라우저 확장으로 추출.
- IG_SESSIONID:    'sessionid' 쿠키 값 하나만. 간단히 시연용으로 쓰기 좋음.
                   둘 다 지정되면 IG_COOKIES_FILE이 우선.

스토리지 옵션:
- STORAGE_BACKEND: 'local' | 's3' | 'none'
- local 모드면 LOCAL_STORAGE_DIR / LOCAL_STORAGE_PUBLIC_URL 사용
- s3 모드면 S3_BUCKET / S3_REGION / (선택) S3_PREFIX / S3_PUBLIC_URL_BASE / S3_ENDPOINT_URL 사용
"""
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://posty:posty@localhost:5432/posty"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = True

    # yt-dlp
    ytdlp_timeout: int = 30
    ytdlp_retries: int = 2

    # Cache
    cache_ttl_seconds: int = 86400

    # ===== Instagram 인증 =====
    ig_cookies_file: Optional[str] = None
    ig_sessionid: Optional[str] = None
    ig_ds_user_id: Optional[str] = None
    ig_user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )

    # 미디어 proxy 엔드포인트 (응답에 proxy_url 필드 포함)
    enable_media_proxy: bool = True

    # ===== 미디어 영구 저장 =====
    # 'local'(개발) | 's3'(배포) | 'none'(저장 안 함)
    storage_backend: str = "local"

    # local 모드 설정
    local_storage_dir: str = "./storage"
    # 서버가 노출할 정적 경로. main.py에서 mount함.
    # 외부 도메인을 쓰려면 절대 URL로 바꾸세요 (예: https://cdn.myhost.com/media)
    local_storage_public_url: str = "http://localhost:8000/static"

    # s3 모드 설정
    s3_bucket: Optional[str] = None
    s3_region: str = "ap-northeast-2"
    s3_prefix: Optional[str] = None  # 예: "posty/media"
    # CloudFront 또는 커스텀 도메인. 비워두면 s3 표준 URL 사용.
    s3_public_url_base: Optional[str] = None
    # MinIO 등 S3 호환 서비스용. AWS는 None.
    s3_endpoint_url: Optional[str] = None

    # 저장된 미디어를 며칠 후 자동 삭제할지 (저작권 이슈 대응).
    # 0이면 자동 삭제 안 함. cleanup_expired_media.py 스크립트가 이 값을 참조.
    media_retention_days: int = 7

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    @property
    def cookies_file_path(self) -> Optional[Path]:
        if not self.ig_cookies_file:
            return None
        p = Path(self.ig_cookies_file).expanduser().resolve()
        return p if p.exists() else None


settings = Settings()
