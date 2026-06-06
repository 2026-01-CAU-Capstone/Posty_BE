# Posty — 프로젝트 정리 (read.md)

레퍼런스 릴스 1개의 **편집 스타일** 을 분석해서, 내 소스 영상 여러 개를 그 스타일대로 자동 편집해 9:16 영상을 만들어 주는 도구.

이 문서는 지금까지의 작업물을 한 번에 훑기 위한 종합 정리본. 세부 운영 가이드는 [README.md](README.md), 파이프라인 다이어그램은 [PIPELINE.md](PIPELINE.md).

---

## 1. 모노레포 구성

```
posty-prototype/
├── frontend/           Vite + React UI (마법사: 레퍼런스 → 소스 → 분석 → 옵션 → 편집 → BGM → 완성)
├── backend/            Hono API + in-process job queue (lib/ 파이프라인을 비동기로 실행)
├── lib/                편집 파이프라인 (Stage 0~4) — backend가 import해서 사용
│   └── stages/         stage0.ts ~ stage4.ts
├── assets/fonts/       자막 burn-in용 번들 한글 폰트 (39종, gitignore — install-fonts.ps1로 설치)
├── ig-fetch/           (선택) Instagram URL → mp4 다운로드 FastAPI 서비스 (Python)
├── scripts/            install-fonts.ps1
└── data/projects/{id}/ 프로젝트별 산출물 (gitignore)
```

**프로세스 분리:**
- frontend (`:5173`, Vite) ─ HTTP only ─→ backend (`:8787`, Hono)
- backend ─ (선택) ─→ ig-fetch (`:8000`, FastAPI)
- backend ─→ Gemini / OpenAI / Internet Archive / AudD (외부 API)
- backend ─→ FFmpeg / FFprobe (로컬 바이너리, PATH)

frontend는 HTTP로만 backend와 통신. `VITE_API_BASE`로 주소 변경 가능.

---

## 2. 백엔드 (Hono + in-process queue)

### 2.1 진입점
[backend/src/server.ts](backend/src/server.ts) — cwd를 repo 루트로 고정 → `.env.local` 로드 → 그 **후** 동적으로 [app.ts](backend/src/app.ts) import. (lib/config가 import 시점에 process.env를 읽으므로 순서가 중요.)

### 2.2 HTTP 엔드포인트 ([backend/src/app.ts](backend/src/app.ts))

| Method | Path | 역할 |
|---|---|---|
| GET  | `/api/health` | 헬스 |
| POST | `/api/projects` | 새 projectId 생성 + 디렉토리 부트스트랩 |
| POST | `/api/upload` | multipart 파일 업로드 (`projectId`, `kind=reference\|source\|bgm`, `file[]`) |
| POST | `/api/ig-import` | IG URL 임포트 (ig-fetch 서비스 경유) |
| GET  | `/api/project` | 프로젝트 상태 (uploads, stages, spec/plan summary, 산출물 경로) |
| GET  | `/api/file` | 산출물 파일 서빙 (Range 지원, `data/projects/` 밑만 허용) |
| POST | `/api/run` | 파이프라인 실행 (`mode:'all'` from~to, 또는 `mode:'stage'` stage) → jobId 반환 |
| GET  | `/api/jobs/:id` | job 상태 + progress 배열 polling |
| GET  | `/api/estimate` | 보수적 처리시간 예측 (초). `SAFETY=1.6` 으로 과대 추정 |
| **GET**  | **`/api/raw-responses`** | **`raw-api-responses.json` 누적 엔트리 반환 (`limit` 쿼리). 프론트 디버그 로그 패널이 사용** |
| **GET/POST**  | **`/api/style-suggest`** | **Stage 0.5 — Stage 0 끝난 뒤 옵션 자동 추천 캐시 조회/생성. POST `{force:true}` 면 재생성** |
| POST | `/api/style-note` | 자유 스타일 노트 저장 |
| POST | `/api/style-brief` | 구조화된 스타일 브리프 저장 |
| POST | `/api/tts-config` | TTS 설정 저장 (`enabled` / `source:captions\|generate` / `genMode:auto\|manual` / `voice` / `script`) |
| POST | `/api/audio-config` | 오디오 밸런스 저장 (`originalVolume:mute\|low\|full`) — 기본 mute(음원만) |
| GET  | `/api/edit-spec` | 레퍼런스 분석 결과(edit-spec.json) 전체 반환 — 디버그 뷰어용 |

TTS 나레이션은 별도 confirm API 없이 Stage 4 직전 `prepareNarrationOutline`([lib/narration.ts](lib/narration.ts))이 `tts-config` 의 source/genMode 를 보고 segments 를 생성·합성한다 (옵션 선택이 곧 승인).

### 2.3 작업 큐 ([backend/src/queue.ts](backend/src/queue.ts))

경량 in-process 큐 (메모리). 무거운 파이프라인을 HTTP 요청 경로 밖에서 실행해 30분 타임아웃·요청 블로킹을 회피.

```
createJob(type, projectId, params)
  → jobs.set(id, job)
  → pendingQueue.push(id)
  → pump()  // CONCURRENCY 이하면 runOne() 호출
```

- `CONCURRENCY = WORKER_CONCURRENCY` (기본 1) — ffmpeg CPU 폭주 방지
- 진행상황은 메모리에만 보관, 프론트가 `jobId`로 polling
- 프로세스 재시작 시 휘발 (MVP)

### 2.4 Job runner ([backend/src/pipeline.ts](backend/src/pipeline.ts))

job.type에 따라 분기:
- `stage`: 지정한 stage 1개만 실행
- `run_all`: `from`~`to` 범위 순차 실행 (보통 1~4. Stage 0은 별도 stage job으로 미리 실행)

각 stage 시작/종료마다 `progress()`로 보고 → 프론트가 polling으로 표시.

### 2.5 처리 시간 예측 ([backend/src/estimate.ts](backend/src/estimate.ts))

업로드된 레퍼런스/소스 길이 + 소스 개수로 stage별 초를 추정. **`SAFETY=1.6`** 으로 과대 추정 — "왜 이렇게 오래 걸려?" 보다 "예상보다 빨리 끝났네!" 가 UX 좋아서 의도적.

