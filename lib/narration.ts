// ============================================================
// 나레이션 개요 준비 (Stage 4 직전).
//
// TtsConfig 의 source / genMode 에 따라 나레이션 segments 를 만든다:
//   source='captions'              → 화면 자막(planned_caption_layers)을 그대로 segment 로.
//   source='generate' genMode='auto'   → LLM 이 컷 구성을 보고 나레이션 작성.
//   source='generate' genMode='manual' → 사용자가 쓴 script 를 컷에 분배.
//
// 결과는 tts-outline.json 에 approved=true 로 기록하고 segments 를 반환한다.
// (이 플로우에서는 별도 사용자 검토 단계가 없으므로 옵션 선택을 곧 승인으로 본다.)
// segments 가 비면 [] 를 반환 → Stage 4 는 TTS 없이 진행.
// ============================================================

import { ARTIFACTS, readJson, readStyleNote } from './paths';
import { readStyleBrief, briefToPromptBlock } from './style-brief';
import { buildNarrationOutlinePrompt, TtsCutMeta } from './prompts';
import { chatJson } from './openai';
import { config } from './config';
import { NarrationSegment, writeTtsOutline } from './tts-outline';
import { TtsConfig } from './tts-config';

type PlanItem = {
  output_start: number;
  output_end: number;
  source_spoken_text?: string;
  source_scene_description?: string;
  source_shot_type?: string;
  source_filename?: string;
  planned_caption_layers?: { text?: string }[];
};

export type NarrationPrepResult = {
  segments: NarrationSegment[];
  generatedModel: string;     // 'captions' | 'manual' | LLM 모델명
};

export async function prepareNarrationOutline(
  projectId: string,
  ttsConfig: TtsConfig,
  totalDuration: number,
): Promise<NarrationPrepResult> {
  const plan = await readJson<{ items?: PlanItem[] }>(ARTIFACTS.editPlan(projectId));
  const items: PlanItem[] = Array.isArray(plan?.items) ? plan!.items! : [];

  let segments: NarrationSegment[] = [];
  let generatedModel = '';

  if (ttsConfig.source === 'captions') {
    segments = segmentsFromCaptions(items);
    generatedModel = 'captions';
  } else if (ttsConfig.genMode === 'manual') {
    segments = segmentsFromScript(ttsConfig.script, items, totalDuration);
    generatedModel = 'manual';
  } else {
    // generate + auto → LLM
    const r = await segmentsFromLlm(projectId, items, totalDuration);
    segments = r.segments;
    generatedModel = r.model;
  }

  // 시간순 정렬 + 인접 비겹침 보정 (방어적).
  segments = sanitizeSegments(segments);

  // outline 파일에 기록 (approved=true — 옵션 선택이 곧 승인).
  await writeTtsOutline(projectId, {
    generated_at: new Date().toISOString(),
    generated_model: generatedModel,
    total_duration: totalDuration,
    segments,
    approved: true,
    approved_at: new Date().toISOString(),
  });

  return { segments, generatedModel };
}

// ------------------------------------------------------------
// source='captions' — 각 컷의 첫 자막 텍스트를 그 컷 구간에 그대로 읽기.
// ------------------------------------------------------------
function segmentsFromCaptions(items: PlanItem[]): NarrationSegment[] {
  const out: NarrationSegment[] = [];
  items.forEach((it, i) => {
    const text = firstCaptionText(it);
    if (!text) return;
    out.push({
      cut_index: i,
      output_start: Number(it.output_start) || 0,
      output_end: Number(it.output_end) || 0,
      text,
    });
  });
  return out;
}

function firstCaptionText(it: PlanItem): string {
  const layers = Array.isArray(it.planned_caption_layers) ? it.planned_caption_layers : [];
  for (const l of layers) {
    const t = String(l?.text || '').trim();
    if (t) return t;
  }
  return '';
}

