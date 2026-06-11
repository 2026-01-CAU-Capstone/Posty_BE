// ============================================================
// Internet Archive Audio 검색 + 다운로드 (Stage 4 자동 BGM)
// - API 키 불필요
// - advancedsearch.php 로 검색
// - metadata 엔드포인트로 파일 목록 조회
// - download 엔드포인트로 mp3 다운로드
// - audio_profile (mood + genre + tempo + energy + instruments) 으로 멀티팩싯 검색
// - audio_profile 과 제목/파일 특성을 점수화해서 가장 어울리는 트랙 선택
// ============================================================

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

type ArchiveItem = {
  identifier: string;
  title?: string;
  downloads?: number;
};

type ArchiveFile = {
  name: string;
  format: string;
  size?: string;
  length?: string;
};

const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const META_URL = 'https://archive.org/metadata';
const DL_URL = 'https://archive.org/download';

// ============================================================
// 외부에서 받을 audio_profile 모양
// ============================================================
export type BgmProfile = {
  bgm_mood?: string;
  bgm_genre?: string;
  bgm_tempo?: string;
  bgm_energy?: string;
  bgm_instruments?: string[];
  // 지문인식(BGM identify)으로 식별된 곡의 장르를 royalty-free 검색어로 매핑한 힌트.
  // 있으면 가장 우선순위 높은 검색/스코어링에 반영한다.
  extra_terms?: string[];
};

// ============================================================
// 검색어 생성: 구체적인 것부터 일반적인 것까지 단계적 폴백
// ============================================================
function buildQueriesFromProfile(p: BgmProfile): string[] {
  const base = 'mediatype:(audio) AND format:(MP3)';
  const mood = norm(p.bgm_mood);
  const genre = norm(p.bgm_genre);
  const tempo = norm(p.bgm_tempo);
  const energy = norm(p.bgm_energy);
  const insts = Array.isArray(p.bgm_instruments)
    ? p.bgm_instruments.map(norm).filter(Boolean)
    : [];

  const moodSet = moodSynonyms(mood);
  const extras = Array.isArray(p.extra_terms) ? p.extra_terms.map(norm).filter(Boolean) : [];
  const queries: string[] = [];

  // 0) 식별된 곡 장르 힌트 (extra_terms) — 가장 구체적. instrumental 로 한정해 무료음원 적중률↑.
  for (const t of extras.slice(0, 3)) {
    queries.push(`(${base}) AND (subject:(${t} instrumental) OR title:(${t}) OR subject:(${t} ${moodSet[0] || ''}))`);
  }
  if (extras[0] && genre) {
    queries.push(`(${base}) AND (subject:(${genre} ${extras[0]}) OR title:(${genre} ${extras[0]}))`);
  }

  // 1) genre + mood (가장 구체적)
  for (const m of moodSet.slice(0, 2)) {
    if (genre) queries.push(`(${base}) AND (subject:(${genre} ${m}) OR title:(${genre} ${m}))`);
  }
  // 2) genre + instrument
  if (genre && insts[0]) {
    queries.push(`(${base}) AND (subject:(${genre} ${insts[0]}) OR title:(${genre} ${insts[0]}))`);
  }
  // 3) genre 단독
  if (genre) {
    queries.push(`(${base}) AND (subject:(${genre} instrumental) OR title:(${genre} instrumental))`);
  }
  // 4) instrument + mood
  for (const m of moodSet.slice(0, 2)) {
    if (insts[0]) queries.push(`(${base}) AND (subject:(${insts[0]} ${m}))`);
  }
  // 5) mood 단독
  for (const m of moodSet) {
    queries.push(`(${base}) AND (subject:(${m} instrumental) OR title:(${m} instrumental))`);
  }
  // 6) instrument 단독
  if (insts[0]) {
    queries.push(`(${base}) AND (subject:(${insts[0]} instrumental) OR title:(${insts[0]}))`);
  }
  // 7) energy / tempo 단독
  if (energy && energy !== 'moderate') queries.push(`(${base}) AND subject:(${energy} instrumental)`);
  if (tempo && tempo !== 'medium') queries.push(`(${base}) AND subject:(${tempo} instrumental)`);
  // 8) 최후 폴백
  queries.push(`${base} AND subject:(instrumental)`);
  queries.push(base);

  // 중복 제거
  return Array.from(new Set(queries));
}

