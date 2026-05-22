"""
SQLAlchemy 엔진 / 세션 / Base 정의.
get_db()는 FastAPI Depends에서 사용하는 세션 제너레이터.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from app.core.config import settings


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,  # stale connection 자동 폐기
    future=True,
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
    future=True,
)

Base = declarative_base()


def get_db():
    """FastAPI Depends용 DB 세션 제공자."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
