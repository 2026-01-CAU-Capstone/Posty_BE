// ============================================================
// 나레이션 개요 (TTS segments) 저장소.
//
// 현재 흐름 (lib/narration.ts 의 prepareNarrationOutline 이 단일 소스):
//   Stage 4 직전, TtsConfig(source/genMode) 에 따라 segments 를 생성하고
//   approved=true 로 바로 기록한다 — 옵션 선택이 곧 승인이라 별도 confirm
//   단계(POST/PATCH/UI)나 Gemini 자동 생성 단계는 없다.
//     · source='captions'        → edit-plan 의 화면 자막을 그대로
//     · source='generate' auto    → OpenAI(chatJson) 로 작성
//     · source='generate' manual  → 사용자 대본을 컷에 분배
//   Stage 4 는 이 segments 를 합성·배치한다.
//
// segment 의 [output_start, output_end] 는 최종 영상 타임라인 기준.
// 인접 segment 끼리 시간이 겹치면 안 되며 (narration.ts 가 클램프),
// 한 segment 의 text 길이는 (output_end - output_start) * 5자 이하 권장.
// validateOutline() 은 현재 정보성 표시(ttsOutlineIssues)로만 쓰인다.
// ============================================================

import fs from 'fs/promises';
import { ARTIFACTS, ensureDir, projectDir } from './paths';

export type NarrationSegment = {
  cut_index: number;      // edit-plan items 의 인덱스. -1 이면 cut 무관(예: intro/outro).
  output_start: number;   // 영상 타임라인 기준 시작(초)
  output_end: number;     // 끝(초)
  text: string;           // 자연 발화 한국어 (혹은 사용자 지정 언어)
};

export type TtsOutline = {
  generated_at: string | null;
  generated_model: string;       // 'captions' | 'manual' | OpenAI 모델명 | 'failed'
  total_duration: number;        // 영상 길이(초)
  segments: NarrationSegment[];
  approved: boolean;
  approved_at: string | null;
  // 합성 시 발생한 자동 보정 기록 (디버깅용)
  last_synthesis: {
    at: string;
    notes: string[];
  } | null;
};

export const DEFAULT_OUTLINE: TtsOutline = {
  generated_at: null,
  generated_model: '',
  total_duration: 0,
  segments: [],
  approved: false,
  approved_at: null,
  last_synthesis: null,
};

export async function readTtsOutline(projectId: string): Promise<TtsOutline> {
  try {
    const t = await fs.readFile(ARTIFACTS.ttsOutline(projectId), 'utf-8');
    return normalize(JSON.parse(t));
  } catch {
    return { ...DEFAULT_OUTLINE };
  }
}

export async function writeTtsOutline(projectId: string, next: Partial<TtsOutline>): Promise<TtsOutline> {
  await ensureDir(projectDir(projectId));
  const current = await readTtsOutline(projectId);
  const merged = normalize({ ...current, ...next });
  await fs.writeFile(ARTIFACTS.ttsOutline(projectId), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

function normalize(raw: any): TtsOutline {
  const segments: NarrationSegment[] = Array.isArray(raw?.segments)
    ? raw.segments.map(normalizeSegment).filter((s: any): s is NarrationSegment => s !== null)
    : [];
  // 시간순 정렬
  segments.sort((a, b) => a.output_start - b.output_start);
  return {
    generated_at: typeof raw?.generated_at === 'string' ? raw.generated_at : null,
    generated_model: String(raw?.generated_model || ''),
    total_duration: Number.isFinite(raw?.total_duration) ? Number(raw.total_duration) : 0,
    segments,
    approved: raw?.approved === true,
    approved_at: typeof raw?.approved_at === 'string' ? raw.approved_at : null,
    last_synthesis: raw?.last_synthesis && typeof raw.last_synthesis === 'object'
      ? {
        at: String(raw.last_synthesis.at || ''),
        notes: Array.isArray(raw.last_synthesis.notes)
          ? raw.last_synthesis.notes.map(String) : [],
      }
      : null,
  };
}

function normalizeSegment(raw: any): NarrationSegment | null {
  const text = String(raw?.text || '').trim();
  if (!text) return null;
  const s = Number(raw?.output_start);
  const e = Number(raw?.output_end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  const ci = Number(raw?.cut_index);
  return {
    cut_index: Number.isFinite(ci) ? ci : -1,
    output_start: round3(s),
    output_end: round3(e),
    text,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ============================================================
// 검증: 인접 segment overlap 여부 + 발화 길이 sanity
// 반환값: 문제가 있으면 메시지 배열, 없으면 빈 배열.
// approved 강제 차단까지는 안 함 (Stage 4 합성 시 atempo 로 보정).
// ============================================================
export function validateOutline(outline: TtsOutline): string[] {
  const issues: string[] = [];
  const seg = outline.segments;

  for (let i = 0; i < seg.length; i++) {
    const cur = seg[i];
    const dur = cur.output_end - cur.output_start;
    const chars = countSpeakingChars(cur.text);
    // 한국어 평균 발화 속도 ≈ 분당 330자 = 초당 5.5자. 1.4배 까지는 atempo 보정 가능.
    if (chars / Math.max(0.1, dur) > 7.7) {
      issues.push(
        `segment #${i} (cut=${cur.cut_index}) 텍스트가 ${dur.toFixed(2)}초에 비해 ${chars}자로 너무 김. ` +
        `합성 시 atempo 로 자동 압축됩니다.`
      );
    }
    if (i + 1 < seg.length) {
      const nxt = seg[i + 1];
      if (cur.output_end > nxt.output_start + 0.02) {
        issues.push(
          `segment #${i}(end=${cur.output_end.toFixed(2)}) 와 #${i + 1}(start=${nxt.output_start.toFixed(2)}) 가 겹칩니다.`
        );
      }
    }
  }
  return issues;
}

// 한국어 음절·영문 단어 모두 고려한 발화 길이 추정
function countSpeakingChars(text: string): number {
  // 공백 제거 후 글자수. 영문 단어 안의 알파벳도 음절로 친다.
  return text.replace(/\s+/g, '').length;
}
