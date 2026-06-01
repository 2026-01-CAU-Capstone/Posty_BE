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
const H_MARGIN = 96;
const CAPTION_MAX_W = SCRIPT_W - H_MARGIN * 2;   // 888
const V_MARGIN = 130;
const STACK_GAP = 34;

const SIZE_PT: Record<string, number> = { small: 54, medium: 78, large: 104, huge: 132 };
const MIN_SIZE_PT: Record<string, number> = { small: 38, medium: 46, large: 60, huge: 72 };
// ASS 의 Outline 은 외곽선 "바깥 두께(px)". SVG stroke-width(perimeter) 대비 절반 가량이 시각적으로 맞음.
const ASS_OUTLINE_PX: Record<string, number> = { none: 0, thin: 3, medium: 5, thick: 8 };
const LETTER_SPACING_EM: Record<string, number> = { tight: -0.02, normal: 0, wide: 0.06 };

// ============================================================
// 타입 — Stage 1 caption planning 출력과 1:1 (SVG 버전과 동일).
// ============================================================
export type CaptionLayer = {
  text: string;
  position?: string;            // top | center | bottom
  horizontal_align?: string;    // left | center | right
  size_level?: string;          // small | medium | large | huge
  color_hex?: string;
  emphasis?: string;            // regular | bold | black
  italic?: boolean;
  font_category?: string;
  font_personality?: string;
  role?: string;
  tone?: string;

  outline_color_hex?: string;
  outline_thickness?: string;   // none | thin | medium | thick

  has_shadow?: boolean;
  shadow_color_hex?: string;
  shadow_offset_x?: number;
  shadow_offset_y?: number;
  shadow_blur?: number;

  has_background_box?: boolean;
  background_color_hex?: string;
  background_radius?: number;    // ASS 에선 무시 (사각 박스)
  background_padding?: number;

  gradient?: {
    type?: string;
    angle?: number;
    stops?: Array<{ offset: number; color: string }>;
  };

  has_glow?: boolean;
  glow_color_hex?: string;
  glow_radius?: number;

  letter_spacing?: string;       // tight | normal | wide

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
  size_level?: string;
};

export type CutInput = {
  start: number;     // output 타임라인 기준 시작 (초)
  end: number;       // 끝 (초)
  layers: CaptionLayer[];
};

