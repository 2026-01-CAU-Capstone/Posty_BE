// ============================================================
// 모든 LLM 프롬프트 한 곳에서 관리.
// - REFERENCE_ANALYSIS_PROMPT : Stage 0, Gemini Pro
// - SOURCE_SHOT_DESCRIPTION_PROMPT : Stage 1, Gemini Flash
// - buildStyleSuggestPrompt        : Stage 0.5, OpenAI gpt-4o-mini (chat JSON)
//   (분석 결과 → 마스코트 한 줄 요약 + 옵션 자동 채우기)
// ============================================================

// ============================================================
// Stage 0.5 — 분석된 edit-spec.json 을 보고
//   (1) 마스코트가 사용자에게 건넬 한 줄 요약
//   (2) 편집 옵션 자동 추천 (사용자가 수정 가능)
// 을 함께 만들어 돌려준다.
// ============================================================
export function buildStyleSuggestPrompt(args: {
  specSummary: string;
  styleNote: string;
}): string {
  const noteBlock = args.styleNote.trim()
    ? `\n사용자가 미리 적어둔 자유 노트(있다면 옵션 추천에 반영):\n${args.styleNote.trim()}\n`
    : '';
  return `너는 숏폼(릴스/틱톡) 편집 어시스턴트인 클래퍼보드 마스코트 "Posty" 다.
사용자가 방금 레퍼런스 영상 1개를 분석해서 결과가 나왔다.
이 결과를 보고 세 가지를 만들어라.

[1] summary — 마스코트가 사용자에게 건넬 자연스러운 한 줄 인사.
  - 톤: 친근하고 가볍게. 반말이나 존댓말 모두 가능하지만 너무 딱딱하지 않게.
  - 형식 예: "아 ~~한 분위기의 릴스를 올리셨군요!", "오~ ~~ 영상이네요!", "~~한 느낌, 좋아요!"
  - 영상의 핵심 내용·분위기를 한 줄로. 최대 80자 (한글 기준).

[2] analysis — 레퍼런스에서 "무엇을 어떻게 분석했는지" 항목별로 풀어 설명.
  - 사용자가 분석 내용을 구체적으로 파악할 수 있게, 항목(label) + 설명(detail) 쌍의 배열로.
  - 항목은 4~6개. 아래 관점을 골고루 다뤄라 (해당되는 것 위주로):
    · "무드/분위기"   — 영상 전반의 감성·톤
    · "편집 리듬"     — 컷 길이·페이싱·전환 속도 (pacing 기반)
    · "색감/비주얼"   — 밝기·대비·채도·색온도·무드 (color_style 기반)
    · "자막 스타일"   — 폰트 인상·크기·위치·빈도·언어 (caption_global_style / caption_pattern 기반)
    · "오디오/BGM"    — BGM 유무·장르·템포·에너지, 발화 여부 (audio_profile 기반)
    · "소재/주제"     — 무엇을 담은 영상인지, 주요 피사체 (shots / topic 기반)
  - 각 detail 은 1~2 문장, 한국어, 분석 근거가 드러나게 구체적으로. 최대 240자.
  - label 은 짧게(최대 24자). 위 예시 라벨을 그대로 써도 좋다.

[3] brief — 사용자가 이어서 채워야 할 편집 옵션을 미리 추천.
  - 사용자는 받은 값을 그대로 쓰거나 자유롭게 수정한다. 너무 좁게 잡지 말고 영상 내용에서 자연스럽게 뽑아낼 것.
  - tone : 한 줄, 한국어. 예: "발랄한", "잔잔한", "감성적인", "에너지 넘치는"
  - purpose : 한 줄, 한국어. 예: "카페 홍보", "여행 vlog", "제품 리뷰", "맛집 추천"
  - topic_keywords : 5~10개 한국어 키워드. 영상의 주제·소재·분위기·장소·색감 등.
    각 키워드는 짧게 (1~6자 권장). 예: ["맥주", "이자카야", "노을", "감성", "친구"]
  - must_include_phrases : 0~3개. 자막에 자연스럽게 들어가면 좋을 짧은 한국어 문구.
    꼭 필요하지 않으면 빈 배열로. 예: ["오늘 퇴근 후", "딱 한 잔"]
  - caption_language : "ko" / "en" / "mixed" 중 하나.
    레퍼런스 자막이 한글이면 "ko", 영어면 "en", 둘 다면 "mixed".
  - caption_density : "every_cut" / "most_cuts" / "occasional" / "minimal" / "none" 중 하나.
    레퍼런스에 자막이 매 컷마다 있으면 "every_cut", 거의 있으면 "most_cuts",
    띄엄띄엄이면 "occasional", 한두 번이면 "minimal", 없으면 "none".

레퍼런스 분석 요약:
\`\`\`
${args.specSummary}
\`\`\`
${noteBlock}
JSON 만 출력. 다른 텍스트/마크다운/코드펜스 금지.

{
  "summary": string,
  "analysis": [
    { "label": string, "detail": string }
  ],
  "brief": {
    "tone": string,
    "purpose": string,
    "topic_keywords": string[],
    "must_include_phrases": string[],
    "caption_language": "ko" | "en" | "mixed",
    "caption_density": "every_cut" | "most_cuts" | "occasional" | "minimal" | "none"
  }
}
`;
}

// ============================================================
// 사용자 스타일 노트 주입 헬퍼
// 텍스트가 있으면 프롬프트 상단에 "사용자 요청" 블록을 끼워 넣는다.
// 비어 있으면 빈 문자열을 반환해서 기존 프롬프트와 동일.
// ============================================================
export function styleNoteBlock(text: string): string {
  const t = (text || '').trim();
  if (!t) return '';
  return `==============================
[사용자가 원하는 결과 영상의 느낌 — 적극 반영해라]
${t}
==============================
위 의도를 위반하지 않는 범위에서, 분석 결과 값들 (pacing, color_style, audio_profile, shot 묘사·tags 등) 을 사용자 취향에 부합하도록 미세 조정해라.
객관적 사실(시간, 컷 경계 등) 은 바꾸지 마라.

`;
}