```
s0 = 90  + 1.6 * refDur                  // 레퍼런스 분석 (Pro 2패스 업로드 + OCR)
s1 = 40  + 4.0 * srcDur + 18 * nSources  // 디코드 + Gemini per source + 렌더
s2 = 20  + 2.0 * outDurEst               // 색보정
s3 = 20  + 1.6 * outDurEst               // 자막
s4 = 50  + 2.4 * outDurEst               // BGM 다운로드 + 믹스
```

`outDurEst = max(8, min(srcDur, 75))` — 컷 4.5s 캡 + 30~60s 축약 정책 반영.

---

## 3. 파이프라인 (lib/stages/) — Stage 0~4

각 stage는 `data/projects/{pid}/N_xxx/` 에 산출물을 남겨 **체크포인트**가 된다 → 한 stage만 다시 돌릴 수 있음.

### 3.1 Stage 0 — 레퍼런스 분석 ([lib/stages/stage0.ts](lib/stages/stage0.ts))

| 항목 | 내용 |
|---|---|
| 입력 | `reference/*.mp4` + `style-note.txt` |
| API | Gemini 2.5 Pro `generateContent` (영상 입력, 2패스) |
| 출력 | `0_spec/edit-spec.json` |
| 예상 | 1~3분 |

**로직:**
1. `analyzeVideoStructured()` 1차 — 메인 분석 (컷·색감·오디오·텍스트 종합). Pro 429/5xx → Flash 폴백.
2. `analyzeVideoStructured()` 2차 — 텍스트 전용 (한글 OCR 보강). `mergeTextFocusedIntoSpec()`로 `shots[].caption_layers` / `caption_pattern` 덮어쓰기.
3. `normalizeShot()` — index/start/end/duration/shot_type/subject/scene_description/composition/camera_motion/transition_to_next/caption_layers/required_tags 정규화.
4. `normalizeLayer()` — text가 빈 layer도 보존 (스타일 정보용). 기본 필드(position·align·size·color·emphasis·italic·font_category·font_personality·role·tone) + **디자인 필드 전부 보존** (`preserveLayerDesign`: outline·shadow·background_box·gradient·glow·letter_spacing·entry_animation). ⚠ 예전엔 여기서 디자인 필드를 버려 레퍼런스 자막 "형식 복사"가 안 됐다 — 렌더러(caption-ass)는 다 지원하는데 normalize 가 중간에서 누락. Stage 1 `normalizeLayers` 도 동일하게 보존하도록 수정. `CaptionLayer` 타입은 caption-ass 와 단일 소스로 통일.
5. **`stripWatermarkLayers()` — 워터마크/지속 오버레이 제거 (근본 차단).** 출처 핸들·계정명·워터마크·구독 안내처럼 영상 콘텐츠가 아니라 운영용으로 고정된 텍스트를 `shots[].caption_layers` 에서 통째로 제거. caption planning 의 LLM 판단에만 맡기지 않고 spec 단계에서 차단. 제거 시 `raw-api-responses.json` 에 `kind: "watermark_stripped"` 기록.
   - 판정 3신호: (1) 키워드 (`@handle`, URL, `출처`/`credit`, `follow`/`subscribe`/`구독`/`팔로우`, `#해시태그` 단독) (2) **코너(top\|bottom + left\|right) + (작은 크기 \| label/decoration 역할)** — 전형적 워터마크 위치 (3) 거의 모든 컷에 동일 텍스트 반복 + 형태 신호 + 박스 없음 → 지속 오버레이
   - 보존: 중앙·큰 글씨·박스 배경 hook 은 가게명이 들어가도 콘텐츠로 보고 유지 (반복만으로는 제거 안 함)

**스펙 스키마 (edit-spec.json):**
```ts
{
  duration, aspect_ratio, pacing,
  shots: [ { index, start, end, duration, shot_type, subject, scene_description,
             composition, camera_motion, transition_to_next, caption_layers[], required_tags } ],
  color_style, audio_profile, caption_global_style, caption_pattern
}
```

### 3.1.5 Stage 0.5 — 옵션 자동 추천 ([lib/style-suggest.ts](lib/style-suggest.ts))

> Stage 0 → Stage 1 사이에 호출되는 **선택적** 단계. 프론트가 `waiting` 화면에서 자동 트리거.

| 항목 | 내용 |
|---|---|
| 입력 | `0_spec/edit-spec.json` (요약) + 사용자 styleNote |
| API | **OpenAI Chat (`gpt-4o-mini`, `response_format: json_object`)** |
| 출력 | `style-suggest.json` (캐시) — `{ summary, analysis, brief, generated_at, model }` |
| 예상 | 1~3초 |

**왜 OpenAI 인가:**
Gemini 2.5/3 Flash 는 thinking 모델이라 `maxOutputTokens` 안에 추론 토큰이 같이 잡혀, 1K~2K 정도 작은 한도에서는 추론만 하다 응답이 잘리는 사례 발생. OpenAI `gpt-4o-mini` + `json_object` 모드는 잘림/파싱 실패가 거의 없어서 단순 요약 + 옵션 enum 추천에 더 적합.

**산출 스키마:**
```ts
{
  summary: string,              // 마스코트 한 줄 — "아 ~~한 분위기의 릴스를 올리셨군요!" 톤
  analysis: {                   // 항목별 상세 분석 (무드·편집 리듬·색감·자막·오디오·소재 등)
    label: string,              // 예: "무드", "편집 리듬", "색감", "자막 스타일", "오디오", "소재"
    detail: string,             // 1~2 문장 설명
  }[],
  brief: {
    tone: string,               // "발랄한" / "잔잔한" / ...
    purpose: string,            // "카페 홍보" / "여행 vlog" / ...
    topic_keywords: string[],   // 5~10개 한국어 키워드 (영상 주제·소재·분위기)
    must_include_phrases: string[],  // 0~3개 짧은 한국어 문구
    caption_language: 'ko' | 'en' | 'mixed' | '',
    caption_density: 'every_cut' | 'most_cuts' | 'occasional' | 'minimal' | 'none' | '',
  },
}
```

프론트의 옵션 단계는 받은 `brief` 로 태그 풀을 미리 채워두고 (활성 표시), 사용자가 클릭으로 토글하거나 `+ 추가` 로 새 태그를 만들 수 있다. `summary` 는 옵션 화면 상단 마스코트 말풍선으로, `analysis` 는 그 아래 "분석 내용 자세히 보기" 접이식 목록으로 표시. (구버전 캐시는 `analysis` 가 없을 수 있어 `readStyleSuggest` 가 `[]` 로 정규화)

