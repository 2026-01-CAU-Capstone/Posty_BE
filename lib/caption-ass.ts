// ============================================================
// Caption ASS 빌더 (libass / FFmpeg subtitles 필터 풀 활용)
// ----------------------------------------------------------------
// CaptionLayer[] (컷별) → 단일 .ass 문서.
// SVG→PNG 오버레이를 대체. resvg/PNG 합성 없이 FFmpeg subtitles 필터 한 번으로 렌더.
//
// ASS 로 표현 가능한 것 (풀 활용):
//   - 폰트 패밀리 / 크기 / 굵기 / 이탤릭        (Fontname / Fontsize / Bold / Italic)
//   - 글자 색 / 외곽선 색 / 그림자(back) 색      (PrimaryColour / OutlineColour / BackColour)
//   - 외곽선 두께                                (BorderStyle=1 + Outline)
//   - 그림자 오프셋 (방향까지)                   (\xshad \yshad + Shadow)
//   - 박스 배경 (불투명)                         (BorderStyle=3 + Outline=padding)
//   - 글로우/네온 근사                           (OutlineColour=glow + \blur)
//   - 자간                                       (Spacing / \fsp)
//   - 등장 애니메이션 (layer 별 개별 적용 가능)   (\fad / \move)
//   - 위치 / 정렬 / 멀티 layer 수직 스택          (\an + \pos)
//
// ASS 한계 (의도적 degrade):
//   - 글자 그라데이션 불가 → gradient.stops[0] 색으로 단색 처리.
//   - 글로우는 외곽선+blur 근사 (별도 광선 레이어 아님).
//   - 박스 모서리 둥글기(radius) 불가 → 항상 사각 박스.
//   - 박스가 있으면 글자 외곽선은 동시 표현 불가 (외곽선 색을 박스가 사용).
// ============================================================

import { pickBundledFont } from './fonts';

export const SCRIPT_W = 1080;
export const SCRIPT_H = 1920;

const MAX_CAPTION_CHARS = 60;
const H_MARGIN = 48;
const CAPTION_MAX_W = SCRIPT_W - H_MARGIN * 2;   // 984 — 좌우 마진 축소로 폭 예산 확대(기존 888). 한글 medium/large 가 바닥까지 안 깎이도록.
const V_MARGIN = 130;
const STACK_GAP_RATIO = 0.16;   // 인접 layer 간 수직 간격 = fontSize × 비율 (동적). 레퍼런스의 타이트한 제목 쌍처럼 가깝게.
const STACK_GAP_MIN = 16;

// 실제 SNS 자막 임팩트에 맞춰 사이즈 풀을 키운다.
// 이전 풀: huge=132, large=104, medium=78, small=54
//   → ref 의 "임팩트 자막" 이 SVG 시안보다 작아 보이는 주된 원인.
// SCRIPT_H=1920 기준:
//   huge   ≈ 화면 높이의 ~10%      (200pt)
//   large  ≈ 7~8% (140pt)
//   medium ≈ 5%   (96pt)
//   small  ≈ 3~4% (64pt)
const SIZE_PT: Record<string, number> = { small: 64, medium: 96, large: 140, huge: 200 };
// fit 안 되면 줄여나가는 최소치. 시각적 "사이즈 위계" 가 무너지지 않을 정도까지만.
const MIN_SIZE_PT: Record<string, number> = { small: 50, medium: 62, large: 86, huge: 110 };
// fit: 폰트를 깎기 전에 \fscx(가로압축)로 폭을 맞춰 ref 의 크기 위계를 보존한다.
// MIN_SCALEX 까지는 요청 크기를 유지한 채 가로만 압축, 그래도 안 되면 폰트 축소(+ 최후 FLOOR_SCALEX).
const MIN_SCALEX = 80;
const FLOOR_SCALEX = 70;
// 한 줄 유지를 위해 허용하는 최소 가로압축(%). 레퍼런스 hook 이 한 줄이면 결과도 한 줄이 되도록,
// 줄바꿈(2줄 쪼개기) 전에 폰트 축소 + \fscx 가로압축을 이 하한까지 먼저 시도한다.
const SINGLE_LINE_MIN_SCALEX = 62;

// 외곽선/그림자는 fontSize 에 비례시킨다 (px 고정 → 동적 비율).
// 큰 자막에는 굵은 외곽선이, 작은 자막에는 얇은 외곽선이 자연스러움.
const OUTLINE_RATIO: Record<string, number> = { none: 0, thin: 0.035, medium: 0.065, thick: 0.105 };
// 그림자 오프셋도 비례 (기본값 — layer 가 명시 안 했을 때).
const SHADOW_DEFAULT_RATIO_Y = 0.04;
const SHADOW_DEFAULT_BLUR_RATIO = 0.05;

const LETTER_SPACING_EM: Record<string, number> = { tight: -0.02, normal: 0, wide: 0.06 };

// enum(거친 단계) → 정밀 수치 폴백 매핑. LLM 이 정밀 number 필드(outline_ratio / letter_spacing_em /
// font_width_ratio / font_weight)를 주면 그걸 '우선'하고, 없으면 아래 enum 값을 수치로 환산한다.
const WEIGHT_HINT_MAP: Record<string, number> = { thin: 100, light: 300, regular: 400, medium: 500, bold: 700, black: 900 };
const FONT_WIDTH_MAP: Record<string, number> = { condensed: 86, normal: 100, expanded: 115 };

// ── 스타일 정밀 수치 resolve (정밀 number 우선, 없으면 enum 환산) ──
// "유무/정도만" 나타내던 enum 들을 연속 수치로 받아 ASS 렌더에 직접 흘려보내기 위한 단일 창구.
function resolveOutlineRatio(layer: CaptionLayer): number {
  const r = Number(layer.outline_ratio);
  if (Number.isFinite(r) && r >= 0) return clampNum(r, 0, 0.2);
  return OUTLINE_RATIO[String(layer.outline_thickness || 'none').toLowerCase()] ?? 0;
}
function resolveLetterSpacingEm(layer: CaptionLayer): number {
  const e = Number(layer.letter_spacing_em);
  if (Number.isFinite(e)) return clampNum(e, -0.1, 0.4);
  return LETTER_SPACING_EM[String(layer.letter_spacing || 'normal').toLowerCase()] ?? 0;
}
function resolveFontWidthScale(layer: CaptionLayer): number {
  const w = Number(layer.font_width_ratio);
  if (Number.isFinite(w) && w > 0) return clampNum(Math.round(w), 55, 150);
  const fw = String(layer.font_width || '').toLowerCase();
  const cat = String(layer.font_category || '').toLowerCase();
  if (fw === 'condensed' || cat === 'condensed') return FONT_WIDTH_MAP.condensed;
  if (fw === 'expanded') return FONT_WIDTH_MAP.expanded;
  return 100;
}
function resolveFontWeight(layer: CaptionLayer): number {
  const w = Number(layer.font_weight);
  if (Number.isFinite(w) && w >= 100 && w <= 900) return Math.round(w);
  const hint = WEIGHT_HINT_MAP[String(layer.font_weight_hint || '').toLowerCase()];
  if (hint) return hint;
  const emp = String(layer.emphasis || '').toLowerCase();
  return emp === 'black' ? 900 : emp === 'bold' ? 700 : 400;
}
// 박스 padding(px) — blockH/blockW(prepareLayer)와 buildStyleLine 이 '동일한 값'을 쓰도록 단일화.
// (이전엔 두 곳 공식이 달라 계산상 박스와 렌더 박스가 어긋났다.)
function boxPaddingPx(layer: CaptionLayer, fontSize: number): number {
  const raw = Number.isFinite(layer.background_padding) ? Number(layer.background_padding) : fontSize * 0.22;
  return clampNum(Math.round(raw), 4, 60);
}
// 텍스트가 쓸 수 있는 가로 예산(px). 박스 자막은 좌우를 조금 더 쓰게 한다(박스 padding 은 blockW 에서 별도 가산).
function widthBudgetFor(layer: CaptionLayer): number {
  return layer.has_background_box ? (SCRIPT_W - H_MARGIN) : CAPTION_MAX_W; // 박스 1032 / 일반 984
}
// size 단계별 최대 줄 수 — 큰 hook 은 줄을 적게(임팩트 유지), 본문은 더 허용.
function maxLinesFor(sizeLevel: string): number {
  if (sizeLevel === 'huge') return 2;
  if (sizeLevel === 'large') return 3;
  if (sizeLevel === 'medium') return 3;
  return 4; // small
}

