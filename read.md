# Posty — 프로젝트 정리 (read.md)

레퍼런스 릴스 1개의 **편집 스타일** 을 분석해서, 내 소스 영상 여러 개를 그 스타일대로 자동 편집해 9:16 영상을 만들어 주는 도구.

이 문서는 지금까지의 작업물을 한 번에 훑기 위한 종합 정리본. 세부 운영 가이드는 [README.md](README.md), 파이프라인 다이어그램은 [PIPELINE.md](PIPELINE.md).

---

## 1. 모노레포 구성

```
posty-prototype/
├── frontend/           Vite + React UI (4-step 마법사: 레퍼런스 → 소스 → 옵션 → 생성)
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
| GET  | `/api/estimate` | 보수적 처리시간 예측 (초) |
| POST | `/api/style-note` | 자유 스타일 노트 저장 |
| POST | `/api/style-brief` | 구조화된 스타일 브리프 저장 |
| POST | `/api/tts-config` | TTS 설정 저장 (enabled/voice/mode) |

추가로 [PIPELINE.md](PIPELINE.md)에 언급된 `/api/replan-captions`, `/api/tts-outline` (POST/PATCH) 가 caption 재생성 / TTS 개요 confirm 흐름을 담당.

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

업로드된 레퍼런스/소스 길이 + 소스 개수로 stage별 초를 추정 (SAFETY 계수 1.15로 보수적 = 과대 추정).

```
s0 = 75 + 1.2 * refDur                  // 레퍼런스 분석 (Pro 2패스)
s1 = 25 + 3.0 * srcDur + 12 * nSources  // 디코드 + Gemini per source + 렌더
s2 = 12 + 1.5 * outDurEst               // 색보정
s3 = 12 + 1.2 * outDurEst               // 자막
s4 = 35 + 1.8 * outDurEst               // BGM 다운로드 + 믹스
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
4. `normalizeLayer()` — text가 빈 layer도 보존 (스타일 정보용). position·align·size·color·emphasis·italic·font_category·font_personality·role·tone.

**스펙 스키마 (edit-spec.json):**
```ts
{
  duration, aspect_ratio, pacing,
  shots: [ { index, start, end, duration, shot_type, subject, scene_description,
             composition, camera_motion, transition_to_next, caption_layers[], required_tags } ],
  color_style, audio_profile, caption_global_style, caption_pattern
}
```

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
7. **렌더** (FFmpeg, [lib/stages/stage1.ts:975-1082](lib/stages/stage1.ts:975)):
   - 영상 소스: `-ss → trim → scale(+8px) → crop(9:16, subject_center 기반)` → 세그먼트 mp4
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
- `pickBundledFont(category × personality × layer × emphasis)` → ASS Fontname
- 풀 미스 → OS 기본 한글 폰트 폴백

### 3.5 Stage 4 — 음성/BGM/TTS ([lib/stages/stage4.ts](lib/stages/stage4.ts))

| 항목 | 내용 |
|---|---|
| 입력 | `3_caption/captioned.mp4` + (선택) `bgm/` + `edit-spec.json` + `edit-plan.json` + (선택) tts outline |
| API | Internet Archive Audio (BGM 자동), AudD (BGM 지문인식, 선택), Gemini TTS preview (선택) |
| 출력 | `4_final/final.mp4` (+ `tts/seg_*.wav`, `bgm-identity.json`) |
| 예상 | 10~120초 |

**4단계 서브 흐름:**

**(a) 원본 voice 처리** (노이즈 자동 mute):
- `edit-plan.items[].source_has_speech === false` 인 구간을 `between(t,s,e)+...` enable expr로 mute
- TTS 활성 → 전체 mute

**(b) BGM 결정** (우선순위: uploaded > Internet Archive > 없음):
- 업로드 BGM 있으면 그것 사용
- 없고 `audio_profile.has_bgm !== false` 면:
  - **(선택) 레퍼런스 BGM 지문인식** ([lib/bgm-identify.ts](lib/bgm-identify.ts)) — `AUDD_API_TOKEN` 있을 때만
    - 식별된 상용곡은 **임베드 안 함** (저작권). 장르/시대만 archive 검색 hint(`extra_terms`)에 흘림
  - **Internet Archive 자동 다운로드** ([lib/archive.ts](lib/archive.ts)) — `advancedsearch.php` 멀티팩싯 검색 + 점수화
- `pickBgmStartOffset()` — 7~9개 후보 윈도우 `volumedetect` 측정 → intro 무음 회피하고 best start offset 선택

**(c) TTS 합성** (`tts.enabled && outline.approved` 일 때만, [lib/tts.ts](lib/tts.ts) + [lib/tts-outline.ts](lib/tts-outline.ts)):
- `approved=false` → 명시적 throw (overlap 방지)
- 각 segment를 Gemini `gemini-2.5-flash-preview-tts` 로 호출 (Kore/Puck/Charon/Aoede/Fenrir/Leda/Orus/Zephyr)
- 응답: base64 PCM → WAV 래핑
- 실측 길이 > slot → `atempo` 자동 압축 (최대 2.0)
- 보정 내역 → `outline.last_synthesis.notes` 기록

**(d) FFmpeg `filter_complex` 분기:**

