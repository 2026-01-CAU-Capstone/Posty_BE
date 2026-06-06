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
  readJson, readStyleNote, referenceDir, sourcesDir, writeJson, writeStyleNote,
} from '../../lib/paths';
import { ensurePreviewFrames } from '../../lib/preview-frames';
import { fetchBgmCandidates, downloadBgmTrack, BgmCandidate } from '../../lib/archive';
import { identifyReferenceBgm } from '../../lib/bgm-identify';
import { checkStageConfig, StageId } from '../../lib/config';
import { DEFAULT_BRIEF, readStyleBrief, writeStyleBrief } from '../../lib/style-brief';
import { generateStyleSuggest, readStyleSuggest } from '../../lib/style-suggest';
import { DEFAULT_TTS_CONFIG, readTtsConfig, writeTtsConfig } from '../../lib/tts-config';
import { readTtsOutline, validateOutline } from '../../lib/tts-outline';
import { DEFAULT_AUDIO_CONFIG, readAudioConfig, writeAudioConfig } from '../../lib/audio-config';
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
  const audioConfig = await readAudioConfig(projectId);

  return c.json({
    ok: true,
    projectId,
    styleNote,
    styleBrief,
    ttsConfig,
    ttsOutline,
    audioConfig,
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
    const params: any = { stage };
    // Stage 0 재분석 옵션 — "다시 분석하기" 가 누른 케이스.
    // 다른 stage 에서는 무시한다.
    if (stage === 0) {
      if (body.reanalyze === true) params.reanalyze = true;
      if (typeof body.userFocus === 'string' && body.userFocus.trim()) {
        params.userFocus = body.userFocus.trim().slice(0, 1000);
      }
    }
    const job = createJob('stage', projectId, params);
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

// ---- 진행/디버그용 raw API 응답 ----
// raw-api-responses.json 의 누적 entries 를 그대로 반환.
// 각 entry 가 클 수 있으므로 limit 쿼리로 마지막 N개만 받을 수 있게 함 (기본 200).
app.get('/api/raw-responses', async (c) => {
  const projectId = c.req.query('projectId') || '';
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }
  const limit = Math.max(1, Math.min(2000, Number(c.req.query('limit')) || 200));
  const p = ARTIFACTS.rawResponses(projectId);
  let arr: any[] = [];
  try {
    const t = await fsp.readFile(p, 'utf-8');
    arr = JSON.parse(t);
    if (!Array.isArray(arr)) arr = [];
  } catch { arr = []; }
  const sliced = arr.slice(-limit);
  return c.json({ ok: true, total: arr.length, returned: sliced.length, entries: sliced });
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

// ============================================================
// 미리보기 프레임 — UI 진행 화면 캐러셀용
// 레퍼런스 + 소스에서 골고루 추출한 jpg 들을 반환.
// ============================================================
app.get('/api/preview-frames', async (c) => {
  const projectId = c.req.query('projectId') || '';
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }
  const count = Math.max(4, Math.min(24, Number(c.req.query('count')) || 16));
  try {
    const frames = await ensurePreviewFrames(projectId, count);
    return c.json({
      ok: true,
      frames: frames.map(f => ({
        url: '/api/file?path=' + encodeURIComponent(relForServe(f.path)),
        source: f.source,
        sourceFile: f.sourceFile,
      })),
    });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

// ============================================================
// BGM 후보 (다운로드 없이) — 사용자가 듣고 고름.
// 캐시: 4_final/bgm-candidates.json
// ============================================================
app.get('/api/bgm-candidates', async (c) => {
  const projectId = c.req.query('projectId') || '';
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }

  const force = c.req.query('force') === '1';
  const cachePath = path.join(projectDir(projectId), '4_final', 'bgm-candidates.json');
  if (!force) {
    const cached = await readJson<any>(cachePath);
    if (cached && Array.isArray(cached.candidates) && cached.candidates.length > 0) {
      return c.json({ ok: true, ...cached, cached: true });
    }
  }

  const spec = await readJson<any>(ARTIFACTS.editSpec(projectId));
  if (!spec) return c.json({ error: '레퍼런스 분석 결과가 없습니다 (Stage 0 먼저 실행)' }, 400);
  const audioProfile = spec.audio_profile || {};

  // 레퍼런스 BGM 식별 (토큰 있을 때만 — 실패해도 무시)
  let referenceBgm: any = null;
  try {
    const dir = referenceDir(projectId);
    const files = (await fsp.readdir(dir).catch(() => [])).filter(f => !f.startsWith('.'));
    if (files.length > 0) {
      const refFile = path.join(dir, files[0]);
      const r = await identifyReferenceBgm(refFile, path.join(projectDir(projectId), '4_final', 'tmp'));
      referenceBgm = {
        status: r.status,
        title: r.identity?.title,
        artist: r.identity?.artist,
        album: r.identity?.album,
        release_date: r.identity?.release_date,
        genres: r.identity?.genres,
        song_link: r.identity?.song_link,
        spotify_url: r.identity?.spotify_url,
        apple_url: r.identity?.apple_url,
      };
    }
  } catch { /* 무시 */ }

  try {
    const candidates: BgmCandidate[] = await fetchBgmCandidates(audioProfile, 6);
    const payload = { profile: audioProfile, referenceBgm, candidates };
    await writeJson(cachePath, payload);
    return c.json({ ok: true, ...payload, cached: false });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

// ============================================================
// BGM 선택 — 고른 트랙을 다운로드해서 bgm/ 디렉토리에 저장
// 이후 Stage 4 실행 시 uploaded BGM 으로 사용됨.
// body: { projectId, identifier, source_url, title }
// none 모드: { projectId, none: true } → bgm/ 비우고 사용 안 함
// ============================================================
app.post('/api/bgm-pick', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'JSON 파싱 실패' }, 400);
  const projectId = String(body.projectId || '').trim();
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }

  const dir = bgmDir(projectId);
  await ensureDir(dir);
  // bgm/ 비우기 (이전 선택 청소)
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    await fsp.rm(path.join(dir, f), { force: true });
  }

  if (body.none === true) {
    return c.json({ ok: true, mode: 'none' });
  }

  const sourceUrl = String(body.source_url || '').trim();
  const identifier = String(body.identifier || '').trim();
  if (!sourceUrl) return c.json({ error: 'source_url 누락' }, 400);

  const safeName = `archive_${identifier.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}.mp3`;
  const destPath = path.join(dir, safeName);
  try {
    await downloadBgmTrack(sourceUrl, destPath);
    return c.json({ ok: true, mode: 'picked', filename: safeName, title: body.title || null });
  } catch (e: any) {
    return c.json({ error: '다운로드 실패: ' + (e?.message || String(e)) }, 502);
  }
});

app.post('/api/tts-config', async (c) => {
  const { projectId, tts } = await c.req.json().catch(() => ({}));
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }
  await writeTtsConfig(projectId, { ...DEFAULT_TTS_CONFIG, ...(tts || {}) });
  return c.json({ ok: true });
});

// ---- 오디오 밸런스 설정 (원본 음량) ----
app.post('/api/audio-config', async (c) => {
  const { projectId, audio } = await c.req.json().catch(() => ({}));
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }
  await writeAudioConfig(projectId, { ...DEFAULT_AUDIO_CONFIG, ...(audio || {}) });
  return c.json({ ok: true });
});

// ---- 레퍼런스 분석 결과 (edit-spec.json) — 디버그/표시용 ----
// 전체 spec 을 그대로 반환. 없으면 spec:null.
app.get('/api/edit-spec', async (c) => {
  const projectId = c.req.query('projectId') || '';
  if (!projectId) return c.json({ error: 'projectId 누락' }, 400);
  try { await fsp.access(projectDir(projectId)); } catch { return c.json({ error: 'project 가 존재하지 않습니다' }, 404); }
  const spec = await readJson<any>(ARTIFACTS.editSpec(projectId));
  return c.json({ ok: true, spec: spec ?? null });
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