type Prepared = {
  layer: CaptionLayer;
  lines: string[];
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  position: 'top' | 'center' | 'bottom';
  hAlign: 'left' | 'center' | 'right';
  spacingPx: number;
  blockH: number;
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

  const styleLines: string[] = [];
  const eventLines: string[] = [];
  let styleSeq = 0;

  for (let ci = 0; ci < cuts.length; ci++) {
    const cut = cuts[ci];
    if (!cut || !Array.isArray(cut.layers) || cut.layers.length === 0) continue;
    if (!Number.isFinite(cut.start) || !Number.isFinite(cut.end) || cut.end <= cut.start) continue;

    const sanitized = cut.layers
      .map(l => sanitizeLayer(l, g))
      .filter((l): l is CaptionLayer => l !== null);
    if (sanitized.length === 0) continue;

    const prepared = sanitized.map(l => prepareLayer(l, g));
    placeLayers(prepared);

    const dur = cut.end - cut.start;
    for (const p of prepared) {
      const styleName = `s${styleSeq++}`;
      styleLines.push(buildStyleLine(styleName, p));
      eventLines.push(buildDialogueLine(styleName, p, cut.start, cut.end, dur));
    }
  }

  return assDocument(styleLines, eventLines);
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
// Layer sanitize — 색은 강제하지 않고 "구조"(외곽선/그림자 존재)만 보장.
// (SVG 버전과 동일 정책)
// ============================================================
export function sanitizeLayer(raw: any, global: GlobalCaptionStyle): CaptionLayer | null {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text || '').trim();
  if (!text) return null;

  const out: CaptionLayer = {
    text,
    position: String(raw.position || 'bottom').toLowerCase(),
    horizontal_align: String(raw.horizontal_align || 'center').toLowerCase(),
    size_level: String(raw.size_level || global.size_level || 'medium').toLowerCase(),
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

    has_shadow: raw.has_shadow === true || (raw.has_shadow === undefined && global.has_shadow === true),
    shadow_color_hex: normHex(raw.shadow_color_hex || '#000000'),
    shadow_offset_x: Number.isFinite(raw.shadow_offset_x) ? Number(raw.shadow_offset_x) : 0,
    shadow_offset_y: Number.isFinite(raw.shadow_offset_y) ? Number(raw.shadow_offset_y) : 4,
    shadow_blur: Number.isFinite(raw.shadow_blur) ? Number(raw.shadow_blur) : 6,

    has_background_box: raw.has_background_box === true
      || (raw.has_background_box === undefined && global.has_background_box === true),
    background_color_hex: normHex(raw.background_color_hex || global.background_color_hex || '#000000'),
    background_radius: Number.isFinite(raw.background_radius) ? Number(raw.background_radius) : 14,
    background_padding: Number.isFinite(raw.background_padding) ? Number(raw.background_padding) : 28,

    gradient: normalizeGradient(raw.gradient),

    has_glow: raw.has_glow === true,
    glow_color_hex: normHex(raw.glow_color_hex || raw.color_hex || global.primary_color_hex || '#FFFFFF'),
    glow_radius: Number.isFinite(raw.glow_radius) ? Number(raw.glow_radius) : 8,

    letter_spacing: String(raw.letter_spacing || 'normal').toLowerCase(),
    entry_animation: String(raw.entry_animation || 'none').toLowerCase(),
  };

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
  const sizeLevel = autoSizeLevel(truncated);
  const requested = SIZE_PT[sizeLevel] ?? 78;
  const fit = fitCaptionForFrame(truncated, requested, sizeLevel);

  const fontFamily = pickBundledFont({
    category: layer.font_category,
    personality: layer.font_personality,
    emphasis: layer.emphasis,
    layerIndex: 0,
  });
  const bold = layer.emphasis === 'bold' || layer.emphasis === 'black';
  const italic = layer.italic === true;
  const spacingPx = Math.round((LETTER_SPACING_EM[layer.letter_spacing || 'normal'] ?? 0) * fit.fontSize);

  const lineHeight = Math.ceil(fit.fontSize * 1.32);
  let blockH = lineHeight * fit.lines.length;
  if (layer.has_background_box) {
    blockH += 2 * Math.max(0, Math.floor(layer.background_padding ?? 28));
  }

  return {
    layer,
    lines: fit.lines,
    fontSize: fit.fontSize,
    fontFamily,
    bold,
    italic,
    position: normalizePosition(layer.position),
    hAlign: normalizeHAlign(layer.horizontal_align),
    spacingPx,
    blockH,
    anchor: 2,
    x: SCRIPT_W / 2,
    y: SCRIPT_H - V_MARGIN,
  };
}

// ============================================================
// 멀티 layer 수직 배치 (\an + \pos 좌표 산출)
// ============================================================
function placeLayers(items: Prepared[]): void {
  for (const p of items) {
    p.anchor = anchorCode(p.position, p.hAlign);
    p.x = anchorX(p.hAlign);
  }

  const top = items.filter(p => p.position === 'top');
  const center = items.filter(p => p.position === 'center');
  const bottom = items.filter(p => p.position === 'bottom');

  // top: 위에서 아래로 (anchor 가 top edge)
  let topCursor = V_MARGIN;
  for (const p of top) {
    p.y = topCursor;
    topCursor += p.blockH + STACK_GAP;
  }

  // bottom: 아래에서 위로 (anchor 가 bottom edge). 배열 첫 항목이 가장 아래.
  let bottomCursor = SCRIPT_H - V_MARGIN;
  for (const p of bottom) {
    p.y = bottomCursor;
    bottomCursor -= p.blockH + STACK_GAP;
  }

  // center: 화면 중앙 기준으로 블록 중심 정렬 (anchor 가 vertical center)
  if (center.length > 0) {
    const totalH = center.reduce((s, p) => s + p.blockH, 0) + STACK_GAP * Math.max(0, center.length - 1);
    let edge = SCRIPT_H / 2 - totalH / 2;
    for (const p of center) {
      p.y = Math.round(edge + p.blockH / 2);
      edge += p.blockH + STACK_GAP;
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
    outlineColour = hexToAss(layer.background_color_hex || '#000000');
    outline = clampNum(Math.round(layer.background_padding ?? 28), 4, 40);
  } else if (layer.has_glow) {
    borderStyle = 1;
    outlineColour = hexToAss(layer.glow_color_hex || layer.color_hex || '#FFFFFF');
    outline = clampNum(Math.round((layer.glow_radius ?? 8) * 0.6), 3, 12);
  } else {
    borderStyle = 1;
    outline = ASS_OUTLINE_PX[layer.outline_thickness || 'none'] ?? 0;
  }

  if (layer.has_shadow) {
    const dx = Math.abs(layer.shadow_offset_x ?? 0);
    const dy = Math.abs(layer.shadow_offset_y ?? 4);
    shadow = clampNum(Math.round(Math.max(dx, dy, 2)), 0, 30);
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
    '100', '100',
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
  }

  // 글로우 근사 — 외곽선을 부드럽게 blur
  if (layer.has_glow && !layer.has_background_box) {
    const blur = clampNum(Math.round(layer.glow_radius ?? 8), 2, 20);
    tags.push(`\\blur${blur}`);
  }

  const override = `{${tags.join('')}}`;
  const text = p.lines.map(sanitizeAssLine).join('\\N');

  return `Dialogue: 0,${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${override}${text}`;
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
    return grad.stops[0].color;
  }
  return layer.color_hex || '#FFFFFF';
}