| TTS | BGM | filter 구성 | mode |
|---|---|---|---|
| off | off | `[srcA] + loudnorm` | voice_only |
| off | on  | `srcMix + bgmDuck` (sidechain by srcA, ratio=8 release=300ms) | bgm_mixed |
| on  | off | `srcA(mute) + ttsMix + loudnorm` | tts_only |
| on  | on  | `srcA + ttsMix + bgmDuck` (sidechain by tts, ratio=15 release=180ms) | tts_bgm_mixed |

TTS 트랙은 `atempo → dynaudnorm(f=500:g=15:p=0.9:m=8) → volume=1.30 → adelay`. BGM 볼륨: TTS 없으면 0.55, TTS 있으면 0.13. 최종 `loudnorm=I=-14:TP=-1.5:LRA=11` (SNS / YouTube 표준).

---

## 4. 사용자 개입 포인트

1. **업로드 직후** — 스타일 브리프 (자막 톤·언어·빈도·금지표현·필수문구·키워드·extra_notes) + 자유 styleNote
2. **Stage 1 완료 후 (옵션 A)** — `/api/replan-captions` 로 Stage 3만 재생성 (avoid_phrases + feedback 입력 → planCaptions 재실행)
3. **Stage 1 완료 후 (TTS 활성 시)** — 나레이션 개요 생성 → 텍스트 검토·편집 → `approved=true` 확정. 이 confirm을 거치지 않으면 Stage 4는 TTS 합성을 거부

---

## 5. 프론트엔드 (Vite + React)

### 5.1 마법사 4단계 ([frontend/src/App.tsx](frontend/src/App.tsx))

```
ref (레퍼런스) → sources (소스) → options (옵션) → run (생성)
```

- **ref**: IG URL 또는 파일 업로드. "분석 시작하고 다음 →" 누르면 `POST /api/projects` + 업로드 + `POST /api/run mode=stage stage=0` → 즉시 sources 단계로. Stage 0 백그라운드 분석 중에도 다음 화면에서 작업 가능.
- **sources**: 파일 multi-upload + IG URL 줄바꿈 입력. 추가할 때마다 chip 표시.
- **options**: 자막 언어/빈도, 톤, 목적, 키워드, 필수문구, extra_notes, styleNote 7개. 비우면 레퍼런스 따라감.
- **run**: ✨ 영상 생성 → `POST /api/run mode=all from=1 to=4` (Stage 0은 이미 완료 또는 진행 중이지만 from=1로 따라잡힘 — 큐가 순차 처리). 진행률 + ETA + Posty 애니메이션.

### 5.2 진행률 계산 ([frontend/src/App.tsx:57-73](frontend/src/App.tsx:57))

`phaseProgress(job, perStage, from, to, now)`:
- `estimate.perStage` 가중치 합으로 기준 시간 산출
- `job.progress` 에서 `stage{N}_done` 신호로 완료 stage 추적
- `pct = max(elapsed/total, doneEst/total, 0.02)`, status=done이면 100%
- ETA = `max(0, total - elapsed)`

### 5.3 API 클라이언트 ([frontend/src/api.ts](frontend/src/api.ts))

`api.health() / createProject() / uploadFiles() / igImport() / getProject() / run() / getJob() / getEstimate() / saveStyleBrief() / saveStyleNote() / fileUrl()`. polling은 1.5초 간격, job done/error면 종료.

### 5.4 Posty 컴포넌트 ([frontend/src/Posty.tsx](frontend/src/Posty.tsx))

곰돌이 마스코트 SVG. `working` prop으로 분석/생성 중 애니메이션.

---

## 6. lib 디렉토리 모듈 가이드

| 파일 | 역할 |
|---|---|
| [paths.ts](lib/paths.ts) | `data/projects/{pid}/` 전체 경로 + `ARTIFACTS` 상수 + JSON read/write + `appendRawResponse()` (모든 API 응답을 `raw-api-responses.json` 에 누적) |
| [config.ts](lib/config.ts) | API 키, 모델명, FFmpeg 경로, hwaccel 옵션. `checkStageConfig()` 로 stage별 필수 키 검증 |
| [ffmpeg.ts](lib/ffmpeg.ts) | spawn 기반 ffmpeg/ffprobe 래퍼 + `probeDuration` `probeMetadata` `detectShots` `hasAudioStream` `extractFrame` `extractAudio[Range]` `measureSignalStats` |
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
| [tts-outline.ts](lib/tts-outline.ts) | 나레이션 segments 저장 + `validateOutline()` (겹침/길이/5자/초 검사) + `approved` 플래그 |
| [tts-config.ts](lib/tts-config.ts) | TTS enabled/voice 저장 |
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
tts-config.json                 TTS 설정 (enabled / voice / mode)
tts-outline.json                TTS 개요 (segments + approved + last_synthesis)

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
| OpenAI | `gpt-4o-mini` | 긴 소스 축약의 최종 컷 선별 | $0.15 in / $0.60 out |
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
| BGM intro 무음 | 7~9개 후보 윈도우의 `volumedetect` mean/max로 best start offset |
| TTS overlap | `outline.approved` 강제 + `validateOutline()` 시간 겹침 검사 + `atempo` 자동 압축 |
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
