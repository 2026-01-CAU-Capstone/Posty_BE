# ============================================================
# Posty 백엔드 (Hono + lib/ Stage0~4 파이프라인) 이미지.
#  - ffmpeg/ffprobe (모든 단계의 영상 처리)
#  - 자막용 한글 OFL 폰트 번들 (빌드 시 다운로드 → assets/fonts)
#  - tsx 로 TypeScript 직접 실행 (별도 빌드 단계 없음)
# build context = repo 루트 (backend 가 ../../lib, assets/fonts 를 사용하므로).
# ============================================================
FROM node:20-slim

# ffmpeg + 폰트 캐시 + 다운로드 도구
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg fontconfig ca-certificates curl bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) 백엔드 의존성만 먼저 복사 → 레이어 캐시
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci

# 2) 나머지 소스 (lib, scripts, assets, ig-fetch 등). .dockerignore 로 data/·node_modules 제외.
COPY . .

# 3) 한글 폰트 번들 다운로드 (assets/fonts 는 gitignore 라 빌드 시 받는다)
RUN bash scripts/install-fonts.sh

ENV NODE_ENV=production \
    BACKEND_PORT=8787 \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe
EXPOSE 8787

# server.ts 가 cwd 를 repo 루트(/app)로 chdir 하고 data/ 에 산출물을 쓴다 → /app/data 볼륨 권장.
WORKDIR /app/backend
CMD ["npm", "run", "start"]
