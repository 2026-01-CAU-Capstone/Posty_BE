// ============================================================
// 모든 LLM 프롬프트 한 곳에서 관리.
// - REFERENCE_ANALYSIS_PROMPT : Stage 0, Gemini Pro
// - SOURCE_SHOT_DESCRIPTION_PROMPT : Stage 1, Gemini Flash
// ============================================================

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
          "horizontal_align": "left" | "center" | "right",
          "size_level": "small" | "medium" | "large" | "huge",
          "color_hex": string,                   // "#RRGGBB"
          "emphasis": "regular" | "bold" | "black",
          "italic": boolean,                     // 글자가 기울어져 있으면 true. 굵기와 직교한다.
          "font_category": "sans" | "serif" | "handwritten" | "condensed" | "rounded" | "display",
          "font_personality": "modern" | "vintage" | "playful" | "elegant" | "bold_impact" | "minimal" | "retro" | "handwritten_neat" | "handwritten_brush" | "display_decorative",
          "role": "hook" | "fact" | "punchline" | "question" | "cta" | "quote" | "label" | "emphasis" | "decoration",
          "tone": "casual" | "formal" | "hype" | "poetic" | "informational" | "humorous" | "emotional"
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
    "has_background_box": boolean,               // 자막 뒤에 박스/박스형 배경
    "background_color_hex": string,              // 배경 박스 색. "#RRGGBB"
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
- **레퍼런스에 사이즈/폰트가 다른 2개 텍스트가 동시에 보이면 layers 에 두 개를 모두 분리해서 넣어라.**
  예: 위에 큰 강조 hook + 아래 작은 부연 설명 → layer 2개
- size_level (각 layer): 그 글자가 화면 너비에서 차지하는 비율로 추정.
  · 1/4 미만 = "small" / 1/4~1/2 = "medium" / 1/2~3/4 = "large" / 3/4↑ = "huge"
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
- horizontal_align: 화면 좌/중/우 어디에 정렬됐는지 추정 (그냥 center 만 쓰지 말고 실제 위치 반영).
- position: 화면 상단(=top), 중앙(=center), 하단(=bottom).
- required_tags 는 영어 snake_case (예: ["food","close_up","indoor","slow_motion"]).
- caption_global_style 은 자막이 화면에 한 번이라도 등장하면 반드시 모든 필드 채워라.
  · 자막이 전혀 없으면 빈 값으로 두지 말고 합리적 기본값으로 채워라 (흰 글자, 검정 외곽선, 중간 크기, sans, bold).
  · 색은 정확한 hex 가 어렵더라도 가장 가까운 값을 추정해라. 흰색은 "#FFFFFF", 검정은 "#000000", 노랑은 "#FFE600" 같은 식.
  · 글자가 굵으면 "bold", 아주 굵고 두꺼우면 "black", 일반 두께면 "regular".
  · 화면 대비 글자 비율이 작으면 "small", 일반적이면 "medium", 화면의 1/8 이상이면 "large", 화면을 거의 채우면 "huge".
