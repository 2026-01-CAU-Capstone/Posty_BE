// ============================================================
// Stage 0: 레퍼런스 영상 분석
// 입력: data/projects/{pid}/reference/ 안의 영상 1개
// 출력: 0_spec/edit-spec.json
// API: Gemini Pro generateContent — 2회 호출
//   1) 메인 분석 (컷·색감·오디오·텍스트 등 종합)
//   2) 텍스트 전용 추출 (한글 인식 강화) → caption_layers / caption_pattern 덮어쓰기
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { ARTIFACTS, appendRawResponse, readStyleNote, referenceDir, writeJson } from '../paths';
import { analyzeVideoStructured } from '../gemini';
import { probeDuration } from '../ffmpeg';
import {
  REFERENCE_ANALYSIS_PROMPT,
  REFERENCE_TEXT_FOCUSED_PROMPT,
  styleNoteBlock,
} from '../prompts';
import { config } from '../config';

export async function runStage0(projectId: string): Promise<{
  ok: true;
  shots: number;
  duration: number;
  text_focused_pass: 'ok' | 'failed' | 'skipped';
}> {
  const refDir = referenceDir(projectId);
  const files = (await fs.readdir(refDir).catch(() => []))
    .filter(f => !f.startsWith('.'));
  if (files.length === 0) throw new Error('레퍼런스 영상이 없습니다');

  const refFile = path.join(refDir, files[0]);
  const measuredDuration = await probeDuration(refFile);

  const styleNote = await readStyleNote(projectId);
  const prompt = styleNoteBlock(styleNote) + REFERENCE_ANALYSIS_PROMPT;

  // ---- 1차: 메인 분석 ----
  const main = await analyzeWithProFallback(refFile, prompt, 'main');
  const { raw, parsed } = main;
  await appendRawResponse(projectId, {
    stage: 0, kind: `${main.kind}_video_main`, filename: files[0], response: raw,
  });

  const spec = parsed || {};
  if (!spec.duration || !isFinite(spec.duration)) spec.duration = measuredDuration;
  if (!Array.isArray(spec.shots)) spec.shots = [];
  spec.shots = spec.shots.map((s: any, i: number) => normalizeShot(s, i));

  // caption_pattern 도 기본값 보정
  spec.caption_pattern = spec.caption_pattern || {};

  // ---- 2차: 텍스트 전용 추출 (한글 인식 강화) ----
  let textFocusedStatus: 'ok' | 'failed' | 'skipped' = 'skipped';
  try {
    const textFocused = await analyzeWithProFallback(refFile, REFERENCE_TEXT_FOCUSED_PROMPT, 'text_focused');
    const { raw: raw2, parsed: parsed2 } = textFocused;
    await appendRawResponse(projectId, {
      stage: 0, kind: `${textFocused.kind}_video_text_focused`, response: raw2,
    });
    mergeTextFocusedIntoSpec(spec, parsed2);
    textFocusedStatus = 'ok';
  } catch (e: any) {
    await appendRawResponse(projectId, {
      stage: 0, kind: 'gemini_pro_video_text_focused_failed', error: e.message || String(e),
    });
    textFocusedStatus = 'failed';
  }

  await writeJson(ARTIFACTS.editSpec(projectId), spec);
  return { ok: true, shots: spec.shots.length, duration: spec.duration, text_focused_pass: textFocusedStatus };
}

async function analyzeWithProFallback(
  refFile: string,
  prompt: string,
  pass: 'main' | 'text_focused',
): Promise<{ raw: any; parsed: any; kind: 'gemini_pro' | 'gemini_flash_fallback' }> {
  try {
    const result = await analyzeVideoStructured(refFile, prompt, config.GEMINI_PRO_MODEL);
    return { ...result, kind: 'gemini_pro' };
  } catch (e: any) {
    const message = e.message || String(e);
    if (!isRetryExhaustedCapacityError(message)) throw e;

    const result = await analyzeVideoStructured(refFile, prompt, config.GEMINI_FLASH_MODEL);
    return {
      ...result,
      kind: 'gemini_flash_fallback',
      raw: {
        fallback_reason: `${pass}: ${message.slice(0, 500)}`,
        response: result.raw,
      },
    };
  }
}

