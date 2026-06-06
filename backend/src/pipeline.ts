// ============================================================
// 작업 실행기 — job.type 에 따라 기존 파이프라인(lib/stages/*)을 호출하고
// stage 단위 진행상황을 progress() 로 보고한다.
// 파이프라인 로직 자체는 lib/* 를 그대로 재사용 (재작성 없음).
// ============================================================

import path from 'path';
import type { Job, ProgressFn } from './queue';
import { runStage0, RunStage0Options } from '../../lib/stages/stage0';
import { runStage1 } from '../../lib/stages/stage1';
import { runStage2 } from '../../lib/stages/stage2';
import { runStage3 } from '../../lib/stages/stage3';
import { runStage4 } from '../../lib/stages/stage4';
import { ARTIFACTS } from '../../lib/paths';

const STAGE_LABEL = ['레퍼런스 분석', '컷편집', '색보정', '자막', '음성·BGM'];

// stage 0 만 별도 옵션(reanalyze 등) 을 받는다. 다른 stage 는 params 없음.
async function runStage(n: number, projectId: string, stage0Opts?: RunStage0Options): Promise<any> {
  switch (n) {
    case 0: return runStage0(projectId, stage0Opts || {});
    case 1: return runStage1(projectId);
    case 2: return runStage2(projectId);
    case 3: return runStage3(projectId);
    case 4: return runStage4(projectId);
    default: throw new Error(`알 수 없는 stage: ${n}`);
  }
}

// job.params 에서 stage 0 전용 옵션만 추려낸다.
function pickStage0Options(params: any): RunStage0Options | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const opts: RunStage0Options = {};
  if (params.reanalyze === true) opts.reanalyze = true;
  if (typeof params.userFocus === 'string' && params.userFocus.trim()) {
    opts.userFocus = params.userFocus.trim();
  }
  return (opts.reanalyze || opts.userFocus) ? opts : undefined;
}

function relForServe(abs: string): string {
  return path.relative(process.cwd(), abs).replace(/\\/g, '/');
}

export async function jobRunner(job: Job, progress: ProgressFn): Promise<any> {
  const { projectId } = job;

  if (job.type === 'stage') {
    const n = Number(job.params?.stage);
    if (!Number.isInteger(n) || n < 0 || n > 4) throw new Error(`stage 파라미터가 잘못됨: ${job.params?.stage}`);
    const stage0Opts = n === 0 ? pickStage0Options(job.params) : undefined;
    progress(`stage${n}_start`, `Stage ${n} (${STAGE_LABEL[n]}) 시작`, { stage: n, ...(stage0Opts ? { reanalyze: !!stage0Opts.reanalyze } : {}) });
    const result = await runStage(n, projectId, stage0Opts);
    progress(`stage${n}_done`, `Stage ${n} (${STAGE_LABEL[n]}) 완료`, { stage: n, result });
    return { stage: n, result, final: relForServe(ARTIFACTS.finalMp4(projectId)) };
  }

  if (job.type === 'run_all') {
    const from = Number.isInteger(job.params?.from) ? job.params.from : 0;
    const to = Number.isInteger(job.params?.to) ? job.params.to : 4;
    const results: Record<string, any> = {};
    for (let n = from; n <= to; n++) {
      // run_all 흐름에선 stage 0 옵션은 무시(재분석은 'stage' 모드에서만).
      progress(`stage${n}_start`, `Stage ${n} (${STAGE_LABEL[n]}) 시작`, { stage: n, from, to });
      results[`stage${n}`] = await runStage(n, projectId);
      progress(`stage${n}_done`, `Stage ${n} (${STAGE_LABEL[n]}) 완료`, { stage: n, from, to });
    }
    const reachedFinal = to >= 4;
    progress('all_done', `완료 (Stage ${from}~${to})`, reachedFinal ? { final: relForServe(ARTIFACTS.finalMp4(projectId)) } : {});
    return { results, from, to, final: reachedFinal ? relForServe(ARTIFACTS.finalMp4(projectId)) : null };
  }

  throw new Error(`알 수 없는 job type: ${job.type}`);
}