- 절대 JSON 외 텍스트 출력 금지.`;


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
          "horizontal_align": "left" | "center" | "right",
          "size_level": "small" | "medium" | "large" | "huge",
          "color_hex": string,
          "emphasis": "regular" | "bold" | "black",
          "italic": boolean,
          "font_category": "sans" | "serif" | "handwritten" | "condensed" | "rounded" | "display",
          "font_personality": "modern" | "vintage" | "playful" | "elegant" | "bold_impact" | "minimal" | "retro" | "handwritten_neat" | "handwritten_brush" | "display_decorative",
          "role": "hook" | "fact" | "punchline" | "question" | "cta" | "quote" | "label" | "emphasis" | "decoration",
          "tone": "casual" | "formal" | "hype" | "poetic" | "informational" | "humorous" | "emotional"
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
}): string {
  const refLines = args.refCutsWithLayers
    .filter(c => Array.isArray(c.layers) && c.layers.length > 0)
    .map(c => {
      const ll = c.layers.map((l: any) => {
        const styleBits = [
          l.font_category,
          l.font_personality,
          l.emphasis,
          l.italic ? 'italic' : null,
        ].filter(Boolean).join('/');
        return `   · ${l.position}/${l.horizontal_align}/${l.size_level}/${styleBits}/${l.color_hex} [${l.role}/${l.tone}] "${l.text}"`;
      }).join('\n');
      return `cut ${c.idx} (${c.layers.length}개 텍스트):\n${ll}`;
    }).join('\n');

  const cutLines = args.cuts.map(c => {
    const refLayers = (c.matched_ref_layers || [])
      .map((l: any) => {
        const bits = [l.position, l.size_level, l.font_category, l.font_personality, l.italic ? 'italic' : null]
          .filter(Boolean).join('/');
        return `${bits}[${l.role}]`;
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
- 평균/최대 글자수: ${args.refPattern?.average_char_count || '?'} / ${args.refPattern?.max_char_count || '?'}
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
${cutLines}

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

7. **사이즈/색/굵기도 matched_ref_layers 그대로 복사가 기본.**
   - 변형은 사용자 의도(styleNote) 가 명시할 때만.

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
          "horizontal_align": "left" | "center" | "right",
          "size_level": "small" | "medium" | "large" | "huge",
          "color_hex": string,
          "emphasis": "regular" | "bold" | "black",
          "italic": boolean,
          "font_category": "sans" | "serif" | "handwritten" | "condensed" | "rounded" | "display",
          "font_personality": "modern" | "vintage" | "playful" | "elegant" | "bold_impact" | "minimal" | "retro" | "handwritten_neat" | "handwritten_brush" | "display_decorative",
          "role": "hook" | "fact" | "punchline" | "question" | "cta" | "quote" | "label" | "emphasis" | "decoration",
          "tone": "casual" | "formal" | "hype" | "poetic" | "informational" | "humorous" | "emotional"
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
- 각 cut의 시각 내용과 맥락에 맞게 자막을 다르게 쓴다.
- 자막이 필요 없는 장면은 layers: []로 둔다.
- 같은 문구를 모든 cut에 반복하지 않는다.
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
// 영상 평가 (TTS 1단계) — cut.mp4 를 Gemini Pro 에 첨부해 각 컷의 실제 내용,
// 자막의 합리성, 나레이션이 다뤄야 할 포인트를 JSON 으로 먼저 받는다.
// 이후 나레이션 작성 호출(buildNarrationOutlinePrompt) 의 입력으로 사용.
//
// 분리 이유: 한 번의 호출에서 "영상 본 다음 자막 검증 + 나레이션 작성" 을
// 한꺼번에 요구하면 평가가 부실해지고 자막을 그대로 읽는 경향이 강해진다.
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

function formatCutLine(c: TtsCutMeta): string {
  const dur = (c.output_end - c.output_start).toFixed(2);
  const bits: string[] = [];
  bits.push(`cut ${c.cut_index} [${c.output_start.toFixed(2)}~${c.output_end.toFixed(2)}s, ${dur}s]`);
  if (c.caption_text) bits.push(`caption="${c.caption_text}"`);
  if (c.subject) bits.push(`subject="${c.subject.slice(0, 80)}"`);
  if (c.shot_type) bits.push(`shot=${c.shot_type}`);
  if (c.tags && c.tags.length > 0) bits.push(`tags=[${c.tags.slice(0, 8).join(',')}]`);
  if (c.source_filename) bits.push(`src=${c.source_filename}`);
  if (c.spoken) bits.push(`spoken="${c.spoken.slice(0, 100)}"`);
  if (c.scene) bits.push(`scene="${c.scene.slice(0, 120)}"`);
  return bits.join(' | ');
}

export function buildVideoEvaluationPrompt(args: {
  totalDuration: number;
  sourceContext?: string;        // 소스 영상 전체 컨텍스트 (선택) — 파일명 목록 / reference topic 등
  cuts: TtsCutMeta[];
}): string {
  const cutLines = args.cuts.map(formatCutLine).join('\n');
  const ctxBlock = args.sourceContext
    ? `\n═══════════════════════════════\n[소스 영상 전체 컨텍스트 — 계획 · 파일 목록 · reference topic 등]\n═══════════════════════════════\n${args.sourceContext.trim()}\n`
    : '';

  return `너는 영상 사실 검토자다. 자동 편집된 짧은 영상(총 ${args.totalDuration.toFixed(2)}초) 이 첨부됐다.