// ============================================================
// 타입 — Stage 1 caption planning 출력과 1:1 (SVG 버전과 동일).
// ============================================================
export type CaptionLayer = {
  text: string;
  position?: string;            // top | center | bottom (거친 단계)
  vertical_ratio?: number;      // 0.0(맨 위)~1.0(맨 아래) — 정밀 세로 위치. 있으면 이걸 우선해 배치.
  horizontal_ratio?: number;    // 0.0(왼쪽 끝)~1.0(오른쪽 끝) — 정밀 가로 위치(텍스트 블록 중심). 있으면 좌표로 배치.
  horizontal_align?: string;    // left | center | right (블록 내 줄 정렬 / horizontal_ratio 없을 때의 가로 위치)
  size_level?: string;          // small | medium | large | huge (거친 4단계 폴백)
  size_ratio?: number;          // 정밀 크기: 글자(한 줄) 높이 ÷ 영상 높이 (0~1). 있으면 버킷 대신 이 값으로 연속 사이징.
  color_hex?: string;
  // 한 자막 안에서 색이 중간에 바뀌는 경우(예: "오늘 [특가] 세일"에서 특가만 빨강).
  // runs 를 순서대로 이으면 text 와 같아야 한다. 색이 일정하면 비우거나 1개.
  color_runs?: Array<{ text: string; color_hex: string }>;
  emphasis?: string;            // regular | bold | black
  italic?: boolean;
  font_category?: string;
  font_personality?: string;
  role?: string;
  tone?: string;

  outline_color_hex?: string;
  outline_thickness?: string;   // none | thin | medium | thick (거친 단계 폴백)
  outline_ratio?: number;       // 정밀 외곽선 두께 = 두께 ÷ 글자높이(fontSize). 있으면 enum 대신 이걸 우선.

  has_shadow?: boolean;
  shadow_color_hex?: string;
  shadow_offset_x?: number;
  shadow_offset_y?: number;
  shadow_blur?: number;

  has_background_box?: boolean;
  background_color_hex?: string;
  background_alpha?: number;      // 0(완전 투명)~1(완전 불투명). 박스 배경 투명도.
  background_radius?: number;    // ASS 에선 무시 (사각 박스)
  background_padding?: number;

  // 글자 모양 재현 힌트 (optional) — 번들 폰트 매핑 정확도를 높이기 위함.
  font_family_hint?: string;     // 레퍼런스 폰트 이름 추정 (예: "Black Han Sans", "Pretendard"). 번들 family 와 매칭되면 우선.
  font_width?: string;           // normal | condensed | expanded — 자폭 인상(거친 단계 폴백).
  font_width_ratio?: number;     // 정밀 자폭 = \fscx %(100=기본, <100 압축, >100 확장). 있으면 enum 대신 우선.
  font_weight_hint?: string;     // thin | light | regular | medium | bold | black 등 굵기 인상(거친 단계 폴백).
  font_weight?: number;          // 정밀 굵기 100~900(OpenType wght). 있으면 hint/emphasis 대신 우선.
  font_style_notes?: string;     // 자유 서술 (예: "둥근 고딕, 약간 손글씨 느낌").
  gradient?: {
    type?: string;
    angle?: number;
    stops?: Array<{ offset: number; color: string }>;
  };

  has_glow?: boolean;
  glow_color_hex?: string;
  glow_radius?: number;

  letter_spacing?: string;       // tight | normal | wide (거친 단계 폴백)
  letter_spacing_em?: number;    // 정밀 자간 em(-0.05~0.15). 있으면 enum 대신 우선.

  entry_animation?: string;      // none | fade | pop | slide_in_top | slide_in_bottom | slide_in_left | slide_in_right
};

export type GlobalCaptionStyle = {
  font_category?: string;
  font_personality?: string;
  font_weight?: string;
  font_italic?: boolean;
  all_caps?: boolean;
  primary_color_hex?: string;
  has_outline?: boolean;
  outline_color_hex?: string;
  outline_thickness?: string;
  has_shadow?: boolean;
  has_background_box?: boolean;
  background_color_hex?: string;
  background_alpha?: number;      // 0~1. 박스 배경 투명도 (layer 에 없을 때 폴백).
  size_level?: string;
};

export type CutInput = {
  start: number;     // output 타임라인 기준 시작 (초)
  end: number;       // 끝 (초)
  layers: CaptionLayer[];
  // 이 컷의 주피사체 세로 위치 (0=위 ~ 1=아래). 단일 자막을 주체 반대편에 두기 위해 사용.
  subjectCenterY?: number;
};

export type Prepared = {
  layer: CaptionLayer;
  lines: string[];
  fontSize: number;
  scaleX: number;    // ASS ScaleX (가로 압축 %, 100=원본)
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  position: 'top' | 'center' | 'bottom';
  hAlign: 'left' | 'center' | 'right';
  spacingPx: number;
  blockH: number;
  blockW: number;
  // 배치 결과
  anchor: number;    // ASS \an code (1~9)
  x: number;
  y: number;
};

// ============================================================
// 메인 진입점 — 전체 영상의 ASS 문서 생성.
// ============================================================
export function buildCaptionAss(cuts: CutInput[], globalStyle: GlobalCaptionStyle | undefined): string {
  const g = globalStyle || {};

  // 같은 자막이 연속 컷마다 떴다 사라지며 깜빡이는 걸 막는다 — 동일 자막의 인접 구간을 잇고
  // 짧은 무자막 공백은 메워 하나의 연속 자막으로 만든다.
  const mergedCuts = mergeCaptionRuns(cuts);

  const styleLines: string[] = [];
  const eventLines: string[] = [];
  let styleSeq = 0;

  for (let ci = 0; ci < mergedCuts.length; ci++) {
    const cut = mergedCuts[ci];
    if (!cut || !Array.isArray(cut.layers) || cut.layers.length === 0) continue;
    if (!Number.isFinite(cut.start) || !Number.isFinite(cut.end) || cut.end <= cut.start) continue;

    const prepared = layoutCut(cut.layers, g, cut.subjectCenterY);
    if (prepared.length === 0) continue;

    const dur = cut.end - cut.start;
    for (const p of prepared) {
      const styleName = `s${styleSeq++}`;
      styleLines.push(buildStyleLine(styleName, p));
      eventLines.push(buildDialogueLine(styleName, p, cut.start, cut.end, dur));
    }
  }

  return assDocument(styleLines, eventLines);
}

// ============================================================
// 같은 자막의 인접 구간 합치기 (깜빡임 제거)
// ----------------------------------------------------------------
// 동일한 자막(텍스트+색+세로위치)이 여러 연속 컷에 걸쳐 있으면, 컷 경계마다 끊겨
// "떴다 사라졌다" 반복하는 조잡함이 생긴다. 시간상 인접하고 내용이 같은 구간을 하나로
// 잇고, 그 사이의 짧은 무자막 공백(BRIDGE_SEC 이하)은 메워 연속 자막으로 만든다.
// (다른 자막이거나 공백이 길면 합치지 않는다.)
// ============================================================
const CAPTION_BRIDGE_SEC = 2.5;

function captionRunSig(layers: CaptionLayer[]): string {
  return (Array.isArray(layers) ? layers : [])
    .map(l => `${String(l.text || '').trim()}|${normHex(l.color_hex)}|${Math.round((Number(l.vertical_ratio) || 0) * 20)}`)
    .join('||');
}

