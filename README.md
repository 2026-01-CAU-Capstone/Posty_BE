# Posty

레퍼런스 릴스 1개 + 내 소스 영상 여러 개를 주면, **레퍼런스의 편집 스타일을 따라** 자동 편집된 9:16 영상을 만들어 줍니다.

프런트엔드와 백엔드가 **완전히 분리된** 구조입니다.

## 구조 (모노레포)

```
posty-prototype/
├── frontend/     Vite + React UI  (마법사: 레퍼런스 → 소스 → 옵션 → 생성)
├── backend/      Hono API + in-process 작업 큐 (lib/ 파이프라인을 비동기로 실행)
├── lib/          편집 파이프라인 (Stage 0~4) — backend 가 import 해서 사용
├── assets/fonts/ 자막 burn-in 용 번들 한글 폰트 (gitignore — 스크립트로 설치)
├── ig-fetch/     (선택) Instagram URL → mp4 다운로드 FastAPI 서비스
└── data/projects/{id}/   프로젝트별 산출물 (gitignore)
```

> 프런트는 HTTP 로만 백엔드와 통신합니다 (기본 `http://localhost:8787`, `VITE_API_BASE` 로 변경).

## 파이프라인 (Stage 0~4)

| 단계 | 역할 | 사용 API / 도구 | 산출물 |
|---|---|---|---|
| 0 | 레퍼런스 영상 분석 → 스타일 스펙 | **Gemini 2.5 Pro** (영상 이해 + JSON, 2패스) | `0_spec/edit-spec.json` |
| 1 | 소스 컷편집 (+ 긴 소스 자동 축약) | **FFmpeg scene detect** → **Gemini 3.5 Flash** 묘사(긴 소스는 batch) → **OpenAI embedding** 매칭 → 30~60초 큐레이션 → **FFmpeg** 9:16 cut/concat | `1_cut/cut.mp4` + `edit-plan.json` |
| 2 | 색감 보정 | **FFmpeg signalstats** 측정 → `eq`/`colorbalance` | `2_grade/graded.mp4` |
| 3 | 자막 | **FFmpeg subtitles** (ASS/libass burn-in) | `3_caption/captioned.mp4` |
| 4 | 음성/BGM | **Internet Archive** 자동 BGM (+ 선택: **AudD** 레퍼런스 곡 지문인식) + **Gemini TTS**(선택) + FFmpeg 믹스 | `4_final/final.mp4` |

각 단계는 체크포인트 파일을 남겨서 한 단계만 다시 돌릴 수 있습니다 (`POST /api/run` `mode:'stage'`).

## 설치

필요: **Node 18+**, **FFmpeg/FFprobe** (PATH). Windows full build: https://www.gyan.dev/ffmpeg/builds/

```powershell
# 1) 자막용 한글 폰트 (~150MB, 전부 SIL OFL)
powershell -ExecutionPolicy Bypass -File scripts\install-fonts.ps1

# 2) 백엔드 / 프런트 의존성
cd backend;  npm install
cd ..\frontend; npm install
```

폰트는 시스템 설치가 아니라 `assets/fonts/` 번들을 FFmpeg `subtitles=...:fontsdir=...` 로 로드합니다. (자막 `font_category × font_personality` → [lib/fonts.ts](lib/fonts.ts) 매핑)

## API 키 (repo 루트 `.env.local`)

`.env.example` 을 루트에 `.env.local` 로 복사해서 채웁니다. **백엔드가 루트 `.env.local` 을 읽습니다.**

```
GEMINI_API_KEY=...        # https://aistudio.google.com/apikey   (Stage 0,1,4)
OPENAI_API_KEY=...        # https://platform.openai.com/api-keys (Stage 1 임베딩/축약)
# --- 선택 ---
OPENAI_CHAT_MODEL=gpt-4o-mini   # 긴 소스 축약의 최종 컷 선별
AUDD_API_TOKEN=                 # 레퍼런스 BGM 지문인식 (없으면 vibe 매칭만)
FFMPEG_HWACCEL=                 # scene detect GPU 디코드 (예: d3d11va) — 노트북은 깜빡임 주의
FFMPEG_SCENE_SKIP_NONREF=       # '1' 이면 B프레임 디코드 생략 (CPU 절약)
```

## 실행 (PowerShell 은 `&&` 미지원 → 줄 분리)

```powershell
# 터미널 1 — 백엔드 (:8787)
cd backend
npm run dev

# 터미널 2 — 프런트 (:5173)
cd frontend
npm run dev
# → 브라우저에서 http://localhost:5173

# (IG URL 을 쓸 때만) 터미널 3 — ig-fetch (:8000)
cd ig-fetch
uvicorn app.main:app --port 8000
```

프런트 헤더의 **"백엔드 연결됨"** 초록 배지가 보이면 연결 OK.

## 사용 흐름

1. **레퍼런스**(IG URL 또는 파일) 입력 → "분석 시작하고 다음 →" → 곰돌이 Posty 가 백그라운드에서 레퍼런스를 분석(Stage 0).
2. 분석이 도는 동안 **소스 영상** 추가(파일/IG URL) + **편집 옵션**(자막 언어·빈도, 톤, 키워드 등) 입력.
3. **✨ 영상 생성** → Stage 1~4 실행. 실시간 **퍼센트 + 남은시간(ETA) + Posty 애니메이션**.
4. 완료 → 미리보기 + 다운로드.

## 디렉토리 (`data/projects/{id}/`)

```
reference/  sources/  bgm/        업로드/다운로드 미디어
raw-api-responses.json            모든 API 원본 응답 (디버깅)
0_spec/edit-spec.json             Stage 0
1_cut/{source-shots,edit-plan}.json + cut.mp4
2_grade/{color-stats.json, graded.mp4}
3_caption/{captions.ass, captioned.mp4}
4_final/{bgm-identity.json, tts/, final.mp4}   ← final.mp4 가 최종
tts-config.json  tts-outline.json
```

## 커스터마이즈

- LLM 프롬프트: `lib/prompts.ts` 한 파일.
- 모델 교체: `.env.local` 의 `GEMINI_*_MODEL` / `OPENAI_*_MODEL`.
- 영상 분석/임베딩 제공자 교체: `lib/gemini.ts` / `lib/openai.ts` 호출부.

## 한계

- 컷 경계/하이라이트는 FFmpeg scene detect + LLM 추정 결합 (프레임 정확도는 아님).
- 색 보정은 채도/대비/색온도 단순 매칭 (필름 LUT 등 복합 그레이딩은 미흡).
- 긴 소스는 임베딩 중복제거 + 품질/내러티브 기준으로 **30~60초로 자동 축약**.
- BGM 은 업로드본 우선, 없으면 Internet Archive 무료 음원 검색·매칭 (생성형 아님). 레퍼런스 상용곡은 저작권상 임베드하지 않고 정보/매칭 가이드로만 사용.
- 전환 효과는 단순 cut.
