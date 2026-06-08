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
import { ARTIFACTS, appendRawResponse, ensureDir, readJson, stageDir, workDir, writeJson } from '../paths';
import { runFfmpeg, extractFrame } from '../ffmpeg';
import { MediaPart } from '../gemini';
import { bundledFontsDir } from '../fonts';
import { buildCaptionAss, CaptionLayer, CutInput, GlobalCaptionStyle } from '../caption-ass';
import { planCaptions } from './stage1';

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

  // 0) 자막 플래닝 (편집본 시각 그라운딩) — 컷+보정이 끝난 graded.mp4 의 각 컷 프레임을 보고
  //    장면에 맞는 자막을 생성한다. (이전엔 Stage1 에서 컷을 보기 전에 플래닝했음.)
  //    Stage 3 재실행만으로 자막을 재생성할 수 있다(컷 재편집 불필요).
  try {
    const frames = await extractCutFramesForPlanning(projectId, items, graded);
    await planCaptions(projectId, items, spec || {}, undefined, frames);
    await writeJson(ARTIFACTS.editPlan(projectId), plan);
    await appendRawResponse(projectId, {
      stage: 3, kind: 'caption_planning_in_stage3', cuts: items.length, grounded: !!frames,
    });
  } catch (e: any) {
    await appendRawResponse(projectId, {
      stage: 3, kind: 'caption_planning_in_stage3_failed', error: e.message || String(e),
    });
  }

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

// 각 컷의 대표 프레임(중간 시점)을 graded.mp4 에서 뽑아 caption planning 의 시각 그라운딩에 쓴다.
// 모든 컷의 프레임이 다 나와야(순서/개수 1:1) 반환, 하나라도 실패하면 undefined → 텍스트 전용 플래닝으로 폴백.
async function extractCutFramesForPlanning(
  projectId: string,
  items: any[],
  gradedPath: string,
): Promise<MediaPart[] | undefined> {
  try {
    const dir = path.join(workDir(projectId), '_caption_plan_frames');
    await ensureDir(dir);
    const frames: MediaPart[] = [];
    for (let i = 0; i < items.length; i++) {
      const s = Number(items[i]?.output_start) || 0;
      const e = Number(items[i]?.output_end) || (s + 1);
      const mid = Math.max(0, (s + e) / 2);
      const fp = path.join(dir, `cut_${String(i).padStart(3, '0')}.jpg`);
      await extractFrame(gradedPath, mid, fp, 640);
      frames.push({ filePath: fp, mimeType: 'image/jpeg' });
    }
    return frames.length === items.length && frames.length > 0 ? frames : undefined;
  } catch {
    return undefined;
  }
}
