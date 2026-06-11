# Posty Fetch Server

Instagram 포스트(사진)/릴스(영상) 콘텐츠를 fetch하고, 미디어를 **로컬 또는 S3에 영구 저장**하는 FastAPI 서버입니다.

## 핵심 변경 사항 (v0.4)

| 버전 | 추가 사항 |
|------|----------|
| v0.1 | 초기 yt-dlp 기반 (Reels만 안정, 사진 Post 실패) |
| v0.2 | **쿠키 인증 + IG-web fallback** → 사진 Post fetch 가능 |
| v0.3 | **미디어 영구 저장 (Local / S3)** + cleanup 스크립트 + 수동 삭제 API |
| v0.4 | **하이브리드 저장 타이밍** (사진 동기 / 영상·캐러셀 백그라운드) + 상태 폴링 API |
| v0.4.1 | **좀비 작업 자동 정리** + 자동 재시도 (캐시 히트 시) + 명시적 재시도 엔드포인트 |

---

## 1. 빠른 시작

### 1-1. PostgreSQL + 의존성
```bash
docker compose up -d
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # IG_COOKIES_FILE 또는 IG_SESSIONID 입력
uvicorn app.main:app --reload
```

확인:
- API 문서: <http://localhost:8000/docs>
- 헬스: <http://localhost:8000/health>

---

## 2. IG 쿠키 설정 (사진 Post fetch에 필수)

### 방식 A — `cookies.txt` 파일 (권장)
1. Chrome/Edge에 **"Get cookies.txt LOCALLY"** 확장 설치
2. 더미 IG 계정으로 `instagram.com` 로그인
3. 확장 → Export As → `cookies.txt`
4. `.env`: `IG_COOKIES_FILE=/path/to/ig_cookies.txt`

### 방식 B — `sessionid` 직접
1. 로그인 → DevTools (F12) → Application → Cookies
2. `sessionid`, `ds_user_id` 복사
3. `.env`:
   ```ini
   IG_SESSIONID=43215678901%3AabcDEF12...
   IG_DS_USER_ID=43215678901
   ```

팁:
- 쿠키 추출에 사용한 브라우저 UA를 `IG_USER_AGENT`에도 같이 넣을 것
- 새 IG 계정은 만들자마자 쓰지 말고 하루 정상 사용 후 추출

---

## 3. 미디어 저장 — 하이브리드 동작

### 3-1. 저장 타이밍

| 콘텐츠 유형        | 저장 방식 | 응답에서 받는 것 |
|--------------------|-----------|----------------|
| 사진 1장           | **동기**  | `stored_url` 즉시 포함, `storage_pending=false` |
| 릴스 (영상)        | **백그라운드** | `stored_url=null`, `storage_pending=true` |
| 캐러셀 (≥2장)      | **백그라운드** | `stored_url=null`, `storage_pending=true` |

이유: 대부분의 포스트는 사진 1장이라 응답 전에 끝내는 게 UX 좋고, 영상·캐러셀은 다운로드가 길어서 응답 막으면 곤란.

### 3-2. 백엔드 모드

| 모드     | `.env`                                                        |
|----------|---------------------------------------------------------------|
| **로컬** | `STORAGE_BACKEND=local` (기본). `./storage/`에 저장, `/static/...`로 서빙 |
| **S3**   | `STORAGE_BACKEND=s3` + `S3_BUCKET`, `S3_REGION`, ...           |
| 저장 안 함 | `STORAGE_BACKEND=none`                                       |

S3 설정 예시 (.env):
```ini
STORAGE_BACKEND=s3
S3_BUCKET=my-posty-media
S3_REGION=ap-northeast-2
S3_PREFIX=media
S3_PUBLIC_URL_BASE=https://d123abc.cloudfront.net   # 선택
```

---

## 4. API

### 4-1. POST /posts/fetch

```bash
curl -X POST http://localhost:8000/posts/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.instagram.com/p/XXXXX/"}'
```

