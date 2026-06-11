# ============================================================
# Posty ig-fetch (FastAPI Instagram 다운로드 서비스) 이미지.
#  - yt-dlp 가 일부 포맷에서 ffmpeg 를 필요로 하므로 ffmpeg 포함
#  - Postgres 는 별도 컨테이너(docker-compose) 사용
# build context = ./ig-fetch
# ============================================================
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --timeout 120 --retries 10 -r requirements.txt

COPY . .

# 저장 미디어 위치 (LOCAL_STORAGE_DIR 기본 ./storage). 볼륨 권장.
ENV PORT=8000
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