// ------------------------------------------------------------
// source='generate' genMode='manual' — 사용자가 쓴 대본을 문장 단위로 쪼개
// 영상 전체 타임라인에 고르게 분배. 컷 슬롯 길이에 비례해 문장을 배정하므로
// 영상 앞부분에 몰리지 않고, 뒤쪽 컷도 무음으로 남지 않는다.
// 컷이 없으면 영상 전체를 한 segment 로.
// ------------------------------------------------------------
function segmentsFromScript(script: string, items: PlanItem[], totalDuration: number): NarrationSegment[] {
  const sentences = splitSentences(script);
  if (sentences.length === 0) return [];

  // 컷 정보가 없으면 영상 전체에 한 덩어리.
  if (items.length === 0) {
    return [{
      cut_index: -1,
      output_start: 0,
      output_end: Math.max(0.5, totalDuration || 0),
      text: sentences.join(' '),
    }];
  }

  // 문장이 컷보다 많으면: 컷 슬롯 길이에 비례해 문장 묶음을 배정 (긴 컷이 더 많은 문장).
  // 문장이 컷보다 적으면: 문장을 영상 전체에 고르게 퍼뜨림 (앞쪽만 채우지 않음).
  const out: NarrationSegment[] = [];
  if (sentences.length >= items.length) {
    // 각 컷에 슬롯 길이 비례로 문장 개수 배분.
    const durations = items.map(it => Math.max(0.05, (Number(it.output_end) || 0) - (Number(it.output_start) || 0)));
    const totalDur = durations.reduce((a, b) => a + b, 0) || items.length;
    let cursor = 0;
    let assigned = 0;
    for (let i = 0; i < items.length; i++) {
      const remainingCuts = items.length - i;
      const remainingSentences = sentences.length - cursor;
      // 이 컷 몫(비례) — 단, 남은 컷이 모두 최소 1문장은 받도록 보정.
      let take = i === items.length - 1
        ? remainingSentences
        : Math.max(1, Math.round((durations[i] / totalDur) * sentences.length));
      take = Math.min(take, remainingSentences - (remainingCuts - 1)); // 뒤 컷들 최소 1개 확보
      take = Math.max(1, take);
      const text = sentences.slice(cursor, cursor + take).join(' ').trim();
      cursor += take;
      assigned += take;
      const it = items[i];
      if (text) out.push({ cut_index: i, output_start: Number(it.output_start) || 0, output_end: Number(it.output_end) || 0, text });
      if (cursor >= sentences.length) break;
    }
    void assigned;
  } else {
    // 문장 < 컷: 문장들을 컷 인덱스에 고르게 매핑.
    for (let s = 0; s < sentences.length; s++) {
      const i = Math.floor((s * items.length) / sentences.length);
      const it = items[Math.min(i, items.length - 1)];
      out.push({ cut_index: i, output_start: Number(it.output_start) || 0, output_end: Number(it.output_end) || 0, text: sentences[s].trim() });
    }
  }
  return out.filter(s => s.text);
}

// 한국어/영문 혼용 문장 분리 — 마침표·물음표·느낌표·줄바꿈 기준.
function splitSentences(script: string): string[] {
  return String(script || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?。…])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ------------------------------------------------------------
// source='generate' genMode='auto' — LLM 이 컷 구성을 보고 나레이션 작성.
// ------------------------------------------------------------
async function segmentsFromLlm(
  projectId: string,
  items: PlanItem[],
  totalDuration: number,
): Promise<{ segments: NarrationSegment[]; model: string }> {
  if (items.length === 0) return { segments: [], model: config.OPENAI_CHAT_MODEL };

  const cuts: TtsCutMeta[] = items.map((it, i) => ({
    cut_index: i,
    output_start: Number(it.output_start) || 0,
    output_end: Number(it.output_end) || 0,
    spoken: String(it.source_spoken_text || ''),
    scene: String(it.source_scene_description || ''),
    caption_text: firstCaptionText(it),
    shot_type: String(it.source_shot_type || ''),
    source_filename: String(it.source_filename || ''),
  }));

  const brief = await readStyleBrief(projectId);
  const styleNote = await readStyleNote(projectId);
  const directionBits = [briefToPromptBlock(brief), styleNote.trim()].filter(Boolean);
  const userDirectionBlock = directionBits.join('\n\n');

  const prompt = buildNarrationOutlinePrompt({
    userDirectionBlock,
    totalDuration,
    cuts,
  });

  const model = config.OPENAI_CHAT_MODEL;
  const parsed = await chatJson(prompt, { model, temperature: 0.6, maxTokens: 2500 });
  const rawSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const segments: NarrationSegment[] = rawSegments
    .map((s: any): NarrationSegment | null => {
      const text = String(s?.text || '').trim();
      const start = Number(s?.output_start);
      const end = Number(s?.output_end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      const ci = Number(s?.cut_index);
      return {
        cut_index: Number.isFinite(ci) ? ci : -1,
        output_start: start,
        output_end: end,
        text,
      };
    })
    .filter((s: NarrationSegment | null): s is NarrationSegment => s !== null);

  return { segments, model };
}

// ------------------------------------------------------------
// 정렬 + 인접 segment 겹침 제거 (앞 segment 의 end 를 다음 start 로 클램프).
// ------------------------------------------------------------
function sanitizeSegments(segments: NarrationSegment[]): NarrationSegment[] {
  const sorted = [...segments]
    .filter(s => s && s.text && s.output_end > s.output_start)
    .sort((a, b) => a.output_start - b.output_start);
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i].output_end > sorted[i + 1].output_start) {
      sorted[i].output_end = sorted[i + 1].output_start;
    }
  }
  // 클램프 후 길이가 0 이하가 된 segment 제거.
  return sorted.filter(s => s.output_end - s.output_start > 0.05);
}
