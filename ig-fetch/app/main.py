import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, text

from app.core.config import settings
from app.core.database import Base, engine
from app.routers import health, posts, media

logging.basicConfig(
    level=logging.INFO if not settings.debug else logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ===== 테이블 생성 + 가벼운 자동 마이그레이션 =====
# 운영에서는 Alembic으로 대체할 것. 캡스톤 단계라 코드 한 곳에서 처리.

def _bootstrap_schema():
    Base.metadata.create_all(bind=engine)
    # media 테이블에 신규 컬럼들이 없으면 ALTER TABLE로 추가.
    # 이미 있으면 IF NOT EXISTS로 무시됨.
    new_columns = [
        ("stored_key",        "TEXT"),
        ("storage_backend",   "VARCHAR(20)"),
        ("stored_size_bytes", "BIGINT"),
        ("stored_at",         "TIMESTAMP"),
        ("storage_started_at","TIMESTAMP"),
        ("storage_status",    "VARCHAR(20) NOT NULL DEFAULT 'skipped'"),
        ("storage_error",     "TEXT"),
    ]
    with engine.begin() as conn:
        existing = {
            c["name"] for c in inspect(conn).get_columns("media")
        }
        for name, ddl in new_columns:
            if name not in existing:
                logger.info(f"마이그레이션: media.{name} 추가")
                conn.execute(text(f"ALTER TABLE media ADD COLUMN {name} {ddl}"))


_bootstrap_schema()


# ===== 시작 시 좀비 작업 정리 =====
# 서버가 비정상 종료됐을 때 'pending' 상태로 남은 미디어 항목을 정리.
# 너무 오래된 (>10분) pending은 'failed'로 마킹하고, 너무 오래되지 않은 것은
# 그대로 두고 재기동 시 다시 다루도록 함 (지금 코드는 모두 failed로 표시).
def _reset_zombie_pending():
    from datetime import datetime, timedelta
    from app.core.database import SessionLocal
    from app.models import Media

    db = SessionLocal()
    try:
        cutoff = datetime.utcnow() - timedelta(minutes=10)
        zombies = (
            db.query(Media)
            .filter(Media.storage_status == "pending")
            .all()
        )
        if not zombies:
            return
        # 시작 시 모든 pending을 failed로 마킹 → 사용자는 재fetch로 재시도 가능
        # (storage_started_at이 오래된 것만 처리하고 싶다면 .filter() 추가)
        n = 0
        for m in zombies:
            m.storage_status = "failed"
            m.storage_error = "server restart during pending - retry needed"
            n += 1
        db.commit()
        logger.info(f"시작 시 좀비 pending 정리: {n}개를 failed로 마킹")
    finally:
        db.close()


_reset_zombie_pending()


app = FastAPI(
    title="Posty Fetch Server",
    description="Instagram 포스트/릴스 콘텐츠 fetch + 영구 저장 API",
    version="0.4.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(posts.router)
app.include_router(media.router)


# ===== 로컬 스토리지 정적 서빙 =====
# STORAGE_BACKEND=local 일 때만 의미가 있음. S3 모드면 mount 안 함.
if settings.storage_backend.lower() == "local":
    storage_dir = Path(settings.local_storage_dir).resolve()
    storage_dir.mkdir(parents=True, exist_ok=True)
    # /static 경로로 노출. settings.local_storage_public_url 이 이 경로를 가리켜야 함.
    app.mount(
        "/static",
        StaticFiles(directory=str(storage_dir)),
        name="static",
    )
    logger.info(f"로컬 미디어 정적 서빙: /static → {storage_dir}")


@app.get("/", tags=["root"])
def root():
    return {
        "service": "posty-fetch-server",
        "version": "0.4.0",
        "docs": "/docs",
        "storage": settings.storage_backend,
    }