### 3.2 Stage 1 — 컷편집 ([lib/stages/stage1.ts](lib/stages/stage1.ts))

| 항목 | 내용 |
|---|---|
| 입력 | `0_spec/edit-spec.json` + `sources/*` |
| API | FFmpeg scene detect → Gemini Flash (멀티파트) → OpenAI embedding → Gemini Flash (caption planning) |
| 출력 | `1_cut/source-shots.json` + `edit-plan.json` + `cut.mp4` |
| 예상 | 소스 1개당 30초~1분 (fast path) |

**핵심 정책:**
- 모든 source shot을 한 컷씩 사용 (ref 길이에 매이지 않음)
- 각 source shot은 가장 잘 어울리는 ref shot에서 **STYLE만** 빌려옴 (caption 텍스트·위치·크기·색·굵기·transition)
- source 정렬: 업로드 순서 그대로 (영상 N 안에서는 시간순)
- 한 컷 최대 길이 `MAX_CUT_DUR = 4.5s`, highlight 중심으로 자름
- 추정 출력이 `TARGET_MAX_SEC=60s` 초과 → `source-reduce.ts`로 30~60초 축약

**단계별 흐름:**

1. **scene detect** (각 소스 영상) — `detectShots(file, 0.22)` → 시간 경계 배열
2. **shot 묘사 (fast path)** ([lib/stages/stage1.ts:317-484](lib/stages/stage1.ts:317)):
   - 각 shot 중간 시점 키프레임 1장(.jpg, 가로 720) + 전체 오디오(.mp3 mono/24kHz/48kbps) 추출
   - Gemini Flash에 `(image[N] + audio + prompt)` 멀티파트 호출 → `analyzeMultiPartStructured()`
   - 풀 영상 업로드 대비 페이로드 **1/10~1/50**
   - shot 수 > `SINGLE_CALL_SHOT_MAX=150` 이면 `SOURCE_SHOT_BATCH=120` 단위 batch (batch 모드는 audio도 구간만, 인덱스 정합 위해 풀영상 폴백 끔)
   - 폴백 사다리: **multipart Flash → multipart Pro → 풀 영상 Pro → 로컬 기본값**
   - 정지 이미지 (`.jpg/.png/...`) → scene detect 생략, 단일 still shot으로 처리 (Ken Burns 모션)
3. **임베딩** — `embedTexts(srcEntries)` (OpenAI `text-embedding-3-small`, batch=256)
4. **긴 소스 축약** ([lib/source-reduce.ts](lib/source-reduce.ts)) — 추정 출력이 60s 초과일 때만:
   - 결정론 백본: low quality 제거 + cosine ≥ 0.92 중복 제거
   - 남은 합이 60s 이하 → 시간순 유지
   - 초과 → OpenAI `gpt-4o-mini`로 최종 컷·순서 선별 (실패 시 quality greedy)
5. **ref 임베딩** + **매칭** — 각 src shot마다 cosine + shot_type bonus(0.2)로 best ref 선택
6. **caption planning** ([lib/stages/stage1.ts:655-744](lib/stages/stage1.ts:655)) — `planCaptions()`:
   - 입력: ref layers + caption_pattern + cut 정보 (spoken/desc/shot_type) + styleBrief + styleNote
   - Gemini Flash text-only, temperature 0.5
   - 출력: 각 cut의 `planned_caption_layers[]`
   - `caption_language` 검증 실패(한/영/혼합) → 자동 1회 재시도 (temperature 0.35 + 강한 지시문)
   - `caption_mode` (none/per_scene/continuous) + `caption_density` (every_cut/most_cuts/occasional/minimal/none) 사후 enforcing
   - **메타 자막 무시 정책** — 프롬프트 [⚠ ref 자막 중 "영상 콘텐츠와 무관한 메타" 제외] 섹션. 6개 패턴:
     (a) 출처/크레딧 (`출처:`, `by @`, `Credit`) (b) 음악/BGM 정보 (`♪ Title - Artist`)
     (c) SNS 핸들/해시태그 단독 (d) 광고/쿠폰/홍보 (e) 워터마크형 가게·브랜드·URL
     (f) 페이지/날짜 헤더 (`1/5`, `Day 3`, `EP.02`). 한 layer 에 콘텐츠+메타 섞이면 콘텐츠만 추출
   - **size_level 강제 복사** — 프롬프트 4-bis 작성 지침: `matched_ref_layers` 의 `size_level` 을 그대로 카피, 임의 small 폴백 금지. 렌더 단계 fit 이 폰트만 줄임
7. **렌더** (FFmpeg, [lib/stages/stage1.ts:975-1082](lib/stages/stage1.ts:975)):
   - 영상 소스: `-ss → trim → scale(+8px) → crop(9:16, subject_center 기반)` → **punch-in 줌**(zoom>1 이면 가운데 추가 crop+scale) → 세그먼트 mp4
     - `zoom` 은 ref shot_type 기반 (`zoomForShotType`: close_up 1.30 / product 1.25 / selfie 1.15 / medium 1.12 / 그 외 1.0, 화질 위해 최대 1.3). edit-plan item 에 저장.
   - 이미지 소스: `-loop 1 -i img -f lavfi -i anullsrc` + zoompan (인덱스로 순환: zoom_in / pan_right / zoom_out / pan_left / ken_burns_diagonal, subject 위치 기반 보정)
   - 모든 세그먼트 → `concat demuxer` → `cut.mp4`

**edit-plan.json items 스키마:**
```ts
{
  ref_index, ref_caption_layers[], ref_transition,
  source_video_id, source_filename, source_shot_index,
  source_start, source_end, source_spoken_text, source_scene_description,
  source_shot_type, source_has_speech,
  output_start, output_end,
  match_score, match_reason,
  subject_center_x, subject_center_y,
  planned_caption_layers[]   // ← Stage 3가 이걸로 burn-in
}
```

### 3.3 Stage 2 — 색 보정 ([lib/stages/stage2.ts](lib/stages/stage2.ts))

