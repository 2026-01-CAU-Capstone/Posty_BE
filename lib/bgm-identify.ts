// ============================================================
// BGM 지문인식 (Stage 4) — 레퍼런스 영상에 실제 사용된 곡 식별.
// ----------------------------------------------------------------
// 흐름:
//   1) 레퍼런스 MP4 에서 오디오 샘플(mp3, ~20s) 추출.
//   2) AudD.io 에 업로드 → 곡명/아티스트/앨범/발매일/장르/스트리밍 링크 식별.
//   3) 식별된 "장르/시대" 를 royalty-free 검색 힌트로 변환 (archiveHintsFromIdentity).
//
// 주의:
//   - AUDD_API_TOKEN 이 없으면 전체 단계를 건너뛴다 (status='no_token').
//   - 릴스 BGM 은 짧거나/배속/내레이션 혼합이 많아 매칭 실패가 흔하다 (status='no_match').
//   - 식별된 "상용곡" 자체는 저작권상 결과물에 임베드하지 않는다. 정보 + 무료트랙 매칭 가이드 용도.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { config } from './config';
import { probeDuration, runFfmpeg } from './ffmpeg';

export type BgmIdentity = {
  title?: string;
  artist?: string;
  album?: string;
  release_date?: string;
  label?: string;
  genres: string[];           // Apple Music genreNames ("Music" 같은 일반어 제거)
  song_link?: string;         // AudD listen 링크
  spotify_url?: string;
  apple_url?: string;
  timecode?: string;          // 매칭된 구간 (mm:ss)
};

export type BgmIdentifyResult = {
  status: 'no_token' | 'no_match' | 'matched' | 'error';
  identity?: BgmIdentity;
  error?: string;
};

const AUDD_ENDPOINT = 'https://api.audd.io/';

// ============================================================
// 레퍼런스 영상에서 곡 식별
// ============================================================
export async function identifyReferenceBgm(referenceVideoPath: string, tmpDir: string): Promise<BgmIdentifyResult> {
  const token = config.AUDD_API_TOKEN;
  if (!token) return { status: 'no_token' };

  let samplePath = '';
  try {
    samplePath = await extractAudioSample(referenceVideoPath, tmpDir);
    const buf = await fs.readFile(samplePath);

    const fd = new FormData();
    fd.append('api_token', token);
    fd.append('return', 'apple_music,spotify');
    fd.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/mpeg' }), 'sample.mp3');

    const res = await fetch(AUDD_ENDPOINT, { method: 'POST', body: fd });
    if (!res.ok) return { status: 'error', error: `AudD HTTP ${res.status}` };

    const json: any = await res.json().catch(() => null);
    if (!json) return { status: 'error', error: 'AudD 응답 파싱 실패' };
    if (json.status === 'error') {
      return { status: 'error', error: json?.error?.error_message || 'AudD error' };
    }
    if (!json.result) return { status: 'no_match' };

    return { status: 'matched', identity: parseAuddResult(json.result) };
  } catch (e: any) {
    return { status: 'error', error: e?.message || String(e) };
  } finally {
    if (samplePath) await fs.rm(samplePath, { force: true }).catch(() => {});
  }
}

// 레퍼런스의 음악이 또렷한 구간을 노려 ~20s mp3 샘플 추출.
async function extractAudioSample(videoPath: string, tmpDir: string): Promise<string> {
  await fs.mkdir(tmpDir, { recursive: true });
  const out = path.join(tmpDir, 'bgm-sample.mp3');
  const dur = await probeDuration(videoPath).catch(() => 0);
  // 인트로/아웃트로를 살짝 피하고 가운데를 잡되, 너무 짧으면 전체 사용.
  const sampleLen = dur > 0 ? Math.min(20, Math.max(8, dur)) : 20;
  const start = dur > sampleLen ? Math.min(dur * 0.15, dur - sampleLen) : 0;

  await runFfmpeg([
    '-y',
    '-ss', Math.max(0, start).toFixed(2),
    '-i', videoPath,
    '-t', sampleLen.toFixed(2),
    '-vn',
    '-ac', '2',
    '-ar', '44100',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    out,
  ]);
  return out;
}

function parseAuddResult(r: any): BgmIdentity {
  const apple = r?.apple_music || {};
  const spotify = r?.spotify || {};
  const genres: string[] = Array.isArray(apple.genreNames)
    ? apple.genreNames.map((g: any) => String(g)).filter((g: string) => g && !/^music$/i.test(g))
    : [];
  return {
    title: str(r?.title),
    artist: str(r?.artist),
    album: str(r?.album),
    release_date: str(r?.release_date),
    label: str(r?.label),
    genres,
    song_link: str(r?.song_link),
    spotify_url: str(spotify?.external_urls?.spotify),
    apple_url: str(apple?.url),
    timecode: str(r?.timecode),
  };
}

function str(v: any): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s || undefined;
}

// ============================================================
// 식별 결과 → Internet Archive 검색 힌트.
//   - genre 를 royalty-free 풀에서 검색 가능한 용어로 매핑.
//   - 상용 장르(pop/kpop/hiphop 등)는 무료 대체곡이 사실상 없어 "분위기"로 치환.
// ============================================================
export function archiveHintsFromIdentity(identity: BgmIdentity | undefined): { genre?: string; extra_terms: string[] } {
  if (!identity || identity.genres.length === 0) return { extra_terms: [] };

  const mapped: string[] = [];
  for (const raw of identity.genres) {
    const g = raw.toLowerCase();
    mapped.push(...mapGenre(g));
  }
  const uniq = Array.from(new Set(mapped.filter(Boolean)));
  return { genre: uniq[0], extra_terms: uniq.slice(0, 4) };
}

// Apple/Spotify 장르 → Internet Archive(무료 음원) 친화 검색어.
function mapGenre(g: string): string[] {
  if (/lo-?fi/.test(g)) return ['lofi', 'chillhop', 'instrumental'];
  if (/hip.?hop|rap|trap/.test(g)) return ['beats', 'instrumental', 'hip hop'];
  if (/k-?pop|j-?pop|pop|dance|disco/.test(g)) return ['upbeat', 'pop instrumental', 'electronic'];
  if (/electro|edm|house|techno|synth/.test(g)) return ['electronic', 'synthwave', 'ambient electronic'];
  if (/r&b|soul|funk/.test(g)) return ['soul', 'groove', 'instrumental'];
  if (/rock|metal|punk|alternative|indie/.test(g)) return ['rock instrumental', 'guitar', 'energetic'];
  if (/jazz|swing|blues/.test(g)) return ['jazz', 'instrumental'];
  if (/classic|orchestr|piano|score|soundtrack|cinematic/.test(g)) return ['cinematic', 'orchestral', 'piano'];
  if (/ambient|new age|chill|downtempo/.test(g)) return ['ambient', 'chill', 'relaxing'];
  if (/acoustic|folk|country|singer/.test(g)) return ['acoustic', 'guitar', 'folk'];
  if (/reggae|latin|world|afro/.test(g)) return ['world', 'percussion', 'instrumental'];
  // 알 수 없는 장르는 원문 토큰 그대로 (검색 폴백)
  return [g.replace(/[^a-z0-9 ]/g, '').trim()];
}
