// ============================================================
// 작업 실행기 — job.type 에 따라 기존 파이프라인(lib/stages/*)을 호출하고
// stage 단위 진행상황을 progress() 로 보고한다.
// 파이프라인 로직 자체는 lib/* 를 그대로 재사용 (재작성 없음).
// ============================================================

import path from 'path';
import type { Job, ProgressFn } from './queue';
import { runStage0 } from '../../lib/stages/stage0';
import { runStage1 } from '../../lib/stages/stage1';
import { runStage2 } from '../../lib/stages/stage2';
import { runStage3 } from '../../lib/stages/stage3';
import { runStage4 } from '../../lib/stages/stage4';
import { ARTIFACTS } from '../../lib/paths';

const STAGE_LABEL = ['레퍼런스 분석', '컷편집', '색보정', '자막', '음성·BGM'];

async function runStage(n: number, projectId: string): Promise<any> {
  switch (n) {
    case 0: return runStage0(projectId);
    case 1: return runStage1(projectId);
    case 2: return runStage2(projectId);
    case 3: return runStage3(projectId);
    case 4: return runStage4(projectId);
    default: throw new Error(`알 수 없는 stage: ${n}`);
  }
}

function relForServe(abs: string): string {
  return path.relative(process.cwd(), abs).replace(/\\/g, '/');
}

export async function jobRunner(job: Job, progress: ProgressFn): Promise<any> {
  const { projectId } = job;

  if (job.type === 'stage') {
    const n = Number(job.params?.stage);
    if (!Number.isInteger(n) || n < 0 || n > 4) throw new Error(`stage 파라미터가 잘못됨: ${job.params?.stage}`);
    progress(`stage${n}_start`, `Stage ${n} (${STAGE_LABEL[n]}) 시작`, { stage: n });
    const result = await runStage(n, projectId);
    progress(`stage${n}_done`, `Stage ${n} (${STAGE_LABEL[n]}) 완료`, { stage: n, result });
    return { stage: n, result, final: relForServe(ARTIFACTS.finalMp4(projectId)) };
  }

  if (job.type === 'run_all') {
    const from = Number.isInteger(job.params?.from) ? job.params.from : 0;
    const to = Number.isInteger(job.params?.to) ? job.params.to : 4;
    const results: Record<string, any> = {};
    for (let n = from; n <= to; n++) {
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
