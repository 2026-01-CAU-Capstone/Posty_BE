// ============================================================
// Posty 백엔드 API (Hono). 프런트와 HTTP 로만 통신.
// 이 모듈은 server.ts 가 cwd 고정 + .env.local 로드 "후" 동적 import 한다.
// (lib/config 가 import 시점에 process.env 를 읽으므로 순서가 중요)
// ============================================================

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';

import {
  ARTIFACTS, bgmDir, ensureDir, fileExists, newProjectId, projectDir,
  readJson, readStyleNote, referenceDir, sourcesDir, writeStyleNote,
} from '../../lib/paths';
import { checkStageConfig, StageId } from '../../lib/config';
import { DEFAULT_BRIEF, readStyleBrief, writeStyleBrief } from '../../lib/style-brief';
import { generateStyleSuggest, readStyleSuggest } from '../../lib/style-suggest';
import { DEFAULT_TTS_CONFIG, readTtsConfig, writeTtsConfig } from '../../lib/tts-config';
import { readTtsOutline, validateOutline } from '../../lib/tts-outline';
import { ensureIgFetchAlive, importInstagramUrl } from '../../lib/ig-fetch';

import { createJob, getJob, publicJob, setRunner } from './queue';
import { jobRunner } from './pipeline';
import { estimateProject } from './estimate';

setRunner(jobRunner);

const app = new Hono();
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
}));

// ---- 헬스 체크 ----
app.get('/', (c) => c.json({ ok: true, service: 'posty-backend' }));
app.get('/api/health', (c) => c.json({ ok: true }));

// ---- 프로젝트 생성 ----
app.post('/api/projects', async (c) => {
  const id = newProjectId();
  await ensureDir(projectDir(id));
  await ensureDir(referenceDir(id));
  await ensureDir(sourcesDir(id));
  await ensureDir(bgmDir(id));
  return c.json({ ok: true, projectId: id });
});

// ---- 업로드 (multipart: projectId, kind, file[]) ----
app.post('/api/upload', async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart 파싱 실패' }, 400);
  const projectId = String(form.get('projectId') || '');
  const kind = String(form.get('kind') || '');
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  if (!['reference', 'source', 'bgm'].includes(kind)) return c.json({ error: `kind 가 잘못됨: ${kind}` }, 400);

  const files = form.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return c.json({ error: 'file 누락' }, 400);

  const dir = kind === 'reference' ? referenceDir(projectId)
    : kind === 'source' ? sourcesDir(projectId)
    : bgmDir(projectId);
  await ensureDir(dir);

  // reference / bgm 은 1개만 → 기존 파일 청소
  if (kind === 'reference' || kind === 'bgm') {
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      await fsp.rm(path.join(dir, f), { force: true });
    }
  }

  const saved: string[] = [];
  for (const file of files) {
    const safe = sanitizeFileName(file.name);
    const buf = Buffer.from(await file.arrayBuffer());
    await fsp.writeFile(path.join(dir, safe), buf);
    saved.push(safe);
  }
  return c.json({ ok: true, kind, saved });
});

// ---- Instagram URL 임포트 (json: projectId, kind, urls[]) ----
app.post('/api/ig-import', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'JSON 파싱 실패' }, 400);
  const projectId = String(body.projectId || '').trim();
  const kind = String(body.kind || '').trim();
  const urls: string[] = Array.isArray(body.urls)
    ? body.urls.map((u: any) => String(u || '').trim()).filter(Boolean) : [];
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  if (kind !== 'reference' && kind !== 'source') return c.json({ error: `kind 가 잘못됨: ${kind}` }, 400);
  if (urls.length === 0) return c.json({ error: 'urls 가 비어 있음' }, 400);
  if (kind === 'reference' && urls.length > 1) return c.json({ error: '레퍼런스는 1개의 URL 만 허용됩니다' }, 400);

  try { await ensureIgFetchAlive(); } catch (e: any) { return c.json({ error: e.message }, 502); }

  const dir = kind === 'reference' ? referenceDir(projectId) : sourcesDir(projectId);
  await ensureDir(dir);
  if (kind === 'reference') {
    for (const f of await fsp.readdir(dir).catch(() => [])) await fsp.rm(path.join(dir, f), { force: true });
  }

  const saved: { url: string; files: string[] }[] = [];
  const errors: { url: string; error: string }[] = [];
  for (const url of urls) {
    try {
      const r = await importInstagramUrl(url, dir, { onlyVideo: kind === 'reference' });
      saved.push({ url, files: r.files.map((p: string) => path.basename(p)) });
    } catch (e: any) {
      errors.push({ url, error: e.message || String(e) });
    }
  }
  if (saved.length === 0) return c.json({ error: '모든 URL 다운로드 실패', errors }, 502);
  return c.json({ ok: true, kind, saved, errors });
});