응답 — **사진 1장 케이스** (동기 저장 완료):
```json
{
  "ig_shortcode": "XXXXX",
  "content_type": "post",
  "from_cache": false,
  "storage_pending": false,
  "storage_overall": "completed",
  "media_items": [{
    "order_index": 0,
    "media_type": "image",
    "source_url": "https://scontent...",
    "proxy_url": "http://localhost:8000/media/proxy?url=...",
    "stored_url": "http://localhost:8000/static/XXXXX/0.jpg",
    "storage_status": "completed",
    "stored_size_bytes": 184320,
    "stored_at": "2026-05-21T12:34:56"
  }]
}
```

응답 — **릴스/캐러셀 케이스** (백그라운드 큐잉됨):
```json
{
  "ig_shortcode": "YYYYY",
  "content_type": "reel",
  "from_cache": false,
  "storage_pending": true,
  "storage_overall": "pending",
  "media_items": [{
    "order_index": 0,
    "media_type": "video",
    "source_url": "https://scontent...",
    "proxy_url": "...",
    "stored_url": null,
    "storage_status": "pending"
  }]
}
```

### 4-2. GET /posts/{shortcode}/storage-status (폴링용)

`storage_pending=true` 받았으면 1~3초 간격으로 폴링:

```bash
curl http://localhost:8000/posts/YYYYY/storage-status
```

진행 중:
```json
{
  "shortcode": "YYYYY",
  "overall": "pending",
  "total": 4,
  "counts": {"completed": 2, "pending": 2, "failed": 0, "skipped": 0},
  "items": [
    {"order_index": 0, "media_type": "image", "status": "completed", "stored_url": "...", "error": null},
    {"order_index": 1, "media_type": "image", "status": "completed", "stored_url": "...", "error": null},
    {"order_index": 2, "media_type": "image", "status": "pending", "stored_url": null, "error": null},
    {"order_index": 3, "media_type": "image", "status": "pending", "stored_url": null, "error": null}
  ]
}
```

완료:
```json
{ "overall": "completed", "counts": {"completed": 4, ...}, ... }
```

`overall` 값:
- `completed` — 모두 성공
- `pending` — 진행 중
- `failed` — 모두 실패
- `partial` — 일부 성공 + 일부 실패 (재시도는 `force_refresh=true`로 다시 fetch)
- `skipped` — 저장 비활성화 상태

### 4-3. 프론트엔드 사용 패턴

```javascript
async function fetchPost(url) {
  // 1. fetch
  const r = await fetch('/posts/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  let post = await r.json();

  // 2. 동기 케이스는 이미 stored_url 있음
  if (!post.storage_pending) return post;

  // 3. 백그라운드 케이스: 폴링
  while (post.storage_overall === 'pending') {
    await new Promise(r => setTimeout(r, 2000));
    const s = await fetch(`/posts/${post.ig_shortcode}/storage-status`).then(r => r.json());
    if (s.overall !== 'pending') {
      // 최종 상태로 다시 fetch
      post = await fetch(`/posts/${post.ig_shortcode}`).then(r => r.json());
      break;
    }
  }
  return post;
}
```

### 4-4. 어떤 URL을 쓸까

| 필드          | 용도 |
|---------------|------|
| `stored_url`  | **권장**. 영구. S3/로컬. `storage_status='completed'`일 때만 유효. |
| `proxy_url`   | 보조. IG CDN 만료 전까지만 동작. 동기 케이스에서는 불필요. |
| `source_url`  | 원본. 디버깅용. 외부에서 직접 쓰면 403/만료. |

### 4-5. 재시도

저장이 실패한 미디어가 있을 때:

**자동 재시도** — 같은 URL을 다시 `POST /posts/fetch` 하면 캐시 히트 + 실패 항목 자동 큐잉.

**명시적 재시도** — fetch 없이 기존 미디어만 다시 시도:
```bash
curl -X POST http://localhost:8000/posts/{shortcode}/retry
```
응답은 `storage-status`와 동일한 형식 (`overall=pending`으로 바뀜).

