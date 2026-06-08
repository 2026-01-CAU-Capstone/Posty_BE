// ============================================================
// 유료/유명 BGM 추천 (Stage 4 / BGM 선택 화면)
// ----------------------------------------------------------------
// Internet Archive(무료) 와 별개로, 영상 분위기에 어울리는 "유명/대중적인 곡"을
// Gemini 로 추천한다. 저작권상 결과물에 임베드하지 않으며(정보/가이드 용도),
// Spotify / YouTube 검색 링크만 제공해 사용자가 직접 듣고 판단하게 한다.
//
// 레퍼런스 원곡(AudD 식별)이 있으면 그 장르/발매시대를 앵커로 넣어
// "같은 결·같은 시대"의 곡이 나오도록 유도한다.
// ============================================================

import { config } from './config';
import { callGeminiTextOnly } from './gemini';
import { buildFamousBgmPrompt } from './prompts';
import type { BgmProfile } from './archive';
import type { BgmIdentity } from './bgm-identify';

export type FamousTrack = {
  title: string;
  artist: string;
  year?: string;
  genre?: string;
  reason?: string;          // 왜 이 영상에 어울리는지 (한 줄)
  spotify_url: string;      // 검색 링크 (직접 재생/임베드 아님)
  youtube_url: string;      // 검색 링크
  // ── iTunes 검증으로 보강 (실존 곡일 때만) ──
  apple_url?: string;       // Apple Music/iTunes 곡 페이지
  preview_url?: string;     // 30초 미리듣기 (m4a) — UI 에서 바로 들어볼 수 있음
  artwork?: string;         // 앨범 아트 썸네일
  verified?: boolean;       // iTunes 에서 실존 확인됨 (환각 아님)
};

function searchLinks(title: string, artist: string): { spotify_url: string; youtube_url: string } {
  const q = `${artist} ${title}`.trim();
  return {
    spotify_url: `https://open.spotify.com/search/${encodeURIComponent(q)}`,
    youtube_url: `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' audio')}`,
  };
}

// 추천 결과 정규화 — 제목/아티스트 없으면 버리고, 검색 링크를 우리가 직접 구성.
function normalizeTracks(arr: any[], max: number): FamousTrack[] {
  const out: FamousTrack[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(arr) ? arr : []) {
    const title = String(t?.title || '').trim();
    const artist = String(t?.artist || '').trim();
    if (!title || !artist) continue;
    const key = `${title}|${artist}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      artist,
      year: t?.year ? String(t.year).trim() : undefined,
      genre: t?.genre ? String(t.genre).trim() : undefined,
      reason: t?.reason ? String(t.reason).trim() : undefined,
      ...searchLinks(title, artist),
    });
    if (out.length >= max) break;
  }
  return out;
}

// ============================================================
// iTunes Search (키 불필요) 로 추천 곡을 실존 검증 + 메타데이터/미리듣기 보강.
// 못 찾으면 null → 환각 가능성 (search 링크만 남김).
// ============================================================
type ItunesMatch = {
  title: string; artist: string; year?: string; genre?: string;
  apple_url?: string; preview_url?: string; artwork?: string;
};

function normName(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
}

async function itunesLookup(title: string, artist: string): Promise<ItunesMatch | null> {
  const term = `${artist} ${title}`.trim();
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&media=music&limit=5`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'posty-prototype/0.2' } });
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const results: any[] = Array.isArray(json?.results) ? json.results : [];
    if (results.length === 0) return null;

    // title + artist 정규화 비교로 가장 잘 맞는 결과 선택. 충분히 안 맞으면 미검증.
    const wantT = normName(title), wantA = normName(artist);
    let best: any = null, bestScore = 0;
    for (const r of results) {
      const t = normName(r.trackName || ''), a = normName(r.artistName || '');
      let s = 0;
      if (t && (t.includes(wantT) || wantT.includes(t))) s += 2;
      if (a && (a.includes(wantA) || wantA.includes(a))) s += 2;
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (!best || bestScore < 2) return null;
    return {
      title: String(best.trackName || title),
      artist: String(best.artistName || artist),
      year: best.releaseDate ? String(best.releaseDate).slice(0, 4) : undefined,
      genre: best.primaryGenreName ? String(best.primaryGenreName) : undefined,
      apple_url: best.trackViewUrl ? String(best.trackViewUrl) : undefined,
      preview_url: best.previewUrl ? String(best.previewUrl) : undefined,
      artwork: best.artworkUrl100 ? String(best.artworkUrl100) : undefined,
    };
  } catch {
    return null;
  }
}

export async function suggestFamousTracks(
  profile: BgmProfile,
  referenceIdentity?: BgmIdentity,
  count = 3,
): Promise<FamousTrack[]> {
  if (!config.GEMINI_API_KEY) return [];
  // 검증 후 일부가 탈락해도 count 를 채우도록 여유분(+2)을 추천받는다.
  const prompt = buildFamousBgmPrompt(profile, referenceIdentity, count + 2);
  let base: FamousTrack[];
  try {
    // 구글 검색 그라운딩 — 응답 전 웹 검색으로 "지금" 릴스/숏폼 트렌드를 반영(학습 컷오프 한계 보완).
    // 그라운딩은 JSON 강제 모드와 동시 사용 불가 → 텍스트에서 JSON 을 느슨 파싱한다.
    const r = await callGeminiTextOnly(prompt, {
      temperature: 0.8,
      maxOutputTokens: 4096,
      groundWithSearch: true,
    });
    base = normalizeTracks(r?.parsed?.tracks, count + 2);
  } catch {
    return [];
  }
  if (base.length === 0) return [];

  // iTunes 로 실존 검증 + 메타데이터/미리듣기 보강 (병렬). 키 불필요.
  const enriched = await Promise.all(base.map(async (t): Promise<FamousTrack> => {
    const m = await itunesLookup(t.title, t.artist);
    if (!m) return { ...t, verified: false };
    return {
      ...t,
      title: m.title,
      artist: m.artist,
      year: m.year || t.year,
      genre: m.genre || t.genre,
      apple_url: m.apple_url,
      preview_url: m.preview_url,
      artwork: m.artwork,
      ...searchLinks(m.title, m.artist),   // 정확한 이름으로 검색 링크 재구성
      verified: true,
    };
  }));

  // 실존 확인된 곡 우선, 부족하면 미검증으로 채워 count 까지.
  const verified = enriched.filter(t => t.verified);
  const unverified = enriched.filter(t => !t.verified);
  return [...verified, ...unverified].slice(0, count);
}
