// ============================================================
// 번들 폰트 풀 (assets/fonts/) + (category × personality × emphasis) → family 매핑.
// FFmpeg subtitles 필터의 fontsdir 옵션으로 로드되므로 시스템에 별도 설치 불필요.
// 폰트가 풀에 없으면 OS 기본 한글 폰트로 폴백.
// ============================================================

import path from 'path';

export function bundledFontsDir(): string {
  // posty-prototype/assets/fonts
  return path.join(process.cwd(), 'assets', 'fonts');
}

// 각 폰트의 ASS Fontname (family name).
// (assets/fonts/ 에 받은 폰트 파일과 1:1 대응)
export const FONT_FAMILIES = {
  Pretendard: 'Pretendard',
  NanumGothic: 'Nanum Gothic',
  GothicA1: 'Gothic A1',
  GowunDodum: 'Gowun Dodum',
  Sunflower: 'Sunflower',
  NanumMyeongjo: 'Nanum Myeongjo',
  GowunBatang: 'Gowun Batang',
  SongMyung: 'Song Myung',
  BlackHanSans: 'Black Han Sans',
  DoHyeon: 'Do Hyeon',
  Jua: 'Jua',
  YeonSung: 'Yeon Sung',
  Stylish: 'Stylish',
  Gugi: 'Gugi',
  NanumPenScript: 'Nanum Pen Script',
  Gaegu: 'Gaegu',
  SingleDay: 'Single Day',
  HiMelody: 'Hi Melody',
  PoorStory: 'Poor Story',
  NanumBrushScript: 'Nanum Brush Script',
  KirangHaerang: 'Kirang Haerang',
  GamjaFlower: 'Gamja Flower',
  Dokdo: 'Dokdo',
  CuteFont: 'Cute Font',
  BlackAndWhitePicture: 'Black And White Picture',
  EastSeaDokdo: 'East Sea Dokdo',
} as const;

const F = FONT_FAMILIES;

// (category, personality) → 폰트 후보 풀.
// 정확히 매칭되면 우선, 없으면 personality / category 단독으로 폴백.
// 같은 컷 안에서 layerIndex 로 다른 폰트가 선택되도록 배열로 둔다.
const BY_COMBO: Record<string, string[]> = {
  // ---- sans ----
  'sans/modern':              [F.Pretendard, F.GothicA1, F.NanumGothic],
  'sans/minimal':             [F.Sunflower, F.Pretendard, F.GothicA1],
  'sans/elegant':             [F.Sunflower, F.GowunDodum, F.Pretendard],
  'sans/playful':             [F.GowunDodum, F.Jua, F.Gaegu],
  'sans/bold_impact':         [F.BlackHanSans, F.DoHyeon, F.GothicA1],
  'sans/retro':               [F.YeonSung, F.Stylish, F.Gugi],
  'sans/vintage':             [F.SongMyung, F.NanumMyeongjo, F.GowunBatang],
  'sans/handwritten_neat':    [F.Gaegu, F.SingleDay, F.GowunDodum],
  'sans/handwritten_brush':   [F.NanumPenScript, F.NanumBrushScript],
  'sans/display_decorative':  [F.CuteFont, F.KirangHaerang, F.BlackAndWhitePicture],

  // ---- serif ----
  'serif/modern':             [F.GowunBatang, F.NanumMyeongjo],
  'serif/vintage':            [F.SongMyung, F.NanumMyeongjo, F.GowunBatang],
  'serif/elegant':            [F.NanumMyeongjo, F.GowunBatang, F.SongMyung],
  'serif/minimal':            [F.GowunBatang, F.NanumMyeongjo],
  'serif/bold_impact':        [F.NanumMyeongjo, F.SongMyung],
  'serif/playful':            [F.GowunBatang, F.Gaegu],
  'serif/retro':              [F.SongMyung, F.Stylish],
  'serif/handwritten_neat':   [F.SingleDay, F.Gaegu],
  'serif/handwritten_brush':  [F.NanumPenScript, F.NanumBrushScript],
  'serif/display_decorative': [F.KirangHaerang, F.CuteFont],

  // ---- handwritten ----
  'handwritten/handwritten_neat':   [F.Gaegu, F.SingleDay, F.HiMelody, F.GowunDodum],
  'handwritten/handwritten_brush':  [F.NanumBrushScript, F.NanumPenScript],
  'handwritten/playful':            [F.GamjaFlower, F.Gaegu, F.HiMelody, F.PoorStory],
  'handwritten/elegant':            [F.NanumPenScript, F.SingleDay],
  'handwritten/display_decorative': [F.CuteFont, F.KirangHaerang, F.Dokdo, F.EastSeaDokdo],
  'handwritten/retro':              [F.Dokdo, F.EastSeaDokdo, F.Stylish],
  'handwritten/vintage':            [F.SongMyung, F.NanumPenScript],
  'handwritten/modern':             [F.GowunDodum, F.Gaegu],
  'handwritten/minimal':            [F.SingleDay, F.HiMelody],
  'handwritten/bold_impact':        [F.BlackAndWhitePicture, F.KirangHaerang],

  // ---- display ----
  'display/bold_impact':       [F.BlackHanSans, F.DoHyeon, F.Jua],
  'display/retro':             [F.YeonSung, F.Stylish, F.Gugi, F.BlackAndWhitePicture],
  'display/playful':           [F.Jua, F.Gaegu, F.GowunDodum, F.GamjaFlower],
  'display/vintage':           [F.SongMyung, F.YeonSung, F.Stylish],
  'display/display_decorative': [F.CuteFont, F.KirangHaerang, F.BlackAndWhitePicture, F.Dokdo],
  'display/modern':            [F.Pretendard, F.BlackHanSans],
  'display/minimal':           [F.Sunflower, F.Pretendard],
  'display/elegant':           [F.NanumMyeongjo, F.GowunBatang],
  'display/handwritten_neat':  [F.Gaegu, F.SingleDay],
  'display/handwritten_brush': [F.NanumBrushScript, F.NanumPenScript],

  // ---- rounded ----
  'rounded/playful':           [F.GowunDodum, F.Jua, F.Gaegu, F.HiMelody],
  'rounded/modern':            [F.GowunDodum, F.Pretendard],
  'rounded/minimal':           [F.GowunDodum, F.Sunflower],
  'rounded/elegant':           [F.GowunDodum, F.GowunBatang],
  'rounded/bold_impact':       [F.Jua, F.DoHyeon],
  'rounded/handwritten_neat':  [F.HiMelody, F.Gaegu],
  'rounded/handwritten_brush': [F.NanumBrushScript],
  'rounded/display_decorative': [F.CuteFont, F.GamjaFlower],
  'rounded/retro':             [F.YeonSung, F.Stylish],
  'rounded/vintage':           [F.SongMyung],

  // ---- condensed ----
  'condensed/modern':          [F.Pretendard, F.GothicA1, F.NanumGothic],
  'condensed/bold_impact':     [F.BlackHanSans, F.DoHyeon],
  'condensed/minimal':         [F.Sunflower, F.Pretendard],
  'condensed/retro':           [F.Stylish, F.YeonSung],
  'condensed/elegant':         [F.NanumMyeongjo, F.Sunflower],
  'condensed/vintage':         [F.SongMyung],
  'condensed/playful':         [F.Jua, F.DoHyeon],
  'condensed/handwritten_neat':[F.Gaegu, F.SingleDay],
  'condensed/handwritten_brush':[F.NanumBrushScript, F.NanumPenScript],
  'condensed/display_decorative':[F.KirangHaerang, F.CuteFont],
};