주의: IG CDN URL은 시간이 지나면 만료됩니다. fetch 후 너무 오래 지났다면 `force_refresh=true`로 새 fetch가 필요할 수 있습니다.

### 4-6. 삭제

```bash
# 저장된 미디어만 삭제 (메타데이터 보존)
curl -X DELETE http://localhost:8000/posts/XXXXX/media
```

자동 정리 (cron):
```cron
0 4 * * * cd /app && /app/.venv/bin/python -m scripts.cleanup_expired_media
```
`MEDIA_RETENTION_DAYS=7` 보다 오래된 **completed** 항목만 삭제. `failed`는 재시도 여지로 보존.

---

## 5. 에러 코드

| HTTP | 의미 |
|------|------|
| 400  | IG URL 형식 오류 |
| 401  | 쿠키 미설정/만료 |
| 403  | 비공개 콘텐츠 |
| 404  | 콘텐츠 없음 |
| 502  | yt-dlp/IG fetch 실패 |

미디어 저장 실패는 200 응답 + 해당 항목 `storage_status='failed'` 로 표현됨.

---

## 6. 디렉토리 구조

```
app/
├── core/{config,database}.py
├── models/post.py             # Post, Media (+ storage_status, ...)
├── schemas/post.py            # PostResponse, StorageStatusResponse
├── services/
│   ├── fetcher.py             # yt-dlp + IG web fallback
│   ├── storage.py             # Local/S3/Noop 추상화
│   ├── post_service.py        # ★ 하이브리드 분기 + 백그라운드 작업
│   └── url_parser.py
├── routers/
│   ├── posts.py               # /posts/* + /posts/{sc}/storage-status
│   ├── media.py               # /media/proxy
│   └── health.py
└── main.py                    # /static mount + auto migration
scripts/
├── seed_demo_urls.py
└── cleanup_expired_media.py   # cron용
```

---

## 7. 배포 (EC2/ECS + S3)

1. Task Role: `s3:PutObject` `s3:DeleteObject` `s3:HeadObject` 권한
2. `.env`:
   ```ini
   STORAGE_BACKEND=s3
   S3_BUCKET=my-posty-media
   S3_REGION=ap-northeast-2
   S3_PREFIX=media
   MEDIA_RETENTION_DAYS=7
   ```
3. CloudFront 앞단 → `S3_PUBLIC_URL_BASE`에 도메인 입력
4. cron / EventBridge로 `cleanup_expired_media.py` 매일 실행
5. **S3 Lifecycle Rule** 도 함께 설정 (이중 안전망): `media/` 14일 후 자동 삭제

**FastAPI BackgroundTasks 주의점**: 워커가 재시작되면 진행 중인 작업은 손실됩니다.
규모가 커지면 Celery + Redis로 옮기는 게 좋고, 그 전까지는 `force_refresh=true`로 재시도하면 됩니다.

---

## 8. 알려진 한계

- BackgroundTasks는 단일 프로세스 안에서만 동작. **서버 재시작 시 진행 중이던 pending 작업은 시작 시 자동으로 `failed`로 마킹**되어, 사용자는 자동 재시도(같은 URL 재요청) 또는 명시적 재시도(`POST /posts/{sc}/retry`)로 복구 가능.
- 분당 수십~수백 요청 규모로 커지면 **Celery + Redis**로 옮기는 게 좋음. `store_post_media_in_background(post_id)`는 task-friendly 시그니처라 마이그레이션 비용이 작음 — `@celery_app.task` 데코레이터 + 호출부 `.delay()`만 추가.
- IG 쿠키가 차단되면 즉시 fetch 실패. 운영 규모 시 IP 로테이션 또는 IG Graph API 고려.
- IG의 web JSON 응답 포맷이 바뀌면 `fetcher._fetch_via_ig_web`의 두 분기 중 하나 수정 필요.
