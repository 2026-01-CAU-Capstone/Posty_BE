# posty-prototype 전체 파이프라인

## 한눈에 보는 흐름

```
사용자 입력
  └─ 레퍼런스 영상, 소스 영상, BGM, 스타일 브리프, TTS 설정
        ↓
Stage 0   레퍼런스 분석              (Gemini Pro)
        ↓
Stage 1   컷편집 + 자막 플래닝       (FFmpeg + Gemini Flash + OpenAI embedding)
        ↓
   ┌────┴────────┐
   ↓             ↓
자막 재생성    TTS 개요 생성         (사용자 confirm)
   └────┬────────┘
        ↓
Stage 2   색 보정                    (FFmpeg)
        ↓
Stage 3   자막 burn-in               (FFmpeg + 한글 폰트 번들)
        ↓
Stage 4   음성/BGM/TTS mix           (FFmpeg + Gemini TTS)
        ↓
   final.mp4
```

---

## Stage 0 — 레퍼런스 분석

**예상 시간:** 1~3분

- **입력:** `reference/*.mp4` + styleNote
- **API:** Gemini 2.5 Pro `generateContent` (영상 입력)
  - 1차: 메인 분석 (컷/색감/오디오/텍스트 종합)
  - 2차: 텍스트 전용 추출 (한글 OCR 보강) → 머지
  - Pro 429/5xx → Flash 폴백
- **산출:** `0_spec/edit-spec.json`
  - `{ duration, shots[], color_style, audio_profile, caption_global_style, caption_pattern }`
  - 각 `shot.caption_layers[]` 에 `italic`, `font_personality` 포함

---

## Stage 1 — 컷편집 + 자막 플래닝

**예상 시간:** 소스 1개당 30초~1분 (fast path 적용 후)

1. **scene detect** (FFmpeg) — 각 소스 shot 경계 검출
2. **shot 묘사 (멀티파트 fast path)**:
   - 각 shot 의 중간 시점 키프레임 1장(JPG) + 영상 전체 오디오(MP3) 만 추출
   - Gemini 3.5 Flash 에 (image[N] + audio + prompt) 멀티파트로 보냄
   - 풀 영상 업로드 대비 페이로드 1/10~1/50
   - 폴백: multipart Flash → multipart Pro → 풀 영상 Pro → 로컬 기본값
   - **이미지 소스** (.jpg/.png 등) 는 scene detect 없이 단일 still shot 으로 처리
3. **임베딩 매칭** (OpenAI text-embedding-3-small) — ref ↔ src 벡터 매칭
4. **STYLE 빌려오기** — 각 src shot → 가장 어울리는 ref shot 의 스타일
5. **자막 플래닝** (Gemini 3.5 Flash)
   - 입력: ref layers + styleBrief + 사용자 의도
   - 출력: 각 컷의 `planned_caption_layers` (text / 위치 / 폰트 / personality / italic / color)
   - caption_mode / language 검증 실패 시 자동 재시도
6. **렌더** (FFmpeg):
   - 영상 소스: trim + 9:16 smart-reframe crop
   - 이미지 소스: `-loop 1` + zoompan (Ken Burns 1.0→1.12 zoom-in) + anullsrc 무음 오디오
   - concat

**산출:**
- `1_cut/source-shots.json`
- `1_cut/edit-plan.json` (planned_caption_layers 포함)
- `1_cut/cut.mp4`

---

## (옵션 A) 자막 재생성

`/api/replan-captions`

- 사용자가 `avoid_phrases` + feedback 입력
- `planCaptions` 재실행 + Stage 3 재실행
- 컷 매칭 / 렌더는 유지

## (옵션 B) TTS 나레이션 개요

`/api/tts-outline POST`:
- **cut.mp4 가 있으면** Gemini Pro 에 영상 첨부 → 실제 화면 내용을 보고 컷별 segment 작성 (자막 텍스트를 그대로 읽지 않도록 grounding)
- 영상 분석 실패 / cut.mp4 부재 시 Gemini Flash 텍스트 폴백
- 시간 겹침 금지, 5자/초 길이 한계
- 사용자가 검토 · 편집 · 삭제
- `/api/tts-outline PATCH approved=true` 로 확정

> 이 confirm 단계를 거치지 않으면 Stage 4 가 TTS 합성을 거부합니다 (overlap 방지).

---

## Stage 2 — 색 보정

**예상 시간:** 10~30초

- FFmpeg `signalstats` 로 ref / cut 색 측정
- 차이를 `eq` + `colorbalance` 로 보정 (60% 만 반영, 과보정 방지)
- `spec.color_style` 힌트 반영 (vivid / muted, warm / cool)
- **산출:** `2_grade/color-stats.json` + `graded.mp4`

---

## Stage 3 — 자막 burn-in

**예상 시간:** 10~30초