| 항목 | 내용 |
|---|---|
| 입력 | `1_cut/cut.mp4` + `0_spec/edit-spec.json` + reference 영상 |
| API | 외부 API 없음 (로컬 FFmpeg) |
| 출력 | `2_grade/color-stats.json` + `graded.mp4` |
| 예상 | 10~30초 |

**로직:**
1. `measureSignalStats(ref)` + `measureSignalStats(cut)` 병렬 — `signalstats` 로 YAVG / YSTDDEV / SATAVG 측정
2. `computeTransform(ref, cut, hint)`:
   - brightness: `(ref.yavg - cut.yavg) / 128 * 0.6` (과보정 방지, ±0.3 클램프)
   - contrast: `ref.ystddev / cut.ystddev` (0.7~1.4 클램프)
   - saturation: `ref.satavg / cut.satavg` (0.6~1.8 클램프)
   - spec.color_style 힌트 추가 적용 (vivid/muted, high/low contrast, bright/dark, warm/cool)
   - 색온도(`rs`/`bs`)는 hint 위주
3. 적용: `eq=brightness=...:contrast=...:saturation=...:gamma=1.0[,colorbalance=rs=...:gs=...:bs=...]`

### 3.4 Stage 3 — 자막 burn-in ([lib/stages/stage3.ts](lib/stages/stage3.ts))

| 항목 | 내용 |
|---|---|
| 입력 | `2_grade/graded.mp4` + `edit-plan.items[].planned_caption_layers` |
| API | FFmpeg `subtitles` 필터 (libass) |
| 출력 | `3_caption/captions.ass` + `captioned.mp4` |
| 예상 | 10~30초 |

**로직:**
0. **인라인 색 (`color_runs`)** — 한 자막 안에서 색이 중간에 바뀌면(예: "오늘 [특가] 세일") `color_runs[{text,color_hex}]` 로 분석·보존, 렌더 시 grapheme 단위로 ASS `\1c` 인라인 색 적용 (wrap 줄바꿈에도 비공백 문자 순서로 정확히 매핑).
0-bis. **자막 세로 위치** — 분석에서 `vertical_ratio(0~1)` 를 뽑아 그 비율 그대로 배치(`placeLayers` 가 고정 마진 스냅 대신 `y=ratio×1920`). top/center/bottom 3단계로 뭉개지던 정형화 해소. `vertical_ratio` 가 없을 때만 `subject_center_y` 기반(주체 반대편) 또는 거친 position 폴백.
1. cut별 layers 결정 — `planned_caption_layers` 우선, 없으면 `ref_caption_layers` 폴백
2. layers 총합 0이면 video stream을 그대로 copy
3. 그 외: `buildCaptionAss(cuts, globalStyle)` ([lib/caption-ass.ts](lib/caption-ass.ts)) — 단일 .ass 문서 생성
4. FFmpeg: `subtitles='captions.ass':fontsdir='<rel>'` (cwd=stage3, 상대경로/forward-slash로 Windows 드라이브 콜론 escaping 회피)

**ASS로 표현하는 것 (풀 활용):**
- 폰트/크기/굵기/이탤릭
- 글자색 / 외곽선색 / 그림자(back)색
- 외곽선 두께, 그림자 오프셋·방향
- 불투명 박스 배경 (`BorderStyle=3`)
- 글로우 근사 (`\blur` + outline color)
- 자간 (`Spacing`)
- 등장 애니메이션 (layer별 fade/slide/pop)
- 위치/정렬, 멀티 layer 수직 스택 (충돌 회피)

**폰트 매핑** ([lib/fonts.ts](lib/fonts.ts)):
- 39종 한글 OFL 폰트 번들 (assets/fonts/)
- `pickBundledFont(category × personality × emphasis)` → ASS Fontname
- **같은 (category, personality) 면 항상 같은 폰트 (풀의 첫 폰트 고정)** — 영상 내 일관성. layerIndex 분기 제거됨
- `emphasis='black'` 또는 `emphasis='bold' + bold_impact/retro/display_decorative` personality → **heavy 폰트 우선** (BlackHanSans / DoHyeon / Jua). ASS 의 인공 굵기 대신 family 로 굵기 표현
- 풀 미스 → OS 기본 한글 폰트 폴백

**ASS 빌더 정확도 정책** ([lib/caption-ass.ts](lib/caption-ass.ts)):
- **글자 크기 위계 보존** — LLM 의 `size_level` 우선. `autoSizeLevel(text)` 의 강제 덮어쓰기 제거. ref 가 huge 면 글자수 무관 huge 유지, fit 안 되면 같은 size_level 안에서 폰트만 축소
- **SIZE_PT 상향** — `huge: 200pt` (화면 높이의 ~10%), `large: 140`, `medium: 96`, `small: 64`. 이전 풀 (`huge=132`) 은 ref 의 임팩트 사이즈 대비 작아 보임
- **외곽선/그림자/박스 padding 모두 fontSize 비례** — `OUTLINE_RATIO = {thin: 0.035, medium: 0.065, thick: 0.105}` × fontSize. 큰 자막에는 굵은 외곽선, 작은 자막에는 얇은 외곽선
- **maxLines = 2 통일** — 이전 size 별 2~3 비대칭 (small/medium 3줄) 으로 3단 강제되던 케이스 제거
- **인접 layer 수직 gap** — 평균 fontSize × 42%, 최소 28px (이전 고정 34px)

### 3.5 Stage 4 — 음성/BGM/TTS ([lib/stages/stage4.ts](lib/stages/stage4.ts))

| 항목 | 내용 |
|---|---|
| 입력 | `3_caption/captioned.mp4` + (선택) `bgm/` + `edit-spec.json` + `edit-plan.json` + `audio-config.json` + `tts-config.json` |
| API | Internet Archive Audio (BGM 자동), AudD (BGM 지문인식, 선택), Gemini TTS preview (TTS 활성 시), OpenAI chat (TTS 자동 생성 시) |
| 출력 | `4_final/final.mp4` (+ `tts/seg_*.wav`, `tts-outline.json`, `bgm-identity.json`) |
| 예상 | 10~120초 (TTS 활성 시 +합성 시간) |

**4단계 서브 흐름:**

