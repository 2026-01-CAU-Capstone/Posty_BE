// ============================================================
// 프로젝트별 컷편집 설정 (Stage 1).
//
// target_sec — 결과 영상의 목표 길이(초).
//   0 (기본) → 자동: 레퍼런스 길이를 따라가고, 없으면 45초.
//   >0       → 사용자가 지정한 길이. 소스가 더 길면 그 길이에 맞춰 컷을 줄인다(reduce).
//              (소스가 이미 더 짧으면 늘리지는 않는다.)
// ============================================================

import fs from 'fs/promises';
import { ARTIFACTS, ensureDir, projectDir } from './paths';

export type CutConfig = {
  target_sec: number;
};

export const DEFAULT_CUT_CONFIG: CutConfig = {
  target_sec: 0,
};

export async function readCutConfig(projectId: string): Promise<CutConfig> {
  try {
    const t = await fs.readFile(ARTIFACTS.cutConfig(projectId), 'utf-8');
    return normalize(JSON.parse(t));
  } catch {
    return { ...DEFAULT_CUT_CONFIG };
  }
}

export async function writeCutConfig(projectId: string, cfg: Partial<CutConfig>): Promise<void> {
  await ensureDir(projectDir(projectId));
  const merged = normalize({ ...DEFAULT_CUT_CONFIG, ...cfg });
  await fs.writeFile(ARTIFACTS.cutConfig(projectId), JSON.stringify(merged, null, 2), 'utf-8');
}

// 목표 길이(초)와 min/max 범위를 결정. target_sec 0 이면 레퍼런스 길이(없으면 45초).
export function resolveTargetRange(
  cfg: CutConfig,
  referenceDurationSec?: number,
  fallbackSec = 45,
): { targetSec: number; minSec: number; maxSec: number } {
  let target = Number(cfg?.target_sec) || 0;
  if (target <= 0) {
    const ref = Number(referenceDurationSec);
    target = Number.isFinite(ref) && ref > 0 ? Math.round(ref) : fallbackSec;
  }
  target = Math.max(8, Math.min(120, target));
  return {
    targetSec: target,
    minSec: Math.max(5, Math.round(target * 0.8)),
    maxSec: Math.round(target * 1.25),
  };
}

function normalize(raw: any): CutConfig {
  const n = Number(raw?.target_sec);
  const target_sec = Number.isFinite(n) && n > 0 ? Math.max(0, Math.min(120, Math.round(n))) : 0;
  return { target_sec };
}
