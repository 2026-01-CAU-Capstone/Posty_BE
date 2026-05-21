// ============================================================
// Stage 3: 자막 입히기 (layer 기반)
// 입력: 2_grade/graded.mp4 + edit-plan.json
//   (Stage 1 의 caption planning 이 planned_caption_layers 를 이미 채워둠)
// 출력: 3_caption/captioned.mp4 + captions.ass
//
// 각 컷마다 N개의 layer (보통 0~2개) 를 별도 Dialogue 로 렌더링.
// per-layer 으로 다음을 override 가능:
//   - 폰트 (\fn{Font Name})  → font_category 매핑
//   - 사이즈 (\fs<pt>)        → size_level 매핑
//   - 색 (\c&HBBGGRR&)
//   - 굵기 (\b1 / \b0)
//   - 정렬 (\an1~\an9)        → position + horizontal_align 조합
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { ARTIFACTS, appendRawResponse, ensureDir, readJson, stageDir } from '../paths';
import { runFfmpeg } from '../ffmpeg';
import { bundledFontsDir, pickBundledFont } from '../fonts';

const OUT_W = 1080;
const OUT_H = 1920;
const MAX_CAPTION_CHARS = 60;
const H_MARGIN = 96;
const CAPTION_MAX_W = OUT_W - H_MARGIN * 2;
const V_MARGIN = 130;
const STACK_GAP = 34;

const SIZE_PT: Record<string, number> = { small: 56, medium: 84, large: 116, huge: 156 };
const MIN_SIZE_PT: Record<string, number> = { small: 40, medium: 48, large: 64, huge: 78 };

type Layer = {
  text: string;
  position: string;
  horizontal_align: string;
  size_level: string;
  color_hex: string;
  emphasis: string;
  italic: boolean;
  font_category: string;
  font_personality: string;
  role?: string;
  tone?: string;
};
type FittedLayer = {
  layer: Layer;
  an: number;
  text: string;
  fontSize: number;
  lineCount: number;
  blockHeight: number;
};
type PlacedLayer = FittedLayer & {
  x: number;
  y: number;
};

export async function runStage3(projectId: string): Promise<{
  ok: true;
  layer_count: number;
  cut_with_captions: number;
  total_cuts: number;
}> {
  const graded = ARTIFACTS.gradedMp4(projectId);
  if (!(await fileOk(graded))) throw new Error('Stage 2 (graded.mp4) 결과가 없습니다');

  const plan: any = await readJson(ARTIFACTS.editPlan(projectId));
  const spec: any = await readJson(ARTIFACTS.editSpec(projectId));
  if (!plan?.items) throw new Error('edit-plan.json 이 없습니다');

  const items: any[] = plan.items;

  // 각 컷의 layers 결정: planned 우선, 비어있으면 ref 사용
  const layersPerCut: Layer[][] = items.map((it: any) => {
    const planned = Array.isArray(it.planned_caption_layers) ? it.planned_caption_layers : [];
    if (planned.length > 0) return planned.map(sanitizeLayer).filter(Boolean) as Layer[];
    const ref = Array.isArray(it.ref_caption_layers) ? it.ref_caption_layers : [];
    return ref.map(sanitizeLayer).filter(Boolean) as Layer[];
  });

  const totalLayers = layersPerCut.reduce((s, ls) => s + ls.length, 0);
  const cutWithCaps = layersPerCut.filter(ls => ls.length > 0).length;

  await ensureDir(stageDir(projectId, 3));
  const assPath = ARTIFACTS.captionsAss(projectId);
  const captionedPath = ARTIFACTS.captionedMp4(projectId);

  const assBody = buildAss(items, layersPerCut, spec?.caption_global_style || {});
  await fs.writeFile(assPath, assBody, 'utf-8');

  await appendRawResponse(projectId, {
    stage: 3, kind: 'caption_render',
    total_cuts: items.length, cut_with_captions: cutWithCaps, layer_count: totalLayers,
  });

  if (totalLayers === 0) {
    await runFfmpeg([
      '-y', '-i', graded,
      '-c', 'copy',
      '-movflags', '+faststart',
      captionedPath,
    ]);
    return { ok: true, layer_count: 0, cut_with_captions: 0, total_cuts: items.length };
  }

  const assFile = path.basename(assPath);
  // assets/fonts/ 를 fontconfig 가 검색하도록 fontsdir 옵션 추가.
  // 작업디렉토리(=ass 파일 디렉토리) 기준 상대경로 + forward slash 로 변환해서
  // Windows 절대경로의 콜론 escape 문제 회피.
  const fontsDirRel = path.relative(path.dirname(assPath), bundledFontsDir()).replace(/\\/g, '/');
  const subFilter = `subtitles=${assFile}:fontsdir=${fontsDirRel}`;
  await runFfmpeg([
    '-y',
    '-i', graded,
    '-vf', subFilter,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'medium', '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    captionedPath,
  ], path.dirname(assPath));

  return { ok: true, layer_count: totalLayers, cut_with_captions: cutWithCaps, total_cuts: items.length };
}

