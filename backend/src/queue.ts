// ============================================================
// 경량 in-process 작업 큐.
// - 무거운 파이프라인을 HTTP 요청 경로 밖(비동기)에서 실행 → 30분 타임아웃/요청 블로킹 회피.
// - 동시성 제한(WORKER_CONCURRENCY, 기본 1)으로 ffmpeg CPU 폭주 방지.
// - 작업 상태/진행상황을 메모리에 보관, 프런트가 jobId 로 polling.
//   (프로세스 재시작 시 휘발 — MVP. 필요 시 디스크/Postgres 로 승격.)
// ============================================================

import crypto from 'crypto';

export type JobType = 'run_all' | 'stage';
export type JobStatus = 'pending' | 'running' | 'done' | 'error';

export type ProgressEntry = { step: string; msg: string; at: string; extra?: any };

export type Job = {
  id: string;
  type: JobType;
  projectId: string;
  params: any;
  status: JobStatus;
  progress: ProgressEntry[];
  result?: any;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type ProgressFn = (step: string, msg: string, extra?: any) => void;
export type Runner = (job: Job, progress: ProgressFn) => Promise<any>;

const jobs = new Map<string, Job>();
const pendingQueue: string[] = [];
let running = 0;
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 1));

let runner: Runner | null = null;
export function setRunner(r: Runner): void {
  runner = r;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createJob(type: JobType, projectId: string, params: any): Job {
  const id = 'job_' + crypto.randomBytes(6).toString('hex');
  const job: Job = {
    id, type, projectId, params,
    status: 'pending', progress: [],
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  jobs.set(id, job);
  pendingQueue.push(id);
  pump();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

// 공개용 직렬화 (내부 필드 그대로지만 안전하게 복사)
export function publicJob(job: Job) {
  return {
    id: job.id,
    type: job.type,
    projectId: job.projectId,
    status: job.status,
    progress: job.progress,
    result: job.result ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
  };
}

function pump(): void {
  while (running < CONCURRENCY && pendingQueue.length > 0) {
    const id = pendingQueue.shift()!;
    const job = jobs.get(id);
    if (!job) continue;
    running++;
    runOne(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function runOne(job: Job): Promise<void> {
  if (!runner) {
    job.status = 'error';
    job.error = 'job runner 가 설정되지 않았습니다';
    job.finishedAt = nowIso();
    return;
  }
  job.status = 'running';
  job.startedAt = nowIso();
  job.updatedAt = nowIso();

  const progress: ProgressFn = (step, msg, extra) => {
    job.progress.push({ step, msg, at: nowIso(), extra });
    job.updatedAt = nowIso();
  };

  try {
    job.result = await runner(job, progress);
    job.status = 'done';
  } catch (e: any) {
    job.status = 'error';
    job.error = e?.message || String(e);
    progress('error', job.error);
  } finally {
    job.finishedAt = nowIso();
    job.updatedAt = nowIso();
  }
}