**(a) 오디오 밸런스** (`audio-config.json` 의 `originalVolume`):
- `'mute'`(기본) → 원본 빼고 음원(BGM)만 = **음원만**. `'low'`/`'full'` → 원본 살리고 BGM 은 그 아래로 ducking
- 원본을 살릴 때만 `source_has_speech === false` 구간을 `between(t,s,e)+...` enable expr 로 잡음 mute (단, 원본이 유일 음원이면 전체가 무음 되는 걸 막기 위해 mute 생략)
- TTS 활성 → 원본은 항상 mute (TTS 가 메인 음성)

**(b) BGM 결정** (우선순위: uploaded > Internet Archive > 없음):
- 업로드 BGM 있으면 그것 사용
- 없고 `audio_profile.has_bgm !== false` 면:
  - **(선택) 레퍼런스 BGM 지문인식** ([lib/bgm-identify.ts](lib/bgm-identify.ts)) — `AUDD_API_TOKEN` 있을 때만
    - 식별된 상용곡은 **임베드 안 함** (저작권). 장르/시대만 archive 검색 hint(`extra_terms`)에 흘림
  - **Internet Archive 자동 다운로드** ([lib/archive.ts](lib/archive.ts)) — `advancedsearch.php` 멀티팩싯 검색 + 점수화
- `pickBgmStartOffset()` — 7~9개 후보 윈도우 `volumedetect` 측정 → intro 무음 회피하고 best start offset 선택

**(c) TTS 합성** (`tts.enabled` 일 때, [lib/narration.ts](lib/narration.ts) + [lib/tts.ts](lib/tts.ts)):
- `prepareNarrationOutline` 이 `tts-config` 의 source/genMode 로 segments 생성 (별도 approved confirm 없음 — 옵션 선택이 곧 승인):
  - `source='captions'` → edit-plan 의 화면 자막을 그대로 / `generate'+'auto'` → OpenAI(chatJson) 작성 / `generate'+'manual'` → 사용자 대본을 컷 슬롯 길이 비례로 분배
- 각 segment를 Gemini `gemini-2.5-flash-preview-tts` 로 합성 (Kore/Puck/Charon/Aoede/Fenrir/Leda/Orus/Zephyr) → base64 PCM → WAV
- 실측 길이 > slot → `atempo` 자동 압축 (최대 2.0). 보정 내역 → `outline.last_synthesis.notes`
- 키 없음/생성 실패는 영상을 죽이지 않고 TTS 없이 진행 (`tts_skipped_*` / `tts_outline_failed` 로그)

**(d) FFmpeg `filter_complex` 분기:**

| TTS | BGM | originalVolume | filter 구성 | mode |
|---|---|---|---|---|
| off | off | (mute→full 폴백) | `[srcA] + loudnorm` | voice_only |
| off | on  | mute | `[bgm0] + loudnorm` (원본 mute, ducking 없음, BGM=1.0) | bgm_only |
| off | on  | low/full | `srcMix + bgmDuck` (sidechain by srcA, ratio=8 release=300ms) | bgm_mixed |
| on  | off | — | `srcA(mute) + ttsMix + loudnorm` | tts_only |
| on  | on  | — | `srcA + ttsMix + bgmDuck` (sidechain by tts, ratio=15 release=180ms) | tts_bgm_mixed |

TTS 트랙은 `atempo → dynaudnorm(f=500:g=15:p=0.9:m=8) → volume=1.30 → adelay`. BGM 볼륨: BGM only=1.0, 원본 살림=0.55, TTS 있으면=0.13. 최종 `loudnorm=I=-14:TP=-1.5:LRA=11` (SNS / YouTube 표준).

---

## 4. 사용자 개입 포인트

1. **업로드 직후** — 레퍼런스 영상 1개 + 소스 영상 다수 (파일 / 드래그&드롭 / IG URL)
2. **Stage 0.5 완료 후 — 옵션 자동 추천 검토·수정** — 마스코트 말풍선 + 미리 채워진 brief. 사용자가 태그 토글, `+ 추가` 로 신규 태그, extra_notes / select 자유 수정
3. **Stage 1 완료 후 (옵션 A)** — `/api/replan-captions` 로 Stage 3만 재생성 (avoid_phrases + feedback 입력 → planCaptions 재실행)
4. **Stage 1 완료 후 (TTS 활성 시)** — 나레이션 개요 생성 → 텍스트 검토·편집 → `approved=true` 확정. 이 confirm을 거치지 않으면 Stage 4는 TTS 합성을 거부
5. **생성 완료 후** — "옵션 수정해서 다시 생성" 으로 같은 projectId 로 Stage 1~4만 재실행 (Stage 0 캐시 유지 → 비용 절약)

---

## 5. 프론트엔드 (Vite + React)

### 5.1 마법사 단계 ([frontend/src/App.tsx](frontend/src/App.tsx))

```
ref (레퍼런스) → sources (소스) → waiting (분석) → options (옵션)
   → edit (컷+자막, stages 1~3) → bgm (BGM 입히기) → final (완성, stage 4)
```

생성은 **두 개의 잡으로 분리**된다: 먼저 컷편집+자막(stages 1~3)을 만들어 결과를 보여주고, 사용자가 그 결과를 보며 BGM 을 고른 뒤 stage 4(BGM/음성)를 따로 돌린다. (`mainJob` 을 `genPhase: 'edit' | 'final'` 로 재사용)

- **ref**: IG URL 또는 파일 업로드. "분석 시작하고 다음 →" 누르면 `POST /api/projects` + 업로드 + `POST /api/run mode=stage stage=0` → 즉시 sources 단계로. Stage 0 백그라운드 분석 중에도 다음 화면에서 작업 가능
- **sources**: **드래그&드롭 + 클릭 시 파일 탐색기** 드롭존. `multiple` + 영상 확장자 필터. 여러 번 누적 추가.
- **waiting**: Stage 0 polling + 실측 진행률 바. 완료되면 자동으로 `POST /api/style-suggest` → **마스코트 말풍선**(summary) + 항목별 분석(analysis) 표시.
- **options**: `style-suggest` 의 `brief` 로 미리 채워짐 (태그 입력 `ChipSingle`/`ChipMulti`) + 오디오 밸런스 + TTS 옵션. **이때 캐러셀 프레임을 미리 추출·캐시** (`getPreviewFrames`). "편집 시작 (컷+자막) →" 누르면 설정 저장 + `POST /api/run mode=all from=1 to=3` → edit 단계.
- **edit**: stages 1~3 진행률(`phaseProgress(from=1,to=3)`) + 캐러셀. 완료되면 `captioned.mp4` URL 을 가져와 bgm 단계로 자동 전환.
- **bgm**: 편집 결과(`captioned.mp4`) 영상 미리보기 + 추천 음원 후보. 영상을 재생해두고 음원을 들어보며 선택. "이 음원으로 완성" → `pickBgm` + `POST /api/run mode=all from=4 to=4` → final 단계.
- **final**: stage 4 진행률(`phaseProgress(from=4,to=4)`) → 완료 시 결과(`final.mp4`). ⬇ 다운로드 / "옵션 수정해서 다시 생성" / "새 영상 만들기".