- **입력:** `graded.mp4` + `edit-plan.items[].planned_caption_layers`
- **Layer 별 결정:**
  - **font:** `pickBundledFont(category × personality × layer × emphasis)` → 39종 한글 OFL 폰트 풀
  - **ASS tags:** `\an{1-9}`, `\pos(x,y)`, `\fn`, `\fs`, `\c`, `\b`, `\i`
  - **placement:** 같은 컷 multi-layer 끼리 수직 충돌 회피
- **FFmpeg:** `subtitles=captions.ass:fontsdir=../../../assets/fonts`
- **산출:** `3_caption/captions.ass` + `captioned.mp4`

---

## Stage 4 — 음성/BGM/TTS mix

**예상 시간:** 10~120초

### (a) 원본 voice 처리
- TTS off → `source_has_speech=false` 인 구간만 mute
- TTS on → 전체 mute

### (b) BGM 결정
우선순위: **uploaded > Internet Archive 자동 다운로드 > 없음**
- `pickBgmStartOffset` — 7~9개 후보 윈도우의 volume 측정으로 최적 시작점

### (c) TTS 합성 (enabled && outline.approved 일 때만)
- `approved=false` 면 명시적 에러 throw — overlap 방지
- 각 segment 별 Gemini 2.5 Flash TTS Preview 호출
  - voice: Kore / Puck / Charon / Aoede 등 8종
  - 응답: base64 PCM → WAV 래핑
- 실측 길이 > slot 이면 `atempo` 자동 압축 (최대 2배)
- 보정 내역 → `outline.last_synthesis.notes` 기록

### (d) filter_complex 분기

| TTS | BGM | filter 구성                                  | mode           |
|-----|-----|----------------------------------------------|----------------|
| off | off | `[srcA] + loudnorm`                          | voice_only     |
| off | on  | `srcA + bgm0` (sidechain by srcA)            | bgm_mixed      |
| on  | off | `srcA(mute) + ttsMix + loudnorm`             | tts_only       |
| on  | on  | `srcA + ttsMix + bgm0` (sidechain by tts)    | tts_bgm_mixed  |

최종 loudnorm `I=-14 LUFS` (SNS / 유튜브 표준)

**산출:** `4_final/tts/seg_*.wav` (TTS on 시) + `final.mp4` ← 최종

---

## 외부 API + 비용 트리거

| 서비스 | 모델 | 호출 시점 | 단가 (1M 토큰) |
|--------|------|----------|---------------|
| Gemini | gemini-2.5-pro | Stage 0 (1~2회) | $1.25 in / $10 out |
| Gemini | gemini-3.5-flash | Stage 1 source 묘사 + caption planning + TTS outline | $1.50 in / $9 out |
| Gemini | gemini-2.5-flash-preview-tts | Stage 4 (TTS on, segment 별) | $0.50 in / $10 out (audio) |
| OpenAI | text-embedding-3-small | Stage 1 매칭 (batch) | $0.02 |
| Internet Archive | Audio API | Stage 4 (BGM uploaded 없을 때) | 무료 |

---

## 사용자 개입 포인트

1. **업로드 직후** — 영상 스타일 브리프 (자막 톤 · 언어 · 금지표현)
2. **Stage 1 완료 후 (옵션)** — `/api/replan-captions` 로 Stage 3 만 재생성
3. **Stage 1 완료 후 (TTS 활성 시)** — 나레이션 개요 생성 → text 검토 · 편집 → `approved=true` 확정

---

## 산출물 구조

```
data/projects/{projectId}/
├── reference/                 업로드한 레퍼런스
├── sources/                   업로드한 소스들
├── bgm/                       BGM (사용자 또는 archive_*)
├── raw-api-responses.json     모든 API 응답 (usageMetadata 포함)
├── style-note.txt             자유 입력 스타일 노트
├── style-brief.json           구조화된 스타일 브리프
├── tts-config.json            TTS 설정 (enabled / voice)
├── tts-outline.json           TTS 개요 (segments + approved + last_synthesis)
├── 0_spec/
│   └── edit-spec.json
├── 1_cut/
│   ├── source-shots.json
│   ├── edit-plan.json
│   ├── work/seg_*.mp4
│   └── cut.mp4
├── 2_grade/
│   ├── color-stats.json
│   └── graded.mp4
├── 3_caption/
│   ├── captions.ass
│   └── captioned.mp4
└── 4_final/
    ├── tts/seg_*.wav
    └── final.mp4              ← 최종
```

---

## 핵심 안전망

| 위험 | 방어 |
|------|------|
| Gemini Pro rate limit | Pro → Flash 폴백 → 로컬 폴백 (Stage 0 / 1) |
| caption 언어 미준수 | caption_language 검증 + 자동 재시도 (Stage 1) |
| TTS overlap | outline confirm + validate (시간 겹침 검사) + atempo (Stage 4) |
| 한글 폰트 부재 | 39종 OFL 폰트 번들 + fontsdir (Stage 3) |
| BGM intro 무음 | 다중 윈도우 volume 측정으로 best start offset (Stage 4) |
| 영상 캐싱 | UI 가 cache buster 쿼리로 갱신 |