export function mergeCaptionRuns(cuts: CutInput[], bridgeSec = CAPTION_BRIDGE_SEC): CutInput[] {
  const valid = (Array.isArray(cuts) ? cuts : [])
    .filter(c => c && Array.isArray(c.layers) && c.layers.length > 0
      && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const out: CutInput[] = [];
  for (const c of valid) {
    const prev = out[out.length - 1];
    if (prev && captionRunSig(prev.layers) === captionRunSig(c.layers) && c.start - prev.end <= bridgeSec) {
      prev.end = Math.max(prev.end, c.end);     // 같은 자막 연속/짧은 공백 → 이어붙임
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

// ============================================================
// 한 컷의 레이어들을 sanitize → prepare → 배치까지 수행해 Prepared[] 반환.
// (buildCaptionAss 의 컷 단위 로직을 분리 — 레이아웃 단위 테스트 가능.)
// ============================================================
export function layoutCut(
  layers: CaptionLayer[],
  globalStyle?: GlobalCaptionStyle,
  subjectCenterY?: number,
): Prepared[] {
  const g = globalStyle || {};
  const sanitized = (Array.isArray(layers) ? layers : [])
    .map(l => sanitizeLayer(l, g))
    .filter((l): l is CaptionLayer => l !== null);
  if (sanitized.length === 0) return [];
  const prepared = sanitized.map(l => prepareLayer(l, g));
  applySubjectAwarePosition(prepared, subjectCenterY);
  placeLayers(prepared);
  return prepared;
}

function assDocument(styleLines: string[], eventLines: string[]): string {
  const header =
`[Script Info]
; posty-prototype caption (libass full-style)
ScriptType: v4.00+
PlayResX: ${SCRIPT_W}
PlayResY: ${SCRIPT_H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLines.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${eventLines.join('\n')}
`;
  return header;
}

// ============================================================
// 분석 단계(Stage0/Stage1)에서 캡션 layer 의 "디자인 필드"를 보존하기 위한 헬퍼.
//
// 배경: Stage0(normalizeLayer)·Stage1(normalizeLayers)이 예전에 text/위치/폰트 등
// 기본 11개 필드만 남기고 outline/shadow/box/gradient/glow/letter_spacing/
// entry_animation 을 통째로 버려서, 렌더러(sanitizeLayer)가 항상 global 스타일로만
// 폴백 → 레퍼런스 자막 "형식 복사"가 안 됐다.
//
// 정책: 값이 "있을 때만" 담는다. 없으면 키를 만들지 않아 undefined 로 남겨,
// 렌더 단계 sanitizeLayer 가 global 스타일로 폴백할 여지를 그대로 둔다.
// ============================================================
export function preserveLayerDesign(raw: any): Partial<CaptionLayer> {
  const out: Partial<CaptionLayer> = {};
  if (!raw || typeof raw !== 'object') return out;
  const str = (v: any) => (typeof v === 'string' && v.trim() ? v : undefined);
  const num = (v: any) => (Number.isFinite(v) ? Number(v) : undefined);

  const outlineColor = str(raw.outline_color_hex);
  if (outlineColor) out.outline_color_hex = outlineColor;
  const outlineThickness = str(raw.outline_thickness);
  if (outlineThickness) out.outline_thickness = outlineThickness.toLowerCase();
  if (num(raw.outline_ratio) !== undefined) out.outline_ratio = Number(raw.outline_ratio);

  if (raw.has_shadow === true || raw.has_shadow === false) out.has_shadow = raw.has_shadow === true;
  const shadowColor = str(raw.shadow_color_hex);
  if (shadowColor) out.shadow_color_hex = shadowColor;
  if (num(raw.shadow_offset_x) !== undefined) out.shadow_offset_x = Number(raw.shadow_offset_x);
  if (num(raw.shadow_offset_y) !== undefined) out.shadow_offset_y = Number(raw.shadow_offset_y);
  if (num(raw.shadow_blur) !== undefined) out.shadow_blur = Number(raw.shadow_blur);

  if (raw.has_background_box === true || raw.has_background_box === false) out.has_background_box = raw.has_background_box === true;
  const boxColor = str(raw.background_color_hex);
  if (boxColor) out.background_color_hex = boxColor;
  // 박스 투명도 (0~1) — 보존해 반투명 박스를 렌더까지 전달.
  if (num(raw.background_alpha) !== undefined) out.background_alpha = clamp01(Number(raw.background_alpha));
  if (num(raw.background_radius) !== undefined) out.background_radius = Number(raw.background_radius);
  if (num(raw.background_padding) !== undefined) out.background_padding = Number(raw.background_padding);

  if (raw.gradient && typeof raw.gradient === 'object') out.gradient = raw.gradient;

  if (raw.has_glow === true || raw.has_glow === false) out.has_glow = raw.has_glow === true;
  const glowColor = str(raw.glow_color_hex);
  if (glowColor) out.glow_color_hex = glowColor;
  if (num(raw.glow_radius) !== undefined) out.glow_radius = Number(raw.glow_radius);

  const ls = str(raw.letter_spacing);
  if (ls) out.letter_spacing = ls.toLowerCase();
  if (num(raw.letter_spacing_em) !== undefined) out.letter_spacing_em = Number(raw.letter_spacing_em);
  const ea = str(raw.entry_animation);
  if (ea) out.entry_animation = ea.toLowerCase();

  // 글자 모양 재현 힌트 — 있을 때만 보존 (번들 폰트 매핑에 활용).
  const ffh = str(raw.font_family_hint);
  if (ffh) out.font_family_hint = ffh;
  const fw = str(raw.font_width);
  if (fw) out.font_width = fw.toLowerCase();
  if (num(raw.font_width_ratio) !== undefined) out.font_width_ratio = Number(raw.font_width_ratio);
  const fwh = str(raw.font_weight_hint);
  if (fwh) out.font_weight_hint = fwh.toLowerCase();
  if (num(raw.font_weight) !== undefined) out.font_weight = Number(raw.font_weight);
  const fsn = str(raw.font_style_notes);
  if (fsn) out.font_style_notes = fsn;

  // 정밀 글자 크기 (글자 높이 ÷ 영상 높이, 0~1) — 있으면 렌더가 4단계 버킷 대신 이 비율로 사이징.
  const sr = Number(raw.size_ratio);
  if (Number.isFinite(sr) && sr > 0 && sr <= 0.5) out.size_ratio = sr;

  // 정밀 세로 위치 (0~1) — 있으면 보존해 렌더가 고정 마진 대신 이 비율로 배치.
  const vr = Number(raw.vertical_ratio);
  if (Number.isFinite(vr) && vr >= 0 && vr <= 1) out.vertical_ratio = vr;

  // 정밀 가로 위치 (0~1) — 있으면 보존해 렌더가 좌표(블록 중심)로 배치 (center 로 뭉개지 않게).
  const hr = Number(raw.horizontal_ratio);
  if (Number.isFinite(hr) && hr >= 0 && hr <= 1) out.horizontal_ratio = hr;

  // 인라인 색 runs — {text, color_hex} 만 추려 보존 (2개 이상 의미 있을 때).
  if (Array.isArray(raw.color_runs)) {
    const runs = raw.color_runs
      .map((r: any) => ({ text: String(r?.text ?? ''), color_hex: str(r?.color_hex) || '' }))
      .filter((r: { text: string; color_hex: string }) => r.text.length > 0 && r.color_hex.length > 0);
    if (runs.length >= 2) out.color_runs = runs;
  }

  return out;
}

// ============================================================
// Layer sanitize — 색은 강제하지 않고 "구조"(외곽선/그림자 존재)만 보장.
// (SVG 버전과 동일 정책)
// ============================================================
export function sanitizeLayer(raw: any, global: GlobalCaptionStyle): CaptionLayer | null {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text || '').trim();
  if (!text) return null;

  const vr = Number(raw.vertical_ratio);
  const hr = Number(raw.horizontal_ratio);
  const out: CaptionLayer = {
    text,
    // 인라인 색 runs — {text,color_hex} 2개 이상일 때만 유지 (렌더 시 grapheme 매핑).
    color_runs: Array.isArray(raw.color_runs) && raw.color_runs.length >= 2
      ? raw.color_runs.filter((r: any) => r && typeof r.text === 'string' && typeof r.color_hex === 'string')
      : undefined,
    // 정밀 세로 위치 (0~1) — 있으면 placeLayers 가 고정 마진 대신 이 비율로 배치.
    vertical_ratio: (Number.isFinite(vr) && vr >= 0 && vr <= 1) ? vr : undefined,
    // 정밀 가로 위치 (0~1) — 있으면 placeLayers 가 정렬 대신 좌표(블록 중심)로 배치.
    horizontal_ratio: (Number.isFinite(hr) && hr >= 0 && hr <= 1) ? hr : undefined,
    position: String(raw.position || 'bottom').toLowerCase(),
    horizontal_align: String(raw.horizontal_align || 'center').toLowerCase(),
    size_level: String(raw.size_level || global.size_level || 'medium').toLowerCase(),
    // 정밀 크기 (글자 높이÷영상 높이) — 있으면 prepareLayer 가 4단계 버킷 대신 이 값으로 사이징.
    // (유효 범위 밖이면 undefined 로 두어 버킷 폴백.)
    size_ratio: (Number.isFinite(raw.size_ratio) && Number(raw.size_ratio) > 0 && Number(raw.size_ratio) <= 0.5)
      ? Number(raw.size_ratio) : undefined,
    color_hex: normHex(raw.color_hex || global.primary_color_hex || '#FFFFFF'),
    emphasis: String(raw.emphasis || global.font_weight || 'bold').toLowerCase(),
    italic: raw.italic === true || (raw.italic === undefined && global.font_italic === true),
    font_category: String(raw.font_category || global.font_category || 'sans').toLowerCase(),
    font_personality: String(raw.font_personality || global.font_personality || '').toLowerCase(),
    role: raw.role ? String(raw.role) : undefined,
    tone: raw.tone ? String(raw.tone) : undefined,

    outline_color_hex: normHex(raw.outline_color_hex || global.outline_color_hex || '#000000'),
    outline_thickness: String(
      raw.outline_thickness ?? (global.has_outline === false ? 'none' : (global.outline_thickness || 'medium')),
    ).toLowerCase(),
    // 정밀 외곽선 두께(있으면 enum 대신 우선) — resolveOutlineRatio 가 clamp.
    outline_ratio: Number.isFinite(raw.outline_ratio) ? Number(raw.outline_ratio) : undefined,

    has_shadow: raw.has_shadow === true || (raw.has_shadow === undefined && global.has_shadow === true),
    shadow_color_hex: normHex(raw.shadow_color_hex || '#000000'),
    shadow_offset_x: Number.isFinite(raw.shadow_offset_x) ? Number(raw.shadow_offset_x) : 0,
    shadow_offset_y: Number.isFinite(raw.shadow_offset_y) ? Number(raw.shadow_offset_y) : 4,
    shadow_blur: Number.isFinite(raw.shadow_blur) ? Number(raw.shadow_blur) : 6,

    // 박스는 레이어가 명시적으로 has_background_box=true 라고 할 때만. (전역값 자동 상속 제거)
    // 레퍼런스가 박스 없이 그림자/글로우만 있는데 caption_global_style.has_background_box 가 한 번
    // 오판되면 박스 미지정 레이어 전부에 검은 판이 씌워지던 문제를 차단 — 레퍼런스 형식 충실도 ↑.
    has_background_box: raw.has_background_box === true,
    background_color_hex: normHex(raw.background_color_hex || global.background_color_hex || '#000000'),
    // 박스 투명도: layer 값 우선, 없으면 global, 그것도 없으면 불투명(1).
    background_alpha: Number.isFinite(raw.background_alpha) ? clamp01(Number(raw.background_alpha))
      : (Number.isFinite(global.background_alpha) ? clamp01(Number(global.background_alpha)) : 1),
    background_radius: Number.isFinite(raw.background_radius) ? Number(raw.background_radius) : 14,
    background_padding: Number.isFinite(raw.background_padding) ? Number(raw.background_padding) : 28,

    // 글자 모양 힌트 — 폰트 선택에 활용 (있을 때만).
    font_family_hint: raw.font_family_hint ? String(raw.font_family_hint) : undefined,
    font_width: raw.font_width ? String(raw.font_width).toLowerCase() : undefined,
    font_width_ratio: Number.isFinite(raw.font_width_ratio) ? Number(raw.font_width_ratio) : undefined,
    font_weight_hint: raw.font_weight_hint ? String(raw.font_weight_hint).toLowerCase() : undefined,
    font_weight: Number.isFinite(raw.font_weight) ? Number(raw.font_weight) : undefined,

    gradient: normalizeGradient(raw.gradient),

    has_glow: raw.has_glow === true,
    glow_color_hex: normHex(raw.glow_color_hex || raw.color_hex || global.primary_color_hex || '#FFFFFF'),
    glow_radius: Number.isFinite(raw.glow_radius) ? Number(raw.glow_radius) : 8,

    letter_spacing: String(raw.letter_spacing || 'normal').toLowerCase(),
    letter_spacing_em: Number.isFinite(raw.letter_spacing_em) ? Number(raw.letter_spacing_em) : undefined,
    entry_animation: String(raw.entry_animation || 'none').toLowerCase(),
  };

  // 유채색 박스 오판 보정 — '색 글씨'를 '색 박스'로 뒤집어 읽은 분석 결과를 되돌린다.
  // (예: 검은글씨+노란박스 → 노란글씨+검은외곽선, 박스 제거). 아래 가독성 보강보다 먼저 실행해
  // 박스가 풀린 레이어가 외곽선/그림자 보강을 받도록 한다.
  correctVividBoxMisread(out);

  // ----------------------------------------------------------------
  // 가독성 — "구조"만 보장하고 "색"은 강제하지 않는다 (다양한 색 표현 허용).
  //   1) 박스가 없으면 외곽선·그림자가 "존재" 하도록만 보강 (색/두께 선택은 존중).
  //   2) 외곽선/박스 색이 글자색과 거의 같아 사실상 안 보이는 "명백한 버그" 만 최소 교정.
  // ----------------------------------------------------------------
  if (!out.has_background_box) {
    const ot = String(out.outline_thickness || 'none').toLowerCase();
    if (ot === 'none' || ot === '') {
      out.outline_thickness = 'medium';
    }
    if (out.has_shadow !== true) {
      out.has_shadow = true;
      out.shadow_color_hex = out.shadow_color_hex || '#000000';
      out.shadow_offset_x = out.shadow_offset_x ?? 0;
      out.shadow_offset_y = out.shadow_offset_y ?? 3;
      out.shadow_blur = out.shadow_blur ?? 5;
    }
  }

  const finalOt = String(out.outline_thickness || 'none').toLowerCase();
  if (finalOt !== 'none' && finalOt !== '') {
    if (colorsNearlyIdentical(out.color_hex, out.outline_color_hex)) {
      out.outline_color_hex = pickReadableOutline(out.color_hex);
    }
  }

  if (out.has_background_box) {
    if (colorsNearlyIdentical(out.color_hex, out.background_color_hex)) {
      out.background_color_hex = pickReadableOutline(out.color_hex);
    }
  }

  return out;
}

// ============================================================
// fit + 스타일 결정
// ============================================================
function prepareLayer(layer: CaptionLayer, global: GlobalCaptionStyle): Prepared {
  const allCaps = !!global.all_caps;
  const rawText = allCaps ? layer.text.toUpperCase() : layer.text;
  const truncated = truncate(rawText);

  // ─────────────────────────────────────────────────────
  // 사이즈 결정 — LLM 의 size_level(=ref 의 의도) 을 우선 존중.
  //   1) layer.size_level (caption planning 이 ref 의 size 를 그대로 복사) 우선
  //   2) 없거나 알 수 없는 값이면 글자수 기준 추천(autoSizeLevel)
  //   3) 너비가 안 맞으면 폰트를 깎기 전에 \fscx(가로압축)로 먼저 맞춰 요청 크기를 유지
  //      (그래도 안 되면 줄수 2→3 → 폰트 축소 순. ref 의 "large" 가 결과에서 바닥으로 안 떨어지게)
  // ─────────────────────────────────────────────────────
  // 정밀 size_ratio(글자 높이 ÷ 영상 높이) 가 있으면 그걸로 연속 px 사이징.
  // 없으면 LLM 의 4단계 size_level → (모르면) 글자수 기반 autoSizeLevel 폴백.
  // 정밀 px 가 있을 땐 minSize/floor 경계가 일관되도록 sizeLevel 도 px 에서 파생한다.
  const precisePx = sizeRatioToPx(layer.size_ratio);
  const llmLevel = String(layer.size_level || '').toLowerCase();
  const bucketLevel = (llmLevel in SIZE_PT) ? llmLevel : autoSizeLevel(truncated);
  const sizeLevel = precisePx !== undefined ? bucketForSizePx(precisePx) : bucketLevel;
  const requested = precisePx ?? (SIZE_PT[sizeLevel] ?? SIZE_PT.medium);
  // fit 에 '폭 예산'(박스면 더 넓게)과 'size 단계별 줄 상한'을 넘겨 넘침 없는 캐스케이드를 돌린다.
  const fit = fitCaptionForFrame(truncated, requested, sizeLevel, {
    widthBudget: widthBudgetFor(layer),
    maxLinesCap: maxLinesFor(sizeLevel),
  });

  // 굵기 — 정밀 font_weight(100~900) 우선. ASS Bold 는 on/off 뿐이라 600+ 면 Bold,
  // 실제 굵기 차등은 weight 기반 폰트 선택(pickBundledFont)으로 반영한다.
  const weight = resolveFontWeight(layer);
  const fontFamily = pickBundledFont({
    category: layer.font_category,
    personality: layer.font_personality,
    emphasis: layer.emphasis,
    familyHint: layer.font_family_hint,
    weightHint: layer.font_weight_hint,
    weight,
  });
  const bold = weight >= 600;
  const italic = layer.italic === true;
  // 자간 — 정밀 letter_spacing_em(em) 우선, 없으면 tight/normal/wide 환산.
  const spacingPx = Math.round(resolveLetterSpacingEm(layer) * fit.fontSize);

  // 자폭(\fscx) — 정밀 font_width_ratio 우선(없으면 condensed/expanded enum).
  //  - 압축(<100): fit 압축과 더 좁은 쪽 채택. - 확장(>100): fit 가 폭부족으로 이미 압축했으면 포기,
  //    여유 있으면 폭 예산 안에서만 확장(가로 넘침 방지).
  const widthScale = resolveFontWidthScale(layer);
  const widest = fit.lines.reduce((m, l) => Math.max(m, measureTextWidth(l, fit.fontSize)), 1);
  let scaleX = fit.scaleX;
  if (widthScale < 100) {
    scaleX = Math.min(fit.scaleX, widthScale);
  } else if (widthScale > 100 && fit.scaleX >= 100) {
    const maxExpand = Math.floor((widthBudgetFor(layer) / widest) * 100);
    scaleX = clampNum(Math.min(widthScale, Math.max(100, maxExpand)), 100, 150);
  }

  // 박스 padding 은 단일 헬퍼로 통일(blockH/blockW/buildStyleLine 일치).
  const boxPad = layer.has_background_box ? boxPaddingPx(layer, fit.fontSize) : 0;
  const lineHeight = Math.ceil(fit.fontSize * 1.32);
  const blockH = lineHeight * fit.lines.length + 2 * boxPad;

  // 블록 가로 폭 — horizontal_ratio 배치/클램프용. 박스면 좌우 padding 포함해 실제 박스 폭으로 평가.
  const blockW = widest * (scaleX / 100) + 2 * boxPad;

  return {
    layer,
    lines: fit.lines,
    fontSize: fit.fontSize,
    scaleX,
    fontFamily,
    bold,
    italic,
    position: normalizePosition(layer.position),
    hAlign: normalizeHAlign(layer.horizontal_align),
    spacingPx,
    blockH,
    blockW,
    anchor: 2,
    x: SCRIPT_W / 2,
    y: SCRIPT_H - V_MARGIN,
  };
}

// ============================================================
// 주체 기준 자막 위치 — 컷의 주피사체(subject_center_y)를 가리지 않도록
// 단일 자막을 주체 반대편(위/아래)에 배치. 보여주려는 부분 위에 글자가
// 겹치지 않게 한다. (멀티 layer 컷은 ref 디자인을 그대로 두어 충돌 방지)
// ============================================================
function applySubjectAwarePosition(items: Prepared[], subjectCenterY?: number): void {
  if (items.length !== 1) return;
  // 원본의 정밀 세로위치(vertical_ratio)가 있으면 그걸 우선 — 주체 스냅으로 덮지 않는다.
  if (layerVRatio(items[0].layer) !== null) return;
  if (typeof subjectCenterY !== 'number' || !Number.isFinite(subjectCenterY)) return;
  const p = items[0];
  if (subjectCenterY < 0.4) p.position = 'bottom';        // 주체가 위 → 자막 아래
  else if (subjectCenterY > 0.6) p.position = 'top';      // 주체가 아래 → 자막 위
  // 중앙(0.4~0.6)이면 ref 위치 유지
}

// 유효한 vertical_ratio(0~1) 면 반환, 아니면 null.
function layerVRatio(layer: CaptionLayer): number | null {
  const v = Number(layer.vertical_ratio);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

// 유효한 horizontal_ratio(0~1) 면 반환, 아니면 null.
function layerHRatio(layer: CaptionLayer): number | null {
  const h = Number(layer.horizontal_ratio);
  return Number.isFinite(h) && h >= 0 && h <= 1 ? h : null;
}

// ============================================================
// 멀티 layer 수직 배치 (\an + \pos 좌표 산출)
// ============================================================
function placeLayers(items: Prepared[]): void {
  // 각 layer 의 anchor / x / (vr 있으면 y) 결정.
  //  - horizontal_ratio 있으면 → x = hr*W, 가로 앵커 center(블록 중심을 좌표에 둠). 없으면 정렬(anchorX).
  //  - vertical_ratio 있으면   → y = vr*H, 세로 앵커 middle. 없으면 아래 top/center/bottom 스택에서 y 계산.
  for (const p of items) {
    const hr = layerHRatio(p.layer);
    const vr = layerVRatio(p.layer);
    const hMode: 'left' | 'center' | 'right' = hr !== null ? 'center' : p.hAlign;
    const vMode: 'top' | 'center' | 'bottom' = vr !== null ? 'center' : p.position;
    p.anchor = anchorCode(vMode, hMode);
    p.x = hr !== null ? Math.round(hr * SCRIPT_W) : anchorX(p.hAlign);
    if (vr !== null) p.y = Math.round(vr * SCRIPT_H);
  }

  // 나머지(정밀 세로위치 없음)만 기존 top/center/bottom 고정 스택으로.
  const rest = items.filter(p => layerVRatio(p.layer) === null);
  const top = rest.filter(p => p.position === 'top');
  const center = rest.filter(p => p.position === 'center');
  const bottom = rest.filter(p => p.position === 'bottom');

  // 인접 layer 의 평균 fontSize 에 비례한 동적 gap (큰 자막은 더 넓은 간격).
  const gapBetween = (a: Prepared, b: Prepared) =>
    Math.max(STACK_GAP_MIN, Math.round(((a.fontSize + b.fontSize) / 2) * STACK_GAP_RATIO));

  // top: 위에서 아래로 (anchor 가 top edge)
  let topCursor = V_MARGIN;
  for (let i = 0; i < top.length; i++) {
    const p = top[i];
    p.y = topCursor;
    const next = top[i + 1];
    topCursor += p.blockH + (next ? gapBetween(p, next) : 0);
  }

  // bottom: 아래에서 위로 (anchor 가 bottom edge). 배열 첫 항목이 가장 아래.
  let bottomCursor = SCRIPT_H - V_MARGIN;
  for (let i = 0; i < bottom.length; i++) {
    const p = bottom[i];
    p.y = bottomCursor;
    const next = bottom[i + 1];
    bottomCursor -= p.blockH + (next ? gapBetween(p, next) : 0);
  }

  // center: 화면 중앙 기준으로 블록 중심 정렬 (anchor 가 vertical center)
  if (center.length > 0) {
    let totalH = center.reduce((s, p) => s + p.blockH, 0);
    for (let i = 0; i < center.length - 1; i++) totalH += gapBetween(center[i], center[i + 1]);
    let edge = SCRIPT_H / 2 - totalH / 2;
    for (let i = 0; i < center.length; i++) {
      const p = center[i];
      p.y = Math.round(edge + p.blockH / 2);
      edge += p.blockH + (i < center.length - 1 ? gapBetween(p, center[i + 1]) : 0);
    }
  }

  // 안전 마진 보정 — anchor 종류에 맞춰 화면 안으로.
  const safeTop = Math.round(V_MARGIN / 2);
  const safeBottom = SCRIPT_H - Math.round(V_MARGIN / 2);
  for (const p of items) {
    const a = p.anchor;
    if (a >= 7) {
      // top anchor: y = top edge
      const maxTop = safeBottom - p.blockH;
      p.y = Math.min(Math.max(p.y, safeTop), Math.max(safeTop, maxTop));
    } else if (a <= 3) {
      // bottom anchor: y = bottom edge
      const minBottom = safeTop + p.blockH;
      p.y = Math.max(Math.min(p.y, safeBottom), Math.min(safeBottom, minBottom));
    } else {
      // middle anchor: y = center
      const half = p.blockH / 2;
      p.y = Math.min(Math.max(p.y, safeTop + half), safeBottom - half);
    }
    p.y = Math.round(p.y);
  }

  // 레이어 수직 충돌 해소 — bbox 가 겹치는(또는 최소 gap 미만) 레이어들을 ref 순서 유지한 채 분리.
  // (vertical_ratio 좌표 배치 레이어끼리도 적용. 긴 텍스트로 blockH 가 커진 경우도 처리.)
  resolveVerticalOverlaps(items);

  // 가로 안전 마진 — anchor 열에 맞춰 블록이 화면 밖으로 안 나가게.
  const safeLeft = H_MARGIN;
  const safeRight = SCRIPT_W - H_MARGIN;
  for (const p of items) {
    const col = (p.anchor - 1) % 3; // 0=left, 1=center, 2=right
    const w = p.blockW;
    if (col === 1) {
      // center anchor: x = 블록 중심
      const half = w / 2;
      const lo = safeLeft + half, hi = safeRight - half;
      p.x = lo <= hi ? Math.min(Math.max(p.x, lo), hi) : Math.round(SCRIPT_W / 2);
    } else if (col === 0) {
      // left anchor: x = 블록 왼쪽 끝
      p.x = Math.min(Math.max(p.x, safeLeft), Math.max(safeLeft, safeRight - w));
    } else {
      // right anchor: x = 블록 오른쪽 끝
      p.x = Math.max(Math.min(p.x, safeRight), Math.min(safeRight, safeLeft + w));
    }
    p.x = Math.round(p.x);
  }
}

// ============================================================
// 레이어 bbox(세로 범위) — anchor 종류에 따라 y 기준이 다르다.
// ============================================================
export function layerBBox(p: Prepared): { top: number; bottom: number } {
  const a = p.anchor;
  if (a >= 7) return { top: p.y, bottom: p.y + p.blockH };           // top anchor: y=상단
  if (a <= 3) return { top: p.y - p.blockH, bottom: p.y };           // bottom anchor: y=하단
  return { top: p.y - p.blockH / 2, bottom: p.y + p.blockH / 2 };    // middle anchor: y=중심
}

function setBBoxTop(p: Prepared, top: number): void {
  const a = p.anchor;
  if (a >= 7) p.y = Math.round(top);                  // top anchor
  else if (a <= 3) p.y = Math.round(top + p.blockH);  // bottom anchor
  else p.y = Math.round(top + p.blockH / 2);          // middle anchor
}

// ============================================================
// 레이어 수직 충돌 해소 (순수 함수 — 테스트 가능).
//  - bbox 가 겹치거나 최소 gap(fontSize 비례) 미만이면 ref 상대순서를 유지한 채 위/아래로 분리.
//  - 분리 후 그룹을 원래 중심 부근으로 되돌리고, safe area 안으로 클램프.
//  - vertical_ratio 좌표 배치 레이어끼리도 적용된다(같은 caption group 으로 간주).
//  - 긴 텍스트로 blockH 가 커져도 겹치지 않는다(스택이 화면보다 크면 최선으로 클램프).
// ============================================================
export function resolveVerticalOverlaps(items: Prepared[]): void {
  if (!Array.isArray(items) || items.length < 2) return;

  const safeTop = Math.round(V_MARGIN / 2);
  const safeBottom = SCRIPT_H - Math.round(V_MARGIN / 2);
  const gapOf = (a: Prepared, b: Prepared) =>
    Math.max(STACK_GAP_MIN, Math.round(((a.fontSize + b.fontSize) / 2) * STACK_GAP_RATIO));

  // ref 상대 순서 = 현재 bbox 중심 y 오름차순 (동률이면 원래 인덱스 유지).
  const order = items
    .map((p, i) => { const b = layerBBox(p); return { p, i, c: (b.top + b.bottom) / 2 }; })
    .sort((a, b) => (a.c - b.c) || (a.i - b.i));

  // 겹침/gap부족이 없으면 변경하지 않음(ref 위치 보존).
  let needs = false;
  for (let k = 1; k < order.length; k++) {
    const minTop = layerBBox(order[k - 1].p).bottom + gapOf(order[k - 1].p, order[k].p);
    if (layerBBox(order[k].p).top < minTop - 0.5) { needs = true; break; }
  }
  if (!needs) return;

  const seq = order.map(o => o.p);
  const origCenter = order.reduce((s, o) => s + o.c, 0) / order.length;

  // 1) 위→아래로 최소 gap 확보하며 밀어내기.
  for (let k = 1; k < seq.length; k++) {
    const minTop = layerBBox(seq[k - 1]).bottom + gapOf(seq[k - 1], seq[k]);
    if (layerBBox(seq[k]).top < minTop) setBBoxTop(seq[k], minTop);
  }

  // 2) 해소된 스택을 원래 중심 부근으로 재배치 + safe area 클램프.
  const stackTop = layerBBox(seq[0]).top;
  const stackBottom = layerBBox(seq[seq.length - 1]).bottom;
  let shift = origCenter - (stackTop + stackBottom) / 2;
  if (stackBottom + shift > safeBottom) shift = safeBottom - stackBottom; // 아래 넘침 방지
  if (stackTop + shift < safeTop) shift = safeTop - stackTop;             // 위 넘침 방지(우선)
  if (Math.abs(shift) > 0.5) for (const p of seq) setBBoxTop(p, layerBBox(p).top + shift);
}

function anchorCode(position: 'top' | 'center' | 'bottom', hAlign: 'left' | 'center' | 'right'): number {
  const col = hAlign === 'left' ? 0 : (hAlign === 'right' ? 2 : 1);     // 0,1,2
  const rowBase = position === 'bottom' ? 1 : (position === 'center' ? 4 : 7);
  return rowBase + col;
}

function anchorX(hAlign: 'left' | 'center' | 'right'): number {
  if (hAlign === 'left') return H_MARGIN;
  if (hAlign === 'right') return SCRIPT_W - H_MARGIN;
  return Math.round(SCRIPT_W / 2);
}

// ============================================================
// Style 라인 빌드
// 결정 트리:
//   has_background_box  → BorderStyle=3 (불투명 박스). OutlineColour=박스색, Outline=padding.
//   else has_glow       → BorderStyle=1, OutlineColour=글로우색 (+ dialogue \blur).
//   else                → BorderStyle=1, OutlineColour=외곽선색, Outline=두께.
// ============================================================
function buildStyleLine(name: string, p: Prepared): string {
  const layer = p.layer;
  const primary = hexToAss(resolvePrimary(layer));
  const back = hexToAss(layer.shadow_color_hex || '#000000');

  let borderStyle = 1;
  let outlineColour = hexToAss(layer.outline_color_hex || '#000000');
  let outline = 0;
  let shadow = 0;

  if (layer.has_background_box) {
    borderStyle = 3;
    // 박스 배경색 + 투명도(background_alpha). alpha=0.5 면 반투명 박스, 1 이면 불투명.
    outlineColour = hexToAss(layer.background_color_hex || '#000000', layer.background_alpha);
    // 박스 padding — prepareLayer 의 blockH/blockW 와 동일한 헬퍼로 일치시킨다.
    outline = boxPaddingPx(layer, p.fontSize);
  } else if (layer.has_glow) {
    borderStyle = 1;
    outlineColour = hexToAss(layer.glow_color_hex || layer.color_hex || '#FFFFFF');
    // 글로우 외곽은 fontSize 의 5~12% 가 자연스러움.
    const glow = layer.glow_radius ?? Math.round(p.fontSize * 0.08);
    outline = clampNum(Math.round(glow * 0.6), 3, 24);
  } else {
    borderStyle = 1;
    // 외곽선 두께 = fontSize × 정밀 비율(outline_ratio 우선, 없으면 enum 환산).
    outline = Math.max(0, Math.round(p.fontSize * resolveOutlineRatio(layer)));
  }

  if (layer.has_shadow) {
    // shadow 오프셋도 LLM 미기재면 fontSize 비례 기본값.
    const dx = Math.abs(layer.shadow_offset_x ?? 0);
    const dy = Math.abs(layer.shadow_offset_y ?? Math.round(p.fontSize * SHADOW_DEFAULT_RATIO_Y));
    const minShadow = Math.max(2, Math.round(p.fontSize * SHADOW_DEFAULT_BLUR_RATIO));
    shadow = clampNum(Math.round(Math.max(dx, dy, minShadow)), 0, 40);
  }

  const bold = p.bold ? -1 : 0;
  const italic = p.italic ? -1 : 0;

  // Name, Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold, Italic, Underline, StrikeOut,
  // ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  return [
    `Style: ${name}`,
    escapeStyleField(p.fontFamily),
    String(p.fontSize),
    primary,
    primary,
    outlineColour,
    back,
    String(bold),
    String(italic),
    '0', '0',
    String(p.scaleX), '100',
    String(p.spacingPx),
    '0',
    String(borderStyle),
    String(outline),
    String(shadow),
    String(p.anchor),
    '0', '0', '0',
    '1',
  ].join(',');
}

// ============================================================
// Dialogue 라인 빌드 — 위치/애니메이션/글로우-blur/그림자 방향을 인라인 태그로.
// ============================================================
function buildDialogueLine(styleName: string, p: Prepared, start: number, end: number, dur: number): string {
  const layer = p.layer;
  const tags: string[] = [];

  // 위치 / 등장 애니메이션
  const anim = String(layer.entry_animation || 'none').toLowerCase();
  const slide = slideOffset(anim);
  if (slide) {
    const moveMs = Math.min(320, Math.round(dur * 1000 * 0.4));
    tags.push(`\\move(${p.x + slide.dx},${p.y + slide.dy},${p.x},${p.y},0,${moveMs})`);
  } else {
    tags.push(`\\pos(${p.x},${p.y})`);
  }

  // fade in/out
  const fadeMs = fadeMillis(anim, dur);
  if (fadeMs > 0) tags.push(`\\fad(${fadeMs},${fadeMs})`);

  // 그림자 방향 (BorderStyle 무관하게 적용) — style Shadow 와 함께 방향성 보강
  if (layer.has_shadow) {
    const dx = Math.round(layer.shadow_offset_x ?? 0);
    const dy = Math.round(layer.shadow_offset_y ?? 4);
    if (dx !== 0) tags.push(`\\xshad${dx}`);
    if (dy !== 0) tags.push(`\\yshad${dy}`);
    // 부드러운 그림자/헤일로 — shadow_blur 가 있으면 \blur 로 외곽·그림자를 흐린다.
    // (레퍼런스처럼 "글자 획 주변만 어둡게 퍼지는" 룩을 박스 없이 재현. 이전엔 shadow_blur 가
    //  파싱·보존만 되고 렌더에서 완전히 무시됐다.) 박스가 있으면 무의미, 글로우가 이미 \blur 를
    //  넣는 경우는 중복을 피한다.
    if (!layer.has_background_box && !layer.has_glow) {
      const sb = Number(layer.shadow_blur);
      if (Number.isFinite(sb) && sb > 0) tags.push(`\\blur${clampNum(Math.round(sb), 1, 24)}`);
    }
  }

  // 글로우 근사 — 외곽선을 부드럽게 blur (fontSize 비례)
  if (layer.has_glow && !layer.has_background_box) {
    const fallback = Math.round(p.fontSize * 0.08);
    const blur = clampNum(Math.round(layer.glow_radius ?? fallback), 2, 28);
    tags.push(`\\blur${blur}`);
  }

  const override = `{${tags.join('')}}`;
  const text = renderCaptionText(p.lines, layer);

  return `Dialogue: 0,${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${override}${text}`;
}

// 본문 렌더 — 인라인 색 runs 가 있으면 grapheme 단위로 색을 입히고, 없으면 단색.
//   color_runs 를 이어붙인 비공백 grapheme 순서대로 색을 매핑 → wrap 으로 줄이 나뉘어도
//   (줄바꿈 시 공백만 변함) 비공백 문자 순서는 보존되므로 정확히 따라간다.
function renderCaptionText(lines: string[], layer: CaptionLayer): string {
  const runs = layer.color_runs;
  if (!runs || runs.length < 2) return lines.map(sanitizeAssLine).join('\\N');

  const colorSeq: string[] = [];
  for (const r of runs) {
    for (const g of graphemes(String(r.text || ''))) {
      if (/^\s+$/.test(g)) continue;
      colorSeq.push(r.color_hex);
    }
  }
  if (colorSeq.length === 0) return lines.map(sanitizeAssLine).join('\\N');

  let nsIdx = 0;
  let curColor = '';
  const out: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) out.push('\\N');
    for (const g of graphemes(lines[li])) {
      if (/^\s+$/.test(g)) { out.push(escapeAssChar(g)); continue; }
      const color = colorSeq[Math.min(nsIdx, colorSeq.length - 1)];
      nsIdx++;
      if (color !== curColor) { out.push(`{\\1c${hexToAss(color)}&}`); curColor = color; }
      out.push(escapeAssChar(g));
    }
  }
  return out.join('');
}

// 단일 grapheme 의 ASS 제어문자 무력화 (sanitizeAssLine 의 char 버전, trim 없음).
function escapeAssChar(g: string): string {
  return g.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝');
}

function slideOffset(anim: string): { dx: number; dy: number } | null {
  switch (anim) {
    case 'slide_in_top': return { dx: 0, dy: -240 };
    case 'slide_in_bottom': return { dx: 0, dy: 240 };
    case 'slide_in_left': return { dx: -340, dy: 0 };
    case 'slide_in_right': return { dx: 340, dy: 0 };
    default: return null;
  }
}

function fadeMillis(anim: string, dur: number): number {
  if (anim === 'none') return 0;
  // pop 은 짧게, 그 외(fade/slide)는 부드럽게. 컷 길이의 35% 를 넘지 않게.
  const base = anim === 'pop' ? 120 : 260;
  const cap = Math.max(0, Math.round(dur * 1000 * 0.35));
  return Math.min(base, cap);
}

// ============================================================
// 색 처리
// ============================================================
// gradient 있으면 첫 stop 색(없으면 color_hex). ASS 는 글자 그라데이션 불가.
function resolvePrimary(layer: CaptionLayer): string {
  const grad = layer.gradient;
  if (grad && grad.type === 'linear' && grad.stops && grad.stops.length >= 1) {
    // ASS 는 글자 그라데이션 불가 → stops 평균색(대표색)으로 단색 degrade(첫 색만 쓰던 것 개선).
    return averageHex(grad.stops.map(s => s.color)) || grad.stops[0].color;
  }
  return layer.color_hex || '#FFFFFF';
}

// 여러 hex 색의 평균(대표색). 그라데이션을 단색으로 degrade 할 때 사용.
function averageHex(hexes: string[]): string | null {
  const valid = hexes.map(normHex).filter(h => /^#[0-9A-F]{6}$/.test(h));
  if (valid.length === 0) return null;
  let r = 0, g = 0, b = 0;
  for (const h of valid) {
    r += parseInt(h.slice(1, 3), 16);
    g += parseInt(h.slice(3, 5), 16);
    b += parseInt(h.slice(5, 7), 16);
  }
  const n = valid.length;
  const hx = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`.toUpperCase();
}

// #RRGGBB → ASS &HAABBGGRR (BGR 순서). alpha(0~1, 1=불투명) 를 주면 AA 에 반영.
// ASS alpha 규약: AA=00 불투명, FF 완전투명 → AA = round((1-alpha)*255). alpha 미지정이면 불투명(00).
function hexToAss(hex?: string, alpha?: number): string {
  const h = normHex(hex).replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  let aa = '00';
  if (Number.isFinite(alpha as number)) {
    const a = Math.max(0, Math.min(255, Math.round((1 - (alpha as number)) * 255)));
    aa = a.toString(16).padStart(2, '0');
  }
  return `&H${aa}${b}${g}${r}`.toUpperCase();
}

function normHex(hex?: string): string {
  let h = String(hex || '').trim();
  if (!h) return '#FFFFFF';
  if (h[0] !== '#') h = `#${h}`;
  if (/^#[0-9A-Fa-f]{3}$/.test(h)) {
    // #abc → #aabbcc
    h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(h)) return '#FFFFFF';
  return h.toUpperCase();
}

function colorsNearlyIdentical(a?: string, b?: string): boolean {
  return Math.abs(lumaOf(a) - lumaOf(b)) < 0.12;
}

function pickReadableOutline(textHex?: string): string {
  return lumaOf(textHex) > 0.55 ? '#000000' : '#FFFFFF';
}

// 고채도 유채색인가 — 검정/흰/회색/어두운 반투명 같은 '진짜 배경판' 색과 구분하기 위한 신호.
// (한국형 임팩트 자막의 노랑/빨강/초록 '색 글씨'를 박스로 오판했는지 가리는 데 쓴다.)
function isVividChroma(hex?: string): boolean {
  const h = normHex(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255; // 0(무채색)~1(순색)
  const lum = lumaOf(hex);
  return chroma >= 0.45 && lum > 0.12 && lum < 0.95;
}

// ============================================================
// '색 글씨'를 '색 박스'로 뒤집어 읽은 분석 오판을 렌더 직전 결정적으로 되돌린다.
//
// 배경: 한국형 임팩트 자막은 '유채색 굵은 글씨 + 어두운 외곽선/그림자'가 매우 흔한데,
// 분석 LLM 은 이를 자주 '유채색 박스 + (검정/흰) 글씨'로 뒤집어 읽는다.
//   예) 노란 "기린이찌방 한강점"(검은 외곽선) → color=#000000 + box=#FFE600 (검은 글씨+노란 박스)
// 진짜 배경판은 보통 검정/흰/회색/어두운 반투명이라, '유채색 불투명 박스'는 거의 항상 오판이다.
// 프롬프트 경고만으론 못 막아(LLM 이 계속 틀림) 여기서 결정적으로 교정한다.
// ============================================================
function correctVividBoxMisread(out: CaptionLayer): void {
  if (out.has_background_box !== true) return;
  const box = out.background_color_hex || '';
  if (!isVividChroma(box)) return;                    // 검정/흰/회색/어두운 박스는 진짜 → 보존
  const textLum = lumaOf(out.color_hex);

  if (colorsNearlyIdentical(out.color_hex, box)) {
    // 글자색 ≈ 박스색 (노란 글씨를 노란 박스로): 색 글씨다.
    out.color_hex = box;
    out.has_background_box = false;
    out.background_color_hex = '';
  } else if (textLum < 0.2) {
    // 유채색 글씨 + 검은 외곽선을 '검은 글씨 + 유채색 박스'로 뒤집어 읽음.
    // → 유채색을 글자색으로 되돌리고, 검정은 외곽선으로.
    out.color_hex = box;
    out.has_background_box = false;
    out.background_color_hex = '';
    out.outline_color_hex = '#000000';
    const ot = String(out.outline_thickness || '').toLowerCase();
    if (ot === 'none' || ot === '') out.outline_thickness = 'medium';
  } else if (lumaOf(box) > 0.6 && textLum > 0.6) {
    // 밝은 유채색 '박스' + 밝은(흰) 글씨 = 대비 모순 → 인접 색글씨의 번짐을 박스로 오판한 것.
    // 박스만 해제하고 글자색(흰색 등)은 유지.
    out.has_background_box = false;
    out.background_color_hex = '';
  }
}

function lumaOf(hex?: string): number {
  const h = normHex(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function normalizeGradient(raw: any): CaptionLayer['gradient'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = String(raw.type || '').toLowerCase();
  if (type !== 'linear') return undefined;
  const stops = Array.isArray(raw.stops) ? raw.stops : [];
  const cleanStops = stops
    .map((s: any) => ({ offset: clamp01(Number(s?.offset) || 0), color: normHex(s?.color) }))
    .filter((s: any) => /^#[0-9A-Fa-f]{6}$/.test(s.color));
  if (cleanStops.length < 1) return undefined;
  return {
    type: 'linear',
    angle: Number.isFinite(raw.angle) ? Number(raw.angle) : 0,
    stops: cleanStops,
  };
}

// ============================================================
// 텍스트 fit / wrapping (SVG 버전과 동일 로직)
// ============================================================
function autoSizeLevel(text: string): string {
  const chars = graphemes(text).filter(g => !/\s/.test(g)).length;
  if (chars <= 5) return 'huge';
  if (chars <= 9) return 'large';
  if (chars <= 18) return 'medium';
  return 'small';
}

// 정밀 글자 크기: size_ratio(글자 높이 ÷ 영상 높이) → ASS Fontsize(px).
// SIZE_PT 버킷과 동일 스케일(px = ratio × SCRIPT_H)이라 버킷 폴백과 자연스럽게 호환된다.
// (small≈0.033 / medium≈0.05 / large≈0.073 / huge≈0.104 부근.)
// 비정상/누락 값은 undefined 반환 → 호출부가 4단계 버킷으로 폴백.
function sizeRatioToPx(ratio?: number): number | undefined {
  if (!Number.isFinite(ratio as number)) return undefined;
  const r = Number(ratio);
  if (r <= 0.005 || r > 0.5) return undefined;          // 너무 작거나 큰 값은 신뢰하지 않음
  return clampNum(Math.round(r * SCRIPT_H), 44, 240);   // small 하한 ~ huge 상한 근처로 클램프
}

// 정밀 px → 가장 가까운 4단계 버킷. minSize/floor 경계 + 폰트 선택 일관성을 위해 사용.
function bucketForSizePx(px: number): string {
  if (px < 80) return 'small';
  if (px < 118) return 'medium';
  if (px < 170) return 'large';
  return 'huge';
}

function truncate(s: string): string {
  const t = s.trim();
  const chars = graphemes(t);
  if (chars.length <= MAX_CAPTION_CHARS) return t;
  return `${chars.slice(0, MAX_CAPTION_CHARS - 1).join('').trimEnd()}...`;
}

// 텍스트를 줄바꿈하고, ref 의 요청 크기를 최대한 유지한 채 폭을 맞춘다.
// 우선순위:
//   A) 요청 크기 유지 — 줄수(2줄, 긴 텍스트면 3줄까지) × 가로압축(\fscx)으로 폭에 맞추기.
//      줄바꿈만으로 맞으면 압축 없음(scaleX=100). 살짝 넘으면 폰트는 그대로 두고
//      \fscx 로만 폭을 흡수(scaleX≥MIN_SCALEX) → ref 의 medium/large 가 바닥으로 안 깎임.
//   B) 그래도 과하면 폰트를 단계 축소(최대 줄수 사용)하며 가로압축 병행.
//   C) 최후 — minSize + 최대 압축(과압축 방지 하한 FLOOR_SCALEX).
// 줄수/폰트/압축만 조정하며 text·레이어 구조(형태)는 건드리지 않는다.
function fitCaptionForFrame(
  text: string,
  requestedSize: number,
  sizeLevel: string,
  opts?: { widthBudget?: number; maxLinesCap?: number },
): { lines: string[]; fontSize: number; scaleX: number } {
  const minSize = MIN_SIZE_PT[sizeLevel] ?? 60;
  // 폭 예산(박스면 더 넓게)과 size 단계별 줄 상한.
  const budget = opts?.widthBudget && opts.widthBudget > 0 ? opts.widthBudget : CAPTION_MAX_W;
  const lineCap = Math.max(2, opts?.maxLinesCap ?? 3);

  // 0) 명시적 줄바꿈(\n) 존중 — LLM/레퍼런스가 넣은 줄 구조는 그대로 두고 폰트축소+압축으로만 맞춘다.
  if (/[\r\n]/.test(text)) {
    const explicit = text.split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (explicit.length >= 2) return fitFixedLines(explicit, requestedSize, minSize, budget);
    if (explicit.length === 1) text = explicit[0];
  }

  // A0) huge/large 한 줄 유지 우선 — 임팩트 hook 은 한 줄이 자연스럽다.
  if (sizeLevel === 'huge' || sizeLevel === 'large') {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine) {
      for (let size = requestedSize; size >= minSize; size -= 6) {
        const w = measureTextWidth(oneLine, size);
        if (w <= budget) return { lines: [oneLine], fontSize: size, scaleX: 100 };
        const scaleX = Math.floor((budget / w) * 100);
        if (scaleX >= SINGLE_LINE_MIN_SCALEX) {
          return { lines: [oneLine], fontSize: size, scaleX: clampNum(scaleX, SINGLE_LINE_MIN_SCALEX, 100) };
        }
      }
    }
  }

  // 줄수 옵션: 2부터 size 단계 상한까지 점증.
  const lineOptions: number[] = [];
  for (let n = 2; n <= lineCap; n++) lineOptions.push(n);
  if (lineOptions.length === 0) lineOptions.push(2);

  const tryFit = (size: number, maxLines: number): { lines: string[]; fontSize: number; scaleX: number } | null => {
    const lines = wrapLinesNoTrunc(text, size, maxLines, budget);
    const widest = maxLineWidth(lines, size);
    if (widest <= budget) return { lines, fontSize: size, scaleX: 100 };
    const scaleX = Math.floor((budget / widest) * 100);
    if (scaleX >= MIN_SCALEX) return { lines, fontSize: size, scaleX: clampNum(scaleX, MIN_SCALEX, 100) };
    return null;
  };

  // 사이즈 맞춤 캐스케이드 (요청하신 우선순위):
  // (1) 요청 크기 유지 + 줄수 점증(=박스/폭예산 안에서 최대한 크게)
  for (const maxLines of lineOptions) {
    const hit = tryFit(requestedSize, maxLines);
    if (hit) return hit;
  }
  // (2) 텍스트 크기 축소(최대 줄수 사용) + 가로압축
  const maxLines = lineOptions[lineOptions.length - 1];
  for (let size = requestedSize - 6; size >= minSize; size -= 6) {
    const hit = tryFit(size, maxLines);
    if (hit) return hit;
  }
  // (3) 줄 추가 escalation — minSize 에서 줄 수를 절대 상한까지 늘려 넘침 없이 담아본다.
  const HARD_MAX_LINES = Math.max(maxLines, 6);
  for (let extra = maxLines + 1; extra <= HARD_MAX_LINES; extra++) {
    const hit = tryFit(minSize, extra);
    if (hit) return hit;
  }
  // (4) 최종 보장 — minSize + 최대 줄수 + 절대 압축으로 '가로 넘침 0' 보장(최후엔 45%까지 눌러서라도).
  const lines = wrapLinesNoTrunc(text, minSize, HARD_MAX_LINES, budget);
  const widest = maxLineWidth(lines, minSize);
  const scaleX = clampNum(Math.floor((budget / widest) * 100), 45, 100);
  return { lines, fontSize: minSize, scaleX };
}

// 줄 구조 고정(명시적 \n 줄들)으로 fit — 재wrap 없이 폰트 축소 + \fscx 가로압축으로만 폭에 맞춘다.
// 요청 크기부터 minSize 까지 단계적으로 낮추며 각 단계에서 가로압축(MIN_SCALEX 하한)으로 시도,
// 끝내 안 되면 minSize + 최대 압축(FLOOR_SCALEX). 줄 수/줄 내용은 절대 바꾸지 않는다.
function fitFixedLines(
  lines: string[],
  requestedSize: number,
  minSize: number,
  budget: number = CAPTION_MAX_W,
): { lines: string[]; fontSize: number; scaleX: number } {
  for (let size = requestedSize; size >= minSize; size -= 6) {
    const widest = maxLineWidth(lines, size);
    if (widest <= budget) return { lines, fontSize: size, scaleX: 100 };
    const scaleX = Math.floor((budget / widest) * 100);
    if (scaleX >= MIN_SCALEX) return { lines, fontSize: size, scaleX: clampNum(scaleX, MIN_SCALEX, 100) };
  }
  const widest = maxLineWidth(lines, minSize);
  const scaleX = clampNum(Math.floor((budget / widest) * 100), FLOOR_SCALEX, 100);
  return { lines, fontSize: minSize, scaleX };
}

// 줄바꿈만 수행(truncate 없음). maxLines 를 넘기면 나머지는 마지막 줄에 몰아 담고,
// 폭 초과분은 호출부가 \fscx 로 흡수한다. (MAX_CAPTION_CHARS 로 길이는 이미 상한돼 있음.)
function wrapLinesNoTrunc(text: string, fontSize: number, maxLines: number, budget: number = CAPTION_MAX_W): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];
  const tokens = normalized.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    const pieces = splitLongToken(token, fontSize, budget);
    for (const piece of pieces) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (!current) {
        current = candidate;
      } else if (lines.length < maxLines - 1 && measureTextWidth(candidate, fontSize) > budget) {
        lines.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function maxLineWidth(lines: string[], fontSize: number): number {
  return Math.max(1, ...lines.map(l => measureTextWidth(l, fontSize)));
}

function splitLongToken(token: string, fontSize: number, budget: number = CAPTION_MAX_W): string[] {
  if (measureTextWidth(token, fontSize) <= budget) return [token];
  const pieces: string[] = [];
  let current = '';
  for (const ch of graphemes(token)) {
    const candidate = current + ch;
    if (current && measureTextWidth(candidate, fontSize) > budget) {
      pieces.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function measureTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of graphemes(text)) {
    if (/\s/.test(ch)) units += 0.4;
    else if (isEmojiLike(ch)) units += 1.25;
    else if (isWideGlyph(ch)) units += 1.13;
    else if (/[가-힣一-龥ぁ-ゔァ-ヴー々〆〤]/.test(ch)) units += 1.13;
    else if (/[A-Z0-9]/.test(ch)) units += 0.72;
    else if (/[a-z]/.test(ch)) units += 0.62;
    else units += 0.46;
  }
  return units * fontSize;
}

function graphemes(s: string): string[] {
  const Segmenter = (Intl as any).Segmenter;
  if (typeof Segmenter === 'function') {
    return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x: any) => x.segment);
  }
  return Array.from(s);
}

function isEmojiLike(s: string): boolean {
  return /\p{Extended_Pictographic}/u.test(s);
}

function isWideGlyph(s: string): boolean {
  return /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(s);
}

function normalizePosition(p?: string): 'top' | 'center' | 'bottom' {
  const v = String(p || 'bottom').toLowerCase();
  if (v === 'top') return 'top';
  if (v === 'center' || v === 'middle') return 'center';
  return 'bottom';
}

function normalizeHAlign(h?: string): 'left' | 'center' | 'right' {
  const v = String(h || 'center').toLowerCase();
  if (v === 'left') return 'left';
  if (v === 'right') return 'right';
  return 'center';
}

// ============================================================
// ASS 직렬화 유틸
// ============================================================
function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(c)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Dialogue 본문에서 ASS 제어문자 무력화. (override 블록의 \N 은 호출부에서 별도로 join)
function sanitizeAssLine(s: string): string {
  return String(s || '')
    .replace(/\\/g, '＼')   // 리터럴 백슬래시 → 전각 (희귀)
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\r?\n/g, ' ')
    .trim();
}

// Style 의 Fontname 등 콤마 포함 금지 필드 보호.
function escapeStyleField(s: string): string {
  return String(s || '').replace(/,/g, ' ');
}

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