### 5.2 디버그 로그 (`DebugLog`)

생성 화면 / 결과 화면 둘 다 하단에 **`▸ 로그 확인`** 토글. 펼치면 두 탭:
- **진행 로그** — `job.progress` 의 `step / msg / at / extra`. 각 엔트리 클릭하면 `extra` 객체 펼침
- **API 응답** — `/api/raw-responses` 로 받아온 `raw-api-responses.json` 누적 엔트리. Stage 0 메인/text-focused, Stage 1 shot 묘사 (소스별/배치별), 임베딩, caption planning, source reduction, color-stats, BGM 검색, TTS segment, Stage 0.5 style_suggest 다 보임. 12K char 넘으면 잘림 표시
- 생성 진행 중에는 5초 간격 폴링, 완료/대기 시에는 1회 로드 + 새로고침 버튼

### 5.3 진행률 계산 ([frontend/src/App.tsx:57-73](frontend/src/App.tsx:57))

`phaseProgress(job, perStage, from, to, now)`:
- `estimate.perStage` 가중치 합으로 기준 시간 산출
- `job.progress` 에서 `stage{N}_done` 신호로 완료 stage 추적
- `pct = max(elapsed/total, doneEst/total, 0.02)`, status=done이면 100%
- ETA = `max(0, total - elapsed)`

### 5.4 API 클라이언트 ([frontend/src/api.ts](frontend/src/api.ts))

`api.health() / createProject() / uploadFiles() / igImport() / getProject() / run() / getJob() / getEstimate() / saveStyleBrief() / saveStyleNote() / getStyleSuggest() / generateStyleSuggest() / getRawResponses() / fileUrl()`. polling은 1.5초 간격, job done/error면 종료.

### 5.5 Posty 컴포넌트 ([frontend/src/Posty.tsx](frontend/src/Posty.tsx))

**클래퍼보드 마스코트** Canvas (인라인, 오리지널). `variant` prop 으로 두 모습:
- `variant="logo"` — 헤더 로고. **클래퍼가 "딱! 딱! 딱!" 박수치는** 클래퍼보드 (`bothClap` 라우틴 + 인사·윙크·하트눈·포스트잇 들기·숨었다 빼꼼 등 다양한 라우틴 풀)
- `variant="detective"` (기본) — **돋보기 든 클래퍼보드**. 분석 대기 / 영상 생성 화면. `working=true` 면 돋보기 스캔 애니메이션

`working` prop 으로 분석/생성 중 애니메이션. 말풍선 옆 작은 사이즈(28~46px)부터 대기 화면 큰 사이즈(96px)까지 사용.

---

## 6. lib 디렉토리 모듈 가이드

| 파일 | 역할 |
|---|---|
| [paths.ts](lib/paths.ts) | `data/projects/{pid}/` 전체 경로 + `ARTIFACTS` 상수 + JSON read/write + `appendRawResponse()` (모든 API 응답을 `raw-api-responses.json` 에 누적) |
| [style-suggest.ts](lib/style-suggest.ts) | **Stage 0.5** — `generateStyleSuggest(projectId)` / `readStyleSuggest()`. edit-spec.json 요약 → **OpenAI `gpt-4o-mini` (`response_format: json_object`)** → `style-suggest.json` 캐시. 정규화 (enum 검증, 배열/문자열 길이 제한) |
| [config.ts](lib/config.ts) | API 키, 모델명, FFmpeg 경로, hwaccel 옵션. `checkStageConfig()` 로 stage별 필수 키 검증 |
| [ffmpeg.ts](lib/ffmpeg.ts) | spawn 기반 ffmpeg/ffprobe 래퍼 + `probeDuration` `probeMetadata` `detectShots` `hasAudioStream` `extractFrame` `extractAudio[Range]` `measureSignalStats`. **`FFMPEG_VERBOSE=1`** 이면 각 ffmpeg 명령/진행률(stderr)/exit code+소요시간을 backend stdout 에 실시간 출력 (hang 디버깅용) |
| [gemini.ts](lib/gemini.ts) | `analyzeVideoStructured` (단일 영상), `analyzeMultiPartStructured` (멀티미디어), `callGeminiTextOnly`. 18MB 초과는 Files API resumable upload로 자동 전환. 429/5xx 재시도 |
| [openai.ts](lib/openai.ts) | `embedTexts` (text-embedding-3-small, batch=256), `chatJson` (gpt-4o-mini, JSON 모드), `cosineSim` |
| [prompts.ts](lib/prompts.ts) | 모든 LLM 프롬프트 한 파일 (`REFERENCE_ANALYSIS_PROMPT`, `REFERENCE_TEXT_FOCUSED_PROMPT`, `buildSourceDescriptionPrompt[Multipart]`, `buildImageSourceDescriptionPrompt`, `buildCaptionPlanningPrompt`, `buildSourceReductionPrompt`, `styleNoteBlock`) |
| [source-reduce.ts](lib/source-reduce.ts) | 긴 소스 30~60s 축약 (dedup → OpenAI 선별 → quality greedy 폴백) |
| [style-brief.ts](lib/style-brief.ts) | 구조화된 스타일 브리프 (category/purpose/tone/formality/caption_mode/density/language/keywords/avoid/must_include/extra_notes) + `briefToPromptBlock()` |
| [caption-ass.ts](lib/caption-ass.ts) | CaptionLayer[] → ASS 문서. 1080x1920 캔버스, 폰트/색/외곽선/그림자/박스/글로우/자간/등장 애니메이션/멀티 layer 수직 스택 |
| [fonts.ts](lib/fonts.ts) | 39종 한글 OFL 폰트 + `(category × personality × emphasis × layerIdx)` → family 매핑 |
| [archive.ts](lib/archive.ts) | Internet Archive Audio 검색·다운로드 (audio_profile → 멀티팩싯 쿼리 → 점수화) |
| [bgm-identify.ts](lib/bgm-identify.ts) | AudD.io 지문인식 (선택). 식별된 상용곡 정보 + archive 검색 hint 생성 (`archiveHintsFromIdentity`) |
| [tts.ts](lib/tts.ts) | Gemini TTS preview → PCM(base64) → WAV 래핑. 8종 prebuilt voice |
| [narration.ts](lib/narration.ts) | `prepareNarrationOutline()` — source/genMode 에 따라 나레이션 segments 생성 (captions / generate-auto LLM / generate-manual 분배) + outline 기록 |
| [tts-outline.ts](lib/tts-outline.ts) | 나레이션 segments 저장 + `validateOutline()` (겹침/길이 정보성 검사). `approved` 는 항상 true (옵션 선택이 곧 승인) |
| [tts-config.ts](lib/tts-config.ts) | TTS 설정 저장 (`enabled` / `source:captions\|generate` / `genMode:auto\|manual` / `voice` / `script`) |
| [audio-config.ts](lib/audio-config.ts) | 오디오 밸런스 저장 (`originalVolume:mute\|low\|full`) + `ORIGINAL_VOLUME_GAIN` 매핑 |
| [ig-fetch.ts](lib/ig-fetch.ts) | ig-fetch FastAPI 클라이언트. fetch → `storage_pending` 폴링 → `stored_url` 다운로드 → 로컬 저장 |
| [stages/stage0.ts ~ stage4.ts](lib/stages/) | 각 stage entry point. `runStage{N}(projectId)` |