// #RRGGBB → ASS &HAABBGGRR (AA=00 불투명, BGR 순서)
function hexToAss(hex?: string): string {
  const h = normHex(hex).replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
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

function truncate(s: string): string {
  const t = s.trim();
  const chars = graphemes(t);
  if (chars.length <= MAX_CAPTION_CHARS) return t;
  return `${chars.slice(0, MAX_CAPTION_CHARS - 1).join('').trimEnd()}...`;
}

function fitCaptionForFrame(text: string, requestedSize: number, sizeLevel: string): { lines: string[]; fontSize: number } {
  const maxLines = sizeLevel === 'small' || sizeLevel === 'medium' ? 3 : 2;
  const minSize = MIN_SIZE_PT[sizeLevel] ?? 46;
  for (let size = requestedSize; size >= minSize; size -= 4) {
    const wrapped = wrapCaptionText(text, size, maxLines);
    if (wrapped.ok) return { lines: wrapped.lines, fontSize: size };
  }
  const wrapped = wrapCaptionText(text, minSize, maxLines);
  return { lines: wrapped.lines, fontSize: minSize };
}

function wrapCaptionText(text: string, fontSize: number, maxLines: number): { ok: boolean; lines: string[] } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return { ok: true, lines: [''] };
  const tokens = normalized.split(' ');
  const lines: string[] = [];
  let current = '';
  let ok = true;
  const push = () => { if (current) lines.push(current); current = ''; };

  for (const token of tokens) {
    const pieces = splitLongToken(token, fontSize);
    for (const piece of pieces) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (measureTextWidth(candidate, fontSize) <= CAPTION_MAX_W) {
        current = candidate;
        continue;
      }
      push();
      current = piece;
      if (lines.length >= maxLines) {
        ok = false;
        current = trimToFit(`${piece}...`, fontSize);
        break;
      }
    }
    if (!ok) break;
  }
  push();
  if (lines.length > maxLines) {
    ok = false;
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = trimToFit(`${kept[maxLines - 1]}...`, fontSize);
    return { ok, lines: kept };
  }
  return { ok, lines };
}

function splitLongToken(token: string, fontSize: number): string[] {
  if (measureTextWidth(token, fontSize) <= CAPTION_MAX_W) return [token];
  const pieces: string[] = [];
  let current = '';
  for (const ch of graphemes(token)) {
    const candidate = current + ch;
    if (current && measureTextWidth(candidate, fontSize) > CAPTION_MAX_W) {
      pieces.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function trimToFit(text: string, fontSize: number): string {
  let out = text;
  while (graphemes(out).length > 1 && measureTextWidth(out, fontSize) > CAPTION_MAX_W) {
    const chars = graphemes(out.replace(/\.\.\.$/, ''));
    out = `${chars.slice(0, -1).join('').trimEnd()}...`;
  }
  return out;
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
