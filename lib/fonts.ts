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

// 폰트 이름 정규화 — 공백/특수문자 제거 + 소문자.
function normFamilyName(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

// 번들 family 의 정규화 이름 → 실제 family (font_family_hint 직접 매칭용).
const NORMALIZED_BUNDLED: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const fam of Object.values(FONT_FAMILIES)) m[normFamilyName(fam)] = fam;
  return m;
})();

// 흔한 비번들 폰트(상용/시스템) → 가장 가까운 번들 family 별칭.
// (레퍼런스에서 추정된 font_family_hint 가 번들에 없을 때 근사 매핑)
const FAMILY_ALIASES: Record<string, string> = {
  notosans: F.NanumGothic, notosanskr: F.NanumGothic, notosanscjk: F.NanumGothic,
  applesdgothicneo: F.Pretendard, spoqahansans: F.Pretendard, malgungothic: F.Pretendard,
  nanumsquare: F.NanumGothic, nanumsquareround: F.GowunDodum, nanumbarungothic: F.NanumGothic,
  spongofont: F.Jua, bmhanna: F.DoHyeon, bmhannapro: F.DoHyeon, bmjua: F.Jua, bmdohyeon: F.DoHyeon,
  tvnenjoystories: F.DoHyeon, gmarketsans: F.DoHyeon, jalnan: F.DoHyeon,
  배달의민족주아: F.Jua, 배달의민족도현: F.DoHyeon, 검은고딕: F.BlackHanSans,
  나눔손글씨: F.NanumPenScript, 카페24: F.YeonSung,
  // 한글 상용 '둥근 굵은 고딕' 류 → 가장 가까운 rounded heavy 번들(Do Hyeon)로 통일.
  // (얇은 기본 폰트나 각진 폰트로 새지 않게. 같은 제목 자막 쌍이 같은 폰트로 렌더되도록.)
  g마켓산스: F.DoHyeon, 지마켓산스: F.DoHyeon, 잘난체: F.DoHyeon, 여기어때잘난체: F.DoHyeon,
  배달의민족한나: F.DoHyeon, 한나체: F.DoHyeon, 한나: F.DoHyeon, 주아체: F.Jua, 도현체: F.DoHyeon,
};

// font_family_hint → 번들 family (직접 또는 별칭). 못 찾으면 null.
function familyFromHint(hint?: string): string | null {
  const n = normFamilyName(hint || '');
  if (!n) return null;
  if (NORMALIZED_BUNDLED[n]) return NORMALIZED_BUNDLED[n];
  if (FAMILY_ALIASES[n]) return FAMILY_ALIASES[n];
  // 부분 포함 매칭 (예: "blackhansansbold" → blackhansans)
  for (const key of Object.keys(NORMALIZED_BUNDLED)) {
    if (n.includes(key) || key.includes(n)) return NORMALIZED_BUNDLED[key];
  }
  return null;
}

// 굵기(weight) 보정용 — ASS Bold 는 on/off 뿐이라 '실제 굵기 차등'은 폰트 선택으로 반영한다.
// 매우 굵은 자막(black류)은 두꺼운 번들 폰트를, 가는 자막은 가벼운 산세리프를 우선한다.
// 단 hint 가 풀리면(원본 폰트 매칭) 그게 최우선이라 여기까지 오지 않는다(스타일 카테고리 보존).
const HEAVY_FONTS = new Set<string>([F.BlackHanSans, F.DoHyeon, F.Jua]);
const LIGHT_FONTS = new Set<string>([F.Pretendard, F.GothicA1, F.Sunflower, F.GowunDodum, F.NanumGothic]);

export function pickBundledFont(args: {
  category?: string;
  personality?: string;
  emphasis?: string;        // (미사용) — 폰트 간 우선순위를 두지 않으므로 emphasis 로 폰트를 바꾸지 않는다.
  familyHint?: string;      // 레퍼런스 폰트 이름 추정 — 번들/별칭에 매칭되면 무조건 이걸 사용(원본 폰트 그대로).
  weightHint?: string;      // (보조) thin~black 인상. weight 미지정 시 폴백으로 환산해 사용.
  weight?: number;          // 정밀 굵기 100~900(OpenType wght). 풀 안에서 굵기 맞는 폰트를 고르는 데 사용.
}): string {
  const cat = (args.category || 'sans').toLowerCase();
  const per = (args.personality || '').toLowerCase();

  // ─────────────────────────────────────────────────────
  // 0) 원본과 같은 폰트로 맞추기 (최우선). font_family_hint 가 번들/별칭과 매칭되면 그대로 사용.
  // ─────────────────────────────────────────────────────
  const hinted = familyFromHint(args.familyHint);
  if (hinted) return hinted;

  // 1) hint 가 없거나 못 풀 때 — (category, personality) 의 대표 폰트 풀로 결정적 폴백.
  let pool: string[] | undefined;
  if (per) pool = BY_COMBO[`${cat}/${per}`];                     // (category, personality) 정확 매칭
  if (!pool || pool.length === 0) pool = per ? BY_PERSONALITY[per] : undefined; // personality 단독
  if (!pool || pool.length === 0) pool = BY_CATEGORY[cat];       // category 단독
  if (!pool || pool.length === 0) pool = [F.Pretendard];         // 최후 폴백

  // 2) 굵기 보정 — 풀 '안에서만' 무게에 맞는 폰트를 고른다(스타일 카테고리는 깨지 않음).
  //    weight 우선, 없으면 weightHint(black/thin 등) 환산.
  const weight = Number.isFinite(args.weight as number)
    ? Number(args.weight)
    : ({ thin: 100, light: 300, regular: 400, medium: 500, bold: 700, black: 900 } as Record<string, number>)[(args.weightHint || '').toLowerCase()];
  if (Number.isFinite(weight)) {
    if ((weight as number) >= 800) {
      const heavy = pool.find(f => HEAVY_FONTS.has(f));
      if (heavy) return heavy;
    } else if ((weight as number) <= 200) {
      const light = pool.find(f => LIGHT_FONTS.has(f));
      if (light) return light;
    }
  }
  return pool[0];
}
