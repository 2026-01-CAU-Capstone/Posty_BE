// ============================================================
// 자막 레이아웃/색/머지 단위 테스트 (실행: npx tsx scripts/test-captions.mts)
// 프레임워크 없이 순수 assert. 실패 시 exit 1.
// ============================================================
import fs from 'fs';
import path from 'path';
import {
  buildCaptionAss, layoutCut, layerBBox, resolveVerticalOverlaps, mergeCaptionRuns,
  CaptionLayer, GlobalCaptionStyle, CutInput,
} from '../lib/caption-ass';
import { mergeShotLayers, groupCaptionsForCrop, mergeCropStyleIntoLayer, bandFracForSize, cropMatchesExpected, bandBox, pickDetectionBox, bboxCenter } from '../lib/stages/stage0';
import { reinjectRefStyle, enforceBrandTitle, applyReferenceCaptionTiming } from '../lib/stages/stage1';
import { pickBundledFont } from '../lib/fonts';
import { resolveTargetRange } from '../lib/cut-config';

// Dialogue 본문(override 블록 제외)의 줄 수 = \N 개수 + 1.
const dlgLineCount = (ass: string, nth = 0): number => {
  const dlg = ass.split('\n').filter(l => l.startsWith('Dialogue:'))[nth];
  if (!dlg) return 0;
  const marker = ',,0,0,0,,';
  const i = dlg.indexOf(marker);
  const body = i >= 0 ? dlg.slice(i + marker.length) : dlg;
  return body.replace(/^\{[^}]*\}/, '').split('\\N').length;
};

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const overlap = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); // >0 이면 겹침(px)

// ── (a) vertical_ratio 0.78/0.85, large, 2줄 두 레이어가 겹치지 않음 ──
{
  const global: GlobalCaptionStyle = { size_level: 'large', has_background_box: true, background_alpha: 1, primary_color_hex: '#FFFFFF' };
  const layers: CaptionLayer[] = [
    { text: '요즘 날씨에 가기 좋은', vertical_ratio: 0.78, horizontal_ratio: 0.5, size_level: 'large', color_hex: '#FFFFFF', has_background_box: true },
    { text: '기린이찌방 한강점',   vertical_ratio: 0.85, horizontal_ratio: 0.5, size_level: 'large', color_hex: '#FDE200', has_background_box: true },
  ];
  const placed = layoutCut(layers, global);
  const bboxes = placed.map(layerBBox).sort((a, b) => a.top - b.top);
  const ov = bboxes.length === 2 ? overlap(bboxes[0], bboxes[1]) : 999;
  console.log(`   (a) bbox: ${bboxes.map(b => `[${b.top}~${b.bottom}]`).join('  ')}`);
  ok('(a) vr 0.78/0.85 large 2레이어 — 겹침 없음', placed.length === 2 && ov <= 0, `overlap=${ov}px`);
  ok('(a) 모두 safe area(48~1872) 안', bboxes.every(b => b.top >= 40 && b.bottom <= 1880));
}

// ── (b) background_alpha 0.5 가 ASS alpha(&H80..)로 반영 ──
{
  const ass = buildCaptionAss(
    [{ start: 0, end: 3, layers: [{ text: '반투명 박스', has_background_box: true, background_color_hex: '#FF0000', background_alpha: 0.5, color_hex: '#FFFFFF' }] }],
    undefined,
  );
  const styleLine = ass.split('\n').find(l => l.startsWith('Style:'))!;
  const outlineColour = styleLine.split(',')[5]; // OutlineColour = 박스색(BorderStyle=3)
  console.log(`   (b) OutlineColour=${outlineColour}`);
  ok('(b) background_alpha 0.5 → AA=80 (반투명)', /^&H80/i.test(outlineColour), outlineColour);
  // 대조: alpha=1 이면 불투명(&H00)
  const ass1 = buildCaptionAss(
    [{ start: 0, end: 3, layers: [{ text: '불투명 박스', has_background_box: true, background_color_hex: '#FF0000', background_alpha: 1, color_hex: '#FFFFFF' }] }],
    undefined,
  );
  const oc1 = ass1.split('\n').find(l => l.startsWith('Style:'))!.split(',')[5];
  ok('(b) background_alpha 1 → AA=00 (불투명)', /^&H00/i.test(oc1), oc1);
}

