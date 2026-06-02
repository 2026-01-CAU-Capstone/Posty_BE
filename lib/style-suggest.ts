// ============================================================
// Style Suggest (Stage 0.5)
// ----------------------------------------------------------------
// Stage 0 (레퍼런스 영상 분석) 가 끝난 뒤, 사용자가 옵션 단계에
// 들어가기 전에 호출.
//
// edit-spec.json 을 요약해서 Gemini Flash 에 보내고 두 가지를 받는다:
//   1) summary — 마스코트가 사용자에게 건넬 친근한 한 줄
//   2) brief   — 편집 옵션 자동 추천 (사용자가 수정 가능)
//
// 결과는 data/projects/{pid}/style-suggest.json 에 저장(캐시).
// 같은 프로젝트에서 재호출 시 force=true 가 아니면 캐시를 그대로 돌려준다.
// ============================================================

import path from 'path';
import fs from 'fs/promises';
import { ARTIFACTS, appendRawResponse, ensureDir, projectDir, readJson, readStyleNote, writeJson } from './paths';
import { chatJson } from './openai';
import { buildStyleSuggestPrompt } from './prompts';
import { config } from './config';

export type SuggestBrief = {
  tone: string;
  purpose: string;
  topic_keywords: string[];
  must_include_phrases: string[];
  caption_language: '' | 'ko' | 'en' | 'mixed';
  caption_density: '' | 'every_cut' | 'most_cuts' | 'occasional' | 'minimal' | 'none';
};

export type StyleSuggest = {
  summary: string;
  brief: SuggestBrief;
  generated_at: string;
  model: string;
};

const FILE_NAME = 'style-suggest.json';

function suggestFile(projectId: string): string {
  return path.join(projectDir(projectId), FILE_NAME);
}

export async function readStyleSuggest(projectId: string): Promise<StyleSuggest | null> {
  return readJson<StyleSuggest>(suggestFile(projectId));
}

export async function clearStyleSuggest(projectId: string): Promise<void> {
  await fs.rm(suggestFile(projectId), { force: true }).catch(() => {});
}

export async function generateStyleSuggest(projectId: string): Promise<StyleSuggest> {
  const spec = await readJson<any>(ARTIFACTS.editSpec(projectId));
  if (!spec) throw new Error('Stage 0 (edit-spec.json) 이 아직 없습니다. 분석이 끝난 뒤 다시 시도하세요.');

  const styleNote = await readStyleNote(projectId);
  const specSummary = summarizeSpecForLlm(spec);
  const prompt = buildStyleSuggestPrompt({ specSummary, styleNote });

  // OpenAI Chat (json_object 모드) 사용 — Gemini thinking 모델의 토큰 잘림 이슈 회피.
  // response_format=json_object 라 파싱 실패가 거의 없음.
  const model = config.OPENAI_CHAT_MODEL;
  let parsed: any = null;
  try {
    parsed = await chatJson(prompt, {
      model,
      temperature: 0.6,
      maxTokens: 1024,
    });
  } catch (e: any) {
    await appendRawResponse(projectId, {
      stage: 0.5, kind: 'style_suggest_failed', model,
      error: e?.message || String(e),
    });
    throw e;
  }

  await appendRawResponse(projectId, {
    stage: 0.5,
    kind: 'style_suggest',
    provider: 'openai',
    model,
    parsed_ok: !!parsed,
    summary_chars: String(parsed?.summary || '').length,
    keywords_count: Array.isArray(parsed?.brief?.topic_keywords) ? parsed.brief.topic_keywords.length : 0,
  });

  const result: StyleSuggest = {
    summary: clampStr(parsed?.summary, 200) || '레퍼런스 분석을 마쳤어요! 어떤 느낌으로 편집할지 골라봐요.',
    brief: normalizeBrief(parsed?.brief),
    generated_at: new Date().toISOString(),
    model,
  };

  await ensureDir(projectDir(projectId));
  await writeJson(suggestFile(projectId), result);
  return result;
}

// ------------------------------------------------------------
// spec → LLM 입력용 짧은 요약 (전체 spec 던지면 토큰 낭비)
// ------------------------------------------------------------
function summarizeSpecForLlm(spec: any): string {
  const lines: string[] = [];
  if (spec.duration) lines.push(`길이: ${Number(spec.duration).toFixed(1)}초`);
  if (spec.aspect_ratio) lines.push(`비율: ${spec.aspect_ratio}`);
  if (spec.pacing) lines.push(`페이싱: ${spec.pacing}`);
  if (spec.color_style) lines.push(`색감: ${safeStringify(spec.color_style)}`);
  if (spec.audio_profile) lines.push(`오디오 프로파일: ${safeStringify(spec.audio_profile)}`);
  if (spec.caption_global_style) lines.push(`자막 글로벌 스타일: ${safeStringify(spec.caption_global_style)}`);
  if (spec.caption_pattern) lines.push(`자막 패턴: ${safeStringify(spec.caption_pattern, 600)}`);

  const shots: any[] = Array.isArray(spec.shots) ? spec.shots.slice(0, 12) : [];
  if (shots.length > 0) {
    lines.push('컷 (최대 12개):');
    shots.forEach((s, i) => {
      const parts: string[] = [];
      parts.push(`#${i}`);
      if (s.shot_type) parts.push(`[${s.shot_type}]`);
      if (s.subject) parts.push(`주체:${s.subject}`);
      if (s.scene_description) parts.push(s.scene_description);
      lines.push(`  ${parts.join(' ')}`);
      const layers: any[] = Array.isArray(s.caption_layers) ? s.caption_layers : [];
      const captionTexts = layers.map(l => String(l?.text || '').trim()).filter(Boolean);
      if (captionTexts.length > 0) {
        lines.push(`    자막: ${captionTexts.map(t => `"${t}"`).join(', ')}`);
      }
    });
  }
  return lines.join('\n').slice(0, 4000);
}

function safeStringify(v: any, max = 300): string {
  try {
    const s = JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch {
    return String(v).slice(0, max);
  }
}

// ------------------------------------------------------------
// LLM 결과 정규화 — enum 값 검증, 배열 길이 제한, 문자열 trim
// ------------------------------------------------------------
function normalizeBrief(raw: any): SuggestBrief {
  return {
    tone: clampStr(raw?.tone, 40),
    purpose: clampStr(raw?.purpose, 60),
    topic_keywords: toStrArray(raw?.topic_keywords, 12, 24),
    must_include_phrases: toStrArray(raw?.must_include_phrases, 6, 60),
    caption_language: normEnum(raw?.caption_language, ['ko', 'en', 'mixed']),
    caption_density: normEnum(raw?.caption_density, ['every_cut', 'most_cuts', 'occasional', 'minimal', 'none']),
  };
}

function clampStr(v: any, max: number): string {
  const s = String(v ?? '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function toStrArray(v: any, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const it of v) {
    const s = clampStr(it, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normEnum<T extends string>(v: any, allowed: T[]): '' | T {
  const s = String(v ?? '').toLowerCase().trim();
  return (allowed as string[]).includes(s) ? (s as T) : '';
}