// Stage 0: 레퍼런스 영상을 "재현 가능한 편집 설계도" 로 분해
export const REFERENCE_ANALYSIS_PROMPT = `너는 숏폼(릴스/틱톡) 편집 디렉터다.
주어진 레퍼런스 영상을 다른 소스 영상으로 재현할 수 있는 편집 설계도로 분해해라.
컷 단위로 정확한 시간과 구성 정보를 추출해라.

⚠ 중요: 영상 위에 표시되는 글자는 단순한 "자막(받아쓰기)" 이 아니라
"영상 텍스트 오버레이" — 시각 디자인 요소와 메시지 둘 다 담은 그래픽이다.
폰트/사이즈/위치/색 같은 디자인 요소와 실제 문구(text) 둘 다 정확히 잡아내라.
특히 caption_layers[].text 는 글자 한 자도 빠짐없이, 받아 적은 것처럼 정확히 적어라.

⚠⚠ 한국어(한글) 텍스트 인식 — 절대 준수:
- 영상에 등장하는 한글 텍스트는 반드시 **한글 문자 그대로** caption_layers[].text 에 적어라.
- 영문 알파벳 / 로마자 표기 / 영어 번역으로 변환 금지. (예: "오늘" 을 "oneul" / "today" 로 적지 마라.)
- 받침·이중모음·복합자음 하나도 틀리지 말고, 보이는 그대로.
- 띄어쓰기와 줄바꿈도 화면에 보이는 그대로.
- 글자가 흐릿하거나 잘 안 보이면 **추측하지 말고 빈 문자열 ""** 로 두어라.
  (틀린 추측보다 빈 답이 훨씬 낫다.)
- 한글 + 영문/숫자가 섞여 있으면 섞인 그대로 적어라 (예: "1초만에 OK").

아래 JSON 스키마를 strict 하게 따라 출력해라. 다른 설명/마크다운/코드펜스 금지. JSON 만.

{
  "duration": number,
  "aspect_ratio": "9:16" | "1:1" | "16:9" | "other",
  "pacing": "slow" | "medium" | "fast" | "very_fast",
  "shots": [
    {
      "index": number,
      "start": number,
      "end": number,
      "duration": number,
      "shot_type": string,                       // close_up | medium | wide | pov | selfie | product | b_roll | text_only
      "subject": string,                         // 주피사체
      "scene_description": string,               // 한 줄 설명 (영어 또는 한국어, 매칭용)
      "composition": string,
      "camera_motion": string,                   // static | pan | zoom_in | zoom_out | handheld | whip_pan
      "transition_to_next": string,              // cut | fade | whip | match_cut | dissolve
      "caption_layers": [                        // 이 컷에 보이는 텍스트들 (보통 0~2개, 많아도 3개)
        {
          "text": string,                        // 한 줄 (글자 그대로)
          "position": "top" | "center" | "bottom",
          "vertical_ratio": number,              // 자막 세로 중심 위치 0.0(맨 위)~1.0(맨 아래). position 보다 정밀 — 화면에서 실제 보이는 높이를 정확히 추정 (예: 살짝 위 0.18, 한가운데 0.5, 하단 0.86). 정형화 방지에 중요.
          "horizontal_ratio": number,            // 자막 가로 중심 위치 0.0(왼쪽 끝)~0.5(중앙)~1.0(오른쪽 끝). horizontal_align 보다 정밀 — 화면에서 실제 보이는 가로 위치를 정확히 추정. 무조건 0.5(center)로 통일하지 말고 실제 위치를 반영.
          "horizontal_align": "left" | "center" | "right",
          "size_level": "small" | "medium" | "large" | "huge",
          "size_ratio": number,                  // 정밀 크기: 글자(한 줄)의 높이가 영상 전체 높이에서 차지하는 비율 0~1. 글자 윗변~아랫변 기준(여백 제외). 예: 화면높이의 5%면 0.05, 7%면 0.07, 10%면 0.10. size_level 과 일관: small≈0.03 / medium≈0.05 / large≈0.07 / huge≈0.10. 화면에서 실제 보이는 크기를 정확히 추정 — 4단계로 뭉개지 말고 숫자로.
          "color_hex": string,                   // "#RRGGBB" — 본문(또는 첫 부분) 글자 색
          "color_runs": [                        // 한 자막 안에서 색이 중간에 바뀌면 부분별로 끊어서. 색이 일정하면 []. runs.text 를 이으면 위 text 와 정확히 같아야 함.
            { "text": string, "color_hex": string }
          ],
          "emphasis": "regular" | "bold" | "black",
          "italic": boolean,                     // 글자가 기울어져 있으면 true. 굵기와 직교한다.
          "font_category": "sans" | "serif" | "handwritten" | "condensed" | "rounded" | "display",
          "font_personality": "modern" | "vintage" | "playful" | "elegant" | "bold_impact" | "minimal" | "retro" | "handwritten_neat" | "handwritten_brush" | "display_decorative",
          "font_family_hint": string,            // 글자 모양 재현용 — 폰트 이름이 떠오르면 추정 (예: "Black Han Sans", "Pretendard", "BM Hanna", "G마켓 산스"). 모르면 "".
          "font_width": "normal" | "condensed" | "expanded",            // 자폭(거친 단계). 보통은 normal.
          "font_width_ratio": number,            // 정밀 자폭 = 가로 폭 비율 %(100=기본, 좁고 길쭉=80~90, 넓음=110~130). 4단계로 뭉개지 말고 숫자로. 모르면 100. font_width 보다 우선.
          "font_weight_hint": "thin" | "light" | "regular" | "medium" | "bold" | "black",   // 굵기 인상(거친 단계).
          "font_weight": number,                 // 정밀 굵기 100~900(OpenType wght): thin100 light300 regular400 medium500 bold700 black900(매우 두꺼움). 4단계로 뭉개지 말고 숫자로 — font_weight_hint/emphasis 보다 우선.
          "font_style_notes": string,            // 자유 서술 (예: "둥근 고딕", "각진 헤드라인", "약간 손글씨"). 모르면 "".
          "role": "hook" | "fact" | "punchline" | "question" | "cta" | "quote" | "label" | "emphasis" | "decoration",
          "tone": "casual" | "formal" | "hype" | "poetic" | "informational" | "humorous" | "emotional",

          "outline_color_hex": string,           // 글자 외곽선 색. 외곽선 없으면 ""
          "outline_thickness": "none" | "thin" | "medium" | "thick",   // (거친 단계)
          "outline_ratio": number,               // 정밀 외곽선 두께 = 외곽선 두께 ÷ 글자높이(0~0.15, 0=없음). 4단계로 뭉개지 말고 숫자로. outline_thickness 보다 우선.

          "has_shadow": boolean,                 // 글자에 그림자가 보이면 true
          "shadow_color_hex": string,            // 그림자 색. 보통 "#000000"
          "shadow_blur": number,                 // 0~24. 그림자 흐림 반경(px, 화면높이 1920 기준). 또렷한 그림자=0~3, 부드러운 글로우형=8~20
          "shadow_offset_x": number,             // 그림자 가로 오프셋 px(오른쪽+ / 왼쪽-). 보통 0~6. 없으면 0.
          "shadow_offset_y": number,             // 그림자 세로 오프셋 px(아래+ / 위-). 보통 2~6. 없으면 4.

          "has_background_box": boolean,         // 글자 뒤에 박스/박스형 배경이 있으면 true
          "background_color_hex": string,        // 박스 색 (있을 때)
          "background_alpha": number,            // 0~1. 박스 불투명도. 완전 불투명=1.0, 반투명=0.4~0.7, 거의 안 보이는 박스=0.2~0.3
          "background_radius": number,           // 박스 모서리. 0=각진, 12=살짝 둥근, 999=알약형(pill)

          "gradient": {                          // 글자 자체에 그라데이션이 보이면 type="linear", 아니면 type="none"
            "type": "linear" | "none",
            "angle": number,                     // 0=상→하, 90=좌→우, 180=하→상, 270=우→좌. 사선은 30/45/60 등.
            "stops": [                           // 2개 이상. type="none" 이면 빈 배열.
              { "offset": number, "color": string }   // offset 0~1, color "#RRGGBB"
            ]
          },

          "has_glow": boolean,                   // 글자 주변에 빛나는 광이 보이면 true (네온/글로우 효과)
          "glow_color_hex": string,              // 광 색. 보통 글자 색과 같거나 살짝 다른 색.
          "glow_radius": number,                 // 0~28. 광(헤일로) 퍼짐 반경 px(화면높이 1920 기준). 0=글로우 없음.

          "letter_spacing": "tight" | "normal" | "wide",   // 자간(거친 단계).
          "letter_spacing_em": number,           // 정밀 자간 em(-0.05~0.15): 좁으면 음수(-0.02), 넓으면 양수(0.06). 모르면 0. letter_spacing 보다 우선.

          "entry_animation": "none" | "fade"     // 자막 등장 방식. 갑작스럽게 나타나면 none, 부드럽게 페이드인이면 fade. 확실치 않으면 fade.
        }
      ],
      "required_tags": string[]                  // 이 컷 재현에 소스가 가져야 할 태그들 (snake_case 영어 권장)
    }
  ],
  "color_style": {
    "brightness": "dark" | "normal" | "bright",
    "contrast": "low" | "normal" | "high",
    "saturation": "muted" | "normal" | "vivid",
    "temperature": "cool" | "neutral" | "warm",
    "mood": string
  },
  "audio_profile": {
    "has_bgm": boolean,
    "bgm_mood": string,                          // upbeat | chill | dramatic | romantic | sad | epic | calm 등
    "bgm_genre": string,                         // lofi | edm | jazz | rock | classical | hiphop | acoustic | ambient | folk 등
    "bgm_tempo": "slow" | "medium" | "fast" | "very_fast",
    "bgm_energy": "calm" | "moderate" | "energetic" | "intense",
    "bgm_instruments": string[],                 // 들리는 주요 악기 ["piano","guitar","drums","synth"]
    "has_speech": boolean,
    "pacing_sync": "on_beat" | "speech_synced" | "free"
  },
  "caption_global_style": {
    "font_category": "sans" | "serif" | "handwritten" | "condensed" | "rounded" | "display",
    "font_personality": "modern" | "vintage" | "playful" | "elegant" | "bold_impact" | "minimal" | "retro" | "handwritten_neat" | "handwritten_brush" | "display_decorative",
    "font_weight": "regular" | "bold" | "black",
    "font_italic": boolean,                      // 전체적으로 자막이 기울어진 글씨면 true
    "all_caps": boolean,                         // 전부 대문자/대문자 강조면 true
    "primary_color_hex": string,                 // 본문 색. "#RRGGBB"
    "has_outline": boolean,                      // 글자에 외곽선이 있나
    "outline_color_hex": string,                 // 외곽선 색. "#RRGGBB"
    "outline_thickness": "none" | "thin" | "medium" | "thick",
    "has_shadow": boolean,
    "has_background_box": boolean,               // 자막 뒤 '분리된 색 판'(획 사이 여백까지 메워짐)이 있을 때만 true. 글자 자체가 컬러인 건(노란 글씨 등) false — 그 색은 primary_color_hex.
    "background_color_hex": string,              // 배경 박스 색. "#RRGGBB"
    "background_alpha": number,                  // 0~1. 박스 불투명도. 1=완전 불투명, 0.4~0.7=반투명
    "size_level": "small" | "medium" | "large" | "huge"
  },
  "caption_pattern": {
    "frequency": "every_cut" | "most_cuts" | "occasional" | "rare" | "never",
    "average_char_count": number,
    "max_char_count": number,
    "size_contrast": "uniform" | "alternating" | "dramatic",     // 컷 간 크기 차이 패턴
    "layer_count_typical": number,                                // 동시에 보이는 텍스트 개수 (보통 1~2)
    "font_variety": "single" | "dual" | "multi",                  // 폰트 가짓수. 두 종류 섞이면 "dual"
    "position_variety": "all_bottom" | "mostly_bottom" | "varied" | "all_top",
    "language_tone": "casual" | "formal" | "hype" | "poetic" | "informational" | "humorous" | "emotional",
    "language_features": string[],                                // 예: ["짧은_문장", "체언_종결", "감탄사_사용", "이모지"]
    "narrative_arc": "hook_to_cta" | "list" | "story" | "quote_drop" | "none",
    "rhetorical_patterns": string[],                              // 예: ["대비_구조", "의문문→답", "숫자_강조"]
    "topic_summary": string,                                      // 영상 텍스트 오버레이가 무엇에 대한 것인지 한 문장
    "topic_category": string,                                     // 예: "food_review", "travel", "fashion_haul", "study_vlog", "product_promo", "daily_diary"
    "key_phrases": string[],                                      // ref 텍스트 오버레이에서 핵심/반복 어휘 (5~15개)
    "recurring_structures": string[],                             // 반복되는 문장 구조/템플릿. 예: "오늘은 [N]", "이거 [V]어봤어?", "[숫자]초만에 [V]"
    "subject_substitution_hints": string[],                       // 사용자 영상에 옮길 때 치환 가능한 슬롯 예시. 예: ["떡볶이→[음식]", "여기→[장소]"]
    "repeats_across_cuts": boolean                                // 같은 텍스트가 여러 컷에 걸쳐 유지되는지
  }
}

규칙:
- shots 는 시간 순서. shots[i].end == shots[i+1].start.
- caption_layers 는 컷마다 화면에 보이는 텍스트의 개수만큼 만들어라. 글자가 없으면 빈 배열 [].
- **레이어 분리 기준은 "크기/위치/역할"이 다른 경우가 우선이다.** 크기·화면상 위치(높이)·역할(hook/부연 등)이 다르면 별도 layer 로 분리하라.
  예1: 위에 큰 강조 hook + 아래 작은 부연 설명 → 크기·위치 다름 → layer 2개
  예2: 윗줄 흰색 "요즘 날씨에 가기 좋은"(위) + 아랫줄 노란색 "기린이찌방 한강점"(아래) → 세로 위치가 다르므로 layer 2개 (각 layer color_hex 를 그 줄 색으로)
- **⚠ 색만 다르다고 무조건 분리하지 마라.** 같은 줄·같은 위치·같은 크기의 한 덩어리 안에서 "일부 단어만" 색이 강조된 경우(예: 흰 문장 중 한 단어만 노랑)는 **분리하지 말고 color_runs 로** 표현한다. 분리는 어디까지나 크기/위치/역할이 다를 때다.
- **⚠ 1 layer = 같은 줄·같은 위치·같은 크기의 한 텍스트 덩어리.** 크기/위치/역할이 다른 텍스트를 한 layer 에 \n 으로 합치지 마라(합치면 글자수가 늘어 렌더에서 폰트가 자동 축소돼 원본보다 작아진다). 같은 줄 안 부분 색강조는 color_runs.
- **color_runs 는 "한 줄(같은 위치) 안에서 색만 중간에 바뀌는" 경우 전용** (예: "오늘 [특가] 세일" 중 특가만 빨강). 각 layer 의 크기는 항상 ref 의 그 덩어리 크기를 그대로 유지.
- size_level (각 layer): 그 글자가 화면 너비에서 차지하는 비율로 추정.
  · 1/4 미만 = "small" / 1/4~1/2 = "medium" / 1/2~3/4 = "large" / 3/4↑ = "huge"
  · 강조 hook(가장 크고 먼저 띄는 텍스트)은 거의 항상 large/huge — 길다고 습관적으로 medium 으로 낮추지 마라. caption_pattern.size_contrast 를 dramatic/alternating 으로 적었다면 layer 들 size 가 전부 같을 수 없다(큰 것+작은 것 혼재).
- size_ratio (각 layer): size_level 의 4단계를 **숫자로 정밀화**한 값. 글자 한 줄의 **세로 높이**가 영상 높이에서 차지하는 비율(0~1)을 글자 윗변~아랫변 기준으로 추정한다. 렌더가 이 숫자로 폰트 크기를 직접 정하므로 4단계로 반올림하지 말고 실제 보이는 크기를 그대로 적어라(예: 0.045, 0.083). size_level 과 모순되지 않게: small≈0.03, medium≈0.05, large≈0.07, huge≈0.10 부근. 같은 컷에 큰 자막/작은 자막이 섞이면 size_ratio 도 분명히 달라야 한다.
- color_hex: 흰색 "#FFFFFF", 검정 "#000000", 노란 강조 "#FFE600" 등 정확히 추정.
- font_category: 가장 가까운 카테고리. 굵은 산세리프=sans+bold, 세리프=serif, 손글씨/필기체=handwritten,
  가로폭 좁은 압축형=condensed, 둥근 곡선=rounded, 거대한 임팩트 폰트=display.
  · 한 컷에 두 개 텍스트가 보이면 폰트가 명확히 다른지 자세히 봐라.
    본문(메인) = 굵은 sans 가 흔하고, 강조/장식(보조) = handwritten / serif / display 인 경우가 많다.
    똑같이 sans 로 답하지 말고, 시각적으로 다르면 다른 카테고리로 정확히 분류해라.
- font_personality: 폰트의 시각적 인상을 다음 중 가장 가까운 한 가지로 분류해라. category 와 직교한다.
  · modern              — 깔끔하고 균형 잡힌 현대적 sans (Pretendard / Noto Sans 류)
  · vintage             — 옛스러운 세리프나 신문체 느낌 (Song Myung 류)
  · playful             — 둥글둥글하고 발랄, 친근한 톤 (Jua / Gowun Dodum 류)
  · elegant             — 가늘고 우아한 세리프나 사뿐한 sans (Nanum Myeongjo / Gowun Batang 류)
  · bold_impact         — 매우 굵고 강한 헤드라인 (Black Han Sans / Do Hyeon 류)
  · minimal             — 가늘고 군더더기 없는 (Sunflower Light / Gowun Dodum 류)
  · retro               — 80~90 년대풍 디스플레이, 약간 비뚤배뚤 (Yeon Sung / Stylish 류)
  · handwritten_neat    — 정돈된 손글씨, 일기체 (Gaegu / Single Day / Hi Melody 류)
  · handwritten_brush   — 붓글씨/유려한 필기체 (Nanum Brush / Nanum Pen 류)
  · display_decorative  — 장식적/유니크 디스플레이, 캐릭터성 강함 (Cute Font / Kirang Haerang 류)
- italic: 글자가 시각적으로 기울어져 있으면 true. 굵기와 별개. 한국어 영상에서는 드물지만 영문/숫자 자막에서는 흔하다.
- **자막 위치 (position / vertical_ratio / horizontal_align) — 컷마다 실제 보이는 위치를 정직하게 측정해라.**
  · position: 화면 상단(=top), 중앙(=center), 하단(=bottom).
  · vertical_ratio: 자막 세로 중심의 실제 높이 (0=맨 위 ~ 1=맨 아래). position 보다 정밀하니 화면에 보이는 그대로. 예) 상단 로고자막 0.12, 중앙 훅 0.5, 하단 설명 0.86.
  · horizontal_ratio: 자막 가로 중심의 실제 위치 (0=왼쪽 끝 ~ 0.5=중앙 ~ 1=오른쪽 끝). 화면에 보이는 그대로 숫자로. 예) 왼쪽 정렬 0.28, 가운데 0.5, 오른쪽 0.72. **무조건 0.5 로 채우지 마라** — 실제로 왼/오른쪽에 치우쳤으면 그 값을.
  · horizontal_align: 블록 내 줄 정렬(좌/중/우). 실제 정렬을 반영하고 그냥 center 로 통일하지 마라.
  · ⚠ **모든 컷을 같은 위치(예: 전부 bottom/center/0.85)로 채우지 마라 — 특별한 이유 없이 균일하게 답하는 건 거의 항상 관찰 오류다.** 자막이 컷마다 다른 높이/정렬에 있으면 그 차이를 반드시 반영하고, 정말로 영상이 전부 같은 위치일 때만 동일하게 답해라.
  · caption_pattern.position_variety 는 위 shots 의 실제 position/vertical_ratio 분포와 일치시켜라 (전부 하단=all_bottom, 대부분 하단=mostly_bottom, 섞임=varied, 전부 상단=all_top).
- required_tags 는 영어 snake_case (예: ["food","close_up","indoor","slow_motion"]).
- caption_global_style 은 자막이 화면에 한 번이라도 등장하면 반드시 모든 필드 채워라.
  · 자막이 전혀 없으면 빈 값으로 두지 말고 합리적 기본값으로 채워라 (흰 글자, 검정 외곽선, 중간 크기, sans, bold).
  · 색은 정확한 hex 가 어렵더라도 가장 가까운 값을 추정해라. 흰색은 "#FFFFFF", 검정은 "#000000", 노랑은 "#FFE600" 같은 식.
  · 글자가 굵으면 "bold", 아주 굵고 두꺼우면 "black", 일반 두께면 "regular".
  · 화면 대비 글자 비율이 작으면 "small", 일반적이면 "medium", 화면의 1/8 이상이면 "large", 화면을 거의 채우면 "huge".
- **caption_layers 의 디자인 디테일 필드들 — 화면에서 보이는 그대로 정확히 채워라.**

  ⚠⚠ **가독성 보장은 자막 디자인의 최우선 원칙이다.** 영상에 자막이 있으면 시청자가 1초 안에 읽을 수 있어야 한다. 따라서:
  · 글자 색이 배경과 비슷한 명도면 (예: 밝은 배경 위 옅은 글자) 반드시 outline 또는 background_box 둘 중 하나는 보임. 둘 다 "없음" 으로 답하면 자막이 실제 영상에서 안 보였다는 것 — 거의 그런 경우는 없다.
  · 시각적으로 외곽선이 가늘게라도 보이면 outline_thickness="thin" 으로 답하지 말고 **실제 픽셀 두께를 정직하게 추정**해라. 글자 굵기의 1/15 이하면 "thin", 1/8 ~ 1/15 이면 "medium", 그보다 굵으면 "thick".
  · 그림자/외곽선이 둘 다 안 보여도 글자가 또렷이 잘 보이면 그건 배경이 충분히 어둡고 글자가 충분히 밝아 (또는 그 반대) 자연스러운 대비가 보장된 경우. 그렇지 않다면 반드시 outline 또는 box 가 있다.

  · outline (글자 테두리): 글자 가장자리에 다른 색 윤곽선이 보이면 outline_color_hex 채우고 outline_thickness 정함. 윤곽선 없으면 outline_thickness="none". 글자색이 흰색이면 outline 은 보통 검정, 글자색이 검정이면 outline 은 보통 흰색.
  · shadow (그림자): 글자 아래/뒤로 떨어지는 그림자가 보이면 has_shadow=true. 또렷한 한 방향 그림자면 shadow_blur=0~3, 부드럽게 퍼지면 8~20.
    ⚠⚠ **글자 '획 주변'만 어둡게 번지고 획 사이 여백은 배경이 그대로 비쳐 보이면 그건 박스가 아니라 '부드러운 그림자/글로우'다.** (큰 흰/노란 글씨 뒤로 어두운 그림자가 깔린, 박스 없는 임팩트 자막에서 매우 흔함.) → has_background_box=false 로 두고, has_shadow=true + shadow_blur 를 10~20 으로(많이 번질수록 크게) 채워라. 같은 색으로 빛나듯 번지면 has_glow=true + glow_color_hex 를 그 번짐 색으로(어두우면 검정 계열). 이 경우에도 박스는 반드시 false.
  · **background_box (박스 배경)**: 글자 뒤로 **글자보다 넓은 사각/알약형 색 면(획 사이 여백까지 같은 색으로 메워진 판)** 이 깔려 그 위에 다른 색 글자가 얹혔을 때만 has_background_box=true.
    박스가 시각적으로 거의 안 보이면 false.
    ⚠ **글자 '획' 자체가 노랑/빨강 등 유채색인 것은 박스가 아니라 '색 글씨'다 → has_background_box=false 로 두고 그 색을 color_hex 에 넣어라.** 검정으로 보이는 건 보통 글자가 아니라 외곽선(outline)이다. 글자색=박스색(노란 글씨를 노란 박스로)인 답은 거의 항상 오판.
  · background_alpha: 박스 불투명도. 또렷한 솔리드 박스 = 1.0, 영상이 살짝 비치는 반투명 = 0.4~0.7, 거의 안 보이는 흐릿한 박스 = 0.2~0.3. 박스가 없으면(=false) 무시.
  · background_radius: 모서리가 각지면 0, 살짝 둥글면 12~16, 알약형이면 999.
  · background_color_hex: has_background_box=true 일 때만 채운다(false 면 ""). 박스 색은 '글자 획 사이 여백까지 채운 분리된 사각 면'의 색이며 글자색과 명도가 달라야 한다(흰 글자에 흰 박스 금지). 글자 자체가 컬러인 것을 여기 넣지 마라 — 그건 color_hex 다.
  · gradient (글자 자체 그라데이션): **글자 안에서 색이 변하면 type="linear" + stops 정확히**. 예) 위 빨강 → 아래 노랑이면 angle=0 + stops=[{offset:0,color:"#FF0000"},{offset:1,color:"#FFE600"}]. 그라데이션 없으면 type="none", stops=[].
  · glow (글로우/네온): 글자 가장자리에서 같은 색 또는 살짝 다른 색이 빛나듯 퍼지면 has_glow=true. 네온 사인이나 노을빛 느낌이 단서.
  · letter_spacing: 자간이 일반보다 좁아 보이면 "tight", 일반은 "normal", 넓게 띄워져 있으면 "wide".
  · entry_animation: 자막이 갑자기 "탁" 튀어나오면 "none", 부드럽게 페이드인이면 "fade". 확신 못 하면 "fade".

- **자가 검증 — caption_layers 작성 후 다음 질문에 모두 "예" 인지 확인:**
  · 글자색과 배경의 명도 차이가 충분한가? 아니라면 outline_thickness 또는 has_background_box 둘 중 하나는 켜져 있나?
  · outline_color_hex 는 글자색과 명도가 충분히 다른가? (흰 글자에 회색 외곽선 같은 답 금지)
  · 모든 컷의 position/horizontal_align/vertical_ratio 를 똑같은 값으로 답하지 않았는가? 균일하게 적었다면 영상이 정말 그런지 컷별 높이를 다시 확인해라.
- **신규 디자인 필드들도 caption_global_style 의 has_outline/outline_color 와 일치해야 자연스럽다.** layer 별 outline 이 다른 영상이 아니면 모든 layer 의 outline_color_hex 가 동일.
- 절대 JSON 외 텍스트 출력 금지.`;


