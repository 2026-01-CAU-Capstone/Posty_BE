// ============================================================
// 긴 소스 축약 (Stage 1) — 후보 컷들을 30~60초 릴스로 큐레이션.
// ----------------------------------------------------------------
// 전략 (ⓑ 결정론 + OpenAI 최종선별):
//   1) 결정론 백본 (공짜·안전):
//      - 매우 낮은 quality 컷 제거 (단, 전멸 방지)
//      - 임베딩 코사인 유사 컷 중복 제거 (대표 1개만 유지)
//   2) 남은 후보 dur 합이 maxSec 이하면 그대로 (시간순).
//   3) 넘으면 OpenAI 가 최종 컷·순서 선별 → 코드에서 maxSec 하드캡 강제.
//      OpenAI 실패/이상 응답이면 quality 그리디로 결정론 폴백.
//
// 반환: 원본 후보 배열에 대한 "재생 순서 인덱스 목록".
// ============================================================

import { cosineSim, chatJson } from './openai';
import { buildSourceReductionPrompt } from './prompts';
import { config } from './config';

export type ReduceCandidate = {
  video_id: string;
  start: number;
  end: number;
  quality_score: number;
  shot_type: string;
  scene_description: string;
  spoken_text: string;
  tags: string[];
};

export type ReduceOptions = {
  targetSec: number;   // 목표 길이 (예: 45)
  minSec: number;      // 30
  maxSec: number;      // 60
  maxCutDur: number;   // 컷 1개 최대 길이 (pickWindow 와 동일, 4.5)
  userDirectionBlock?: string;
};

export type ReduceResult = {
  keptOrder: number[];          // 원본 인덱스, 재생 순서
  method: 'dedup_only' | 'openai' | 'deterministic_fallback';
  dedupRemoved: number;         // 중복/저품질로 제거된 개수
  estimatedSec: number;         // 최종 선택분의 예상 길이
};

const DEDUP_COS = 0.92;         // 이 이상 유사하면 같은 장면으로 보고 하나만
const QUALITY_FLOOR = 0.2;      // 이 미만은 후보에서 제외 (전멸 방지 가드 있음)

export async function reduceSourceShots(
  cands: ReduceCandidate[],
  vecs: number[][],
  opts: ReduceOptions,
): Promise<ReduceResult> {
  const useDur = (i: number) => Math.max(0.05, Math.min(cands[i].end - cands[i].start, opts.maxCutDur));

  // ---- 1) 결정론 dedup + 품질 필터 ----
  const byQualityDesc = [...cands.keys()].sort((a, b) => (cands[b].quality_score - cands[a].quality_score));
  const deduped: number[] = [];
  for (const i of byQualityDesc) {
    if (cands[i].quality_score < QUALITY_FLOOR && deduped.length >= 8) continue; // 너무 낮은 건 버림(최소 8개는 확보)
    let dup = false;
    for (const k of deduped) {
      if (vecs[i] && vecs[k] && cosineSim(vecs[i], vecs[k]) >= DEDUP_COS) { dup = true; break; }
    }
    if (!dup) deduped.push(i);
  }
  const dedupRemoved = cands.length - deduped.length;

  const dedupedDur = deduped.reduce((s, i) => s + useDur(i), 0);

  // ---- 2) 이미 짧으면 그대로 (시간순 정렬) ----
  if (dedupedDur <= opts.maxSec) {
    const order = [...deduped].sort((a, b) => a - b);
    return { keptOrder: order, method: 'dedup_only', dedupRemoved, estimatedSec: round1(dedupedDur) };
  }

  // ---- 3) OpenAI 최종 선별 ----
  if (config.OPENAI_API_KEY) {
    try {
      const candidates = deduped.map(i => ({
        id: i,
        video: cands[i].video_id,
        start: cands[i].start,
        duration: useDur(i),
        shot_type: cands[i].shot_type || 'medium',
        scene_description: cands[i].scene_description || '',
        spoken_text: cands[i].spoken_text || '',
        tags: cands[i].tags || [],
        quality: cands[i].quality_score,
      }));
      const prompt = buildSourceReductionPrompt({
        candidates,
        targetSec: opts.targetSec,
        minSec: opts.minSec,
        maxSec: opts.maxSec,
        userDirectionBlock: opts.userDirectionBlock,
      });
      const parsed = await chatJson(prompt, { temperature: 0.3, maxTokens: 2048 });
      const picked = sanitizeSelection(parsed?.selected, new Set(deduped));
      const capped = capToMaxSec(picked, useDur, opts.maxSec);
      // 최소 길이의 60% 는 채워야 유효하다고 본다 (너무 짧게 고르면 폴백)
      const sec = capped.reduce((s, i) => s + useDur(i), 0);
      if (capped.length > 0 && sec >= opts.minSec * 0.6) {
        return { keptOrder: capped, method: 'openai', dedupRemoved, estimatedSec: round1(sec) };
      }
    } catch {
      // 폴백으로 진행
    }
  }

  // ---- 4) 결정론 폴백: quality 그리디로 targetSec 까지 채우고 시간순 정렬 ----
  const greedy: number[] = [];
  let acc = 0;
  for (const i of deduped) { // deduped 는 quality 내림차순
    const d = useDur(i);
    if (acc + d > opts.maxSec) continue;
    greedy.push(i);
    acc += d;
    if (acc >= opts.targetSec) break;
  }
  const order = greedy.sort((a, b) => a - b);
  return { keptOrder: order, method: 'deterministic_fallback', dedupRemoved, estimatedSec: round1(acc) };
}

// OpenAI 가 돌려준 selected 를 유효 id 만 + 중복 제거 + 순서 보존.
function sanitizeSelection(selected: any, valid: Set<number>): number[] {
  if (!Array.isArray(selected)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of selected) {
    const id = Number(raw);
    if (!Number.isInteger(id) || !valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// 누적 길이가 maxSec 를 넘지 않도록 앞에서부터 자른다 (하드캡).
function capToMaxSec(ids: number[], useDur: (i: number) => number, maxSec: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const i of ids) {
    const d = useDur(i);
    if (acc + d > maxSec) break;
    out.push(i);
    acc += d;
  }
  return out;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