// ── (c) text-focused merge 가 main style 보존 + OCR text 채택 ──
{
  const main = [{ text: '기린이찌방한강점(흐림)', color_hex: '#FDE200', has_background_box: true, background_color_hex: '#F9D423', font_personality: 'bold_impact', size_level: 'large', vertical_ratio: 0.85 }];
  const ocr  = [{ text: '기린이찌방 한강점', color_hex: '', font_personality: '', vertical_ratio: 0.85 }];
  const merged = mergeShotLayers(main, ocr);
  const m0 = merged[0];
  console.log(`   (c) merged[0]=${JSON.stringify({ text: m0.text, color: m0.color_hex, box: m0.has_background_box, fp: m0.font_personality, sz: m0.size_level })}`);
  ok('(c) OCR text 채택', m0.text === '기린이찌방 한강점');
  ok('(c) main 색 보존', m0.color_hex === '#FDE200');
  ok('(c) main 박스 보존', m0.has_background_box === true && m0.background_color_hex === '#F9D423');
  ok('(c) main font_personality 보존', m0.font_personality === 'bold_impact');
  ok('(c) main size_level 보존', m0.size_level === 'large');
  ok('(c) 레이어 수 유지(1)', merged.length === 1);
  // OCR 비면 main 보존(hook 보호)
  ok('(c) OCR 빈 배열이면 main 보존', mergeShotLayers(main, []).length === 1);
}

// ── (d) 실제 샘플 a3itec captions.ass 재생성 → 첫 컷 두 Dialogue 겹치지 않음 + 파일 갱신 ──
{
  const P = path.resolve('data/projects/proj_20260607151310_a3itec');
  const plan = JSON.parse(fs.readFileSync(path.join(P, '1_cut/edit-plan.json'), 'utf8'));
  const spec = JSON.parse(fs.readFileSync(path.join(P, '0_spec/edit-spec.json'), 'utf8'));
  const global: GlobalCaptionStyle = spec?.caption_global_style || {};
  const cuts: CutInput[] = (plan.items || [])
    .map((it: any) => ({
      start: Number(it.output_start), end: Number(it.output_end),
      layers: (it.planned_caption_layers?.length ? it.planned_caption_layers : it.ref_caption_layers) || [],
      subjectCenterY: Number.isFinite(Number(it.subject_center_y)) ? Number(it.subject_center_y) : undefined,
    }))
    .filter((c: CutInput) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.layers.length);

  const ass = buildCaptionAss(cuts, global);
  fs.writeFileSync(path.join(P, '3_caption/captions.ass'), ass, 'utf8'); // 파일 재생성

  // 첫 컷 두 레이어 bbox 로 직접 검증(= ASS 첫 두 Dialogue 와 동일 레이아웃)
  const firstWithTwo = cuts.find(c => c.layers.length >= 2) || cuts[0];
  const placed = layoutCut(firstWithTwo.layers, global, firstWithTwo.subjectCenterY);
  const bb = placed.map(layerBBox).sort((a, b) => a.top - b.top);
  console.log(`   (d) 첫 멀티컷 레이어 ${placed.length}개 bbox: ${bb.map(b => `[${b.top}~${b.bottom}]`).join('  ')}`);
  let maxOv = -9999;
  for (let i = 1; i < bb.length; i++) maxOv = Math.max(maxOv, overlap(bb[i - 1], bb[i]));
  ok('(d) a3itec 첫 컷 Dialogue 들 겹침 없음', placed.length < 2 || maxOv <= 0, `maxOverlap=${maxOv}px`);

  // ASS 의 첫 두 Dialogue \pos 출력(가시 확인용)
  const dlgs = ass.split('\n').filter(l => l.startsWith('Dialogue:')).slice(0, 2);
  dlgs.forEach((d, i) => { const m = d.match(/\\pos\((\d+),(\d+)\)/); console.log(`   (d) Dialogue${i} \\pos=${m ? m[1] + ',' + m[2] : '?'}`); });
}