// (personality) 단독 폴백
const BY_PERSONALITY: Record<string, string[]> = {
  modern:              [F.Pretendard, F.GothicA1, F.NanumGothic],
  vintage:             [F.SongMyung, F.NanumMyeongjo, F.GowunBatang],
  playful:             [F.Jua, F.GowunDodum, F.Gaegu, F.GamjaFlower],
  elegant:             [F.NanumMyeongjo, F.GowunBatang, F.Sunflower],
  bold_impact:         [F.BlackHanSans, F.DoHyeon, F.Jua],
  minimal:             [F.Sunflower, F.Pretendard, F.GowunDodum],
  retro:               [F.YeonSung, F.Stylish, F.Gugi, F.BlackAndWhitePicture],
  handwritten_neat:    [F.Gaegu, F.SingleDay, F.HiMelody, F.GowunDodum],
  handwritten_brush:   [F.NanumBrushScript, F.NanumPenScript],
  display_decorative:  [F.CuteFont, F.KirangHaerang, F.Dokdo, F.EastSeaDokdo, F.BlackAndWhitePicture],
};

// (category) 단독 폴백 — personality 미명시일 때
const BY_CATEGORY: Record<string, string[]> = {
  sans:        [F.Pretendard, F.GothicA1, F.NanumGothic],
  serif:       [F.NanumMyeongjo, F.GowunBatang, F.SongMyung],
  handwritten: [F.Gaegu, F.NanumPenScript, F.NanumBrushScript, F.SingleDay],
  condensed:   [F.Pretendard, F.GothicA1, F.NanumGothic],
  rounded:     [F.GowunDodum, F.Jua, F.HiMelody],
  display:     [F.BlackHanSans, F.DoHyeon, F.Jua, F.YeonSung],
};

// emphasis=black 시 우선시할 헤비웨이트 폰트 (한글에서 weight 900 효과를 family로 흉내냄)
const HEAVY_FONTS = new Set<string>([F.BlackHanSans, F.DoHyeon, F.Jua]);

export function pickBundledFont(args: {
  category?: string;
  personality?: string;
  emphasis?: string;        // regular | bold | black
  layerIndex?: number;      // 같은 컷 안에서 layer 가 다른 폰트로 가도록 분기
}): string {
  const cat = (args.category || 'sans').toLowerCase();
  const per = (args.personality || '').toLowerCase();
  const emp = (args.emphasis || 'bold').toLowerCase();
  const idx = Math.max(0, args.layerIndex ?? 0);

  // 1) (category, personality) 정확 매칭
  let pool: string[] | undefined;
  if (per) pool = BY_COMBO[`${cat}/${per}`];
  // 2) personality 단독
  if (!pool || pool.length === 0) pool = per ? BY_PERSONALITY[per] : undefined;
  // 3) category 단독
  if (!pool || pool.length === 0) pool = BY_CATEGORY[cat];
  // 4) 최후 폴백
  if (!pool || pool.length === 0) pool = [F.Pretendard];

  // emphasis=black 이고 풀에 헤비폰트가 있으면 우선
  if (emp === 'black') {
    const heavy = pool.find(f => HEAVY_FONTS.has(f));
    if (heavy) return heavy;
  }

  return pool[idx % pool.length];
}
