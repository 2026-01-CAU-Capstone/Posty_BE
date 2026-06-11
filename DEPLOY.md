# Posty 배포 가이드 (백엔드)

이 저장소(**Posty_BE**)는 **백엔드 + 편집 파이프라인 + (선택) ig-fetch** 입니다.
프런트엔드는 별도 저장소 [Posty_FE](https://github.com/2026-01-CAU-Capstone/Posty_FE) — 정적 배포(아래 §3).

백엔드는 **FFmpeg + 분 단위 작업 + 디스크 쓰기**가 필요해 서버리스가 아니라 **상시 실행 컨테이너**로 배포합니다. 가장 단순한 방법은 Docker 한 대를 띄울 수 있는 **VM/VPS 에서 `docker compose`** 입니다(ig-fetch + Postgres 까지 한 번에).

---

## 1. 한 줄 요약 (Docker Compose)

```bash
# 서버(VM)에서
git clone https://github.com/2026-01-CAU-Capstone/Posty_BE.git
cd Posty_BE
cp .env.example .env          # GEMINI_API_KEY / OPENAI_API_KEY 채우기 (필수)
docker compose up -d --build  # backend(:8787) + ig-fetch + postgres
```

- 첫 빌드는 ffmpeg 설치 + 한글 폰트(~150MB) 다운로드로 몇 분 걸립니다.
- 외부로 노출되는 포트는 **backend `:8787`** 하나뿐입니다 (ig-fetch/postgres 는 내부 전용).
- 헬스 체크: `curl http://<서버>:8787/api/health` → `{"ok":true}`

서비스 구성:

| 서비스 | 역할 | 포트 | 영속 볼륨 |
|---|---|---|---|
| `backend` | Hono API + Stage0~4 파이프라인 | 8787 (공개) | `posty_data` → `/app/data` |
| `ig-fetch` | Instagram URL 임포트 (FastAPI) | 내부 8000 | `posty_igstorage` → `/app/storage` |
| `postgres` | ig-fetch 메타 DB | 내부 5432 | `posty_pgdata` |

---

## 2. 환경변수 (`.env`)

`cp .env.example .env` 후 채웁니다 (`.env` 는 `.gitignore` — 커밋되지 않음).

| 변수 | 필수 | 설명 |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Stage 0/1/4 (https://aistudio.google.com/apikey) |
| `OPENAI_API_KEY` | ✅ | Stage 1 임베딩/축약 (https://platform.openai.com/api-keys) |
| `AUDD_API_TOKEN` | — | 레퍼런스 원곡 지문인식 (없으면 vibe 매칭만) |
| `GEMINI_*_MODEL` / `OPENAI_CHAT_MODEL` | — | 모델 교체 시에만 |
| `IG_SESSIONID` (+ `IG_DS_USER_ID`) | — | ig-fetch 로 **사진** Post 까지 받을 때. 릴스(yt-dlp)는 없어도 동작 |

> 키를 안 넣으면 backend 컨테이너가 시작 시 `GEMINI_API_KEY 가 .env 에 필요합니다` 로 멈춥니다.

---

## 3. 프런트엔드 (Posty_FE) — 정적 배포

프런트는 빌드된 정적 파일이라 **Vercel / Netlify / Cloudflare Pages** 등에 올리면 됩니다.

```bash
# Posty_FE 클론 후
npm install
VITE_API_BASE=https://<백엔드-공개주소> npm run build   # dist/ 생성
```

- 빌드 시 `VITE_API_BASE` 를 **위에서 띄운 백엔드 주소**로 지정.
- ⚠️ **Vercel/Netlify(HTTPS)에 올리면 백엔드도 HTTPS 여야 합니다** — HTTPS 페이지가 `http://...:8787` 을 호출하면 브라우저가 mixed-content 로 차단합니다. 백엔드 HTTPS 는 아래 **§5(Caddy 자동 HTTPS)** 참고.
- Vercel/Netlify 라면 프로젝트 환경변수에 `VITE_API_BASE` 를 넣고 `dist/` 를 배포 대상으로.
- 백엔드는 CORS `*` 허용이라 별도 설정 불필요.

---

## 4. 운영 메모

- **영속성**: 산출물(`final.mp4` 등)은 `posty_data` 볼륨에 남습니다. `docker compose down` 만으로는 볼륨이 유지되고, `down -v` 하면 데이터까지 삭제됩니다.
- **자원**: FFmpeg 인코딩이 CPU 를 많이 씁니다. 동시 작업은 `WORKER_CONCURRENCY`(기본 1)로 제한됩니다 — 코어 여유가 있으면 backend 환경변수로 올릴 수 있습니다.
- **로그**: `docker compose logs -f backend` / `... ig-fetch`. 파이프라인 상세 디버그는 backend 환경변수 `FFMPEG_VERBOSE=1`.
- **HTTPS/도메인**: 공개 서비스라면 backend 앞에 리버스 프록시(Nginx/Caddy)로 TLS 종료 권장.
- **단일 컨테이너 PaaS(Render/Railway/Fly) 로 가려면**: 서비스를 backend / ig-fetch 둘로 나눠 각각 이 Dockerfile 로 배포하고, Postgres 는 매니지드 DB 를 붙인 뒤 위 환경변수(`DATABASE_URL`, `IG_FETCH_BASE`, `LOCAL_STORAGE_PUBLIC_URL`)를 같은 의미로 설정하면 됩니다.

---

## 5. 클라우드 VM 프로덕션 — 자동 HTTPS (권장)

프런트(Vercel 등 HTTPS)에서 백엔드를 호출하려면 **백엔드도 HTTPS** 여야 합니다 — HTTPS 페이지가 HTTP API 를 부르면 브라우저가 mixed-content 로 **차단**합니다. 이 저장소는 **Caddy 리버스 프록시**로 도메인 인증서를 자동 발급/갱신하는 프로덕션 오버레이(`docker-compose.prod.yml` + `Caddyfile`)를 제공합니다.

### 사전 준비
1. **VM**: Ubuntu 등 Docker 설치 가능한 VM 1대 (최소 2 vCPU / 4GB RAM 권장, data 디스크 여유).
2. **도메인**: 예 `api.posty.example.com`. 이 도메인의 **A 레코드를 VM 공인 IP** 로 지정. (도메인이 없으면 DuckDNS 같은 무료 서브도메인도 가능.)
3. **방화벽/보안그룹**: 인바운드 **22(SSH) / 80 / 443** 만 열기.

### 실행
```bash
# VM 에서 (Docker 미설치면: curl -fsSL https://get.docker.com | sh)
git clone https://github.com/2026-01-CAU-Capstone/Posty_BE.git && cd Posty_BE
cp .env.example .env
#  .env 에 채우기:
#    GEMINI_API_KEY=...   OPENAI_API_KEY=...
#    DOMAIN=api.posty.example.com     ← A레코드가 이 VM 을 가리켜야 함
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

- Caddy 가 첫 요청 시 Let's Encrypt 인증서를 자동 발급합니다 (80/443 열려 있고 DNS 가 맞아야 함).
- 이 모드에선 **backend 직접 포트(:8787)는 닫히고 Caddy(:443)만 공개**됩니다.
- 확인: `curl https://api.posty.example.com/api/health` → `{"ok":true}`

### 프런트 연결
```bash
# Posty_FE
VITE_API_BASE=https://api.posty.example.com npm run build   # → dist/ 를 Vercel/Netlify 에
```

> 이 구성은 로컬에서 `DOMAIN=localhost`(Caddy internal TLS)로 띄워 `https://localhost/api/health → {"ok":true}` 및 backend 미노출까지 검증했습니다.
