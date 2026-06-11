// ============================================================
// 사용자 스타일 브리프 (구조화된 영상 톤·내용 답변)
// - 단순 styleNote 텍스트보다 정밀.
// - 자막 플래닝 프롬프트에 강하게 주입되어 출력 톤/내용을 결정.
// - 프로젝트별 JSON 파일로 저장.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { ARTIFACTS, ensureDir, projectDir } from './paths';

export type StyleBrief = {
  category: string;             // food | travel | fashion | fitness | study | product | daily | other
  category_other: string;       // category=other 일 때 직접 입력
  purpose: string;              // info | review | daily | promo | emotional | other
  tone: string;                 // calm | energetic | serious | humorous | poetic | formal
  formality: string;            // casual | formal | mixed
  caption_mode: string;         // none | per_scene | continuous
  caption_density: string;      // every_cut | most_cuts | occasional | minimal | none
  caption_language: string;     // ko | en | mixed
  topic_keywords: string[];     // 자유 입력 (콤마 구분 → 배열)
  avoid_phrases: string[];      // 자유 입력 — 절대 사용 금지
  must_include_phrases: string[]; // 자유 입력 — 가능하면 사용
  extra_notes: string;          // 자유 메모 (기존 styleNote 역할)
};

export const DEFAULT_BRIEF: StyleBrief = {
  category: '',
  category_other: '',
  purpose: '',
  tone: '',
  formality: '',
  caption_mode: '',
  caption_density: '',
  caption_language: '',
  topic_keywords: [],
  avoid_phrases: [],
  must_include_phrases: [],
  extra_notes: '',
};

export async function readStyleBrief(projectId: string): Promise<StyleBrief> {
  try {
    const t = await fs.readFile(ARTIFACTS.styleBrief(projectId), 'utf-8');
    const parsed = JSON.parse(t);
    return {
      ...DEFAULT_BRIEF,
      ...parsed,
      topic_keywords: Array.isArray(parsed?.topic_keywords) ? parsed.topic_keywords.map(String) : [],
      avoid_phrases: Array.isArray(parsed?.avoid_phrases) ? parsed.avoid_phrases.map(String) : [],
      must_include_phrases: Array.isArray(parsed?.must_include_phrases) ? parsed.must_include_phrases.map(String) : [],
    };
  } catch {
    return { ...DEFAULT_BRIEF };
  }
}

export async function writeStyleBrief(projectId: string, brief: Partial<StyleBrief>): Promise<void> {
  await ensureDir(projectDir(projectId));
  const merged: StyleBrief = { ...DEFAULT_BRIEF, ...brief };
  // 정제: 문자열만, 배열은 trim/empty 제거
  merged.topic_keywords = (brief.topic_keywords ?? []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 30);
  merged.avoid_phrases = (brief.avoid_phrases ?? []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 30);
  merged.must_include_phrases = (brief.must_include_phrases ?? []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 30);
  await fs.writeFile(ARTIFACTS.styleBrief(projectId), JSON.stringify(merged, null, 2), 'utf-8');
}

export function isBriefEmpty(b: StyleBrief): boolean {
  return !b.category && !b.purpose && !b.tone && !b.formality && !b.caption_mode && !b.caption_density && !b.caption_language
    && b.topic_keywords.length === 0
    && b.avoid_phrases.length === 0
    && b.must_include_phrases.length === 0
    && !b.extra_notes.trim();
}

// 자연어 라벨 매핑 — Gemini 가 읽기 좋게
const CATEGORY_LABEL: Record<string, string> = {
  food: '음식', travel: '여행', fashion: '패션', fitness: '운동',
  study: '공부', product: '제품/홍보', daily: '일상', other: '기타',
};
const PURPOSE_LABEL: Record<string, string> = {
  info: '정보 전달', review: '후기/리뷰', daily: '일상 기록',
  promo: '홍보/CTA', emotional: '감성', other: '기타',
};
const TONE_LABEL: Record<string, string> = {
  calm: '차분/잔잔', energetic: '활발/에너지', serious: '진지/정보',
  humorous: '유머/위트', poetic: '감성/시적', formal: '정중/격식',
};
const FORMALITY_LABEL: Record<string, string> = {
  casual: '반말', formal: '존댓말', mixed: '반말·존댓말 혼합',
};
const DENSITY_LABEL: Record<string, string> = {
  every_cut: '거의 모든 컷', most_cuts: '절반 이상의 컷', occasional: '가끔',
  minimal: '강조 컷에만', none: '자막 없이',
};
const CAPTION_MODE_LABEL: Record<string, string> = {
  none: '자막 없음',
  per_scene: '장면마다 다른 자막',
  continuous: '하나의 자막을 영상 끝까지 유지',
};
const LANGUAGE_LABEL: Record<string, string> = {
  ko: '한국어만 사용',
  en: '영어만 사용',
  mixed: '한국어와 영어를 자연스럽게 섞어서 사용',
};

export function briefToPromptBlock(b: StyleBrief): string {
  if (isBriefEmpty(b)) return '';
  const cat = b.category === 'other' ? (b.category_other || '기타') : (CATEGORY_LABEL[b.category] || b.category);

  const lines: string[] = [];
  if (cat) lines.push(`- 영상 카테고리: ${cat}`);
  if (b.purpose) lines.push(`- 영상 목적: ${PURPOSE_LABEL[b.purpose] || b.purpose}`);
  if (b.tone) lines.push(`- 원하는 톤: ${TONE_LABEL[b.tone] || b.tone}`);
  if (b.formality) lines.push(`- 친밀도/격식: ${FORMALITY_LABEL[b.formality] || b.formality}`);
  if (b.caption_mode) lines.push(`- 자막 모드: ${CAPTION_MODE_LABEL[b.caption_mode] || b.caption_mode}`);
  if (b.caption_density) lines.push(`- 자막 빈도 요구: ${DENSITY_LABEL[b.caption_density] || b.caption_density}`);
  if (b.caption_language) lines.push(`- 자막 언어: ${LANGUAGE_LABEL[b.caption_language] || b.caption_language}`);
  if (b.topic_keywords.length > 0) lines.push(`- 다루는 주제 키워드: ${b.topic_keywords.join(', ')}`);
  if (b.avoid_phrases.length > 0) lines.push(`- 피하고 싶은 표현 (절대 사용 금지): ${b.avoid_phrases.join(', ')}`);
  if (b.must_include_phrases.length > 0) lines.push(`- 꼭 들어갔으면 하는 문구: ${b.must_include_phrases.join(', ')}`);
  if (b.extra_notes.trim()) lines.push(`- 추가 메모: ${b.extra_notes.trim()}`);

  if (lines.length === 0) return '';
  return `═══════════════════════════════
[사용자 영상 스타일 브리프 — 최우선으로 반영할 것]
═══════════════════════════════
${lines.join('\n')}

→ 위 답변을 자막 내용·톤·빈도 결정의 최우선 기준으로 삼아라.
   - "피하고 싶은 표현" 에 들어있는 단어/문구는 어떤 형태로도 사용 금지.
   - "꼭 들어갔으면 하는 문구" 는 자연스러운 컷 한두 곳에 그대로 배치.
   - "다루는 주제 키워드" 는 자막 어휘 선택의 핵심 풀로 사용.
   - "자막 언어" 가 있으면 레퍼런스 언어보다 이 선택을 우선한다.
   - 친밀도/격식 답변에 따라 종결 어미·인칭을 결정 (반말이면 반말, 존댓말이면 존댓말).
`;
}