// ── (e) 단일 huge/large 레이어가 한 줄로 렌더 (여러 줄 쪼개짐 방지) ──
{
  const mk = (text: string, size: string): CutInput => ({ start: 0, end: 3, layers: [{ text, size_level: size, color_hex: '#FFFFFF' }] });
  const a1 = buildCaptionAss([mk('기린이찌방 한강점', 'huge')], undefined);
  ok('(e) huge "기린이찌방 한강점" 한 줄 유지', dlgLineCount(a1) === 1, `lines=${dlgLineCount(a1)}`);
  const a2 = buildCaptionAss([mk('요즘 날씨에 가기 좋은', 'large')], undefined);
  ok('(e) large "요즘 날씨에 가기 좋은" 한 줄 유지', dlgLineCount(a2) === 1, `lines=${dlgLineCount(a2)}`);
}

// ── (e2) 명시적 줄바꿈(\n) 존중 — LLM 이 의도한 줄 구조를 너비로 재wrap 하지 않는다 ──
// (이전 버그: "노을 보며 마시는\n시원한 기린 생맥주" 가 \n 무시 + 너비 wrap 으로 3줄로 깨졌음)
{
  const mk = (text: string, size: string): CutInput => ({ start: 0, end: 3, layers: [{ text, size_level: size, color_hex: '#FFFFFF' }] });
  const b1 = buildCaptionAss([mk('노을 보며 마시는\n시원한 기린 생맥주', 'large')], undefined);
  ok('(e2) "노을…\\n…생맥주" 2줄 유지(3줄로 안 깨짐)', dlgLineCount(b1) === 2, `lines=${dlgLineCount(b1)}`);
  const b1body = b1.split('\n').filter(l => l.startsWith('Dialogue:'))[0];
  ok('(e2) 줄 내용이 \\n 위치 그대로', /노을 보며 마시는\\N시원한 기린 생맥주/.test(b1body), b1body.slice(-60));
  const b2 = buildCaptionAss([mk('요즘 날씨에 가기 좋은\n기린이찌방 한강점', 'large')], undefined);
  ok('(e2) "요즘…\\n…한강점" 2줄 유지', dlgLineCount(b2) === 2, `lines=${dlgLineCount(b2)}`);
  // \n 없는 단일 줄은 기존 동작(한 줄) 유지
  const b3 = buildCaptionAss([mk('요즘 날씨에 가기 좋은', 'large')], undefined);
  ok('(e2) \\n 없으면 기존대로 한 줄', dlgLineCount(b3) === 1, `lines=${dlgLineCount(b3)}`);
}

// ── (e3) 정밀 size_ratio — 4단계 버킷 대신 연속 px 로 사이징 ──
{
  const G: GlobalCaptionStyle = { primary_color_hex: '#FFFFFF' };
  // 짧은 텍스트(width fit 영향 최소)로 size_ratio 가 fontSize 에 직접 반영되는지 본다.
  // px = round(ratio * 1920). 0.05→96, 0.073→140 부근. (width 안 넘으면 그대로)
  const fs = (ratio: number) => layoutCut([{ text: '맛집', size_ratio: ratio, color_hex: '#FFFFFF' }], G)[0]?.fontSize;
  ok('(e3) size_ratio 0.05 → ~96px', Math.abs((fs(0.05) ?? 0) - 96) <= 2, `fontSize=${fs(0.05)}`);
  ok('(e3) size_ratio 0.073 → ~140px', Math.abs((fs(0.073) ?? 0) - 140) <= 2, `fontSize=${fs(0.073)}`);
  // 4단계 사이값(버킷이면 표현 불가한 크기)도 그대로 나온다 — 정밀화 핵심
  ok('(e3) size_ratio 0.062 → ~119px(버킷 사이값)', Math.abs((fs(0.062) ?? 0) - 119) <= 2, `fontSize=${fs(0.062)}`);
  // size_ratio 가 size_level 을 이긴다 (level=small 이어도 ratio 가 우선)
  const fsOverride = layoutCut([{ text: '맛집', size_level: 'small', size_ratio: 0.073, color_hex: '#FFFFFF' }], G)[0]?.fontSize;
  ok('(e3) size_ratio 가 size_level 보다 우선', Math.abs((fsOverride ?? 0) - 140) <= 2, `fontSize=${fsOverride}`);
  // 비정상값(과대/과소)은 무시 → size_level 버킷 폴백
  const fsBad = layoutCut([{ text: '맛집', size_level: 'large', size_ratio: 5, color_hex: '#FFFFFF' }], G)[0]?.fontSize;
  ok('(e3) 비정상 size_ratio 무시 → large 버킷(140)', fsBad === 140, `fontSize=${fsBad}`);
  // size_ratio 없으면 기존 버킷 동작
  const fsNone = layoutCut([{ text: '맛집', size_level: 'medium', color_hex: '#FFFFFF' }], G)[0]?.fontSize;
  ok('(e3) size_ratio 없으면 medium 버킷(96)', fsNone === 96, `fontSize=${fsNone}`);
}