---

## 7. ig-fetch (선택) — Instagram URL 다운로드

[ig-fetch/README.md](ig-fetch/README.md) 참고. 별도 FastAPI 서비스 (Python).

| 버전 | 변경 |
|---|---|
| v0.1 | yt-dlp 기반 (Reels만 안정, 사진 Post 실패) |
| v0.2 | 쿠키 인증 + IG-web fallback → 사진 Post 가능 |
| v0.3 | 미디어 영구 저장 (Local / S3) + cleanup 스크립트 |
| v0.4 | **하이브리드 저장 타이밍** (사진 동기 / 영상·캐러셀 백그라운드) + 폴링 API |
| v0.4.1 | 좀비 작업 자동 정리 + 자동 재시도 + 명시적 retry endpoint |

**핵심 흐름:**
1. `POST /posts/fetch` — 사진 1장이면 동기 저장 후 즉시 `stored_url` 반환. 영상/캐러셀이면 BackgroundTasks 큐잉 + `storage_pending=true`
2. `GET /posts/{shortcode}/storage-status` — 1~3초 폴링
3. `POST /posts/{shortcode}/retry` — 실패한 미디어만 재시도

**backend의 ig-import 흐름:**
- backend가 ig-fetch에 fetch 요청 → `storage_pending` 폴링 → `stored_url` 다운로드 → `reference/` 또는 `sources/` 에 저장 → 이후 일반 업로드와 동일하게 Stage 0/1이 동작.

**저장 백엔드:** `STORAGE_BACKEND=local|s3|none`. S3는 `S3_BUCKET/S3_REGION/S3_PREFIX/S3_PUBLIC_URL_BASE` 설정.

---

## 8. 프로젝트별 산출물 디렉토리 (`data/projects/{id}/`)

```
reference/                      업로드/임포트한 레퍼런스 영상 (1개)
sources/                        업로드/임포트한 소스들
bgm/                            (선택) 사용자 BGM 또는 archive_*.mp3 자동 다운로드
raw-api-responses.json          모든 API 호출 원본 응답 (디버깅) — appendRawResponse() 누적
style-note.txt                  자유 텍스트 스타일 노트
style-brief.json                구조화된 스타일 브리프
tts-config.json                 TTS 설정 (enabled / source / genMode / voice / script)
audio-config.json               오디오 밸런스 (originalVolume: mute|low|full)
tts-outline.json                TTS 개요 (segments + approved(항상 true) + last_synthesis)
style-suggest.json              Stage 0.5 — 마스코트 한 줄 요약 + 옵션 자동 추천 brief (OpenAI 캐시)

0_spec/
  edit-spec.json                Stage 0 — 레퍼런스 스펙
1_cut/
  source-shots.json             FFmpeg shot 검출 + Gemini Flash 묘사
  edit-plan.json                매칭 + planned_caption_layers
  work/seg_*.mp4 + concat.txt   세그먼트 임시
  cut.mp4                       Stage 1 산출물
2_grade/
  color-stats.json              측정값 + transform + applied_filter
  graded.mp4                    Stage 2
3_caption/
  captions.ass
  captioned.mp4                 Stage 3
4_final/
  tts/seg_*.wav                 TTS on 시
  bgm-identity.json             (선택) 레퍼런스 BGM 지문인식 결과
  final.mp4                     ← 최종
```

---

## 9. 외부 API 비용 트리거

| 서비스 | 모델 | 호출 시점 | 단가 (1M 토큰) |
|---|---|---|---|
| Gemini | `gemini-2.5-pro` | Stage 0 (1~2회) | $1.25 in / $10 out |
| Gemini | `gemini-3.5-flash` | Stage 1 source 묘사 (per shot batch) + caption planning + TTS outline | $1.50 in / $9 out |
| Gemini | `gemini-2.5-flash-preview-tts` | Stage 4 (TTS on, segment 별) | $0.50 in / $10 out (audio) |
| OpenAI | `text-embedding-3-small` | Stage 1 매칭 (batch=256) | $0.02 |
| OpenAI | `gpt-4o-mini` | **Stage 0.5 옵션 자동 추천** + 긴 소스 축약 최종 컷 선별 | $0.15 in / $0.60 out |
| Internet Archive | Audio API | Stage 4 (BGM 없을 때 자동 검색) | 무료 |
| AudD.io | — | Stage 4 (선택, 레퍼런스 BGM 지문인식) | API 토큰 필요 |

---

## 10. 핵심 안전망 / 폴백 사다리