다른 작업(나레이션 작성 등) 은 절대 하지 말고, 오직 **컷별 평가 JSON** 만 출력해라.
${ctxBlock}

═══════════════════════════════
[평가 항목]
═══════════════════════════════
각 컷마다 영상을 직접 보고 다음을 평가한다.

1) what_happens (한 문장): 컷에서 실제로 무엇이 일어나는지 본 그대로 묘사. 자동 묘사(auto_scene) 가 부정확하면 영상에서 본 내용을 우선.
2) caption_consistency: 자막 텍스트가 화면 내용과 부합하는가?
   - "match"   = 자막이 화면 내용을 정확히 반영
   - "loose"   = 살짝 추상적이지만 어긋나진 않음 (시적 표현 등)
   - "mismatch" = 자막이 화면 내용과 모순됨 (예: "여의도의 봄" 인데 영상은 한겨울)
   - "no_caption" = 이 컷에 자막 없음
3) caption_plausibility: 자막 문구 자체가 영상 주제로서 합리적인가? (자막 hallucination / 무의미한 텍스트 감지)
   - "ok"     = 자연스럽고 합리적
   - "weak"   = 약간 부자연스럽거나 평이함
   - "broken" = 명백히 hallucinated / 의미 없음 / 어색한 한국어
   - "no_caption"
4) narration_guidance (한 줄): 이 컷에서 음성 나레이션이 무엇을 다루면 좋을지 한 줄 가이드. **자막을 그대로 읽지 말 것** 을 전제로, 시각 채널이 못 전하는 정보(분위기·맥락·이유 등) 를 짚어줘라. 컷이 단순 b-roll 이라 침묵이 적절하면 "silence" 라고 적어라.
5) is_broll (boolean): 이 컷이 정보 없는 분위기/연결 컷이라 나레이션 없이 두는 게 자연스러우면 true.
6) arc_role: 이 컷이 영상 전체 서사에서 맡는 역할.
   - "hook"   = 도입/관심 끌기 (보통 영상 초반 1~2 컷)
   - "build"  = 본론 전개, 정보 누적, 장면 묘사
   - "reveal" = 핵심 메시지·하이라이트·전환점
   - "outro"  = 마무리, 여운, CTA
   - "broll"  = 분위기/연결 컷 (서사 진행과 무관, 시각적 휴식)

마지막으로 영상 전체의 흐름을 묘사한다.
- video_summary (한 문단): 무엇에 관한 영상인지, 전체 톤은 어떤지.
- narrative_arc (2~4문장): 영상이 어떤 흐름으로 전개되는지 한 편의 글처럼 정리. 도입에서 무엇으로 시작해, 중간에 무엇을 보여주고, 어떻게 끝맺는지. 기승전결까지 강하지 않아도 좋고, 약한 흐름이라도 명확히 적어라. 정보가 부족하면 "느슨한 vlog 형 나열" 같이 솔직히 적어라.
- core_message (한 줄): 이 영상이 시청자에게 결국 전하려는 핵심 메시지·인상·감정. 자막을 그대로 베끼지 말고 영상 전체에서 추출한 한 문장. 예: "혼자 떠난 짧은 여행에서 마음이 가벼워지는 순간." 약한 영상이면 "특별한 메시지 없는 일상 기록" 같이 솔직히.

═══════════════════════════════
[컷 메타데이터 — 영상의 자동 분석 결과. 정답이 아니라 참고용]
═══════════════════════════════
${cutLines}

═══════════════════════════════
[응답 형식]
═══════════════════════════════
JSON 만 출력. 다른 텍스트/마크다운/코드펜스 금지.

{
  "video_summary": string,
  "narrative_arc": string,
  "core_message": string,
  "cuts": [
    {
      "cut_index": number,
      "what_happens": string,
      "caption_consistency": "match" | "loose" | "mismatch" | "no_caption",
      "caption_plausibility": "ok" | "weak" | "broken" | "no_caption",
      "narration_guidance": string,
      "is_broll": boolean,
      "arc_role": "hook" | "build" | "reveal" | "outro" | "broll"
    }
  ]
}