// ── (f) 레퍼런스형(흰 한 줄 + 노란 한 줄, 박스 없음) — 전역 box=true 여도 박스 안 생김 + 소프트 그림자 ──
{
  const global: GlobalCaptionStyle = { has_background_box: true, background_color_hex: '#000000', primary_color_hex: '#FFFFFF' };
  const layers: CaptionLayer[] = [
    { text: '요즘 날씨에 가기 좋은', vertical_ratio: 0.30, size_level: 'large', color_hex: '#FFFFFF', has_shadow: true, shadow_blur: 14 },
    { text: '기린이찌방 한강점',   vertical_ratio: 0.62, size_level: 'huge',  color_hex: '#FDE200', has_shadow: true, shadow_blur: 14 },
  ];
  const ass = buildCaptionAss([{ start: 0, end: 3, layers }], global);
  const styleLines = ass.split('\n').filter(l => l.startsWith('Style:'));
  const borderStyles = styleLines.map(l => l.split(',')[15]); // BorderStyle (3=박스)
  console.log(`   (f) BorderStyle=${borderStyles.join(',')}  lines=${dlgLineCount(ass, 0)},${dlgLineCount(ass, 1)}`);
  ok('(f) 전역 box=true 자동상속 차단 — 박스(BorderStyle=3) 없음', borderStyles.length === 2 && borderStyles.every(b => b !== '3'), `borderStyle=${borderStyles.join(',')}`);
  ok('(f) 두 레이어 각각 한 줄', dlgLineCount(ass, 0) === 1 && dlgLineCount(ass, 1) === 1, `lines=${dlgLineCount(ass, 0)},${dlgLineCount(ass, 1)}`);
  const placed = layoutCut(layers, global);
  const bb = placed.map(layerBBox).sort((a, b) => a.top - b.top);
  ok('(f) captions.ass 두 Dialogue 겹침 없음', bb.length === 2 && overlap(bb[0], bb[1]) <= 0, `bbox=${bb.map(b => `[${b.top}~${b.bottom}]`).join(' ')}`);
  const dlgs = ass.split('\n').filter(l => l.startsWith('Dialogue:'));
  ok('(f) 또렷한 드롭섀도(\\yshad) + \\blur 전면 제거', dlgs.length === 2 && dlgs.every(d => /\\yshad\d/.test(d) && !/\\blur/.test(d)), dlgs[0].match(/\{[^}]*\}/)?.[0] || 'none');
}