// ============================================================
// Stage 0 재분석 프롬프트 — 사용자가 "다시 분석하기" 를 눌렀을 때.
// 이전 분석 결과를 함께 넣어, 같은 자리를 똑같이 답하지 말고 **놓친/부정확
// /불충분한 부분만 골라 보강** 하도록 유도한다.
// 출력 스키마는 메인 분석과 동일 — 이전 결과 + 새 발견을 합친 완전한 spec.
// 한 번 더 같은 모델에게 같은 영상을 보여줘서 "second pass" 효과를 노린다.
// ============================================================
export function buildReanalysisPrompt(previousSpec: any, userFocus?: string): string {
  const trimmedPrev = pruneSpecForPrompt(previousSpec);
  const previousJson = JSON.stringify(trimmedPrev, null, 2);

  const focusBlock = (userFocus || '').trim()
    ? `사용자가 이번 패스에서 특히 봐주길 원하는 포인트:
"""
${userFocus!.trim().slice(0, 800)}
"""
위 포인트를 우선 깊이 보고, 그 외에도 이전 분석이 놓친 영역이 있으면 함께 보강해라.

`
    : '';

  return `너는 같은 레퍼런스 영상을 두 번째로 다시 보는 편집 디렉터다.
이전 패스의 분석 결과가 아래에 있으니 **반복 작업을 최소화하고**, 이번엔 그때 놓친
부분을 집중적으로 잡는 second-pass 분석을 해라.

${focusBlock}== 이전 분석 결과 (재현하지 말고 보강 대상으로 사용) ==
\`\`\`json
${previousJson}
\`\`\`

== 재분석 지시 ==
이전 결과를 그대로 베껴서 출력하지 마라. 영상을 다시 보고 다음을 찾아내라:

1. **빠진 컷** — shots[] 에 누락된 cut boundary 가 있으면 추가 (특히 짧은 컷·점프컷).
2. **부정확한 텍스트** — caption_layers[].text 가 추측이거나 일부만 적혀 있으면, 다시 보고 정확히 받아 적어라.
   · 글자가 흐릿하면 빈 문자열 "" 로 정정 (틀린 추측 유지 금지).
   · 한글이 알파벳/번역으로 잘못 적혀 있으면 한글 그대로 정정.
3. **빈약한 디자인 디테일** — caption_layers 의 outline / shadow / background_box / gradient / glow / letter_spacing /
   entry_animation 같은 디자인 필드가 default 값 그대로(예: outline_thickness="none", has_shadow=false, gradient.type="none")
   적혀 있는데 실제 영상에선 보이면 정직하게 갱신해라.
4. **일반적인 묘사** — scene_description / subject / composition / camera_motion 가 너무 일반적("a person", "indoor")
   이면 영상에서 더 구체적인 단서를 찾아 풍부하게.
5. **놓친 패턴** — caption_pattern 의 recurring_structures / subject_substitution_hints / key_phrases 가 빈약하면
   영상의 반복 구조를 다시 살펴 채워라.
6. **color_style / audio_profile** 의 mood / bgm_genre / bgm_instruments 가 generic 하다면 실제 톤·악기 단서를 잡아 정정.

== 출력 규칙 ==
- 출력 JSON 스키마는 **메인 분석과 정확히 동일**. 같은 모든 필드를 채워라.
- 이전 분석에서 **정확했던 부분(검증된 shot boundary, 명확한 텍스트 등)은 그대로 유지** 하면서,
  위에서 찾은 보강 사항을 **함께 반영한 완전한 새 spec** 하나만 출력해라.
- 절대 \`\`\`json 같은 코드펜스 / 설명 / 주석 / 마크다운 출력 금지. JSON 객체 하나만.

(스키마 / 규칙 — 동일하게 따라라)

${REFERENCE_ANALYSIS_PROMPT}`;
}

// 프롬프트에 넣기 위해 이전 spec 을 가볍게 가공.
// raw spec 은 shots 수가 많아지면 토큰 부담이 크므로, 분석에 핵심적인 필드만 남긴다.
function pruneSpecForPrompt(spec: any): any {
  if (!spec || typeof spec !== 'object') return {};
  const pruned: any = {
    duration: spec.duration,
    aspect_ratio: spec.aspect_ratio,
    pacing: spec.pacing,
    color_style: spec.color_style,
    audio_profile: spec.audio_profile,
    caption_global_style: spec.caption_global_style,
    caption_pattern: spec.caption_pattern,
  };
  if (Array.isArray(spec.shots)) {
    pruned.shots = spec.shots.map((s: any) => ({
      index: s.index,
      start: s.start,
      end: s.end,
      duration: s.duration,
      shot_type: s.shot_type,
      subject: s.subject,
      scene_description: s.scene_description,
      composition: s.composition,
      camera_motion: s.camera_motion,
      transition_to_next: s.transition_to_next,
      // caption_layers 는 텍스트와 핵심 디자인 필드만 (디자인 디테일은 전체 보존)
      caption_layers: Array.isArray(s.caption_layers) ? s.caption_layers : [],
      required_tags: Array.isArray(s.required_tags) ? s.required_tags : [],
    }));
  }
  return pruned;
}