// ---- 프로젝트 상태 ----
app.get('/api/project', async (c) => {
  const projectId = c.req.query('projectId') || '';
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }

  const list = async (dir: string) => (await fsp.readdir(dir).catch(() => [])).filter(f => !f.startsWith('.'));
  const reference = await list(referenceDir(projectId));
  const sources = await list(sourcesDir(projectId));
  const bgm = await list(bgmDir(projectId));

  const stages = {
    s0_spec: await fileExists(ARTIFACTS.editSpec(projectId)),
    s1_cut: await fileExists(ARTIFACTS.cutMp4(projectId)),
    s2_graded: await fileExists(ARTIFACTS.gradedMp4(projectId)),
    s3_captioned: await fileExists(ARTIFACTS.captionedMp4(projectId)),
    s4_final: await fileExists(ARTIFACTS.finalMp4(projectId)),
  };

  const spec = await readJson<any>(ARTIFACTS.editSpec(projectId));
  const plan = await readJson<any>(ARTIFACTS.editPlan(projectId));
  const colorStats = await readJson<any>(ARTIFACTS.colorStats(projectId));
  const styleNote = await readStyleNote(projectId);
  const styleBrief = await readStyleBrief(projectId);
  const ttsConfig = await readTtsConfig(projectId);
  const ttsOutline = await readTtsOutline(projectId);

  return c.json({
    ok: true,
    projectId,
    styleNote,
    styleBrief,
    ttsConfig,
    ttsOutline,
    ttsOutlineIssues: validateOutline(ttsOutline),
    uploads: { reference, sources, bgm },
    stages,
    artifacts: {
      editSpec: spec ? summarizeSpec(spec) : null,
      editPlan: plan ? summarizePlan(plan) : null,
      colorStats: colorStats?.transform || null,
    },
    paths: {
      finalMp4: stages.s4_final ? relForServe(ARTIFACTS.finalMp4(projectId)) : null,
      captionedMp4: stages.s3_captioned ? relForServe(ARTIFACTS.captionedMp4(projectId)) : null,
      gradedMp4: stages.s2_graded ? relForServe(ARTIFACTS.gradedMp4(projectId)) : null,
      cutMp4: stages.s1_cut ? relForServe(ARTIFACTS.cutMp4(projectId)) : null,
    },
  });
});

// ---- 산출물 파일 서빙 (Range 지원) ----
app.get('/api/file', (c) => {
  const relPath = c.req.query('path') || '';
  if (!relPath) return c.text('path 누락', 400);
  const abs = path.resolve(process.cwd(), relPath);
  const allowed = path.resolve(process.cwd(), 'data', 'projects');
  if (!abs.startsWith(allowed)) return c.text('forbidden', 403);
  if (!fs.existsSync(abs)) return c.text('not found', 404);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) return c.text('not a file', 400);

  const ext = path.extname(abs).toLowerCase();
  const ct = ext === '.mp4' ? 'video/mp4'
    : ext === '.mov' ? 'video/quicktime'
    : ext === '.webm' ? 'video/webm'
    : ext === '.mp3' ? 'audio/mpeg'
    : ext === '.json' ? 'application/json; charset=utf-8'
    : 'application/octet-stream';

  const range = c.req.header('range');
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      const chunk = end - start + 1;
      const stream = Readable.toWeb(fs.createReadStream(abs, { start, end })) as unknown as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunk),
          'Content-Type': ct,
        },
      });
    }
  }
  const stream = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream;
  return new Response(stream, {
    headers: {
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Type': ct,
    },
  });
});

