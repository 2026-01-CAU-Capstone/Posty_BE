// ============================================================
// Stage 2: 색 보정 (영상 보정)
// 입력: 1_cut/cut.mp4 + 0_spec/edit-spec.json + reference 영상 (색 측정용)
// 출력: 2_grade/graded.mp4 + color-stats.json
// 도구: FFmpeg signalstats 로 ref/cut 색 측정 → 차이를 eq + colorbalance 로 보정
// API: 외부 API 없음 (로컬 FFmpeg)
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { ARTIFACTS, ensureDir, readJson, referenceDir, stageDir, writeJson } from '../paths';
import { measureSignalStats, runFfmpeg, SignalStats } from '../ffmpeg';

export async function runStage2(projectId: string): Promise<{ ok: true; transform: any }> {
  // ---- 입력 확인 ----
  const cutPath = ARTIFACTS.cutMp4(projectId);
  if (!(await fileOk(cutPath))) throw new Error('Stage 1 (cut.mp4) 결과가 없습니다');

  const refDir = referenceDir(projectId);
  const refFiles = (await fs.readdir(refDir).catch(() => [])).filter(f => !f.startsWith('.'));
  if (refFiles.length === 0) throw new Error('레퍼런스 영상을 찾을 수 없습니다');
  const refFile = path.join(refDir, refFiles[0]);

  // ---- 색 측정 ----
  const [refStats, cutStats] = await Promise.all([
    measureSignalStats(refFile),
    measureSignalStats(cutPath),
  ]);

  // ---- spec 의 color_style 힌트도 같이 활용 ----
  const spec: any = await readJson(ARTIFACTS.editSpec(projectId));
  const hint = spec?.color_style || {};

  const transform = computeTransform(refStats, cutStats, hint);

  // ---- 적용 ----
  await ensureDir(stageDir(projectId, 2));
  const outPath = ARTIFACTS.gradedMp4(projectId);
  const vf = buildEqFilter(transform);

  await runFfmpeg([
    '-y',
    '-i', cutPath,
    '-vf', vf,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'medium', '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outPath,
  ]);

  await writeJson(ARTIFACTS.colorStats(projectId), {
    reference: refStats,
    cut: cutStats,
    hint,
    transform,
    applied_filter: vf,
  });

  return { ok: true, transform };
}

async function fileOk(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// ============================================================
// signalstats 측정값 → eq/colorbalance 파라미터
//
// brightness : (-1.0 ~ 1.0). YAVG 차이 / 128 정도로 매핑
// contrast   : (-2.0 ~ 2.0, 기본 1.0). YSTDDEV 비율
// saturation : (0.0 ~ 3.0, 기본 1.0). SATAVG 비율
// gamma      : (0.1 ~ 10.0, 기본 1.0)
// 색온도(temperature) : colorbalance 의 rs/bs 로 시안↔레드 / 블루↔옐로우 미세조정
// ============================================================

type ColorTransform = {
  brightness: number;     // eq brightness
  contrast: number;       // eq contrast
  saturation: number;     // eq saturation
  gamma: number;          // eq gamma
  rs: number;             // colorbalance red shadows
  gs: number;             // colorbalance green shadows
  bs: number;             // colorbalance blue shadows
};

function computeTransform(ref: SignalStats, cut: SignalStats, hint: any): ColorTransform {
  // 밝기: ref - cut 차이를 [-1, 1] 로
  const bdiff = (ref.yavg - cut.yavg) / 128;
  let brightness = clamp(bdiff * 0.6, -0.3, 0.3); // 너무 과하지 않게 60%만 보정

  // 대비: ref/cut 비율
  let contrast = 1.0;
  if (cut.ystddev > 1) {
    contrast = clamp(ref.ystddev / cut.ystddev, 0.7, 1.4);
  }

  // 채도: SATAVG 비율
  let saturation = 1.0;
  if (cut.satavg > 1) {
    saturation = clamp(ref.satavg / cut.satavg, 0.6, 1.8);
  }

  // hint 가 명시적이면 그쪽도 반영
  if (hint?.saturation === 'vivid') saturation = Math.max(saturation, 1.15);
  if (hint?.saturation === 'muted') saturation = Math.min(saturation, 0.85);
  if (hint?.contrast === 'high') contrast = Math.max(contrast, 1.1);
  if (hint?.contrast === 'low') contrast = Math.min(contrast, 0.92);
  if (hint?.brightness === 'bright') brightness = Math.max(brightness, 0.05);
  if (hint?.brightness === 'dark') brightness = Math.min(brightness, -0.05);

  // 색온도: hint 위주 (signalstats 만으로 정확히 추정 어렵)
  let rs = 0, gs = 0, bs = 0;
  if (hint?.temperature === 'warm') { rs = 0.06; bs = -0.06; }
  else if (hint?.temperature === 'cool') { rs = -0.06; bs = 0.06; }

  return {
    brightness: round3(brightness),
    contrast: round3(contrast),
    saturation: round3(saturation),
    gamma: 1.0,
    rs: round3(rs), gs: round3(gs), bs: round3(bs),
  };
}

function buildEqFilter(t: ColorTransform): string {
  const parts: string[] = [];
  parts.push(`eq=brightness=${t.brightness}:contrast=${t.contrast}:saturation=${t.saturation}:gamma=${t.gamma}`);
  if (t.rs || t.gs || t.bs) {
    parts.push(`colorbalance=rs=${t.rs}:gs=${t.gs}:bs=${t.bs}`);
  }
  return parts.join(',');
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