// ============================================================
// Stage 0 의 2차 패스 — 영상의 텍스트 오버레이만 집중 추출.
// 메인 분석에서 한글이 잘 안 잡힐 때를 보강한다.
// 입력: 영상 1개. 출력: shots_text + caption_pattern.
// 결과를 메인 spec 의 caption_layers / caption_pattern 에 덮어쓴다.
// ============================================================
export const REFERENCE_TEXT_FOCUSED_PROMPT = `너는 영상 OCR + 디자인 분석가다.
오직 영상 위에 그래픽으로 얹힌 "텍스트 오버레이" 만 본다. 다른 시각 정보는 무시한다.

⚠⚠ 한국어(한글) 텍스트 인식 — 절대 준수:
- 화면에 표시된 한글은 반드시 **한글 문자 그대로** 적어라.
- 영문 / 로마자 / 영어 번역으로 변환 금지.
- 받침·이중모음·복합자음 하나도 틀리지 말고 보이는 그대로.
- 띄어쓰기와 줄바꿈은 화면에 보이는 그대로.
- 글자가 흐릿하거나 잘 안 보이면 **추측 금지, 빈 문자열 ""** 로 두어라.
- 한글 + 영문/숫자 혼용은 그 형태 그대로.

각 컷에서 보이는 텍스트 오버레이를 모두 잡아라. 한 컷에 여러 텍스트가 동시에 있으면 layers 배열에 모두 포함.
shot_index 는 영상의 시각적 컷 순서로 0 부터 매기고, shot_start / shot_end 는 그 컷의 시간(초).
텍스트 없는 컷은 layers: [] 로 포함.

각 layer 의 position / vertical_ratio / horizontal_ratio / horizontal_align 은 화면에서 자막이 실제로 보이는 위치 그대로 채워라.
⚠ 모든 컷을 같은 위치(전부 bottom/center/동일 vertical_ratio/horizontal_ratio=0.5)로 통일하지 마라 — 컷마다 위치가 다르면 그 차이를 반영하고(특히 가로로 왼/오른쪽 치우침은 horizontal_ratio 로), 정말 균일할 때만 동일하게. caption_pattern.position_variety 도 실제 분포와 일치시켜라.

자막 "형태"를 정확히 잡아라 (가장 흔한 오류이니 엄격히):
- **색깔 글씨 vs 박스 구분**: has_background_box=true 는 '글자 뒤로 글자보다 넓은 사각/알약형 색 면(획 사이 여백까지 같은 색으로 메워진 판)'이 있고 그 위에 다른 색 글자가 얹혔을 때만. ⚠ 글자 '획' 자체가 노랑/빨강 등 유채색이면 박스가 아니라 '색 글씨'다 → has_background_box=false, background_color_hex="", 그 색을 color_hex 에. 검정으로 보이는 건 보통 글자가 아니라 외곽선(outline)이다. 글자색=박스색(노란 글씨를 노란 박스로)인 답은 거의 항상 오판. ⚠ **글자 획 주변만 어둡게 번지고 획 사이 여백은 배경이 비쳐 보이면 그것도 박스가 아니라 그림자/글로우다** → has_background_box=false, has_shadow=true + shadow_blur 10~20 (또는 has_glow=true + 어두운 glow_color_hex).
- **색/스타일 다른 줄 분리**: 1 layer = 같은 색·크기·줄의 한 덩어리. 색이 다르거나(예: 윗줄 흰색 "요즘 날씨에 가기 좋은" + 아랫줄 노란색 "기린이찌방 한강점") 크기·역할이 다르면 반드시 별도 layer 로 분리하고 각 layer color_hex 를 그 줄 색으로. **절대 \n 으로 한 layer 에 합치지 마라.** (한 줄 안에서 일부 단어만 색이 바뀔 때만 color_runs.)
- **size_level**: 그 한 덩어리가 화면 너비에서 차지하는 비율 — 1/4미만 small / 1/4~1/2 medium / 1/2~3/4 large / 3/4↑ huge. 강조 hook 은 거의 항상 large/huge(습관적 medium 금지). size_contrast 를 dramatic 으로 적었으면 size 가 전부 같을 수 없다.
- **자가검증**: (1) box=true 라면 글자 사이 여백까지 칠해진 판이 정말 보이나? 아니면 색 글씨다. (2) 색 다른 줄을 한 layer 로 합치지 않았나? (3) layers 개수가 caption_pattern.layer_count_typical 과 모순되지 않나?

응답 JSON 만, 다른 텍스트 금지:

{
  "shots_text": [
    {
      "shot_index": number,
      "shot_start": number,
      "shot_end": number,
      "layers": [
        {
          "text": string,
          "position": "top" | "center" | "bottom",
          "vertical_ratio": number,              // 자막 세로 중심 위치 0.0(맨 위)~1.0(맨 아래). position 보다 정밀 — 화면에서 실제 보이는 높이를 정확히 추정 (예: 살짝 위 0.18, 한가운데 0.5, 하단 0.86). 정형화 방지에 중요.
          "horizontal_ratio": number,            // 자막 가로 중심 위치 0.0(왼쪽 끝)~0.5(중앙)~1.0(오른쪽 끝). horizontal_align 보다 정밀 — 화면에서 실제 보이는 가로 위치를 정확히 추정. 무조건 0.5(center)로 통일하지 말고 실제 위치를 반영.
          "horizontal_align": "left" | "center" | "right",
          "size_level": "small" | "medium" | "large" | "huge",
          "size_ratio": number,                  // 정밀 크기: 글자 한 줄의 높이가 영상 높이에서 차지하는 비율 0~1 (윗변~아랫변). 4단계로 뭉개지 말고 숫자로(예: 0.045, 0.083). size_level 과 일관: small≈0.03/medium≈0.05/large≈0.07/huge≈0.10.
          "color_hex": string,
          "color_runs": [                        // "한 덩어리 안"에서 색만 중간에 바뀔 때 전용. 색 일정하면 []. runs.text 이으면 text 와 동일. ⚠ 크기/위치 다른 별개 텍스트를 색 다르다고 합치지 마라(각각 별도 layer). 합치면 길어져 폰트가 작아짐.
            { "text": string, "color_hex": string }
          ],
          "emphasis": "regular" | "bold" | "black",
          "italic": boolean,
          "font_category": "sans" | "serif" | "handwritten" | "condensed" | "rounded" | "display",
          "font_personality": "modern" | "vintage" | "playful" | "elegant" | "bold_impact" | "minimal" | "retro" | "handwritten_neat" | "handwritten_brush" | "display_decorative",
          "font_family_hint": string,            // 글자 모양 재현용 — 폰트 이름이 떠오르면 추정 (예: "Black Han Sans", "Pretendard", "BM Hanna", "G마켓 산스"). 모르면 "".
          "font_width": "normal" | "condensed" | "expanded",            // 자폭: 좁고 길쭉하면 condensed, 넓으면 expanded, 보통은 normal.
          "font_weight_hint": "thin" | "light" | "regular" | "medium" | "bold" | "black",   // 굵기 인상 (아주 두꺼우면 black).
          "font_style_notes": string,            // 자유 서술 (예: "둥근 고딕", "각진 헤드라인", "약간 손글씨"). 모르면 "".
          "role": "hook" | "fact" | "punchline" | "question" | "cta" | "quote" | "label" | "emphasis" | "decoration",
          "tone": "casual" | "formal" | "hype" | "poetic" | "informational" | "humorous" | "emotional",

          "outline_color_hex": string,
          "outline_thickness": "none" | "thin" | "medium" | "thick",
          "has_shadow": boolean,
          "shadow_color_hex": string,
          "shadow_blur": number,
          "has_background_box": boolean,         // 글자 뒤 '분리된 색 판'(획 사이 여백까지 메워짐)이 있을 때만 true. 글자 자체가 컬러인 건 false.
          "background_color_hex": string,        // box=true 일 때만. false 면 "". 글자색은 color_hex 에.
          "background_alpha": number,
          "background_radius": number,
          "gradient": { "type": "linear" | "none", "angle": number, "stops": [ { "offset": number, "color": string } ] },
          "has_glow": boolean,
          "glow_color_hex": string,
          "glow_radius": number,
          "letter_spacing": "tight" | "normal" | "wide",
          "entry_animation": "none" | "fade"
        }
      ]
    }
  ],
  "caption_pattern": {
    "frequency": "every_cut" | "most_cuts" | "occasional" | "rare" | "never",
    "average_char_count": number,
    "max_char_count": number,
    "size_contrast": "uniform" | "alternating" | "dramatic",
    "layer_count_typical": number,
    "font_variety": "single" | "dual" | "multi",
    "position_variety": "all_bottom" | "mostly_bottom" | "varied" | "all_top",
    "language_tone": "casual" | "formal" | "hype" | "poetic" | "informational" | "humorous" | "emotional",
    "language_features": string[],
    "narrative_arc": "hook_to_cta" | "list" | "story" | "quote_drop" | "none",
    "rhetorical_patterns": string[],
    "topic_summary": string,
    "topic_category": string,
    "key_phrases": string[],
    "recurring_structures": string[],
    "subject_substitution_hints": string[],
    "repeats_across_cuts": boolean
  }
}`;


// ============================================================
// Stage 0 — 자막 위치 로컬라이제이션 (zoom-in 1단계)
// 풀프레임을 보여주고 '자막 오버레이의 bounding box' 만 받는다. (vertical_ratio 오차에 강함)
// 받은 bbox 로 타이트하게 크롭한 뒤 buildCaptionCropAnalysisPrompt 로 스타일을 정밀하게 읽는다.
// ============================================================
export function buildCaptionLocalizePrompt(frames: { idx: number; hints: string[] }[]): string {
  const list = frames
    .map(f => `- image[${f.idx}]${f.hints.length ? `: 이 프레임에 있을 법한 자막(힌트)=${f.hints.map(h => `"${h}"`).join(', ')}` : ''}`)
    .join('\n');
  return `너는 영상 프레임에서 '텍스트 오버레이(편집으로 얹은 자막)'의 위치를 찾는 로컬라이저다.
첨부된 각 이미지(프레임)에서 자막 텍스트 덩어리들의 위치를 bounding box 로 찾아라.
⚠ 배경에 원래 있는 글자(간판/포장지/로고/메뉴판 등)는 제외하고, '편집으로 화면에 얹은 자막'만 잡아라.

이미지 목록:
${list}

규칙:
- 한 줄(한 색·한 위치의 덩어리)을 box 하나로. 윗줄/아랫줄 색이 다르면 각각 별도 box.
- 좌표는 정규화 0~1: x,y = 박스 좌상단, w,h = 폭/높이. (퍼센트 아님)
- 자막이 없으면 captions: [].
- text 에는 그 박스에서 실제로 보이는 글자를 적어라(힌트를 그대로 베끼지 말 것).

JSON 만 출력:
{
  "frames": [
    { "idx": number, "captions": [ { "text": string, "x": number, "y": number, "w": number, "h": number } ] }
  ]
}`;
}