- 모든 컷을 빠짐없이 포함.
- 자막이 없는 컷은 caption_consistency / caption_plausibility 둘 다 "no_caption".
- arc_role 은 영상 전체 흐름 안에서 그 컷의 역할. is_broll=true 인 컷은 보통 arc_role="broll".
- 절대 segments / narration text / 음성 대본을 만들지 마라. 이 단계는 평가만 한다.`;
}

// ============================================================
// 나레이션 개요 (TTS 합성 전 생성) — Stage 1 끝난 뒤 호출.
// 입력:
//   - cuts: edit-plan 각 컷의 (output_start, output_end, spoken, scene, caption_text)
//   - userDirectionBlock: styleBrief + styleNote
//   - evaluation: buildVideoEvaluationPrompt 의 결과 (선택)
// 출력 JSON:
//   { segments: [{ cut_index, output_start, output_end, text }] }
// 핵심 제약:
//   - 인접 segment 끼리 시간이 겹치지 않음.
//   - 한 segment 길이(초) * 5.5 자 이하 (한국어 발화 속도).
//   - 각 cut 마다 0~1개 segment. 자막이 빈 컷은 segment 생략 가능.
// ============================================================
export function buildNarrationOutlinePrompt(args: {
  userDirectionBlock: string;
  totalDuration: number;
  videoAttached?: boolean;     // 영상이 첨부됐는지 (true 면 영상 우선 평가 지침 활성)
  sourceContext?: string;      // 소스 영상 전체 컨텍스트 (선택)
  evaluation?: {
    video_summary?: string;
    narrative_arc?: string;
    core_message?: string;
    cuts?: Array<{
      cut_index: number;
      what_happens?: string;
      caption_consistency?: string;
      caption_plausibility?: string;
      narration_guidance?: string;
      is_broll?: boolean;
      arc_role?: string;
    }>;
  };
  cuts: TtsCutMeta[];
}): string {
  const evalByIdx = new Map<number, any>();
  for (const e of args.evaluation?.cuts || []) {
    if (typeof e.cut_index === 'number') evalByIdx.set(e.cut_index, e);
  }

  const cutLines = args.cuts.map(c => {
    const dur = (c.output_end - c.output_start).toFixed(2);
    const maxChars = Math.floor((c.output_end - c.output_start) * 5);
    const ev = evalByIdx.get(c.cut_index);
    // 평가 결과가 있으면 그것이 1순위 정보. 풍부한 source 메타도 같이 표시.
    const srcBits: string[] = [];
    if (c.subject) srcBits.push(`subject="${c.subject.slice(0, 60)}"`);
    if (c.shot_type) srcBits.push(`shot=${c.shot_type}`);
    if (c.tags && c.tags.length > 0) srcBits.push(`tags=[${c.tags.slice(0, 6).join(',')}]`);
    if (c.source_filename) srcBits.push(`src=${c.source_filename}`);
    if (c.spoken) srcBits.push(`spoken="${c.spoken.slice(0, 80)}"`);
    if (c.scene) srcBits.push(`scene="${c.scene.slice(0, 100)}"`);
    const srcSuffix = srcBits.length > 0 ? ` | ${srcBits.join(' | ')}` : '';
    const evalBits = ev
      ? ` | role=${ev.arc_role || '?'} | what="${(ev.what_happens || '').slice(0, 140)}" | caption_cons=${ev.caption_consistency || '?'} caption_plaus=${ev.caption_plausibility || '?'} | guide="${(ev.narration_guidance || '').slice(0, 100)}"${ev.is_broll ? ' | BROLL' : ''}`
      : '';
    return `cut ${c.cut_index} [${c.output_start.toFixed(2)}~${c.output_end.toFixed(2)}s, ${dur}s, max ${maxChars}자] caption="${c.caption_text || ''}"${evalBits}${srcSuffix}`;
  }).join('\n');

  const evaluationProvided = !!args.evaluation && Array.isArray(args.evaluation.cuts) && args.evaluation.cuts.length > 0;
  const summaryBits: string[] = [];
  if (evaluationProvided && args.evaluation?.video_summary) {
    summaryBits.push(`■ 영상 요약\n${args.evaluation.video_summary}`);
  }
  if (evaluationProvided && args.evaluation?.narrative_arc) {
    summaryBits.push(`■ 서사 흐름 (이 흐름을 따라 나레이션이 한 편의 글처럼 이어지도록 작성)\n${args.evaluation.narrative_arc}`);
  }
  if (evaluationProvided && args.evaluation?.core_message) {
    summaryBits.push(`■ 핵심 메시지 (전체 나레이션의 목적지. 도입에서 암시하고 마무리에서 자연스럽게 닿게 한다 — 그대로 베끼지 말 것)\n${args.evaluation.core_message}`);
  }
  const summaryBlock = summaryBits.length > 0
    ? `\n═══════════════════════════════\n[영상 전체 — 1단계 평가 결과]\n═══════════════════════════════\n${summaryBits.join('\n\n')}\n`
    : '';
  const ctxBlock = args.sourceContext
    ? `\n═══════════════════════════════\n[소스 영상 전체 컨텍스트]\n═══════════════════════════════\n${args.sourceContext.trim()}\n`
    : '';

  const sourceModeBlock = evaluationProvided
    ? `※ 컷별로 이미 1단계에서 영상을 보고 평가한 결과가 함께 주어진다 (what / caption_cons / caption_plaus / guide / BROLL). 그 평가를 신뢰하고 그 위에서 나레이션을 작성해라. caption_cons=mismatch 또는 caption_plaus=broken 인 컷은 자막을 무시하고 what_happens 만 활용. BROLL 표시된 컷은 가급적 segment 생략.\n`
    : args.videoAttached
      ? `※ 영상(cut.mp4) 이 첨부됐다. 컷 메타데이터(아래)가 실제 영상 내용과 다르거나 빠진 정보가 있으면 영상에서 본 내용을 우선해라.\n`
      : '';

  return `너는 짧은 영상의 나레이션 작가다.