function moodSynonyms(m: string): string[] {
  if (!m) return ['instrumental'];
  const map: Record<string, string[]> = {
    upbeat: ['upbeat', 'happy', 'energetic', 'cheerful'],
    happy: ['happy', 'upbeat', 'cheerful'],
    chill: ['chill', 'relaxing', 'ambient', 'lofi'],
    calm: ['calm', 'peaceful', 'serene', 'ambient'],
    relaxing: ['relaxing', 'calm', 'ambient'],
    dramatic: ['dramatic', 'cinematic', 'epic'],
    epic: ['epic', 'cinematic', 'orchestral'],
    romantic: ['romantic', 'love', 'tender', 'soft'],
    sad: ['sad', 'melancholy', 'sorrowful'],
    energetic: ['energetic', 'upbeat', 'powerful'],
    melancholy: ['melancholy', 'sad', 'somber'],
    mysterious: ['mysterious', 'dark', 'suspense'],
  };
  return map[m] ?? [m];
}

function norm(s?: string): string {
  return String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9_ ]/g, '');
}

// ============================================================
// 검색 호출
// ============================================================
async function searchAudio(query: string, rows = 30): Promise<ArchiveItem[]> {
  const url =
    `${SEARCH_URL}?q=${encodeURIComponent(query)}` +
    `&fl[]=identifier&fl[]=title&fl[]=downloads` +
    `&sort[]=downloads+desc` +
    `&rows=${rows}&page=1&output=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'posty-prototype/0.2' } });
  if (!res.ok) throw new Error(`Archive search ${res.status}`);
  const json: any = await res.json();
  const docs: any[] = json?.response?.docs ?? [];
  return docs.map(d => ({
    identifier: String(d.identifier),
    title: d.title ? String(d.title) : undefined,
    downloads: typeof d.downloads === 'number' ? d.downloads : Number(d.downloads) || 0,
  }));
}

// ============================================================
// item 안에서 적합한 mp3 파일 하나 고르기
// ============================================================
async function pickMp3File(identifier: string, profile: BgmProfile, minSec = 45, maxSec = 420): Promise<ArchiveFile | null> {
  const res = await fetch(`${META_URL}/${encodeURIComponent(identifier)}`, {
    headers: { 'User-Agent': 'posty-prototype/0.2' },
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const files: ArchiveFile[] = json?.files ?? [];
  const candidates = files.filter(f => /mp3/i.test(f.format || ''));
  const scored = candidates
    .map(f => {
      const sec = parseLengthToSec(f.length);
      const size = parseInt(f.size || '0', 10);
      return { f, sec, size, score: scoreArchiveFile(f, sec, size, profile) };
    })
    .filter(x => isFinite(x.sec) && x.sec >= minSec && x.sec <= maxSec)
    .filter(x => x.size > 0 && x.size <= 50 * 1024 * 1024)
    .filter(x => x.score > -20);
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || b.size - a.size);
  return scored[0].f;
}

function parseLengthToSec(len?: string): number {
  if (!len) return 0;
  if (/^\d+(\.\d+)?$/.test(len)) return parseFloat(len);
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(len);
  if (!m) return 0;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  const c = m[3] ? parseInt(m[3], 10) : null;
  if (c !== null) return a * 3600 + b * 60 + c;
  return a * 60 + b;
}

// ============================================================
// 다운로드
// ============================================================
async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'posty-prototype/0.2' } });
  if (!res.ok || !res.body) throw new Error(`Archive download ${res.status} ${url}`);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  // @ts-ignore — Node 18+ fetch body 는 ReadableStream
  const nodeStream = Readable.fromWeb(res.body as any);
  await pipeline(nodeStream, createWriteStream(destPath));
}

function scoreArchiveItem(item: ArchiveItem, profile: BgmProfile): number {
  const title = norm(`${item.title || ''} ${item.identifier}`);
  let score = Math.log10(Math.max(1, item.downloads || 0)) * 2;
  for (const term of profileTerms(profile)) {
    if (term && title.includes(term)) score += 6;
  }
  score += moodSynonyms(norm(profile.bgm_mood)).some(m => title.includes(m)) ? 4 : 0;
  score -= unsuitableTitlePenalty(title);
  return score;
}

function scoreArchiveFile(file: ArchiveFile, sec: number, size: number, profile: BgmProfile): number {
  const name = norm(file.name);
  let score = 0;
  for (const term of profileTerms(profile)) {
    if (term && name.includes(term)) score += 4;
  }

  // 숏폼 BGM 은 너무 짧거나 긴 원본보다 1~4분대 트랙이 다루기 쉽다.
  if (sec >= 75 && sec <= 240) score += 8;
  else if (sec >= 45 && sec <= 300) score += 4;
  else score -= 4;

  // 너무 작은 mp3 는 저음질/프리뷰일 가능성이 높다.
  if (size >= 2 * 1024 * 1024) score += 3;
  if (size < 512 * 1024) score -= 8;

  score -= unsuitableTitlePenalty(name);
  return score;
}

function profileTerms(p: BgmProfile): string[] {
  const insts = Array.isArray(p.bgm_instruments)
    ? p.bgm_instruments.map(norm).filter(Boolean)
    : [];
  const extras = Array.isArray(p.extra_terms) ? p.extra_terms.map(norm).filter(Boolean) : [];
  return [
    ...extras,
    norm(p.bgm_genre),
    norm(p.bgm_energy),
    norm(p.bgm_tempo),
    ...moodSynonyms(norm(p.bgm_mood)),
    ...insts,
    'instrumental',
  ].filter(Boolean);
}

function unsuitableTitlePenalty(text: string): number {
  const badTerms = [
    '78rpm', '78 rpm', 'cylinder', 'gramophone', 'phonograph',
    'old time', 'old-time', 'vintage', 'archive recording',
    'lecture', 'speech', 'sermon', 'audiobook', 'podcast',
    'interview', 'radio show', 'news', 'live audience',
  ];
  let penalty = 0;
  for (const term of badTerms) {
    if (text.includes(term)) penalty += 12;
  }
  return penalty;
}

// ============================================================
// 공용 API
// ============================================================
export type FetchedBgm = {
  identifier: string;
  title?: string;
  source_url: string;
  path: string;
  query_used: string;
  candidate_pool_size: number;
};

// ============================================================
// 후보 목록 (다운로드 없이) — UI 의 BGM 선택 화면용.
// 사용자가 들어보고 고를 수 있도록 mp3 url 도 같이 넘긴다.
// ============================================================
export type BgmCandidate = {
  identifier: string;
  title?: string;
  source_url: string;       // mp3 직접 url (Archive 는 CORS 헤더 줌)
  duration_sec: number;
  size_bytes: number;
  query_used: string;
};

export async function fetchBgmCandidates(
  profile: BgmProfile,
  maxCandidates = 6,
): Promise<BgmCandidate[]> {
  const queries = buildQueriesFromProfile(profile);
  const out: BgmCandidate[] = [];
  const seen = new Set<string>();

  for (const q of queries) {
    if (out.length >= maxCandidates) break;
    let items: ArchiveItem[] = [];
    try { items = await searchAudio(q, 20); } catch { continue; }
    if (items.length === 0) continue;

    const ranked = items
      .map(item => ({ item, score: scoreArchiveItem(item, profile) }))
      .sort((a, b) => b.score - a.score || (b.item.downloads || 0) - (a.item.downloads || 0))
      .map(x => x.item);

    for (const item of ranked) {
      if (out.length >= maxCandidates) break;
      if (seen.has(item.identifier)) continue;
      let file: ArchiveFile | null = null;
      try { file = await pickMp3File(item.identifier, profile); } catch { /* next */ }
      if (!file) continue;
      const url = `${DL_URL}/${encodeURIComponent(item.identifier)}/${encodeURIComponent(file.name)}`;
      out.push({
        identifier: item.identifier,
        title: item.title,
        source_url: url,
        duration_sec: parseLengthToSec(file.length),
        size_bytes: parseInt(file.size || '0', 10) || 0,
        query_used: q,
      });
      seen.add(item.identifier);
    }
  }
  return out;
}

export async function downloadBgmTrack(sourceUrl: string, destPath: string): Promise<void> {
  await downloadFile(sourceUrl, destPath);
}

export async function fetchBgmFromArchive(
  profile: BgmProfile | string,    // 후방 호환을 위해 mood 문자열도 받음
  saveDir: string,
): Promise<FetchedBgm> {
  await fs.mkdir(saveDir, { recursive: true });
  const p: BgmProfile = typeof profile === 'string' ? { bgm_mood: profile } : (profile || {});
  const queries = buildQueriesFromProfile(p);

  for (const q of queries) {
    let items: ArchiveItem[] = [];
    try { items = await searchAudio(q, 30); } catch { continue; }
    if (items.length === 0) continue;

    const topN = items
      .slice(0, Math.min(30, items.length))
      .map(item => ({ item, score: scoreArchiveItem(item, p) }))
      .sort((a, b) => b.score - a.score || (b.item.downloads || 0) - (a.item.downloads || 0))
      .map(x => x.item);

    for (const item of topN) {
      let file: ArchiveFile | null = null;
      try { file = await pickMp3File(item.identifier, p); } catch { /* next */ }
      if (!file) continue;

      const url = `${DL_URL}/${encodeURIComponent(item.identifier)}/${encodeURIComponent(file.name)}`;
      const safeName = `archive_${item.identifier.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}.mp3`;
      const destPath = path.join(saveDir, safeName);

      try {
        await downloadFile(url, destPath);
        return {
          identifier: item.identifier,
          title: item.title,
          source_url: url,
          path: destPath,
          query_used: q,
          candidate_pool_size: topN.length,
        };
      } catch {
        continue;
      }
    }
  }
  throw new Error(`Internet Archive 에서 BGM 을 찾지 못했습니다 (profile=${JSON.stringify(p)})`);
}
