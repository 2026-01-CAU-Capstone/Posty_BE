# posty-prototype

레퍼런스 릴스 1개 + 원본 영상 여러 개를 업로드하면, **단계별로 특화된 API**를 사용해 자동 편집된 9:16 결과를 만드는 localhost 검증용 프로토타입.

## 단계 구조

| 단계 | 역할 | 사용 API / 도구 | 산출물 |
|---|---|---|---|
| 0 | 레퍼런스 영상 분석 → 텍스트 스펙 | **Gemini 2.5 Pro** (영상 이해 + JSON) | `0_spec/edit-spec.json` |
| 1 | 소스 영상 컷편집 | **FFmpeg scene detect** → **Gemini 3.5 Flash** 묘사 → **OpenAI text-embedding-3-small** 매칭 → **FFmpeg** 9:16 cut/concat | `1_cut/cut.mp4` + `edit-plan.json` |
| 2 | 영상 색감 보정 | **FFmpeg signalstats** 측정 → `eq` / `colorbalance` 적용 | `2_grade/graded.mp4` |
| 3 | 자막 입히기 | **FFmpeg subtitles** (ASS burn-in) | `3_caption/captioned.mp4` |
| 4 | 음성/BGM/TTS | **Internet Archive Audio API** (자동 BGM 검색·다운로드) + **Gemini 2.5 Flash TTS Preview** (선택, 한국어 나레이션) + **FFmpeg amix + sidechain ducking + loudnorm** | `4_final/final.mp4` |

각 단계는 **체크포인트 파일**을 남기므로 한 단계만 다시 돌릴 수 있습니다.

## 설치

```powershell
cd posty-prototype
npm install
powershell -ExecutionPolicy Bypass -File scripts\install-fonts.ps1
```

FFmpeg/FFprobe 가 PATH 에 있어야 합니다. Windows full build: https://www.gyan.dev/ffmpeg/builds/

### 한글 폰트 번들 (`assets/fonts/`)

자막 burn-in (Stage 3) 은 시스템 설치 폰트가 아니라 **번들 폰트**를 FFmpeg `subtitles=...:fontsdir=...` 옵션으로 로드합니다. `install-fonts.ps1` 가 다음을 다운로드합니다 (모두 SIL OFL 라이센스):

- **Modern sans**: Pretendard (Regular/Bold/Black), Nanum Gothic, Gothic A1
- **Rounded / minimal**: Gowun Dodum, Sunflower
- **Serif**: Nanum Myeongjo, Gowun Batang, Song Myung
- **Bold impact**: Black Han Sans, Do Hyeon, Jua
- **Retro display**: Yeon Sung, Stylish, Gugi
- **Handwritten neat**: Gaegu (Light/Regular/Bold), Single Day, Hi Melody, Poor Story
- **Handwritten brush**: Nanum Pen Script, Nanum Brush Script
- **Decorative**: Kirang Haerang, Gamja Flower, Cute Font, Dokdo, East Sea Dokdo, Black And White Picture

총 ~150MB. 자막 layer 의 `font_category × font_personality` 조합으로 [lib/fonts.ts](lib/fonts.ts) 에서 매핑됩니다 — italic 은 ASS `\i1` 오버라이드로 burn-in 시 적용.

## API 키 설정

`.env.example` 을 `.env.local` 로 복사한 뒤 키를 채웁니다.

```
GEMINI_API_KEY=...        # https://aistudio.google.com/apikey
OPENAI_API_KEY=...        # https://platform.openai.com/api-keys
```

> 키가 없는 단계는 실행 시 명확한 에러로 알려줍니다. Stage 2~4 는 외부 API 불필요.

## 실행

```powershell
npm run dev
```

브라우저에서 http://localhost:3000

## 사용 흐름

1. **새 프로젝트 만들기** 클릭
2. 업로드 섹션에서:
   - 레퍼런스 영상 1개 (필수)
   - 소스 영상 여러 개 (필수)
   - BGM 파일 (선택 — Stage 4 에 사용)
3. 단계별 **실행** 버튼을 0 → 1 → 2 → 3 → 4 순서로 누름
4. **TTS 활성 시** Stage 1 완료 후 "음성 나레이션" 섹션에서:
   - "개요 생성" 클릭 → Gemini Flash 가 각 컷 시간에 맞춰 한국어 segment 들을 작성
   - 각 segment 의 text 를 검토·편집 (시간 슬롯은 자동 계산됨)
   - "확인하고 진행" 클릭 → approved=true → Stage 4 실행 시 합성
   - **이 confirm 단계를 거치지 않으면 Stage 4 가 TTS 합성을 거부**합니다 (cut 별 자동 합성으로 인한 overlap 방지)
5. 각 단계 완료 시 산출물이 카드에 즉시 표시됨 (Stage 0: 스펙 JSON, Stage 1: 매칭 결과 + 영상, Stage 2: 색 transform + 영상, Stage 3/4: 영상)

## 디렉토리

```
data/projects/{projectId}/
├── reference/                업로드한 레퍼런스 영상
├── sources/                  업로드한 소스 영상들
├── bgm/                      BGM (사용자 업로드 또는 Stage 4 가 Internet Archive 에서 자동 다운로드)
├── raw-api-responses.json    모든 API 원본 응답
├── 0_spec/edit-spec.json
├── 1_cut/
│   ├── source-shots.json     컷 검출 + Flash 묘사
│   ├── edit-plan.json        매칭 결과
│   ├── work/seg_*.mp4        중간 segment 들
│   └── cut.mp4
├── 2_grade/
│   ├── color-stats.json
│   └── graded.mp4
├── 3_caption/
│   ├── captions.ass
│   └── captioned.mp4
├── 4_final/
│   ├── tts/                  TTS 활성 시 segment 별 wav (seg_NNNN.wav)
│   └── final.mp4             ← 최종
├── tts-config.json           TTS 설정 (enabled/voice 등)
└── tts-outline.json          TTS 합성 전 사용자 confirm 받는 segment 개요
```

## 프롬프트 수정

LLM 프롬프트는 모두 `lib/prompts.ts` 한 파일에 있습니다.
- `REFERENCE_ANALYSIS_PROMPT` — Stage 0 (Gemini Pro)
- `buildSourceDescriptionPrompt()` — Stage 1 (Gemini Flash)
- `buildCaptionPlanningPrompt()` — Stage 1 자막 작성 (Gemini Flash)
- `buildNarrationOutlinePrompt()` — TTS 개요 (Gemini Flash, Stage 4 합성 전)

## API/모델 교체

- 영상 분석 API 를 다른 제공자로: `lib/gemini.ts` 의 `requestBody` / `extractText` 만 수정
- 임베딩을 다른 제공자로: `lib/openai.ts` 의 호출부 수정
- 모델만 바꾸려면 `.env.local` 의 `GEMINI_*_MODEL`, `OPENAI_EMBEDDING_MODEL` 변경

## 한계

- 컷 경계/하이라이트는 LLM 추정값 + FFmpeg scene detect 의 결합이므로 프레임 정확도가 아님
- 색 보정은 채도/대비/색온도 단순 매칭. 복잡한 그레이딩(필름 LUT 등) 은 흉내내지 못함
- BGM 은 사용자 업로드가 있으면 그걸 쓰고, 없으면 Internet Archive 의 무료 음원에서 mood 검색·다운로드 (생성형 음악이 아님 — 검색 매칭)
- 레퍼런스 음원 자동 추출은 저작권 문제로 미구현
- 전환 효과(whip/fade) 는 모두 단순 cut 으로 처리
