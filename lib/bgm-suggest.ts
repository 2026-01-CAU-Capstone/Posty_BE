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

export async function suggestFamousTracks(
  profile: BgmProfile,
  referenceIdentity?: BgmIdentity,
  count = 3,
): Promise<FamousTrack[]> {
  if (!config.GEMINI_API_KEY) return [];
  const prompt = buildFamousBgmPrompt(profile, referenceIdentity, count);
  try {
    // 구글 검색 그라운딩 — 응답 전 웹 검색으로 "지금" 릴스/숏폼 트렌드를 반영(학습 컷오프 한계 보완).
    // 그라운딩은 JSON 강제 모드와 동시 사용 불가 → 텍스트에서 JSON 을 느슨 파싱한다.
    // 추천은 다양성이 있어야 하므로 temperature 를 약간 높게.
    const r = await callGeminiTextOnly(prompt, {
      temperature: 0.8,
      maxOutputTokens: 4096,
      groundWithSearch: true,
    });
    const tracks = r?.parsed?.tracks;
    return normalizeTracks(tracks, count);
  } catch {
    return [];
  }
}