아래는 자동 편집된 영상 (총 ${args.totalDuration.toFixed(2)}초) 의 컷 구성이다.
${sourceModeBlock}각 컷의 시각 내용·자막·1단계 평가를 종합해 자연스러운 음성 나레이션 segments 를 작성해라.
${summaryBlock}${ctxBlock}
═══════════════════════════════
[작성 원칙]
═══════════════════════════════
- **전체 segments 는 한 편의 짧은 글처럼 이어지게 작성**. 위 narrative_arc 흐름을 따라 도입(hook)에서 흥미를 끌고, 중간(build)에서 보여주거나 설명하고, 끝(reveal/outro)에서 메시지를 마무리한다. 기승전결까지 강하지 않아도 좋지만, **컷별 독립 묘사 나열이 되지 않게** 유의.
- core_message 가 주어졌다면 그것을 영상의 목적지로 삼는다. 도입 segment 에서 살짝 암시하고 마무리(reveal/outro) segment 에서 자연스럽게 도달하게 구성. core_message 문장을 그대로 베껴 읽지 말고 다른 단어로 풀어쓰기.
- 각 컷의 arc_role 을 참고해 톤을 맞춘다.
   · role=hook    → 짧고 강한 한 마디. 호기심 또는 결론 한 줄.
   · role=build   → 정보·맥락·감각 묘사. 흐름을 이어주는 연결구 활용.
   · role=reveal  → 핵심 메시지·전환. 무게감 있는 한 문장.
   · role=outro   → 여운·CTA·요약. 마무리 톤.
   · role=broll   → 가급적 침묵. 꼭 필요하면 매우 짧은 한 단어 정도.
- 자막을 그대로 읽지 마라. 자막은 시각 채널, 나레이션은 별도 청각 채널이다.
- 1단계 평가에서 caption_cons=mismatch / caption_plaus=broken 으로 표시된 컷은 자막 문구를 신뢰하지 말고 what_happens 만 활용해라.
- BROLL 컷은 비워두는 게 자연스럽다 (segment 생략).
- narration_guidance 가 "silence" 면 그 컷에 segment 만들지 마라.

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