| 위험 | 방어 |
|---|---|
| Gemini Pro rate limit | Pro → Flash 폴백 → 로컬 폴백 (Stage 0, Stage 1) |
| 한글 OCR 누락 | Stage 0 2패스 분석 (메인 + 텍스트 전용), 흐리면 빈 문자열로 두라는 명시 지시 |
| caption 언어 미준수 | `caption_language` 검증(ko/en/mixed) + 강한 재시도 프롬프트 + temperature 낮춤 (Stage 1) |
| Gemini Flash 풀영상 분석 비용 | shot 키프레임 + 오디오만 멀티파트로 보내는 fast path (페이로드 1/10~1/50) |
| 긴 소스 토큰 폭주 | shot > 150 → 120 단위 batch, batch 모드는 풀영상 폴백 끔 (인덱스 정합) |
| 출력 너무 길어짐 | 60s 초과 시 dedup + OpenAI 큐레이션으로 30~60s 축약 |
| 한글 폰트 부재 | 39종 OFL 폰트 번들 + libass `fontsdir` |
| Windows 경로 escaping (드라이브 콜론) | Stage 3 ffmpeg cwd=stage3 → 상대 forward-slash 경로로 fontsdir·.ass 지정 |
| Gemini thinking 모델의 응답 잘림 (Stage 0.5) | OpenAI `gpt-4o-mini` + `response_format=json_object` 로 회피. (Gemini 2.5 Flash 의 maxOutputTokens 1K~2K 는 thinking 만 하다 끝남) |
| caption_planning 이 ref size 위계를 평탄화 | 프롬프트 4-bis "size_level 그대로 카피" + caption-ass 가 LLM size_level 우선 사용 (autoSizeLevel 덮어쓰기 제거) |
| ref 메타 자막(출처/광고/워터마크/음악정보) 가 사용자 영상에 새겨짐 | **(1차) Stage 0 `stripWatermarkLayers()` 가 spec 단계에서 원천 제거** + (2차) caption planning 프롬프트의 6개 패턴 무시 정책 |
| ffmpeg hang 디버깅 불가 (stderr 가 버퍼에만 쌓임) | `FFMPEG_VERBOSE=1` 로 명령/진행률/exit 실시간 출력 |
| ref 와 자막 폰트 인상 불일치 | `pickBundledFont` 첫 폰트 고정 (영상 내 일관성) + bold+heavy personality 에 family 단위 굵기 |
| huge 자막의 외곽선이 가늘게 보임 | 외곽선/그림자/박스 padding 을 px 고정 → fontSize 비율로 변경 |
| BGM intro 무음 | 7~9개 후보 윈도우의 `volumedetect` mean/max로 best start offset |
| TTS overlap | `prepareNarrationOutline` 이 captions/auto-LLM/manual 로 생성 → `sanitizeSegments()` 가 인접 겹침 클램프 + 최소 길이 컷 → 합성 후 slot 초과분 `atempo` 자동 압축 (`validateOutline()` 은 정보성 표시) |
| TTS segment 음량 들쭉날쭉 | `dynaudnorm=f=500:g=15:p=0.9:m=8` + `volume=1.30` boost + 최종 `loudnorm=-14 LUFS` |
| 발화 없는 컷의 환경 노이즈 | `source_has_speech=false` 구간을 `between(t,s,e)+...` enable expr로 자동 mute |
| 9:16 crop 가장자리 검은 라인 | scale 을 +8px oversize 후 정확히 crop. 이미지 zoompan은 zoom을 1.0이 아닌 1.02부터 시작 |
| 영상 미리보기 캐싱 | 프론트가 cache buster 쿼리로 갱신 |
| ig-fetch IG CDN 만료 | `stored_url` 권장. 만료 시 `force_refresh=true` 또는 `retry` |

---

## 11. 실행 (PowerShell)

PowerShell은 `&&` 미지원 → 줄 분리.

```powershell
# 0) 폰트 설치 (최초 1회, ~150MB)
powershell -ExecutionPolicy Bypass -File scripts\install-fonts.ps1

# 1) 의존성
cd backend;  npm install
cd ..\frontend; npm install

# 2) 백엔드 (:8787)
cd backend
npm run dev          # tsx watch src/server.ts

# 3) 프론트 (:5173)
cd frontend
npm run dev          # vite

# 4) (선택) ig-fetch (:8000)
cd ig-fetch
docker compose up -d         # PostgreSQL
uvicorn app.main:app --port 8000
```

`.env.local` 은 **repo 루트** ([.env.example](.env.example) → `.env.local`):
```
GEMINI_API_KEY=...              # Stage 0,1,4 필수
OPENAI_API_KEY=...              # Stage 1 필수
OPENAI_CHAT_MODEL=gpt-4o-mini   # 긴 소스 축약
AUDD_API_TOKEN=                 # 선택 — 레퍼런스 BGM 지문인식
FFMPEG_HWACCEL=                 # 선택 — d3d11va 등 (노트북 깜빡임 주의)
FFMPEG_SCENE_SKIP_NONREF=       # 선택 — '1' 이면 B프레임 디코드 생략
FFMPEG_VERBOSE=                 # 선택 — '1' 이면 ffmpeg 명령/진행률을 콘솔에 실시간 출력 (hang 디버깅)
BACKEND_PORT=8787
WORKER_CONCURRENCY=1            # ffmpeg CPU 폭주 방지
```

---

## 12. 한계 / 알려진 제약

- 컷 경계/하이라이트: FFmpeg scene detect + LLM 추정 결합 (프레임 정확도는 아님)
- 색 보정: 채도/대비/색온도 단순 매칭 (필름 LUT 등 복합 그레이딩 미흡)
- 긴 소스: 임베딩 dedup + 품질/내러티브 기준으로 30~60초 자동 축약
- BGM: 업로드본 우선, 없으면 Internet Archive 무료 음원 검색·매칭 (생성형 아님). 레퍼런스 상용곡은 저작권상 임베드하지 않고 정보/매칭 가이드로만 사용
- 전환 효과: 단순 cut (fade/whip/match_cut 등은 spec에 잡히지만 렌더는 cut)
- 작업 큐: in-process 메모리. 프로세스 재시작 시 진행 상태 손실 (MVP)
- ig-fetch BackgroundTasks: 단일 프로세스, 재시작 시 pending → failed 마킹 후 retry 가능. 규모 시 Celery+Redis 마이그레이션 권장
