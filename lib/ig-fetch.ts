// ============================================================
// ig-fetch (FastAPI 서버, 기본 :8000) HTTP 클라이언트.
//
// 사용자가 IG URL 을 주면:
//   1) POST /posts/fetch
//   2) storage_pending=true 면 GET /posts/{shortcode}/storage-status 폴링
//   3) completed 된 media_items[].stored_url 들을 다운로드해 로컬 파일로 저장
//
// 결과적으로 reference/sources 디렉토리에 .mp4/.jpg 들이 떨어지면
// 기존 업로드와 동일한 흐름으로 Stage 0/1 이 동작한다.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { config } from './config';
import { ensureDir } from './paths';

type StorageStatus = 'skipped' | 'pending' | 'completed' | 'failed';
type OverallStorageStatus = StorageStatus | 'partial';

interface MediaItem {
  order_index: number;
  media_type: 'image' | 'video';
  source_url: string;
  proxy_url: string | null;
  stored_url: string | null;
  storage_status: StorageStatus;
  storage_error: string | null;
}

interface FetchPostResponse {
  id: number;
  ig_shortcode: string;
  content_type: 'post' | 'reel' | 'story';
  from_cache: boolean;
  storage_pending: boolean;
  storage_overall: OverallStorageStatus;
  media_items: MediaItem[];
}

interface StorageStatusResponse {
  shortcode: string;
  overall: OverallStorageStatus;
  total: number;
  counts: Record<string, number>;
  items: {
    order_index: number;
    media_type: 'image' | 'video';
    status: StorageStatus;
    stored_url: string | null;
    error: string | null;
  }[];
}

export interface ImportedMedia {
  shortcode: string;
  /** 디스크에 저장된 절대 경로들 (캐러셀이면 여러 개) */
  files: string[];
  /** 다운로드된 항목들의 미디어 타입 */
  media_types: ('image' | 'video')[];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function joinUrl(base: string, p: string): string {
  return base.replace(/\/+$/, '') + (p.startsWith('/') ? p : '/' + p);
}

/**
 * stored_url 이 상대 경로(/static/...)면 ig-fetch base 와 합친다.
 * 절대 URL 이면 그대로.
 */
function resolveStoredUrl(stored: string): string {
  if (/^https?:\/\//i.test(stored)) return stored;
  return joinUrl(config.IG_FETCH_BASE, stored);
}

async function postFetch(url: string): Promise<FetchPostResponse> {
  const res = await fetch(joinUrl(config.IG_FETCH_BASE, '/posts/fetch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ig-fetch POST /posts/fetch ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as FetchPostResponse;
}

async function getStorageStatus(shortcode: string): Promise<StorageStatusResponse> {
  const res = await fetch(
    joinUrl(config.IG_FETCH_BASE, `/posts/${encodeURIComponent(shortcode)}/storage-status`),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ig-fetch GET storage-status ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as StorageStatusResponse;
}

async function getPost(shortcode: string): Promise<FetchPostResponse> {
  const res = await fetch(
    joinUrl(config.IG_FETCH_BASE, `/posts/${encodeURIComponent(shortcode)}`),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ig-fetch GET /posts/${shortcode} ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as FetchPostResponse;
}

/**
 * pending 미디어가 완료될 때까지 폴링.
 * 너무 오래 걸리면 에러. partial 은 받아들임 (일부라도 받은 걸 쓴다).
 */
async function waitForCompletion(shortcode: string): Promise<FetchPostResponse> {
  const deadline = Date.now() + config.IG_FETCH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = await getStorageStatus(shortcode);
    if (s.overall === 'completed' || s.overall === 'partial' || s.overall === 'failed' || s.overall === 'skipped') {
      // 최신 stored_url 정보를 위해 다시 가져옴
      return await getPost(shortcode);
    }
    await sleep(config.IG_FETCH_POLL_INTERVAL_MS);
  }
  throw new Error(`ig-fetch 폴링 timeout (${config.IG_FETCH_POLL_TIMEOUT_MS}ms): ${shortcode}`);
}

function pickExt(mediaType: 'image' | 'video', sourceUrl: string): string {
  // source_url 에서 확장자를 추출 시도. 실패하면 타입 기본값.
  try {
    const u = new URL(sourceUrl);
    const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (m) {
      const ext = m[1].toLowerCase();
      if (['mp4', 'mov', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
        return ext;
      }
    }
  } catch {}
  return mediaType === 'video' ? 'mp4' : 'jpg';
}

async function downloadTo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`다운로드 실패 ${res.status} ${res.statusText}: ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await ensureDir(path.dirname(destPath));
  await fs.writeFile(destPath, buf);
}

/**
 * 한 IG URL → ig-fetch 호출 → 완료까지 대기 → 모든 미디어를 destDir 에 저장.
 *
 * @param igUrl   인스타 포스트/릴스 URL
 * @param destDir 다운로드 받을 디렉토리 (예: data/projects/{pid}/sources)
 * @param opts.namePrefix 저장 파일명 prefix (기본: shortcode)
 * @param opts.onlyVideo  영상만 받음 (레퍼런스에서 사진 캐러셀 제외)
 */
export async function importInstagramUrl(
  igUrl: string,
  destDir: string,
  opts: { namePrefix?: string; onlyVideo?: boolean } = {},
): Promise<ImportedMedia> {
  // 1) fetch 요청
  const initial = await postFetch(igUrl);

  // 2) pending 이면 폴링
  let post = initial;
  if (initial.storage_pending) {
    post = await waitForCompletion(initial.ig_shortcode);
  }

  // 3) completed 된 항목만 다운로드
  const items = post.media_items
    .filter(m => m.storage_status === 'completed' && m.stored_url)
    .filter(m => (opts.onlyVideo ? m.media_type === 'video' : true));

  if (items.length === 0) {
    const reasons = post.media_items
      .map(m => `[${m.order_index}] ${m.media_type} ${m.storage_status}${m.storage_error ? ` (${m.storage_error})` : ''}`)
      .join(', ');
    throw new Error(`ig-fetch: ${post.ig_shortcode} 에서 받을 수 있는 미디어가 없음. items: ${reasons || '(없음)'}`);
  }

  const prefix = opts.namePrefix ?? post.ig_shortcode;
  const files: string[] = [];
  const types: ('image' | 'video')[] = [];

  for (const m of items) {
    const ext = pickExt(m.media_type, m.source_url);
    const suffix = items.length > 1 ? `_${m.order_index}` : '';
    const destPath = path.join(destDir, `${prefix}${suffix}.${ext}`);
    await downloadTo(resolveStoredUrl(m.stored_url!), destPath);
    files.push(destPath);
    types.push(m.media_type);
  }

  return { shortcode: post.ig_shortcode, files, media_types: types };
}

/**
 * ig-fetch 서버가 띄워져 있는지 빠른 헬스체크. 띄우지 않았으면 즉시 분명한 에러.
 */
export async function ensureIgFetchAlive(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(joinUrl(config.IG_FETCH_BASE, '/health'), {
      // 짧은 타임아웃
      signal: AbortSignal.timeout(3000),
    });
  } catch (e: any) {
    throw new Error(
      `ig-fetch 서버에 연결할 수 없습니다 (${config.IG_FETCH_BASE}). ` +
      `별도 터미널에서 띄워주세요: cd ig-fetch && uvicorn app.main:app --port 8000. ` +
      `원인: ${e.message || e}`,
    );
  }
  if (!res.ok) {
    throw new Error(`ig-fetch /health ${res.status}: ${res.statusText}`);
  }
}
