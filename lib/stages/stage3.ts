// ============================================================
// Stage 3: 자막 입히기 (ASS / libass 풀 활용 모드)
// ----------------------------------------------------------------
// 입력:  2_grade/graded.mp4 + edit-plan.json (planned_caption_layers 포함)
// 출력:  3_caption/captioned.mp4 + 3_caption/captions.ass
//
// 흐름:
//   1) 각 컷의 layer 들 → 단일 .ass 문서 (컷별 타이밍의 Dialogue 이벤트).
//   2) FFmpeg subtitles 필터 한 번으로 libass 가 직접 렌더 (PNG/오버레이 없음).
//
// ASS 로 표현 (caption-ass.ts 참고):
//   폰트/크기/굵기/이탤릭, 글자색/외곽선색/그림자색, 외곽선 두께,
//   그림자 오프셋·방향, 불투명 박스 배경, 글로우 근사, 자간,
//   등장 애니메이션(layer별 fade/slide/pop), 위치/정렬/멀티 layer 수직 스택.
//
// Windows 경로 escaping 회피:
//   ffmpeg 를 cwd=3_caption 에서 실행하고 .ass 는 basename, fontsdir 는
//   forward-slash 상대경로로 넘겨 드라이브 콜론/백슬래시를 필터그래프에 넣지 않는다.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { ARTIFACTS, appendRawResponse, ensureDir, readJson, stageDir } from '../paths';
import { runFfmpeg } from '../ffmpeg';
import { bundledFontsDir } from '../fonts';
import { buildCaptionAss, CaptionLayer, CutInput, GlobalCaptionStyle } from '../caption-ass';

export async function runStage3(projectId: string): Promise<{
  ok: true;
  layer_count: number;
  cut_with_captions: number;
  total_cuts: number;
  ass_path: string;
}> {
  const graded = ARTIFACTS.gradedMp4(projectId);
  if (!(await fileOk(graded))) throw new Error('Stage 2 (graded.mp4) 결과가 없습니다');

  const plan: any = await readJson(ARTIFACTS.editPlan(projectId));
  const spec: any = await readJson(ARTIFACTS.editSpec(projectId));
  if (!plan?.items) throw new Error('edit-plan.json 이 없습니다');

  const items: any[] = plan.items;
  const globalStyle: GlobalCaptionStyle = spec?.caption_global_style || {};

  // 1) 각 컷의 layer 결정 — planned 우선, 없으면 매칭된 ref 사용
  const layersPerCut: CaptionLayer[][] = items.map((it: any) => {
    const planned = Array.isArray(it.planned_caption_layers) ? it.planned_caption_layers : [];
    if (planned.length > 0) return planned as CaptionLayer[];
    const ref = Array.isArray(it.ref_caption_layers) ? it.ref_caption_layers : [];
    return ref as CaptionLayer[];
  });

  const totalLayers = layersPerCut.reduce((s, ls) => s + ls.length, 0);
  const cutWithCaps = layersPerCut.filter(ls => ls.length > 0).length;

  const stage3 = stageDir(projectId, 3);
  await ensureDir(stage3);
  const assPath = path.join(stage3, 'captions.ass');
  const captionedPath = ARTIFACTS.captionedMp4(projectId);

  // 자막이 하나도 없으면 그냥 copy
  if (totalLayers === 0) {
    await fs.rm(assPath, { force: true }).catch(() => {});
    await runFfmpeg([
      '-y', '-i', graded,
      '-c', 'copy',
      '-movflags', '+faststart',
      captionedPath,
    ]);
    await appendRawResponse(projectId, {
      stage: 3, kind: 'caption_render',
      total_cuts: items.length, cut_with_captions: 0, layer_count: 0,
      mode: 'ass_subtitles', engine: 'libass',
    });
    return { ok: true, layer_count: 0, cut_with_captions: 0, total_cuts: items.length, ass_path: assPath };
  }

  // 2) 컷 타이밍 + layer → ASS 문서
  const cuts: CutInput[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const layers = layersPerCut[i];
    if (!layers || layers.length === 0) continue;
    const start = Number(it.output_start);
    const end = Number(it.output_end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const sy = Number(it.subject_center_y);
    cuts.push({ start, end, layers, subjectCenterY: Number.isFinite(sy) ? sy : undefined });
  }

  const ass = buildCaptionAss(cuts, globalStyle);
  await fs.writeFile(assPath, ass, 'utf8');

  // 3) FFmpeg subtitles 필터로 렌더
  // cwd=stage3 → .ass 는 basename, fontsdir 는 상대경로(forward slash) 로 넘긴다.
  let fontsRel = path.relative(stage3, bundledFontsDir()).split(path.sep).join('/');
  if (!fontsRel) fontsRel = '.';
  const vf = `subtitles='captions.ass':fontsdir='${fontsRel}'`;

  await runFfmpeg([
    '-y', '-i', graded,
    '-vf', vf,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'medium', '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    captionedPath,
  ], stage3);

  await appendRawResponse(projectId, {
    stage: 3, kind: 'caption_render',
    total_cuts: items.length, cut_with_captions: cutWithCaps,
    layer_count: totalLayers, rendered_cuts: cuts.length,
    mode: 'ass_subtitles', engine: 'libass',
  });

  return {
    ok: true,
    layer_count: totalLayers,
    cut_with_captions: cutWithCaps,
    total_cuts: items.length,
    ass_path: assPath,
  };
}

async function fileOk(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