function isRetryExhaustedCapacityError(message: string): boolean {
  return /Gemini .* (429|500|502|503|504):/.test(message);
}

// ============================================================
// shot 객체 정규화 — 현재 스키마의 모든 필드 보존
// (이전 버전이 caption_layers / caption_pattern 등을 버리던 버그 수정)
// ============================================================
function normalizeShot(s: any, fallbackIdx: number): any {
  const layers = Array.isArray(s?.caption_layers)
    ? s.caption_layers.map(normalizeLayer).filter((x: any) => x !== null)
    : [];
  return {
    index: typeof s.index === 'number' ? s.index : fallbackIdx,
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    duration: Number(s.duration) || Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0)),
    shot_type: s.shot_type || 'medium',
    subject: s.subject || '',
    scene_description: s.scene_description || '',
    composition: s.composition || '',
    camera_motion: s.camera_motion || 'static',
    transition_to_next: s.transition_to_next || 'cut',
    caption_layers: layers,
    required_tags: Array.isArray(s.required_tags) ? s.required_tags : [],
  };
}

function normalizeLayer(l: any): any | null {
  if (!l || typeof l !== 'object') return null;
  const text = typeof l.text === 'string' ? l.text : '';
  // 텍스트가 비어있어도 layer 자체는 유지 (스타일 정보가 있을 수 있음).
  return {
    text,
    position: String(l.position || 'bottom').toLowerCase(),
    horizontal_align: String(l.horizontal_align || 'center').toLowerCase(),
    size_level: String(l.size_level || 'medium').toLowerCase(),
    color_hex: typeof l.color_hex === 'string' ? l.color_hex : '',
    emphasis: String(l.emphasis || 'bold').toLowerCase(),
    italic: l.italic === true,
    font_category: String(l.font_category || 'sans').toLowerCase(),
    font_personality: String(l.font_personality || '').toLowerCase(),
    role: String(l.role || 'none').toLowerCase(),
    tone: String(l.tone || 'none').toLowerCase(),
  };
}

// ============================================================
// 텍스트 전용 결과를 메인 spec 에 머지
// - shots_text → shots[].caption_layers 덮어쓰기 (텍스트 인식 우선)
// - caption_pattern 통째로 덮어쓰기 (한글 인식이 강화된 결과)
// shots_text 의 shot_index 또는 shot_start 로 메인 shots 와 매칭.
// 매칭 실패 시 시간 기준 nearest 로 폴백.
// ============================================================
function mergeTextFocusedIntoSpec(spec: any, parsed2: any): void {
  if (!parsed2 || typeof parsed2 !== 'object') return;

  // 1. caption_pattern 덮어쓰기 (텍스트 분석이 더 정확)
  if (parsed2.caption_pattern && typeof parsed2.caption_pattern === 'object') {
    spec.caption_pattern = {
      ...spec.caption_pattern,
      ...parsed2.caption_pattern,
    };
  }

  // 2. shots_text → shots[].caption_layers
  const shotsText = Array.isArray(parsed2.shots_text) ? parsed2.shots_text : [];
  if (shotsText.length === 0) return;
  if (!Array.isArray(spec.shots) || spec.shots.length === 0) return;

  for (const st of shotsText) {
    const layers = Array.isArray(st?.layers)
      ? st.layers.map(normalizeLayer).filter((x: any) => x !== null)
      : [];

    // index 매칭 우선
    let target: any = null;
    if (typeof st.shot_index === 'number') {
      target = spec.shots.find((s: any) => s.index === st.shot_index);
    }
    // 시간 매칭 (start 가장 가까운 shot)
    if (!target && typeof st.shot_start === 'number') {
      let best = spec.shots[0];
      let bestDiff = Math.abs((Number(best.start) || 0) - st.shot_start);
      for (const s of spec.shots) {
        const d = Math.abs((Number(s.start) || 0) - st.shot_start);
        if (d < bestDiff) { best = s; bestDiff = d; }
      }
      if (bestDiff < 0.6) target = best; // 0.6초 이내면 같은 shot 으로 간주
    }
    if (!target) continue;

    // 덮어쓰기 — 빈 layers 도 의미 있음 (텍스트 없는 컷)
    target.caption_layers = layers;
  }
}