// ── (g) reinjectRefStyle: 색 일치 시 글로우/그림자흐림까지 재주입, 불일치 시 글자 본체를
//        흐리는 효과(glow/blur)는 재주입 안 함(가독성 보호). 오프셋·폰트힌트는 색 무관 항상. ──
{
  // (g-1) 색 일치 → glow/blur/offset/폰트 전부 재주입.
  const planned: CaptionLayer[] = [{ text: '플랜 카피', color_hex: '#FDE200' }];
  const ref: CaptionLayer[] = [{
    text: '레프', color_hex: '#FDE200',
    has_shadow: true, shadow_blur: 16, shadow_offset_x: 3, shadow_offset_y: 7,
    has_glow: true, glow_color_hex: '#000000', glow_radius: 20,
    font_family_hint: 'Black Han Sans', font_weight_hint: 'black', font_width: 'normal',
  }];
  const o = reinjectRefStyle(planned, ref)[0];
  ok('(g) 색일치 — shadow_blur 재주입', o.shadow_blur === 16, String(o.shadow_blur));
  ok('(g) 색일치 — shadow_offset 재주입', o.shadow_offset_x === 3 && o.shadow_offset_y === 7);
  ok('(g) 색일치 — glow_radius 재주입', o.glow_radius === 20, String(o.glow_radius));
  ok('(g) 폰트 힌트 재주입', o.font_family_hint === 'Black Han Sans' && o.font_weight_hint === 'black');

  // (g-2) 색 불일치(흰 자막 ↔ 노란 ref) → glow/blur 는 미재주입(글자 안 흐림), offset·폰트는 재주입.
  const plannedM: CaptionLayer[] = [{ text: '흰 자막', color_hex: '#FFFFFF' }];
  const refY: CaptionLayer[] = [{
    text: '노란 ref', color_hex: '#FDE200',
    has_shadow: true, shadow_blur: 16, shadow_offset_x: 3, shadow_offset_y: 7,
    has_glow: true, glow_radius: 20,
    font_family_hint: 'Black Han Sans', font_weight_hint: 'black',
  }];
  const m = reinjectRefStyle(plannedM, refY)[0];
  ok('(g) 색불일치 — glow/blur 미재주입(글자 안 흐림)', m.has_glow !== true && m.glow_radius === undefined && m.shadow_blur === undefined);
  ok('(g) 색불일치 — offset·폰트힌트는 재주입', m.shadow_offset_x === 3 && m.shadow_offset_y === 7 && m.font_family_hint === 'Black Han Sans');

  // 색 기반 매칭: ref 레이어 순서가 뒤집혀도(노랑이 먼저) 색으로 맞춰 vr 이 안 뒤바뀐다.
  const planned2: CaptionLayer[] = [
    { text: '요즘 날씨에 가기 좋은', color_hex: '#FFFFFF' },
    { text: '기린이찌방 한강점', color_hex: '#FFEA00' },
  ];
  const refSwapped: CaptionLayer[] = [
    { text: '기린이찌방 한강점', color_hex: '#FFEA00', vertical_ratio: 0.75 },
    { text: '요즘 날씨에 가기 좋은', color_hex: '#FFFFFF', vertical_ratio: 0.65 },
  ];
  const out2 = reinjectRefStyle(planned2, refSwapped);
  ok('(g) ref 순서 뒤집혀도 흰 자막 vr=0.65 (스왑 안 됨)', out2[0].vertical_ratio === 0.65, String(out2[0].vertical_ratio));
  ok('(g) ref 순서 뒤집혀도 노란 자막 vr=0.75', out2[1].vertical_ratio === 0.75, String(out2[1].vertical_ratio));
}

// ── (h) 폰트 — font_family_hint 로 원본 폰트 직접 매핑 (폰트 간 우선순위/heavy 승급 제거) ──
{
  ok('(h) hint "Black Han Sans" → Black Han Sans', pickBundledFont({ familyHint: 'Black Han Sans', category: 'sans', personality: 'modern' }) === 'Black Han Sans');
  ok('(h) hint 별칭 "BM Jua" → Jua', pickBundledFont({ familyHint: 'BM Jua' }) === 'Jua');
  ok('(h) hint "G마켓 산스" → 둥근 헤비(Do Hyeon)', pickBundledFont({ familyHint: 'G마켓 산스', category: 'rounded', personality: 'playful' }) === 'Do Hyeon');
  ok('(h) 제목쌍 폰트 통일 — "G마켓 산스" / "배달의민족 한나" 둘 다 Do Hyeon',
    pickBundledFont({ familyHint: 'G마켓 산스' }) === pickBundledFont({ familyHint: '배달의민족 한나' })
    && pickBundledFont({ familyHint: '배달의민족 한나' }) === 'Do Hyeon');
  const reg = pickBundledFont({ category: 'sans', personality: 'playful', emphasis: 'regular' });
  const blk = pickBundledFont({ category: 'sans', personality: 'playful', emphasis: 'black' });
  ok('(h) emphasis 가 폰트를 바꾸지 않음(heavy 승급 제거)', reg === blk, `${reg} vs ${blk}`);
}