// ============================================================
// Stage 0 — 자막 크롭 정밀분석 (zoom-in)
// 각 자막의 세로 위치(vertical_ratio) 기준 가로 밴드를 크롭·업스케일한 이미지를 보낸다.
// 자막이 이미지를 꽉 채우므로 색/박스/그림자/굵기/폰트를 풀프레임보다 정확히 읽는다.
// 입력: 크롭 이미지 N장(순서대로 caption 0..N-1) + 각 caption 의 현재 추정 텍스트.
// 출력: caption 별 정밀 스타일. (위치/크기는 메인 분석 값을 유지하므로 여기서 다루지 않음)
// ============================================================
export function buildCaptionCropAnalysisPrompt(crops: { idx: number; text: string; size_level?: string }[]): string {
  const list = crops
    .map(c => `- image[${c.idx}]: 현재 추정 텍스트="${c.text}"${c.size_level ? ` (size=${c.size_level})` : ''}`)
    .join('\n');
  return `너는 영상 자막의 '디자인'을 픽셀 단위로 읽는 분석가다.
첨부된 각 이미지는 레퍼런스 영상에서 자막 한 줄(덩어리)만 확대(크롭)한 것이다. 자막이 이미지를 거의 꽉 채운다.
각 이미지의 자막 스타일을 매우 정확히 읽어라.

첨부 이미지 ↔ caption 매핑 (순서대로):
${list}

⚠⚠ 가장 흔한 오판 — 반드시 지켜라:
- **유채색(노랑/빨강/초록 등) 굵은 글씨를 '색 박스'로 착각하지 마라.** 글자 '획' 자체가 유채색이면 그건 색 글씨다 → color_hex 에 그 색, has_background_box=false.
- 글자 획 둘레의 검정/어두운 테두리는 '글자'가 아니라 outline(외곽선) 또는 shadow 다. 그걸 color_hex(검은 글씨)로 적지 마라.
- has_background_box=true 는 '글자 획 사이 여백까지 같은 색으로 메워진, 글자보다 넓은 사각/알약 판' 위에 다른 색 글자가 얹혔을 때만. 보통 그 판 색은 검정/흰/회색 계열이다. **유채색 '박스' 답은 거의 항상 색 글씨 오판이다.**
- 글자 획 주변만 부드럽게 어둡게 번지면 box 가 아니라 has_shadow=true(+shadow_blur 10~20) 또는 has_glow.
- 굵기(font_weight_hint)·자폭(font_width)·폰트 인상(font_family_hint)을 확대 이미지로 정직하게. 매우 두꺼우면 "black".
- **text 에는 이 크롭에서 '실제로 보이는' 자막 글자를 적어라(위의 현재 추정 텍스트를 그대로 베끼지 말 것).**
  자막이 안 보이거나 위 추정과 다른 내용이면 본 그대로(또는 빈 문자열) 적어라 — 이 값으로 크롭이 올바른 자막을 담았는지 검증한다.
- 한글은 한글 그대로. 흐리면 추측 금지.

각 caption 에 대해 아래 스키마로만 출력. JSON 외 텍스트/마크다운/코드펜스 금지.

{
  "captions": [
    {
      "idx": number,
      "text": string,
      "color_hex": string,
      "color_runs": [ { "text": string, "color_hex": string } ],
      "emphasis": "regular" | "bold" | "black",
      "font_weight_hint": "thin" | "light" | "regular" | "medium" | "bold" | "black",
      "font_weight": number,                 // 정밀 굵기 100~900(thin100 light300 regular400 medium500 bold700 black900). 확대 이미지로 정직하게 숫자로. font_weight_hint 보다 우선.
      "font_family_hint": string,
      "font_width": "normal" | "condensed" | "expanded",
      "font_width_ratio": number,            // 정밀 자폭 %(100=기본, 좁음 80~90, 넓음 110~130). 모르면 100.
      "outline_color_hex": string,
      "outline_thickness": "none" | "thin" | "medium" | "thick",
      "outline_ratio": number,               // 정밀 외곽선 두께 ÷ 글자높이(0~0.15, 0=없음). 4단계로 뭉개지 말고 숫자로. outline_thickness 보다 우선.
      "has_shadow": boolean,
      "shadow_color_hex": string,
      "shadow_blur": number,                 // 0~24. 그림자 흐림 반경 px.
      "shadow_offset_x": number,             // 그림자 가로 오프셋 px(오른쪽+/왼쪽-). 없으면 0.
      "shadow_offset_y": number,             // 그림자 세로 오프셋 px(아래+/위-). 없으면 4.
      "has_background_box": boolean,
      "background_color_hex": string,
      "background_alpha": number,
      "has_glow": boolean,
      "glow_color_hex": string,
      "glow_radius": number,                 // 0~28. 광 퍼짐 반경 px. 0=글로우 없음.
      "letter_spacing": "tight" | "normal" | "wide",
      "letter_spacing_em": number            // 정밀 자간 em(-0.05~0.15). 좁으면 음수, 넓으면 양수. 모르면 0. letter_spacing 보다 우선.
    }
  ]
}`;
}

