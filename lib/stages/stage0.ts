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
import { ARTIFACTS, appendRawResponse, readJson, readStyleNote, referenceDir, writeJson } from '../paths';
import { analyzeVideoStructured } from '../gemini';
import { probeDuration } from '../ffmpeg';
import {
  REFERENCE_ANALYSIS_PROMPT,
  REFERENCE_TEXT_FOCUSED_PROMPT,
  buildReanalysisPrompt,
  styleNoteBlock,
} from '../prompts';
import { clearStyleSuggest } from '../style-suggest';
import { preserveLayerDesign } from '../caption-ass';
import { config } from '../config';

export type RunStage0Options = {
  // true 면 기존 edit-spec.json 을 읽어 프롬프트에 함께 넣고 "보강 분석" 으로 돌린다.
  reanalyze?: boolean;
  // 재분석 시 사용자가 특히 봐주길 원하는 포인트(자유 문장).
  userFocus?: string;
};

export async function runStage0(
  projectId: string,
  options: RunStage0Options = {},
): Promise<{
  ok: true;
  shots: number;
  duration: number;
  text_focused_pass: 'ok' | 'failed' | 'skipped';
  reanalyzed: boolean;
}> {
  const refDir = referenceDir(projectId);
  const files = (await fs.readdir(refDir).catch(() => []))
    .filter(f => !f.startsWith('.'));
  if (files.length === 0) throw new Error('레퍼런스 영상이 없습니다');

  const refFile = path.join(refDir, files[0]);
  const measuredDuration = await probeDuration(refFile);

  const styleNote = await readStyleNote(projectId);

  // 재분석 모드 — 기존 spec 이 있으면 그걸 프롬프트에 끼워 넣어 second-pass 로 돌린다.
  // 기존 결과는 ".previous.json" 으로 백업해두어 디버깅/비교용으로 남긴다.
  let prompt: string;
  let reanalyzed = false;
  if (options.reanalyze) {
    const previousSpec = await readJson<any>(ARTIFACTS.editSpec(projectId));
    if (previousSpec) {
      const backupPath = ARTIFACTS.editSpec(projectId).replace(/\.json$/i, '.previous.json');
      await writeJson(backupPath, previousSpec);
      await appendRawResponse(projectId, {
        stage: 0, kind: 'reanalyze_start',
        backup: path.basename(backupPath),
        user_focus: options.userFocus || null,
      });
      prompt = styleNoteBlock(styleNote) + buildReanalysisPrompt(previousSpec, options.userFocus);
      reanalyzed = true;
    } else {
      // 이전 분석 결과가 없으면 그냥 일반 분석으로 폴백
      prompt = styleNoteBlock(styleNote) + REFERENCE_ANALYSIS_PROMPT;
    }
  } else {
    prompt = styleNoteBlock(styleNote) + REFERENCE_ANALYSIS_PROMPT;
  }

  // ---- 1차: 메인 분석 (재분석 모드면 second-pass 프롬프트) ----
  const main = await analyzeWithProFallback(refFile, prompt, 'main');
  const { raw, parsed } = main;
  await appendRawResponse(projectId, {
    stage: 0,
    kind: reanalyzed ? `${main.kind}_video_main_reanalyze` : `${main.kind}_video_main`,
    filename: files[0],
    response: raw,
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

  // ---- 워터마크/지속 오버레이 제거 ----
  // 출처/핸들/가게 워터마크처럼 "영상 콘텐츠가 아닌" 지속 오버레이를 spec 에서 미리 제거.
  // (caption planning 단계의 LLM 판단에만 맡기지 않고, 원천 차단)
  const wm = stripWatermarkLayers(spec);
  if (wm.removed > 0) {
    await appendRawResponse(projectId, {
      stage: 0, kind: 'watermark_stripped',
      removed_layers: wm.removed, samples: wm.samples,
    });
  }

  await writeJson(ARTIFACTS.editSpec(projectId), spec);

  // spec 이 바뀌었으니 캐시된 style-suggest 는 무효화 (다음 호출 시 새로 생성).
  // 첫 분석에선 사실상 noop 이지만, 재분석 시엔 stale 한 추천이 남는 걸 막아준다.
  await clearStyleSuggest(projectId);

  return { ok: true, shots: spec.shots.length, duration: spec.duration, text_focused_pass: textFocusedStatus, reanalyzed };
}

// ============================================================
// 워터마크 / 지속 오버레이 레이어 제거
// ----------------------------------------------------------------
// 영상 "콘텐츠" 가 아니라 운영용으로 화면에 고정으로 박혀 있는 텍스트
// (출처 핸들, 계정명, 워터마크, 구독/팔로우 안내 등) 를 spec.shots[].caption_layers
// 에서 통째로 제거한다.
//
// 판정 신호:
//   1) 명백한 키워드 패턴 (@handle, URL, 출처/credit, follow/subscribe/구독/팔로우, #해시태그 단독)
//   2) 코너(top|bottom + left|right) + (작은 크기 | label/decoration 역할) → 전형적 워터마크 위치
//   3) (거의) 모든 컷에 동일 텍스트가 반복 + 위 형태 신호 → 지속 오버레이
//
// 주의: 중앙·큰 글씨·박스 배경이 있는 "hook" 류는 가게명이 들어가도 콘텐츠로 보고 유지.
//       (반복된다는 이유만으로 제거하지 않음 — hook 도 전 컷 반복될 수 있으므로)
// ============================================================
const WATERMARK_TEXT_RE = /(@[\w.]{2,}|^#[\w가-힣]+$|\b[\w-]+\.(com|co\.kr|net|io|kr|tv)\b|출처|credit|구독|팔로우|\bfollow\b|\bsubscribe\b|\bDM\b)/i;

function stripWatermarkLayers(spec: any): { removed: number; samples: string[] } {
  const shots: any[] = Array.isArray(spec?.shots) ? spec.shots : [];
  if (shots.length === 0) return { removed: 0, samples: [] };

  // 1) 텍스트별 등장 컷 수 집계 (같은 컷 내 중복은 1회)
  const counts = new Map<string, { count: number; layer: any }>();
  for (const s of shots) {
    const layers: any[] = Array.isArray(s.caption_layers) ? s.caption_layers : [];
    const seenInShot = new Set<string>();
    for (const l of layers) {
      const key = wmKey(l?.text);
      if (!key || seenInShot.has(key)) continue;
      seenInShot.add(key);
      const prev = counts.get(key);
      if (prev) prev.count++;
      else counts.set(key, { count: 1, layer: l });
    }
  }

  // 2) 워터마크 판정
  const wmKeys = new Set<string>();
  const samples: string[] = [];
  for (const [key, { count, layer }] of counts) {
    if (isWatermarkLayer(layer, count, shots.length)) {
      wmKeys.add(key);
      const t = String(layer?.text || '').trim();
      if (t && samples.length < 8) samples.push(t.slice(0, 40));
    }
  }
  if (wmKeys.size === 0) return { removed: 0, samples: [] };

  // 3) 모든 컷에서 제거
  let removed = 0;
  for (const s of shots) {
    const layers: any[] = Array.isArray(s.caption_layers) ? s.caption_layers : [];
    s.caption_layers = layers.filter((l: any) => {
      const key = wmKey(l?.text);
      if (key && wmKeys.has(key)) { removed++; return false; }
      return true;
    });
  }
  return { removed, samples };
}

function wmKey(text: any): string {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isWatermarkLayer(l: any, count: number, totalShots: number): boolean {
  const text = String(l?.text || '').trim();
  if (!text) return false;

  // (1) 명백한 키워드 → 무조건 워터마크
  if (WATERMARK_TEXT_RE.test(text)) return true;

  const pos = String(l.position || '').toLowerCase();
  const align = String(l.horizontal_align || '').toLowerCase();
  const size = String(l.size_level || '').toLowerCase();
  const role = String(l.role || '').toLowerCase();

  const isCorner = (pos === 'top' || pos === 'bottom') && (align === 'left' || align === 'right');
  const isSmall = size === 'small';
  const isLabel = role === 'label' || role === 'decoration';
  const noBox = l.has_background_box !== true;
  const persistent = totalShots >= 3 && count >= Math.ceil(totalShots * 0.6);

  // (2) 코너 + (작음 | 라벨) → 전형적 워터마크 형태
  if (isCorner && (isSmall || isLabel)) return true;

  // (3) 거의 모든 컷에 반복 + 형태 신호(작음/라벨/코너, 박스 없음) → 지속 오버레이
  //     중앙·박스 있는 hook 은 콘텐츠로 보고 보존.
  if (persistent && noBox && (isSmall || isLabel || isCorner)) return true;

  return false;
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
    // 외곽선/그림자/박스/그라데이션/글로우/자간/등장애니메이션 보존 (edit-spec 까지 전달).
    ...preserveLayerDesign(l),
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