// ── (i) 유채색 박스 오판 보정 — 실제 분석 데이터 형태(노란박스+검은글씨)를 렌더가 되돌림 ──
{
  // proj_..._38ova1 의 실제 caption 데이터 형태 그대로: 흰글씨+노란박스 / 검은글씨+노란박스.
  const global: GlobalCaptionStyle = { has_background_box: true, background_color_hex: '#FFE600', size_level: 'large', primary_color_hex: '#FFFFFF' };
  const layers: CaptionLayer[] = [
    { text: '요즘 날씨에 가기 좋은', color_hex: '#FFFFFF', has_background_box: true, background_color_hex: '#FFE600', size_level: 'large', vertical_ratio: 0.30 },
    { text: '기린이찌방 한강점',   color_hex: '#000000', has_background_box: true, background_color_hex: '#FFE600', size_level: 'large', vertical_ratio: 0.62 },
  ];
  const placed = layoutCut(layers, global);
  const L0 = placed[0].layer, L1 = placed[1].layer;
  console.log(`   (i) L0 box=${L0.has_background_box} color=${L0.color_hex} | L1 box=${L1.has_background_box} color=${L1.color_hex} outline=${L1.outline_color_hex}`);
  ok('(i) 흰글씨+노란박스 → 박스 제거(흰색 유지)', L0.has_background_box === false && /FFFFFF/i.test(L0.color_hex || ''));
  ok('(i) 검은글씨+노란박스 → 노란글씨+검은외곽선(박스 제거)', L1.has_background_box === false && /FFE600/i.test(L1.color_hex || '') && /000000/i.test(L1.outline_color_hex || ''));
  const ass = buildCaptionAss([{ start: 0, end: 3, layers }], global);
  const borderStyles = ass.split('\n').filter(l => l.startsWith('Style:')).map(l => l.split(',')[15]);
  ok('(i) ASS 에 박스(BorderStyle=3) 없음', borderStyles.length === 2 && borderStyles.every(b => b !== '3'), borderStyles.join(','));
}

// ── (j) 자막 크롭 정밀분석 — 그룹핑/머지/밴드 순수 로직 ──
{
  const spec = { shots: [
    { start: 0, end: 1, caption_layers: [
      { text: '요즘 날씨에 가기 좋은', vertical_ratio: 0.30, size_level: 'large' },
      { text: '기린이찌방 한강점',   vertical_ratio: 0.62, size_level: 'large' },
    ] },
    { start: 1, end: 2, caption_layers: [
      { text: '요즘 날씨에 가기 좋은', vertical_ratio: 0.30, size_level: 'large' },
      { text: '기린이찌방 한강점',   vertical_ratio: 0.62, size_level: 'large' },
    ] },
  ] };
  const groups = groupCaptionsForCrop(spec);
  ok('(j) 반복 자막 2종 → 그룹 2개', groups.length === 2, `groups=${groups.length}`);
  ok('(j) 각 그룹 멤버 2개(반복 샷 묶임)', groups.every(g => g.members.length === 2));
  ok('(j) band: huge>large>medium', bandFracForSize('huge') > bandFracForSize('large') && bandFracForSize('large') > bandFracForSize('medium'));

  // 머지: 풀프레임이 오판한 (검은글씨+노란박스) → 크롭 정밀분석(노란글씨, 박스없음, 검은외곽선)
  const layer: any = { text: '기린이찌방 한강점', color_hex: '#000000', has_background_box: true, background_color_hex: '#FFE600', emphasis: 'bold' };
  mergeCropStyleIntoLayer(layer, { idx: 0, color_hex: '#FFE600', has_background_box: false, outline_color_hex: '#000000', outline_thickness: 'medium', font_weight_hint: 'black', has_shadow: true, shadow_blur: 14 });
  ok('(j) 크롭 머지 — 노란글씨/박스해제/검은외곽선/black 굵기 반영',
    layer.color_hex === '#FFE600' && layer.has_background_box === false && layer.outline_color_hex === '#000000' && layer.font_weight_hint === 'black');

  // 안전장치: 크롭이 자막을 빗나가면(되읽은 text 불일치) 적용 안 함 → 오판 주입 방지.
  ok('(j) 크롭 검증 — 같은 자막은 통과', cropMatchesExpected('기린이찌방 한강점', '기린이찌방 한강점') === true);
  ok('(j) 크롭 검증 — 빈/엉뚱한 영역(KIMCHIPS 봉지 등)은 차단',
    cropMatchesExpected('기린이찌방 한강점', '') === false && cropMatchesExpected('기린이찌방 한강점', 'KIMCHIPS 김칩스 크런치') === false);
}