// ============================================================
// Caption Planning 프롬프트 (Gemini Flash, 텍스트만)
// Stage 1 매칭 후 호출. 레퍼런스의 자막 layers 패턴을 그대로 모방해서
// 사용자 소스 컷마다 어울리는 한글 자막 layers 를 작성.
// ============================================================
export function buildCaptionPlanningPrompt(args: {
  userDirectionBlock: string;       // styleBrief + styleNote 가 미리 합쳐진 블록 (비어있으면 빈 문자열)
  captionMode?: string;             // none | per_scene | continuous
  captionLanguage?: string;         // ko | en | mixed
  refCutsWithLayers: { idx: number; layers: any[] }[];
  refPattern: any;
  cuts: {
    idx: number;
    duration: number;
    spoken: string;
    description: string;
    shot_type: string;
    subject_center_x: number;
    subject_center_y: number;
    matched_ref_idx: number;
    matched_ref_layers: any[];
  }[];
  extraFeedback?: string;
  groundedFrames?: boolean;       // true 면 각 cut 의 실제 편집본 프레임이 image[idx] 로 첨부됨.
}): string {
  // ref layer 의 "색" 디자인을 LLM 에 그대로 노출한다 (작성지침의 '그대로 복사'가 실효를 갖도록).
  // 박스/외곽선/그라데이션/글로우/color_runs 는 이전엔 프롬프트 어디에도 안 보여 LLM 이
  // 재현할 수 없었다 → 흰 글씨·박스 없음으로 표류하던 핵심 원인. (값 없으면 토큰 절약 위해 생략.)
  const layerColorBits = (l: any): string => {
    const parts: string[] = [];
    if (l.color_hex) parts.push(`color=${l.color_hex}`);
    if (l.has_background_box) parts.push(`box=${l.background_color_hex || '#000000'}`);
    if (l.outline_color_hex && l.outline_thickness && l.outline_thickness !== 'none') {
      parts.push(`outline=${l.outline_color_hex}(${l.outline_thickness})`);
    }
    if (l.gradient && Array.isArray(l.gradient.stops) && l.gradient.stops.length > 0) {
      parts.push(`grad=${l.gradient.stops.map((s: any) => s.color).filter(Boolean).join('>')}`);
    }
    if (l.has_glow && l.glow_color_hex) parts.push(`glow=${l.glow_color_hex}`);
    if (l.has_shadow) {
      const sb = Number(l.shadow_blur);
      parts.push(Number.isFinite(sb) && sb > 0 ? `shadow(blur${Math.round(sb)})` : 'shadow');
    }
    if (Array.isArray(l.color_runs) && l.color_runs.length >= 2) {
      parts.push(`runs=${l.color_runs.map((r: any) => r.color_hex).filter(Boolean).join('|')}`);
    }
    return parts.join(' ');
  };
  // ref layer 의 정밀 위치(0~1) 노출. top/center/bottom·center 로 뭉개지 말고 이 좌표를 유지하도록.
  const layerPosBits = (l: any): string => {
    const parts: string[] = [];
    const v = Number(l.vertical_ratio);
    if (Number.isFinite(v) && v >= 0 && v <= 1) parts.push(`vr=${v.toFixed(2)}`);
    const h = Number(l.horizontal_ratio);
    if (Number.isFinite(h) && h >= 0 && h <= 1) parts.push(`hr=${h.toFixed(2)}`);
    return parts.join(' ');
  };

  const refLines = args.refCutsWithLayers
    .filter(c => Array.isArray(c.layers) && c.layers.length > 0)
    .map(c => {
      const ll = c.layers.map((l: any) => {
        const styleBits = [
          l.font_category,
          l.font_personality,
          l.emphasis,
          l.italic ? 'italic' : null,
          l.font_weight_hint ? `w-${l.font_weight_hint}` : null,
          (l.font_width && l.font_width !== 'normal') ? `width-${l.font_width}` : null,
          l.font_family_hint ? `font:${l.font_family_hint}` : null,
        ].filter(Boolean).join('/');
        const cb = layerColorBits(l);
        const pb = layerPosBits(l);
        return `   · ${l.position}/${l.horizontal_align}/${l.size_level}/${styleBits}${cb ? ' ' + cb : ''}${pb ? ' ' + pb : ''} [${l.role}/${l.tone}] "${l.text}"`;
      }).join('\n');
      return `cut ${c.idx} (${c.layers.length}개 텍스트):\n${ll}`;
    }).join('\n');

  const cutLines = args.cuts.map(c => {
    const refLayers = (c.matched_ref_layers || [])
      .map((l: any) => {
        const bits = [l.position, l.size_level, l.font_category, l.font_personality,
          l.italic ? 'italic' : null,
          l.font_weight_hint ? `w-${l.font_weight_hint}` : null,
          (l.font_width && l.font_width !== 'normal') ? `width-${l.font_width}` : null,
          l.font_family_hint ? `font:${l.font_family_hint}` : null,
        ].filter(Boolean).join('/');
        const cb = layerColorBits(l);
        const pb = layerPosBits(l);
        return `${bits}${cb ? ' ' + cb : ''}${pb ? ' ' + pb : ''}[${l.role}]`;
      })
      .join(' + ');
    const safePosition = suggestSafeCaptionPosition(c.subject_center_y);
    return `cut ${c.idx}: ${c.duration.toFixed(2)}s | shot=${c.shot_type} | subject_center=(${c.subject_center_x.toFixed(2)},${c.subject_center_y.toFixed(2)}) | safe_caption_position=${safePosition} | matched_ref=#${c.matched_ref_idx} layers=[${refLayers || '없음'}] | spoken="${(c.spoken || '').slice(0, 150)}" | visual="${(c.description || '').slice(0, 150)}"`;
  }).join('\n');
  const languageBlock = captionLanguageBlock(args.captionLanguage);
  const modeBlock = captionModeBlock(args.captionMode);

  return `너는 영상 위에 얹는 "텍스트 오버레이" 디자이너 겸 카피라이터다.
이것은 음성 받아쓰기 자막이 아니라 **시각 디자인 요소로서의 글자** 다.
레퍼런스 영상의 실제 텍스트 오버레이(글자·디자인·문구) 를 **1차 참고 자료** 로 삼아,
같은 구조/리듬/디자인/주제 영역에서 사용자 영상 컷에 새 텍스트 오버레이를 작성한다.
${languageBlock}
${modeBlock}

═══════════════════════════════
[ref 영상의 실제 텍스트 — 가장 중요한 1차 참고]
═══════════════════════════════
${refLines || '(레퍼런스에 텍스트 오버레이 없음)'}

═══════════════════════════════
[⚠ ref 자막 중 "영상 콘텐츠와 무관한 메타" 는 분석·치환·재사용 모두에서 제외]
═══════════════════════════════
다음 패턴의 ref 자막은 영상이 전하려는 메시지가 아니라 운영용 메타 정보다.
**아래 6개 패턴에 해당하는 layer 는 없는 것으로 간주하고 사용자 컷에도 옮기지 마라.**

  a) 출처/크레딧 — "출처: @user", "by @author", "Credit ...", "원본 ..."
  b) 음악/BGM 정보 — "♪ Song Title - Artist", "Music by ...", "BGM ..."
  c) SNS 핸들/해시태그가 단독 — "@username", "#hashtag" (한 layer 가 거의 핸들만일 때.
     본문 안에 자연스럽게 섞여 있으면 그건 콘텐츠의 일부)
  d) 광고/쿠폰/홍보 — "선착순", "쿠폰코드 XXXX", "지금 신청", "광고/협찬 문의", "DM 주세요"
  e) 워터마크형 가게·브랜드·URL — 한 컷에만 작게 고정된 가게명·도메인·로고 텍스트
  f) 페이지/날짜 헤더 — "1/5", "Day 3", "2025.06.02", "EP.02" 같은 단독 표기

한 layer 안에 콘텐츠 + 메타가 같이 있으면 (예: "오늘은 떡볶이 by @user") 메타 부분만 떼고
콘텐츠 부분("오늘은 떡볶이")만 참고한다.

분석할 때, 치환 예시를 만들 때, frequency·key_phrases·recurring_structures 를 따를 때
**모두 위 메타 layer 를 제외한 "콘텐츠 layer" 만 대상**으로 계산해라.

위 ref 텍스트의 **실제 문구를 직접 보고 분석**해라:
- 어떤 단어/명사가 반복되는가
- 문장 구조가 무엇인가 (예: "오늘은 [N]", "[V]어봐", "[숫자]초만에 [V]")
- 어떻게 시작하고 어떻게 끝맺는가 (종결어미, 인칭, 호흡)
- 어떤 부분이 명사 슬롯(=치환 가능)이고 어떤 부분이 고정구인가

→ **사용자 영상의 텍스트 오버레이는 위 ref 텍스트의 구조와 리듬을 그대로 빌리되,
   슬롯(명사·동작·주제)만 사용자 영상 내용에 맞게 치환** 한다. 이것이 작업의 핵심.

치환 예시:
  ref: "오늘은 진한 라멘" / 사용자=떡볶이 → "오늘은 매콤한 떡볶이"
  ref: "이거 먹어봤어?"   / 사용자=등산   → "여기 가봤어?"
  ref: "이게 진짜 신상"   / 사용자=카페   → "이게 진짜 핫플"

ref 텍스트가 사용자 영상 맥락에도 그대로 들어맞으면 **변경 없이 재사용해도 좋다**.

═══════════════════════════════
[ref 텍스트의 카테고리·패턴 메타]
═══════════════════════════════
- 주제 한 줄: ${args.refPattern?.topic_summary || '(미파악)'}
- 카테고리: ${args.refPattern?.topic_category || '(미파악)'}
- 자주 쓰인 키 문구: ${(args.refPattern?.key_phrases || []).join(' / ') || '(없음)'}
- 반복 구조 템플릿: ${(args.refPattern?.recurring_structures || []).join(' / ') || '(없음)'}
- 치환 슬롯 힌트: ${(args.refPattern?.subject_substitution_hints || []).join(' / ') || '(없음)'}
- 빈도: ${args.refPattern?.frequency || '?'}  ← 이 빈도를 정확히 따라가라
- 평균/최대 글자수: ${args.refPattern?.average_char_count || '?'} / ${args.refPattern?.max_char_count || '?'}  ← 각 layer text 글자수를 이 범위에 맞춰라(특히 max 를 넘기지 마라). 넘칠 것 같으면 size 를 낮추지 말고 문구를 더 짧게 써라.
- 사이즈 대비: ${args.refPattern?.size_contrast || '?'} (uniform=일정, dramatic=극단적)
- 동시 layer 수: ${args.refPattern?.layer_count_typical || 1}
- 폰트 다양성: ${args.refPattern?.font_variety || 'single'} (dual = 두 종류 섞임)
- 위치 다양성: ${args.refPattern?.position_variety || 'mostly_bottom'}
- 언어 톤: ${args.refPattern?.language_tone || '?'}
- 같은 텍스트가 여러 컷에 유지: ${args.refPattern?.repeats_across_cuts ? 'YES' : 'NO'}

${args.userDirectionBlock || '═══════════════════════════════\n[사용자 영상 스타일 브리프]\n═══════════════════════════════\n(브리프 미입력 — ref 패턴만 따라가라)\n'}
${args.extraFeedback ? `═══════════════════════════════\n[방금 사용자가 준 피드백 — 즉시 반영]\n═══════════════════════════════\n${args.extraFeedback.trim()}\n` : ''}

═══════════════════════════════
[사용자 영상 컷 정보 — 각 컷이 매칭된 ref 의 layers 도 함께]
═══════════════════════════════
${args.groundedFrames ? '⚠ 각 cut 의 **실제 편집본 화면 프레임이 image[cut_index] 순서로 첨부**됐다. 텍스트 묘사보다 그 화면을 우선해서 보고, 장면에 실제로 보이는 내용(피사체·분위기·행동)에 맞는 자막을 써라.\n' : ''}${cutLines}

═══════════════════════════════
[작성 지침]
═══════════════════════════════

1. **ref 텍스트의 실제 문구가 1순위 자료다 (카테고리 메타 < 실제 문구).**
   - matched_ref_layers 의 text 를 직접 보고 같은 구조/리듬으로 사용자 영상 컷의 텍스트 작성.
   - 명사 슬롯만 사용자 영상 주제로 치환한다. 동사/조사/종결어미 등 고정구는 가능하면 유지.
   - ref 텍스트가 사용자 영상 맥락에도 맞으면 그대로 재사용 가능.
   - 절대 ref 텍스트를 무시하고 카테고리만 보고 새로 쓰지 마라.

2. **사용자가 자막 언어를 지정했다면 그 언어 선택이 ref 언어보다 우선이다.**
   - "한국어만 사용"이면 모든 text 를 자연스러운 한국어로 작성한다. 영어 고유명사/브랜드명은 필요할 때만 그대로 둔다.
   - "영어만 사용"이면 모든 text 를 자연스러운 짧은 영어 카피로 작성한다. 한국어 조사/어미를 섞지 마라.
   - "한국어와 영어를 자연스럽게 섞어서 사용"이면 핵심 명사나 짧은 강조어는 영어, 설명/호흡은 한국어처럼 자연스럽게 섞는다.
   - 언어만 바꾸고, ref 의 layer 수/위치/폰트/크기/색/리듬은 최대한 유지한다.

3. **톤은 ref 그대로 — 강제로 변형하지 마라.**
   - ref 가 차분하면 차분하게. ref 가 발랄하면 발랄하게.
   - 인위적인 줄임말/감탄사/SNS 슬랭 강제 금지. ref 의 언어 톤(${args.refPattern?.language_tone || '?'})과 종결어미를 그대로 흉내내라.

4. **폰트는 ref 의 그것을 그대로 복사 (변경 금지).**
   - 컷의 matched_ref_layers 에 적힌 font_category, font_personality, italic 을 layer 순서대로 그대로 사용해라.
     예: matched_ref_layers 가 [sans/modern, handwritten/handwritten_brush] 이면 작성한 layers 도 정확히 그 조합.
   - 임의로 sans 로 통일하거나 다른 카테고리/인상으로 바꾸지 마라.
   - matched_ref_layers 가 비어있고 자막을 새로 만든다면 ref 전체 폰트 다양성을 따라가라.
   - font_personality 는 빈 값으로 두지 말고 ref 와 가장 유사한 값으로 반드시 채워라.

4-bis. **🔥 size_level + size_ratio (글자 크기) 도 ref 그대로 복사 — 절대 임의 변경 금지.**
   - 컷의 matched_ref_layers 의 size_level 을 layer 순서대로 그대로 사용해라 (small/medium/large/huge).
   - **size_ratio (정밀 크기, 글자 높이÷영상 높이) 도 matched_ref_layers 의 값을 그대로 복사.** ref layer 에 size_ratio 가 있으면 그 숫자를 그대로, size_level 과 일관되게(small≈0.03/medium≈0.05/large≈0.07/huge≈0.10).
   - "텍스트가 길어서 작아져야 할 것 같다" 같은 추측으로 임의로 small 로 떨어뜨리지 마라.
     **너의 일은 ref 의 "사이즈 위계" 를 그대로 옮기는 것** — size 는 ref 그대로 두고, 길이는 "문구를 짧게" 써서 맞춘다.
   - **길이는 size 축소가 아니라 문구로 맞춘다:** 한 layer 가 ref 글자수(특히 max_char_count)를 넘기면 size 를 낮추지 말고, 슬롯 치환은 유지하되 수식어/조사를 줄여 더 짧게 다시 써라.
   - size 단계별 권장 글자수(한 줄 기준, 넘으면 문구를 줄여라): huge ≤ 6자, large ≤ 10자, medium ≤ 18자, small ≤ 30자.
   - 예: ref 의 huge 자막이 사용자 컷에서도 huge 여야 한다. large 면 large, medium 이면 medium (size 는 유지하되 글자수만 위 범위로).
   - **이 size_level 필드는 빈 값이나 누락 절대 금지. 모든 layer 가 4개 enum 중 하나로 반드시 지정한다.**
   - matched_ref_layers 가 비어있는 컷에서 새로 만들 때는 ref pattern 의 size_contrast 와 layer_count_typical
     을 보고 결정. uniform 이면 일관 medium, alternating/dramatic 이면 hook 은 huge/large, fact 는 medium. (size_ratio 도 그 size_level 에 맞춰 숫자로 채운다.)

5. **자막은 자연스러운 곳에만. 모든 컷에 강제로 넣지 마라.**
   - ref frequency 가 "rare" / "occasional" 면 사용자 컷도 절반 이하만 자막.
   - 자막을 안 넣을 컷은 "layers": [] 로 두라.
   - 비슷한 내용의 인접 컷은 같은 자막을 그대로 유지 가능 (ref.repeats_across_cuts 가 YES 면 적극 활용).

6. **자막 위치는 ref 패턴을 우선하되, 소스 피사체를 가리면 safe_caption_position 을 우선한다.**
   - layer_count_typical = 2 면 강조해야 할 컷에 2 개, 나머지는 1 개 또는 0 개.
   - cut 정보의 subject_center=(x,y)는 소스 영상에서 주피사체가 있는 위치다. x/y 는 0~1 범위이며 y=0 이 상단, y=1 이 하단이다.
   - safe_caption_position 은 피사체를 덜 가릴 가능성이 높은 추천 위치다.
   - matched_ref_layers 의 position 이 피사체와 겹치지 않으면 그대로 따라가라.
   - matched_ref_layers 의 position 이 피사체 중심과 같은 영역이면 safe_caption_position 으로 옮겨라.
   - 예: subject_center_y 가 0.75 인 음식/제품 컷에서 ref 가 bottom 이면 top 으로 옮기는 편이 좋다.
   - 예: subject_center_y 가 0.25 인 얼굴 클로즈업에서 ref 가 top 이면 bottom 으로 옮기는 편이 좋다.

7. **사이즈/색/굵기 + 외곽선/그림자/박스배경/그라데이션/글로우/자간/등장애니메이션도 matched_ref_layers 그대로 복사가 기본.**
   - matched_ref_layers 의 다음 필드들은 모두 그대로 복사:
     · font_family_hint, font_weight_hint, font_width (글자 폰트·굵기·자폭 인상 — ref 와 같은 폰트로 렌더되도록 그대로 복사. 비우지 마라.)
     · outline_color_hex, outline_thickness
     · has_shadow, shadow_color_hex, shadow_blur (부드러운 그림자/헤일로면 shadow_blur 값까지 그대로)
     · has_background_box, background_color_hex, background_alpha, background_radius
     · gradient (type / angle / stops 전체. stops 의 color 까지 정확히 같게)
     · has_glow, glow_color_hex, glow_radius
     · letter_spacing, entry_animation
     · color_runs (글자 중간에 색이 바뀌는 패턴 — ref 에 있으면 같은 구조로, text 만 우리 카피에 맞춰 바꿔라)
     · vertical_ratio (자막 세로 위치 0~1 — ref 가 둔 높이를 그대로. top/center/bottom 으로 뭉개지 말고 실제 비율 유지)
     · horizontal_ratio (자막 가로 위치 0~1 — ref 가 둔 가로 위치를 그대로. 무조건 0.5(center)로 뭉개지 말 것)
   - **임의로 디자인 값 만들어내지 마라.** ref 와 시각적으로 다르면 매칭의 의미가 사라진다.
   - matched_ref_layers 가 비어있는 컷에서 자막을 새로 만들 때는 caption_global_style 의 has_outline / outline_color_hex / has_shadow / has_background_box / primary_color_hex 등을 따라가라.
   - 사용자 styleNote 가 명시적으로 "박스 배경 빼라" 같은 지시를 했을 때만 변형.

═══════════════════════════════
[응답 형식]
═══════════════════════════════
JSON 만 출력. 다른 텍스트 금지.

{
  "cuts": [
    {
      "cut_index": number,
      "layers": [
        {
          "text": string,
          "position": "top" | "center" | "bottom",
          "vertical_ratio": number,              // 자막 세로 중심 위치 0.0(맨 위)~1.0(맨 아래). position 보다 정밀 — 화면에서 실제 보이는 높이를 정확히 추정 (예: 살짝 위 0.18, 한가운데 0.5, 하단 0.86). 정형화 방지에 중요.
          "horizontal_ratio": number,            // 자막 가로 중심 위치 0.0(왼쪽 끝)~0.5(중앙)~1.0(오른쪽 끝). horizontal_align 보다 정밀 — 화면에서 실제 보이는 가로 위치를 정확히 추정. 무조건 0.5(center)로 통일하지 말고 실제 위치를 반영.
          "horizontal_align": "left" | "center" | "right",
          "size_level": "small" | "medium" | "large" | "huge",
          "size_ratio": number,                  // 정밀 크기: 글자 한 줄의 높이가 영상 높이에서 차지하는 비율 0~1 (윗변~아랫변). 4단계로 뭉개지 말고 숫자로(예: 0.045, 0.083). size_level 과 일관: small≈0.03/medium≈0.05/large≈0.07/huge≈0.10.
          "color_hex": string,
          "color_runs": [                        // "한 덩어리 안"에서 색만 중간에 바뀔 때 전용. 색 일정하면 []. runs.text 이으면 text 와 동일. ⚠ 크기/위치 다른 별개 텍스트를 색 다르다고 합치지 마라(각각 별도 layer). 합치면 길어져 폰트가 작아짐.
            { "text": string, "color_hex": string }
          ],
          "emphasis": "regular" | "bold" | "black",
          "italic": boolean,
          "font_category": "sans" | "serif" | "handwritten" | "condensed" | "rounded" | "display",
          "font_personality": "modern" | "vintage" | "playful" | "elegant" | "bold_impact" | "minimal" | "retro" | "handwritten_neat" | "handwritten_brush" | "display_decorative",
          "font_family_hint": string,            // 글자 모양 재현용 — 폰트 이름이 떠오르면 추정 (예: "Black Han Sans", "Pretendard", "BM Hanna", "G마켓 산스"). 모르면 "".
          "font_width": "normal" | "condensed" | "expanded",            // 자폭: 좁고 길쭉하면 condensed, 넓으면 expanded, 보통은 normal.
          "font_weight_hint": "thin" | "light" | "regular" | "medium" | "bold" | "black",   // 굵기 인상 (아주 두꺼우면 black).
          "font_style_notes": string,            // 자유 서술 (예: "둥근 고딕", "각진 헤드라인", "약간 손글씨"). 모르면 "".
          "role": "hook" | "fact" | "punchline" | "question" | "cta" | "quote" | "label" | "emphasis" | "decoration",
          "tone": "casual" | "formal" | "hype" | "poetic" | "informational" | "humorous" | "emotional",

          "outline_color_hex": string,
          "outline_thickness": "none" | "thin" | "medium" | "thick",
          "has_shadow": boolean,
          "shadow_color_hex": string,
          "shadow_blur": number,
          "has_background_box": boolean,         // 글자 뒤 '분리된 색 판'(획 사이 여백까지 메워짐)이 있을 때만 true. 글자 자체가 컬러인 건 false.
          "background_color_hex": string,        // box=true 일 때만. false 면 "". 글자색은 color_hex 에.
          "background_alpha": number,
          "background_radius": number,
          "gradient": { "type": "linear" | "none", "angle": number, "stops": [ { "offset": number, "color": string } ] },
          "has_glow": boolean,
          "glow_color_hex": string,
          "glow_radius": number,
          "letter_spacing": "tight" | "normal" | "wide",
          "entry_animation": "none" | "fade"
        }
      ]
    }
  ]
}

- 모든 cut 빠짐없이 포함 (자막 없는 컷은 "layers": []).
- 자막 layer 의 font_category 와 font_personality 는 matched_ref_layers 의 값을 그대로 복사하는 것을 기본으로 한다. italic 도 동일하게 복사.
- 작성한 layer 에 시각적으로 어울리는 font_personality 값을 반드시 채워라 (빈 문자열 금지).`;
}