function sanitizeLayer(l: any): Layer | null {
  if (!l || typeof l !== 'object') return null;
  const text = String(l.text || '').trim();
  if (!text) return null;
  const truncated = truncate(text);
  // LLM 이 size_level 을 정해도 신뢰하지 않고 텍스트 길이로 코드가 다시 결정한다.
  // 너무 긴 글을 'huge' 로 답해 화면을 넘기는 사례 방지.
  const size_level = autoSizeLevel(truncated);
  return {
    text: truncated,
    position: String(l.position || 'bottom').toLowerCase(),
    horizontal_align: String(l.horizontal_align || 'center').toLowerCase(),
    size_level,
    color_hex: String(l.color_hex || ''),
    emphasis: String(l.emphasis || 'bold').toLowerCase(),
    italic: l.italic === true,
    font_category: String(l.font_category || 'sans').toLowerCase(),
    font_personality: String(l.font_personality || '').toLowerCase(),
    role: l.role ? String(l.role) : undefined,
    tone: l.tone ? String(l.tone) : undefined,
  };
}

// ============================================================
// 자막 사이즈를 텍스트 길이 기반으로 자동 결정.
// 기준: 한 줄에 들어가야 하는 글자 수.
//   huge   : ≤ 6자       (한 번에 강한 hook)
//   large  : ≤ 12자
//   medium : ≤ 22자      (보통 자막)
//   small  : > 22자      (긴 설명문)
// 글자 수는 grapheme 단위. 한글/한자/이모지 = 1 grapheme.
// ============================================================
function autoSizeLevel(text: string): string {
  const chars = graphemes(text).filter(g => !/\s/.test(g)).length;
  if (chars <= 6) return 'huge';
  if (chars <= 12) return 'large';
  if (chars <= 22) return 'medium';
  return 'small';
}
function truncate(s: string): string {
  const t = s.trim();
  const chars = graphemes(t);
  if (chars.length <= MAX_CAPTION_CHARS) return t;
  return `${chars.slice(0, MAX_CAPTION_CHARS - 1).join('').trimEnd()}...`;
}
async function fileOk(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// ============================================================
// ASS 빌더 — 단일 기본 Style, layer 마다 override tag 로 차별화
// ============================================================
function buildAss(items: any[], layersPerCut: Layer[][], globalStyle: any): string {
  const g = globalStyle || {};

  const baseFontName = pickBundledFont({
    category: g.font_category,
    personality: g.font_personality,
    emphasis: g.font_weight,
  });
  const baseBold = (g.font_weight === 'bold' || g.font_weight === 'black') ? 1 : 0;
  const baseItalic = g.font_italic === true ? 1 : 0;
  const baseSize = SIZE_PT[String(g.size_level || 'medium')] ?? 84;
  const primary = hexToAss(g.primary_color_hex, '#FFFFFF');
  const outlineColor = hexToAss(g.outline_color_hex, '#000000');
  // 자막은 항상 outline-only (BorderStyle=1). OpaqueBox(3) 는 글자/박스 색이
  // 비슷할 때 글자가 사라져 "빈 검은 박스" 처럼 보이는 사례가 잦아 완전히 끔.
  // ScaledBorderAndShadow=yes 이므로 PlayRes 기준 절대값으로 outline/shadow 가 적용된다.
  const bg = '&H00000000';   // BorderStyle=1 에서는 사실상 사용되지 않지만 슬롯 채움
  const thicknessMap: Record<string, number> = { none: 0, thin: 2, medium: 4, thick: 7 };
  const outlineW = thicknessMap[String(g.outline_thickness || 'medium')] ?? 4;
  const shadow = g.has_shadow ? 3 : 0;
  const borderStyle = 1;

  // 단일 Default 스타일. \an override 로 정렬을 dialogue 마다 정함.
  const defaultStyle =
    `Style: Default,${baseFontName},${baseSize},${primary},&H000000FF,${outlineColor},${bg},${baseBold},${baseItalic},0,0,100,100,0,0,${borderStyle},${outlineW},${shadow},2,80,80,140,1`;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${OUT_W}`,
    `PlayResY: ${OUT_H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    defaultStyle,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const allCaps = !!g.all_caps;
  const events: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const layers = layersPerCut[i] || [];
    if (layers.length === 0) continue;
    const start = fmtAssTime(it.output_start);
    const end = fmtAssTime(it.output_end);
    const fittedLayers = layers.map(l => {
      const rawText = allCaps ? l.text.toUpperCase() : l.text;
      const sizePt = SIZE_PT[l.size_level] ?? baseSize;
      const fitted = fitCaptionForFrame(rawText, sizePt, l.size_level);
      const an = alignmentNumber(l.position, l.horizontal_align);
      const lineCount = Math.max(1, fitted.text.split('\n').length);
      // line height 계수: ASS \N 줄바꿈은 폰트마다 advance 가 1.2~1.4 fs 사이.
      // 또한 outline/shadow 가 위아래로 약간씩 더 차지하므로 1.32 로 보수적으로 잡는다.
      return {
        layer: l,
        an,
        text: fitted.text,
        fontSize: fitted.fontSize,
        lineCount,
        blockHeight: Math.ceil(lineCount * fitted.fontSize * 1.32),
      };
    });

    const placedLayers = placeCaptionLayers(fittedLayers);

    for (let li = 0; li < placedLayers.length; li++) {
      const fittedLayer = placedLayers[li];
      const l = fittedLayer.layer;
      const overrideParts: string[] = [];

      // 정렬 (an1~an9)
      const an = fittedLayer.an;
      overrideParts.push(`\\an${an}`);
      overrideParts.push(`\\pos(${fittedLayer.x},${fittedLayer.y})`);

      // 폰트 — (category, personality, emphasis, layerIndex) 로 번들 폰트 풀에서 선택
      const fn = pickBundledFont({
        category: l.font_category,
        personality: l.font_personality,
        emphasis: l.emphasis,
        layerIndex: li,
      });
      if (fn !== baseFontName) overrideParts.push(`\\fn${fn}`);

      // 사이즈. 긴 문구는 화면 폭 안에 들어오도록 자동 축소한다.
      if (fittedLayer.fontSize !== baseSize) overrideParts.push(`\\fs${fittedLayer.fontSize}`);
      overrideParts.push('\\q0');

      // 색
      if (l.color_hex && /^#[0-9A-Fa-f]{6}$/.test(l.color_hex)) {
        overrideParts.push(`\\c${hexToAss(l.color_hex, '#FFFFFF')}`);
      }

      // 굵기
      if (l.emphasis === 'bold' || l.emphasis === 'black') overrideParts.push('\\b1');
      else if (l.emphasis === 'regular') overrideParts.push('\\b0');

      // 기울임 (굵기와 직교)
      if (l.italic) overrideParts.push('\\i1');
      else if (baseItalic) overrideParts.push('\\i0');

      const overrideTag = overrideParts.length > 0 ? `{${overrideParts.join('')}}` : '';
      events.push(
        `Dialogue: ${li},${start},${end},Default,,0,0,0,,${overrideTag}${escapeAss(fittedLayer.text)}`
      );
    }
  }
  return [...header, ...events, ''].join('\n');
}

function placeCaptionLayers(layers: FittedLayer[]): PlacedLayer[] {
  const placed: PlacedLayer[] = layers.map(l => ({ ...l, x: captionX(l.an), y: Math.round(OUT_H / 2) }));
  const top = placed.filter(l => l.an >= 7 && l.an <= 9);
  const center = placed.filter(l => l.an >= 4 && l.an <= 6);
  const bottom = placed.filter(l => l.an >= 1 && l.an <= 3);

  let topCursor = V_MARGIN;
  for (const l of top) {
    l.y = topCursor;
    topCursor += l.blockHeight + STACK_GAP;
  }

  let bottomCursor = OUT_H - V_MARGIN;
  for (let i = bottom.length - 1; i >= 0; i--) {
    const l = bottom[i];
    l.y = bottomCursor;
    bottomCursor -= l.blockHeight + STACK_GAP;
  }

  if (center.length > 0) {
    const total = center.reduce((sum, l) => sum + l.blockHeight, 0) + STACK_GAP * Math.max(0, center.length - 1);
    let y = OUT_H / 2 - total / 2;
    for (const l of center) {
      l.y = Math.round(y + l.blockHeight / 2);
      y += l.blockHeight + STACK_GAP;
    }
    avoidVerticalCollisions(placed, center);
  }

  // multi-line 또는 huge layer 가 한 방향으로 화면 밖을 침범하면 안쪽으로 밀어 넣는다.
  // 양방향이 동시에 침범할 만큼 layer 가 크면 (= 화면 높이 - margin 보다 큼) 가운데로 강제하고
  // top/bottom 각각 안전 margin 만 보장. 이렇게 안 하면 위·아래로 번갈아 밀려 어색해진다.
  const safeTop = V_MARGIN / 2;
  const safeBottom = OUT_H - V_MARGIN / 2;
  const safeRange = safeBottom - safeTop;
  for (const l of placed) {
    let box = layerBox(l);
    if (l.blockHeight >= safeRange) {
      // layer 자체가 안전 영역보다 큼 → 중앙 정렬.
      const cy = OUT_H / 2;
      if (l.an >= 7 && l.an <= 9) l.y = Math.round(cy - l.blockHeight / 2);
      else if (l.an >= 1 && l.an <= 3) l.y = Math.round(cy + l.blockHeight / 2);
      else l.y = Math.round(cy);
      continue;
    }
    if (box.top < safeTop) l.y += Math.ceil(safeTop - box.top);
    box = layerBox(l);
    if (box.bottom > safeBottom) l.y -= Math.ceil(box.bottom - safeBottom);
  }
  return placed;
}

function avoidVerticalCollisions(all: PlacedLayer[], moving: PlacedLayer[]): void {
  for (let guard = 0; guard < 24; guard++) {
    let changed = false;
    for (const layer of moving) {
      let box = layerBox(layer);
      for (const other of all) {
        if (other === layer) continue;
        const otherBox = layerBox(other);
        if (box.bottom <= otherBox.top || box.top >= otherBox.bottom) continue;
        const pushDown = otherBox.bottom - box.top + STACK_GAP;
        const pushUp = box.bottom - otherBox.top + STACK_GAP;
        if (box.top < OUT_H / 2 && layer.y + pushDown < OUT_H - V_MARGIN) {
          layer.y += pushDown;
        } else {
          layer.y -= pushUp;
        }
        box = layerBox(layer);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function layerBox(l: PlacedLayer): { top: number; bottom: number } {
  if (l.an >= 7 && l.an <= 9) return { top: l.y, bottom: l.y + l.blockHeight };
  if (l.an >= 1 && l.an <= 3) return { top: l.y - l.blockHeight, bottom: l.y };
  return { top: l.y - l.blockHeight / 2, bottom: l.y + l.blockHeight / 2 };
}

function captionX(an: number): number {
  const col = ((an - 1) % 3) + 1;
  if (col === 1) return H_MARGIN;
  if (col === 3) return OUT_W - H_MARGIN;
  return Math.round(OUT_W / 2);
}

function fitCaptionForFrame(text: string, requestedSize: number, sizeLevel: string): { text: string; fontSize: number } {
  const maxLines = sizeLevel === 'small' || sizeLevel === 'medium' ? 3 : 2;
  const minSize = MIN_SIZE_PT[sizeLevel] ?? 48;

  for (let size = requestedSize; size >= minSize; size -= 4) {
    const wrapped = wrapCaptionText(text, size, maxLines);
    if (wrapped.ok) return { text: wrapped.lines.join('\n'), fontSize: size };
  }

  const wrapped = wrapCaptionText(text, minSize, maxLines);
  return { text: wrapped.lines.join('\n'), fontSize: minSize };
}

function wrapCaptionText(text: string, fontSize: number, maxLines: number): { ok: boolean; lines: string[] } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return { ok: true, lines: [''] };

  const tokens = normalized.split(' ');
  const lines: string[] = [];
  let current = '';
  let ok = true;

  const pushCurrent = () => {
    if (current) lines.push(current);
    current = '';
  };

  for (const token of tokens) {
    const pieces = splitLongToken(token, fontSize);
    for (const piece of pieces) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (measureTextWidth(candidate, fontSize) <= CAPTION_MAX_W) {
        current = candidate;
        continue;
      }
      pushCurrent();
      current = piece;
      if (lines.length >= maxLines) {
        ok = false;
        current = trimToFit(`${piece}...`, fontSize);
        break;
      }
    }
    if (!ok) break;
  }
  pushCurrent();

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
  // 실측 폰트보다 약간 보수적으로(↑) 잡아서 wrap 이 일찍 일어나게 한다.
  // 종전 한글 1.0 → 1.08 로 올려 한글 자막이 화면 폭을 넘기는 사례를 줄임.
  let units = 0;
  for (const ch of graphemes(text)) {
    if (/\s/.test(ch)) units += 0.4;
    else if (isEmojiLike(ch)) units += 1.2;
    else if (isWideGlyph(ch)) units += 1.08;
    else if (/[가-힣一-龥ぁ-ゔァ-ヴー々〆〤]/.test(ch)) units += 1.08;
    else if (/[A-Z0-9]/.test(ch)) units += 0.66;
    else if (/[a-z]/.test(ch)) units += 0.58;
    else units += 0.42;
  }
  return units * fontSize;
}

// position(top/center/bottom) × horizontal_align(left/center/right) → ASS \an 숫자
//  1=BL  2=BC  3=BR
//  4=ML  5=MC  6=MR
//  7=TL  8=TC  9=TR
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

function alignmentNumber(pos: string, hAlign: string): number {
  const v = (pos || 'bottom').toLowerCase();
  const h = (hAlign || 'center').toLowerCase();
  let row = 1; // bottom
  if (v === 'top') row = 3;
  else if (v === 'center' || v === 'middle') row = 2;
  let col = 2; // center
  if (h === 'left') col = 1;
  else if (h === 'right') col = 3;
  return (row - 1) * 3 + col;
}

function hexToAss(hex: string | undefined, fallback: string): string {
  const h = String(hex || fallback).replace('#', '').padStart(6, '0').slice(-6);
  const r = h.slice(0, 2).toUpperCase();
  const g = h.slice(2, 4).toUpperCase();
  const b = h.slice(4, 6).toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(`${r}${g}${b}`)) {
    return hexToAss(fallback, '#FFFFFF');
  }
  return `&H00${b}${g}${r}`;
}
function hexToAssWithAlpha(hex: string | undefined, fallback: string, alpha: number): string {
  const h = String(hex || fallback).replace('#', '').padStart(6, '0').slice(-6);
  const r = h.slice(0, 2).toUpperCase();
  const g = h.slice(2, 4).toUpperCase();
  const b = h.slice(4, 6).toUpperCase();
  const a = alpha.toString(16).toUpperCase().padStart(2, '0');
  return `&H${a}${b}${g}${r}`;
}
function escapeAss(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\N')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}
function fmtAssTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s - h * 3600 - m * 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${ss}`;
}