// ── (k) LLM bbox 로컬라이제이션 — 매칭/폴백 순수 로직 ──
{
  // 실제 데모에서 본 상황: 자막은 하단(y~0.74)인데 detections 에 배경(봉지)과 자막이 섞여 옴.
  const dets = [
    { text: 'KIMCHIPS 김칩스', x: 0.10, y: 0.20, w: 0.30, h: 0.10 },
    { text: '기린이찌방 한강점', x: 0.12, y: 0.74, w: 0.62, h: 0.07 },
  ];
  const box = pickDetectionBox('기린이찌방 한강점', dets);
  ok('(k) 로컬라이즈 — 자막 bbox 선택(하단 y≈0.74, 봉지 아님)', !!box && Math.abs(box!.y - 0.74) < 0.01 && box!.x > 0.1);
  ok('(k) 로컬라이즈 — 일치 detection 없으면 null(폴백)', pickDetectionBox('전혀 다른 문구 xyz', dets) === null);
  ok('(k) 로컬라이즈 — 퍼센트(0~100) 좌표도 보정', (() => { const b = pickDetectionBox('한강', [{ text: '한강', x: 12, y: 74, w: 60, h: 7 }]); return !!b && Math.abs(b!.y - 0.74) < 0.02; })());
  // vr-밴드 폴백 bbox
  const bb = bandBox(0.68, bandFracForSize('large'));
  ok('(k) bandBox — 가로 전체 + y=중심-반높이', bb.x === 0 && bb.w === 1 && Math.abs(bb.y - (0.68 - bandFracForSize('large') / 2)) < 0.001);

  // 위치 복제: 로컬라이즈 bbox 중심 → vertical/horizontal_ratio (레퍼런스 위치 그대로)
  const c = bboxCenter({ x: 0.12, y: 0.715, w: 0.62, h: 0.07 });
  ok('(k) bboxCenter — vr/hr 중심값', Math.abs(c.vr - 0.75) < 0.01 && Math.abs(c.hr - 0.43) < 0.01);
}

// ── (l) 브랜드 타이틀 모드 ──
// (box textbox-fit 경로는 폐기됨 — 사이징은 size_ratio[(e3)], 줄 구조는 \n 존중[(e2)] 이 담당)
{
  // 브랜드 타이틀 모드 — 유채색 줄은 가장 흔한 문구로 고정, 흰 훅은 컷마다 유지.
  const plan: any = [
    { planned_caption_layers: [{ text: '좋은 공연', color_hex: '#FFFFFF' }, { text: '기린이찌방 한강점', color_hex: '#FFEA00' }] },
    { planned_caption_layers: [{ text: '노을 맛집', color_hex: '#FFFFFF' }, { text: '기린이찌방 한강점', color_hex: '#FFEA00' }] },
    { planned_caption_layers: [{ text: '시원한 한잔', color_hex: '#FFFFFF' }, { text: '딴 거', color_hex: '#FFEA00' }] },
  ];
  enforceBrandTitle(plan);
  ok('(l) 브랜드 타이틀 — 유채색 줄 모두 고정', plan.every((it: any) => it.planned_caption_layers[1].text === '기린이찌방 한강점'));
  ok('(l) 브랜드 타이틀 — 흰 훅은 컷마다 변주 유지', plan[0].planned_caption_layers[0].text === '좋은 공연' && plan[1].planned_caption_layers[0].text === '노을 맛집');
}

// ── (m) 컷편집 옵션 — 목표 길이 범위 ──
{
  const auto = resolveTargetRange({ target_sec: 0 }, 28);          // 레퍼런스 28초 따라가기
  ok('(m) target 0 → 레퍼런스 길이(28s)', auto.targetSec === 28 && auto.maxSec === 35);
  const auto2 = resolveTargetRange({ target_sec: 0 }, undefined, 45);
  ok('(m) target 0 + ref 없음 → fallback 45', auto2.targetSec === 45);
  const fixed = resolveTargetRange({ target_sec: 15 }, 60);        // 사용자 15초 고정(ref 무시)
  ok('(m) target 15 고정', fixed.targetSec === 15 && fixed.minSec === 12 && fixed.maxSec === 19);
}