// ---- 실행 (비동기 job 등록) ----
// body: { projectId, mode: 'all' | 'stage', stage? }
app.post('/api/run', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'JSON 파싱 실패' }, 400);
  const projectId = String(body.projectId || '').trim();
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }

  const mode = body.mode === 'stage' ? 'stage' : 'all';
  if (mode === 'stage') {
    const stage = Number(body.stage);
    if (!Number.isInteger(stage) || stage < 0 || stage > 4) return c.json({ error: `stage 가 잘못됨: ${body.stage}` }, 400);
    const cfgErr = checkStageConfig(stage as StageId);
    if (cfgErr) return c.json({ error: cfgErr }, 400);
    const job = createJob('stage', projectId, { stage });
    return c.json({ ok: true, jobId: job.id });
  }

  // run_all: from~to 범위(기본 0~4). Stage 0(레퍼런스 분석)만 먼저, 또는 1~4(나머지)만 돌릴 수 있게.
  const from = clampStage(body.from, 0);
  const to = clampStage(body.to, 4);
  if (to < from) return c.json({ error: `from(${from}) > to(${to})` }, 400);
  // 범위에 포함된 키 필요 stage(0,1)만 사전 검증
  for (const s of [0, 1] as StageId[]) {
    if (from <= s && s <= to) {
      const e = checkStageConfig(s);
      if (e) return c.json({ error: e }, 400);
    }
  }
  const job = createJob('run_all', projectId, { from, to });
  return c.json({ ok: true, jobId: job.id });
});

// ---- 처리 시간 예상 (보수적) ----
app.get('/api/estimate', async (c) => {
  const projectId = c.req.query('projectId') || '';
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }
  const estimate = await estimateProject(projectId);
  return c.json({ ok: true, estimate });
});

// ---- job 상태 ----
app.get('/api/jobs/:id', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'job 없음' }, 404);
  return c.json({ ok: true, job: publicJob(job) });
});

// ---- 설정 저장 (동기) ----
app.post('/api/style-note', async (c) => {
  const { projectId, text } = await c.req.json().catch(() => ({}));
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  const safe = typeof text === 'string' ? text.slice(0, 4000) : '';
  await writeStyleNote(projectId, safe);
  return c.json({ ok: true, length: safe.length });
});

app.post('/api/style-brief', async (c) => {
  const { projectId, brief } = await c.req.json().catch(() => ({}));
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  await writeStyleBrief(projectId, { ...DEFAULT_BRIEF, ...(brief || {}) });
  return c.json({ ok: true });
});

// ---- 스타일 자동 추천 (Stage 0.5) ----
// GET  : 캐시 조회 (없으면 suggest=null)
// POST : 생성 — body { projectId, force? }. force=true 면 캐시 무시하고 새로 호출.
app.get('/api/style-suggest', async (c) => {
  const projectId = c.req.query('projectId') || '';
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  const suggest = await readStyleSuggest(projectId);
  return c.json({ ok: true, suggest, cached: !!suggest });
});

app.post('/api/style-suggest', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const projectId = String(body.projectId || '').trim();
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }

  const force = body.force === true;
  if (!force) {
    const cached = await readStyleSuggest(projectId);
    if (cached) return c.json({ ok: true, suggest: cached, cached: true });
  }
  try {
    const suggest = await generateStyleSuggest(projectId);
    return c.json({ ok: true, suggest, cached: false });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

app.post('/api/tts-config', async (c) => {
  const { projectId, tts } = await c.req.json().catch(() => ({}));
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  await writeTtsConfig(projectId, { ...DEFAULT_TTS_CONFIG, ...(tts || {}) });
  return c.json({ ok: true });
});

// ============================================================
// 유틸
// ============================================================
function clampStage(v: any, def: number): number {
  const n = Number(v);
  if (!Number.isInteger(n)) return def;
  return Math.max(0, Math.min(4, n));
}

function sanitizeFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return base.length > 0 ? base.slice(0, 200) : `upload_${Date.now()}`;
}

function relForServe(absPath: string): string {
  return path.relative(process.cwd(), absPath).replace(/\\/g, '/');
}

function summarizeSpec(spec: any) {
  return {
    duration: spec.duration,
    aspect_ratio: spec.aspect_ratio,
    pacing: spec.pacing,
    shots_count: Array.isArray(spec.shots) ? spec.shots.length : 0,
    color_style: spec.color_style,
    audio_profile: spec.audio_profile,
    shots: Array.isArray(spec.shots) ? spec.shots.slice(0, 30) : [],
  };
}

function summarizePlan(plan: any) {
  return {
    aspect_ratio: plan.aspect_ratio,
    output_duration: plan.output_duration,
    items_count: Array.isArray(plan.items) ? plan.items.length : 0,
    items: Array.isArray(plan.items) ? plan.items : [],
  };
}

const port = Number(process.env.BACKEND_PORT || 8787);
serve({ fetch: app.fetch, port });
console.log(`[posty-backend] listening on http://localhost:${port}  (cwd=${process.cwd()})`);