function suggestSafeCaptionPosition(subjectCenterY: number): 'top' | 'bottom' | 'center_or_ref' {
  if (!Number.isFinite(subjectCenterY)) return 'center_or_ref';
  if (subjectCenterY < 0.38) return 'bottom';
  if (subjectCenterY > 0.62) return 'top';
  return 'center_or_ref';
}

function captionModeBlock(mode?: string): string {
  if (mode === 'none') {
    return `

==============================
[최우선: 자막 모드]
==============================
자막 없음 모드다. 모든 cut의 layers는 반드시 []로 둔다.
`;
  }
  if (mode === 'continuous') {
    return `

==============================
[최우선: 자막 모드]
==============================
하나의 자막이 영상 처음부터 끝까지 유지되는 모드다.
- 영상 전체를 관통하는 짧은 대표 문구 1개를 만든다.
- 모든 cut에 같은 layers 배열을 반복해서 넣는다.
- 장면마다 문구를 바꾸지 않는다.
- 같은 위치/크기/폰트/색을 유지해서 하나의 고정 자막처럼 보이게 한다.
- 너무 긴 문장은 피하고, 전체 영상 주제를 대표하는 hook 또는 tagline처럼 쓴다.
`;
  }
  if (mode === 'per_scene') {
    return `

==============================
[최우선: 자막 모드]
==============================
장면마다 바뀌는 자막 모드다.
- 각 cut의 시각 내용과 맥락에 맞게 자막을 **서로 다르게** 쓴다.
- ⚠ 레퍼런스가 모든 컷에 같은 고정 타이틀을 반복하더라도, 그 문구를 그대로 복제하지 마라.
  레퍼런스의 스타일·구조·톤만 빌리고, **각 컷 내용에 맞는 새로운 다른 자막**을 만들어라.
  (예: 공연 컷=공연 관련 카피, 노을 컷=풍경 카피, 맥주 컷=맥주 카피 — 같은 문구 복붙 금지)
- 자막이 필요 없는 장면은 layers: []로 둔다.
`;
  }
  if (mode === 'brand_title') {
    return `

==============================
[최우선: 자막 모드]
==============================
브랜드 타이틀 고정 + 훅 변주 모드다.
- 레퍼런스의 '브랜드/장소명' 줄(보통 강조색=노란 줄 같은 유채색 layer)은 **모든 컷에 같은 문구로 고정**한다.
- 나머지 줄(흰색 훅/설명 layer)은 **각 컷의 시각 내용에 맞춰 서로 다르게 변주**한다.
- 즉 한 layer 는 고정 브랜드, 다른 layer 는 컷마다 다른 훅. layer 개수·위치·색은 레퍼런스 그대로.
`;
  }
  return '';
}

function captionLanguageBlock(mode?: string): string {
  if (mode === 'ko') {
    return `

═══════════════════════════════
[절대 우선: 자막 언어 모드]
═══════════════════════════════
한국어만 사용한다. 모든 non-empty layer.text 는 자연스러운 한국어 카피여야 한다.
레퍼런스가 영어여도 한국어로 바꿔라. 영어는 브랜드명/고유명사처럼 꼭 필요한 경우만 허용한다.
`;
  }
  if (mode === 'en') {
    return `

═══════════════════════════════
[절대 우선: 자막 언어 모드]
═══════════════════════════════
영어만 사용한다. 모든 non-empty layer.text 는 짧고 자연스러운 English copy 여야 한다.
한국어 조사/어미/문장을 섞지 마라. 레퍼런스가 한국어여도 영어로 바꿔라.
`;
  }
  if (mode === 'mixed') {
    return `

═══════════════════════════════
[절대 우선: 자막 언어 모드]
═══════════════════════════════
한국어와 영어를 반드시 섞어서 사용한다.
- 자막이 있는 각 cut 의 전체 text 를 합쳤을 때 한글과 영어 알파벳이 모두 포함되어야 한다.
- layer 가 2개 이상이면 한 layer 는 English keyword/hook, 다른 layer 는 한국어 설명/감정선으로 나누는 방식을 우선한다.
- layer 가 1개뿐이면 "SEOUL MOMENT / 여의도의 순간" 처럼 한글과 영어가 함께 들어가게 작성한다.
- 모든 자막이 한국어만 있거나 영어만 있으면 실패다.
`;
  }
  return '';
}

// ============================================================
// 나레이션 컷 메타 — 각 컷의 시간/내용/자막 정보. narration.ts 가
// edit-plan 으로부터 만들어 buildNarrationOutlinePrompt 에 넘긴다.
// ============================================================
export type TtsCutMeta = {
  cut_index: number;
  output_start: number;
  output_end: number;
  spoken: string;                // source 의 발화 (Stage 1 추출)
  scene: string;                 // source shot 의 한 줄 묘사
  caption_text: string;          // 이 컷에 burn-in 되는 자막
  // ↓ source-shots.json 에서 가져오는 풍부한 메타. 빈 값이면 라인에서 생략.
  subject?: string;              // 주피사체
  shot_type?: string;            // close_up / medium / wide / pov / selfie / product / b_roll
  tags?: string[];               // 영어 snake_case 태그들
  source_filename?: string;      // 원본 파일명 (사용자가 의미있게 지었다면 단서)
};

// ============================================================
// 나레이션 개요 (TTS 합성 전 생성) — source='generate' genMode='auto' 에서 호출.
// 입력:
//   - cuts: edit-plan 각 컷의 (output_start, output_end, spoken, scene, caption_text, …)
//   - userDirectionBlock: styleBrief + styleNote
// 출력 JSON:
//   { segments: [{ cut_index, output_start, output_end, text }] }
// 핵심 제약:
//   - 인접 segment 끼리 시간이 겹치지 않음.
//   - 한 segment 길이(초) * 5자 이하 (한국어 발화 속도).
//   - 각 cut 마다 0~1개 segment. b-roll/침묵 컷은 segment 생략 가능.
// ============================================================
export function buildNarrationOutlinePrompt(args: {
  userDirectionBlock: string;
  totalDuration: number;
  cuts: TtsCutMeta[];
}): string {
  const cutLines = args.cuts.map(c => {
    const dur = (c.output_end - c.output_start).toFixed(2);
    const maxChars = Math.floor((c.output_end - c.output_start) * 5);
    const srcBits: string[] = [];
    if (c.subject) srcBits.push(`subject="${c.subject.slice(0, 60)}"`);
    if (c.shot_type) srcBits.push(`shot=${c.shot_type}`);
    if (c.tags && c.tags.length > 0) srcBits.push(`tags=[${c.tags.slice(0, 6).join(',')}]`);
    if (c.source_filename) srcBits.push(`src=${c.source_filename}`);
    if (c.spoken) srcBits.push(`spoken="${c.spoken.slice(0, 80)}"`);
    if (c.scene) srcBits.push(`scene="${c.scene.slice(0, 100)}"`);
    const srcSuffix = srcBits.length > 0 ? ` | ${srcBits.join(' | ')}` : '';
    return `cut ${c.cut_index} [${c.output_start.toFixed(2)}~${c.output_end.toFixed(2)}s, ${dur}s, max ${maxChars}자] caption="${c.caption_text || ''}"${srcSuffix}`;
  }).join('\n');

  return `너는 짧은 영상의 나레이션 작가다.
아래는 자동 편집된 영상 (총 ${args.totalDuration.toFixed(2)}초) 의 컷 구성이다.
각 컷의 시각 내용·자막을 종합해 자연스러운 음성 나레이션 segments 를 작성해라.

═══════════════════════════════
[작성 원칙]
═══════════════════════════════
- **전체 segments 는 한 편의 짧은 글처럼 이어지게 작성**. 도입(hook)에서 흥미를 끌고, 중간(build)에서 보여주거나 설명하고, 끝(outro)에서 마무리한다. **컷별 독립 묘사 나열이 되지 않게** 유의.
- 자막을 그대로 읽지 마라. 자막은 시각 채널, 나레이션은 별도 청각 채널이다.
- 정보 없는 분위기/연결(b-roll) 컷은 비워두는 게 자연스럽다 (segment 생략).

═══════════════════════════════
[컷 구성]
═══════════════════════════════
${cutLines}

${args.userDirectionBlock || '═══════════════════════════════\n[사용자 영상 스타일 브리프]\n═══════════════════════════════\n(미입력 — 영상 맥락에서 자연스럽게 추정)\n'}

═══════════════════════════════
[작성 지침]
═══════════════════════════════

1. **시간 겹침 절대 금지.**
   - segments[i].output_end <= segments[i+1].output_start.
   - 한 컷 내부에서도 한 개의 segment 만 만들어라.

2. **각 segment 의 text 는 컷 길이에 맞춰 짧게.**
   - 한국어 발화 속도 = 초당 5자 안팎. 컷 duration 의 5자/초 이내로 작성.
   - 위 "max N자" 안내치를 절대 넘기지 마라.
   - 너무 길면 다음 컷으로 넘어가지 말고 의미를 줄여라.

3. **자막 텍스트와 중복 회피.**
   - 자막에 이미 같은 문구가 노출되는 컷이면 다른 정보를 음성으로 전해라.
   - 자막을 그대로 읽지 마라.

4. **자연스러운 한국어 구어체.**
   - 친근한 톤 (스타일 브리프의 formality 지침 따름).
   - 끊김 없이 흐르는 한 편의 짧은 내레이션 처럼 들리게.

5. **b-roll/silence 컷은 비워두는 게 자연스럽다.**
   - 모든 컷마다 억지로 채울 필요 없음.
   - 결과적으로 영상의 30~80% 정도 시간에 음성이 나오면 적당.

6. **cut_index 는 위 컷 목록의 index 를 그대로 사용. output_start/end 는 그 컷의 범위 안.**
   - 컷 길이보다 짧게 잡아도 OK (예: 3초짜리 컷 안에 1.5초만 나레이션).
   - 음성이 빨리 끝나면 다음 컷 시작까지 자연스러운 무음.

═══════════════════════════════
[응답 형식]
═══════════════════════════════
JSON 만 출력. 다른 텍스트 금지.

{
  "segments": [
    {
      "cut_index": number,
      "output_start": number,
      "output_end": number,
      "text": string
    }
  ]
}`;
}