// ── (n) 같은 자막 연속/짧은 공백 → 하나로 합쳐 깜빡임 제거 ──
{
  const L = (t: string, c: string): CaptionLayer => ({ text: t, color_hex: c, vertical_ratio: 0.68 });
  const cut = (s: number, e: number, ls: CaptionLayer[]): CutInput => ({ start: s, end: e, layers: ls });
  const A = [L('한강에서 즐겨요', '#FFFFFF'), L('여기서 한 잔', '#FFEB3B')];
  // 실제 u2vjr6 구조: cut0,1 자막 / cut2(5.9~7.77) 무자막 / cut3,4 같은 자막
  const cuts = [cut(0, 4.5, A), cut(4.5, 5.9, A), cut(7.77, 12.27, A), cut(12.27, 15.59, A)];
  const merged = mergeCaptionRuns(cuts);
  ok('(n) 같은 자막 + 짧은 공백 → 1구간(0~15.59) 연속', merged.length === 1 && merged[0].start === 0 && Math.abs(merged[0].end - 15.59) < 0.01, `len=${merged.length}`);

  // 다른 자막은 안 합침
  const B = [L('완전 다른 문구', '#FFFFFF')];
  ok('(n) 다른 자막은 분리 유지', mergeCaptionRuns([cut(0, 3, A), cut(3, 6, B)]).length === 2);
  // 긴 공백(>bridge)은 안 합침
  ok('(n) 긴 공백은 합치지 않음', mergeCaptionRuns([cut(0, 3, A), cut(10, 13, A)]).length === 2);

  // 깜빡임 제거: buildCaptionAss 가 Dialogue 를 줄여줌 (4컷 → 2 layer = 2 Dialogue)
  const ass = buildCaptionAss(cuts, undefined);
  const dlgCount = ass.split('\n').filter(l => l.startsWith('Dialogue:')).length;
  ok('(n) ASS Dialogue 8개 → 2개로 병합', dlgCount === 2, `dialogues=${dlgCount}`);

  // 간격 타이트: 두 자막 bbox 간격이 fontSize 의 ~0.2 이하
  const placed = layoutCut(A, undefined);
  const bb = placed.map(layerBBox).sort((a, b) => a.top - b.top);
  const gap = bb.length === 2 ? bb[1].top - bb[0].bottom : 999;
  ok('(n) 두 자막 간격 타이트(블록 간 ≤ fontSize×0.22)', gap > 0 && gap <= placed[0].fontSize * 0.22, `gap=${Math.round(gap)}px fs=${placed[0].fontSize}`);
}

// ── (o) 레퍼런스 자막 "시간 위치" 재현 — 앞부분 타이틀만 ──
{
  // ref: 자막이 앞 42%(0~5.5s / 13.2s)에만, 뒤는 없음 (실제 u2vjr6 레퍼런스 구조)
  const spec = { duration: 13.2, shots: [
    { start: 0, end: 5.5, caption_layers: [{ text: '타이틀' }] },
    { start: 5.5, end: 13.2, caption_layers: [] },
  ] };
  const T = () => [{ text: '타이틀' }];
  const plan: any = [
    { output_start: 0, output_end: 4.5, planned_caption_layers: T() },     // frac 0.14 → 유지
    { output_start: 4.5, output_end: 5.9, planned_caption_layers: T() },   // frac 0.33 → 유지
    { output_start: 7.8, output_end: 12.3, planned_caption_layers: T() },  // frac 0.64 → 제거
    { output_start: 12.3, output_end: 15.6, planned_caption_layers: T() }, // frac 0.89 → 제거
  ];
  applyReferenceCaptionTiming(plan, spec, 'per_scene');
  ok('(o) 앞부분 컷 자막 유지', plan[0].planned_caption_layers.length === 1 && plan[1].planned_caption_layers.length === 1);
  ok('(o) 후반 컷 자막 제거(레퍼런스가 그 시점엔 자막 없음)', plan[2].planned_caption_layers.length === 0 && plan[3].planned_caption_layers.length === 0);

  // continuous 모드는 시간 제약 미적용
  const plan2: any = [{ output_start: 12, output_end: 15.6, planned_caption_layers: T() }];
  applyReferenceCaptionTiming(plan2, spec, 'continuous');
  ok('(o) continuous 모드는 시간제약 미적용', plan2[0].planned_caption_layers.length === 1);

  // 레퍼런스가 거의 전 구간 자막이면 noop
  const specFull = { duration: 10, shots: [{ start: 0, end: 10, caption_layers: [{ text: 'x' }] }] };
  const plan3: any = [{ output_start: 8, output_end: 10, planned_caption_layers: T() }];
  applyReferenceCaptionTiming(plan3, specFull, 'per_scene');
  ok('(o) ref 전구간 자막 → noop(유지)', plan3[0].planned_caption_layers.length === 1);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