// Stage 1 (멀티파트 fast path): 풀 영상 대신 shot 당 keyframe 1장 + 풀 오디오만 보낼 때.
// parts 순서는: shot 0 의 frame, shot 1 의 frame, ..., shot N-1 의 frame, (optional) audio track.
export function buildSourceDescriptionPromptMultipart(args: {
  shotsJson: string;
  framesPerShot: number;   // 보통 1
  hasAudio: boolean;
}): string {
  const audioBlock = args.hasAudio
    ? `- 마지막 미디어 파트는 영상 전체의 오디오 트랙(MP3) 이다. spoken_text 는 이 오디오에서만 추출해라.`
    : `- 오디오 트랙은 첨부되지 않았다 (원본 영상에 오디오가 없거나 무음). spoken_text 는 "" 로 둬라.`;

  return `너는 영상 클립의 의미를 짧고 매칭 가능하게 묘사하는 분석기다.
풀 영상 대신 shot 당 대표 프레임 ${args.framesPerShot} 장과 전체 오디오를 받았다.
첨부 미디어 순서:
- index 0 부터 (shots.length - 1) 까지: 각 shot 의 대표 프레임 (shot 순서대로)
${audioBlock}

검출된 구간들 (timestamp 는 원본 영상 기준):
${args.shotsJson}

각 shot 에 대해 아래 JSON 스키마로 출력해라. 다른 설명/마크다운/코드펜스 금지. JSON 만.

{
  "shots": [
    {
      "index": number,                           // 입력된 순서 그대로
      "start": number,                           // 입력 그대로
      "end": number,                             // 입력 그대로
      "shot_type": string,                       // close_up | medium | wide | pov | selfie | product | b_roll
      "subject": string,                         // 주피사체
      "scene_description": string,               // 한 줄. 영어 권장. 매칭에 쓰임.
      "tags": string[],                          // 6개 이상. 영어 snake_case 권장.
      "camera_motion": string,                   // static | pan | zoom_in | zoom_out | handheld (단일 프레임이라 확신 못 하면 static)
      "spoken_text": string,                     // 들리는 말. 없으면 ""
      "quality_score": number,                   // 0~1. 프레임의 흔들림/노출/구도 종합.
      "highlight_start": number,                 // shot start ~ end 범위 안. 단일 프레임이라 정확한 임팩트 순간 모르면 (start+end)/2 부근으로.
      "highlight_end": number,                   // 0.4~2.0초 길이 권장.
      "highlight_reason": string,
      "subject_center_x": number,                // 0=왼쪽 1=오른쪽
      "subject_center_y": number                 // 0=위 1=아래
    }
  ]
}

규칙:
- shots 배열은 입력된 모든 구간을 빠짐없이 포함해라. 순서/시간 변경 금지.
- spoken_text 는 오디오에서 명확히 들린 말만. 추측 금지.
- subject_center_x/y 는 9:16 자동 reframe 에 쓰인다. 명확한 주피사체가 없으면 (0.5, 0.5).
- 절대 JSON 외 텍스트 출력 금지.`;
}

// Stage 1 (이미지 소스 전용): 단일 이미지 → 1-shot 묘사.
export function buildImageSourceDescriptionPrompt(args: { durationSec: number }): string {
  return `너는 정지 이미지 한 장을 영상의 한 shot 처럼 묘사한다.
이 이미지를 ${args.durationSec.toFixed(2)}초짜리 영상 cut 으로 사용할 예정이다.
아래 JSON 스키마로 출력해라. 다른 설명/마크다운/코드펜스 금지. JSON 만.

{
  "shot_type": string,                  // close_up | medium | wide | pov | selfie | product | b_roll
  "subject": string,
  "scene_description": string,          // 한 줄, 영어 권장
  "tags": string[],                     // 6개 이상, snake_case
  "camera_motion": "static",
  "spoken_text": "",
  "quality_score": number,              // 0~1
  "subject_center_x": number,           // 0~1
  "subject_center_y": number            // 0~1
}

규칙:
- 정지 이미지이므로 camera_motion 은 항상 "static", spoken_text 는 항상 "".
- subject_center_x/y 는 9:16 reframe 에 사용. 명확한 주피사체가 없으면 (0.5, 0.5).
- 절대 JSON 외 텍스트 출력 금지.`;
}

// Stage 1: 소스 영상에서 FFmpeg 가 검출한 shot 들을 묘사
// {shots} 자리에 timestamp 배열을 끼워넣어서 호출한다.
export function buildSourceDescriptionPrompt(shotsJson: string): string {
  return `너는 영상 클립의 의미를 짧고 매칭 가능하게 묘사하는 분석기다.
이 영상에서 다음 시간 구간들이 검출됐다. 각 구간을 묘사해라.

검출된 구간들:
${shotsJson}

각 구간에 대해 다음 JSON 스키마로 출력해라. 다른 설명/마크다운/코드펜스 금지. JSON 만.

{
  "shots": [
    {
      "index": number,                           // 입력된 순서 그대로
      "start": number,                           // 입력 그대로
      "end": number,                             // 입력 그대로
      "shot_type": string,                       // close_up | medium | wide | pov | selfie | product | b_roll
      "subject": string,                         // 주피사체
      "scene_description": string,               // 한 줄. 영어 권장. 매칭에 쓰임.
      "tags": string[],                          // 6개 이상. 영어 snake_case 권장.
      "camera_motion": string,                   // static | pan | zoom_in | zoom_out | handheld
      "spoken_text": string,                     // 들리는 말. 없으면 ""
      "quality_score": number,                   // 0~1. 흔들림/노출/구도 종합.
      "highlight_start": number,                 // 이 구간 내부에서 가장 임팩트 있는 짧은 순간의 시작 (영상 전체 기준 초)
      "highlight_end": number,                   // 같은 구간의 끝. 0.4~2.0초 권장.
      "highlight_reason": string,
      "subject_center_x": number,                // 주피사체의 가로 중심. 화면 왼쪽 끝=0.0, 오른쪽 끝=1.0
      "subject_center_y": number                 // 주피사체의 세로 중심. 화면 위쪽 끝=0.0, 아래쪽 끝=1.0
    }
  ]
}

규칙:
- shots 배열은 입력된 모든 구간을 빠짐없이 포함해라. 순서/시간 변경 금지.
- highlight_start/end 는 그 shot 의 start/end 범위 안에 있어야 한다.
- scene_description 과 tags 는 다른 영상의 비슷한 장면을 찾기 위한 키워드라고 생각하고 풍부하게 써라.
- subject_center_x/y 는 9:16 자동 reframe 에 쓰인다. 주피사체의 화면 위치를 [0,1] 로 추정해라.
  · 명확한 주피사체가 없거나 풍경이면 (0.5, 0.5)
  · 사람 얼굴 클로즈업은 보통 (0.5, 0.4) 정도 (얼굴이 약간 위)
  · 음식·제품을 테이블 위에서 찍은 경우 보통 (0.5, 0.55)
  · 셀카에서 인물이 화면 오른쪽에 있으면 (0.7, 0.45) 같은 식
- 절대 JSON 외 텍스트 출력 금지.`;
}

// ============================================================
// Stage 1 (긴 소스 축약): 후보 컷들 중에서 30~60초 릴스를 구성할
// "최종 컷"을 골라 순서까지 정하는 OpenAI 선별 프롬프트.
// 입력은 이미 (중복 제거 + 품질 필터) 거친 후보들.
// ============================================================
export function buildSourceReductionPrompt(args: {
  candidates: Array<{
    id: number;
    video: string;
    start: number;
    duration: number;     // 실제 컷으로 쓸 길이 (≤4.5s 로 캡됨)
    shot_type: string;
    scene_description: string;
    spoken_text: string;
    tags: string[];
    quality: number;
  }>;
  targetSec: number;       // 목표 길이 (예: 45)
  minSec: number;          // 30
  maxSec: number;          // 60
  userDirectionBlock?: string;
}): string {
  const list = args.candidates.map(c =>
    `  {"id":${c.id},"video":"${c.video}","dur":${c.duration.toFixed(2)},"type":"${c.shot_type}",` +
    `"q":${c.quality.toFixed(2)},"desc":${JSON.stringify(c.scene_description)},` +
    `"spoken":${JSON.stringify((c.spoken_text || '').slice(0, 120))},"tags":${JSON.stringify((c.tags || []).slice(0, 6))}}`,
  ).join(',\n');

  const direction = args.userDirectionBlock?.trim()
    ? `\n[사용자 방향 — 선별·순서에 반영]\n${args.userDirectionBlock.trim()}\n`
    : '';

  return `너는 숏폼(릴스) 편집 디렉터다.
긴 원본에서 추출한 "후보 컷" 목록을 준다. 이 중에서 시청 흐름이 좋은 ${args.minSec}~${args.maxSec}초짜리 릴스를 구성할 컷들을 골라 순서까지 정해라.
${direction}
[후보 컷] (dur=초, q=품질 0~1, desc/spoken/tags=내용 단서)
[
${list}
]

선별 규칙:
- 고른 컷들의 dur 합이 ${args.minSec}~${args.maxSec}초가 되게 하라 (목표 ${args.targetSec}초 부근). 절대 ${args.maxSec}초를 넘기지 마라.
- 비슷하거나 반복되는 장면은 가장 좋은 것 하나만. 다양한 shot_type/장면으로 변주를 줘라.
- 품질(q)이 낮거나 의미 없는 컷은 버려라. 발화(spoken)나 임팩트가 있는 컷을 우선.
- 도입(훅) → 전개 → 마무리 흐름이 자연스럽게 순서를 정해라. 영상 간 교차 배치 허용.
- 반드시 입력에 존재하는 id 만 사용.

아래 JSON 스키마로만 출력. 다른 텍스트/마크다운/코드펜스 금지.
{
  "selected": [number]   // 최종 컷 id 들을 "재생 순서대로". 위 규칙을 만족하는 부분집합.
}`;
}

// ============================================================
// 유료/유명 BGM 추천 프롬프트 (BGM 선택 화면)
// ----------------------------------------------------------------
// audio_profile(분위기) + (있으면) 레퍼런스 원곡의 장르/발매시대를 앵커로,
// 영상에 어울리는 "실제로 존재하는 유명/대중적인 곡" top N 을 추천.
// 릴스/숏폼에서 자주 쓰이는, 누구나 알 법한 곡 위주. (정보/추천용 — 임베드 아님)
// ============================================================
export function buildFamousBgmPrompt(
  profile: {
    bgm_mood?: string; bgm_genre?: string; bgm_tempo?: string; bgm_energy?: string;
    bgm_instruments?: string[];
  },
  reference?: {
    title?: string; artist?: string; genres?: string[]; release_date?: string;
  },
  count = 3,
): string {
  const p = profile || {};
  const insts = Array.isArray(p.bgm_instruments) ? p.bgm_instruments.filter(Boolean).join(', ') : '';
  const refLine = reference && (reference.title || (reference.genres && reference.genres.length))
    ? `\n[레퍼런스 원곡 — 이 결/시대를 따라가라]\n` +
      `- 곡: ${reference.title || '?'}${reference.artist ? ` / ${reference.artist}` : ''}\n` +
      `- 장르: ${(reference.genres || []).join(', ') || '?'}\n` +
      `- 발매: ${reference.release_date || '?'}\n` +
      `→ 이 곡과 "비슷한 분위기·장르·시대"의 다른 유명 곡들을 추천해라. (레퍼런스 원곡 자체는 제외)\n`
    : '';

  return `너는 숏폼(인스타 릴스/유튜브 쇼츠) 영상에 BGM 을 골라주는 음악 큐레이터다.
아래 영상 분위기에 어울리는, "실제로 존재하는 유명하고 대중적인 곡" ${count}개를 추천해라.

[영상 BGM 분위기]
- 무드: ${p.bgm_mood || '?'}
- 장르: ${p.bgm_genre || '?'}
- 템포: ${p.bgm_tempo || '?'}
- 에너지: ${p.bgm_energy || '?'}
- 악기: ${insts || '?'}
${refLine}
중요 — **반드시 구글 검색을 사용해 최신 정보를 확인하고 추천해라:**
- "지금/최근 인스타 릴스(reels)·틱톡·쇼츠에서 유행하는(viral/trending) 곡"을 위 장르·무드로 검색해 **현재 트렌드**를 반영해라.
- 네 학습 기억에만 의존하지 말고, 검색 결과로 곡 제목·아티스트가 실재하는지 확인해라 (가공의 곡 금지).

규칙:
- **실재하는 유명 곡만.** 누구나 들으면 알 법한 대중적인 곡, 특히 릴스/숏폼에서 자주 쓰이는 곡 위주.
- 분위기(무드·장르·템포·에너지)에 실제로 어울리는 곡으로. 레퍼런스 원곡 정보가 있으면 그 장르·시대(연도대)에 맞춰라.
- ${count}개 모두 서로 다른 곡/아티스트로 다양하게.
- 각 곡에 왜 이 영상에 어울리는지 한 줄(reason)을 한국어로.

아래 JSON 스키마로만 출력. 다른 텍스트/마크다운/코드펜스 금지.
{
  "tracks": [
    {
      "title": string,      // 곡 제목 (정확히)
      "artist": string,     // 아티스트
      "year": string,       // 발매 연도(대략) "2019" 등, 모르면 ""
      "genre": string,      // 장르
      "reason": string      // 이 영상에 어울리는 이유 (한국어, 한 줄)
    }
  ]
}`;
}
