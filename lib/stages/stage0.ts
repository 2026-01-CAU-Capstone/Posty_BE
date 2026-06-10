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
import { ARTIFACTS, appendRawResponse, ensureDir, readJson, readStyleNote, referenceDir, workDir, writeJson } from '../paths';
import { analyzeVideoStructured, analyzeMultiPartStructured } from '../gemini';
import { probeDuration, extractFrame, cropRegion } from '../ffmpeg';
import {
  REFERENCE_ANALYSIS_PROMPT,
  REFERENCE_TEXT_FOCUSED_PROMPT,
  buildReanalysisPrompt,
  buildCaptionCropAnalysisPrompt,
  buildCaptionLocalizePrompt,
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
  // 단계별 진행 보고(선택). Stage 0 은 Gemini Pro 영상 호출이 길어 예전엔 start~done 사이
  // 신호가 전혀 없었다 → 진행률 바가 시간추정만 따라가 "99%에서 멈춤"처럼 보이고,
  // hang 감지가 "느림"과 "멈춤"을 구분 못 했다. 주요 단계마다 보고해 실제 진행을 노출한다.
  onProgress?: (step: string, msg: string) => void,
): Promise<{
  ok: true;
  shots: number;
  duration: number;
  text_focused_pass: 'ok' | 'failed' | 'skipped';
  caption_crop_refine: 'ok' | 'failed' | 'skipped' | 'deferred';
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

  // ---- 1차+2차 병렬: 메인 분석(Pro) ∥ 텍스트 전용 OCR(Flash) ----
  // 예전엔 둘 다 풀영상 Pro 였는데, 같은 Pro quota 를 동시에 때려 429 충돌 → 백오프로 도로
  // 직렬화되며 재시도 비용만 순증해 오히려 더 느렸다(2분 → 6분+ 미완성).
  // 이제 모델을 분리한다:
  //   · main         : Pro(정확도 우선). capacity 면 2회만에 끊고 Flash 로 빠르게 폴백.(analyzeWithProFallback)
  //   · text_focused : 한글 OCR/텍스트 추출 패스라 Flash(3.5)로 충분 → Pro quota 와 안 다퉈 '진짜' 병렬.
  // (main 결과로 spec 을 만들고, text_focused 결과는 그 위에 머지 — 둘은 독립적.)
  // 두 호출 모두 파일/공유상태를 안 건드리고 결과만 반환하므로 병렬이 안전하다.
  // 사용자 화면(잡 progress)엔 구현 디테일(Pro/Flash/병렬) 없이 중립 문구만 노출하고,
  // 기술 상세는 console(디버그 전용)로만 남긴다.
  if (!reanalyzed) console.log('[stage0] 분석 시작 — main(Pro) ∥ text_focused(Flash) 병렬');
  onProgress?.('stage0_main', reanalyzed ? '레퍼런스 보강 분석 중' : '레퍼런스 영상 분석 중');
  const [mainSettled, textSettled] = await Promise.allSettled([
    analyzeWithProFallback(refFile, prompt, 'main', onProgress),
    analyzeWithFlashOnly(refFile, REFERENCE_TEXT_FOCUSED_PROMPT, 'text_focused', onProgress),
  ]);

  // main 은 필수 — 실패하면 Stage 0 자체가 실패(기존 동작 유지).
  if (mainSettled.status !== 'fulfilled') {
    throw mainSettled.reason instanceof Error ? mainSettled.reason : new Error(String(mainSettled.reason));
  }
  const main = mainSettled.value;
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

  // ---- 텍스트 전용 추출 결과 머지 (보조 — 성공 시 머지, 실패해도 분석 유지) ----
  let textFocusedStatus: 'ok' | 'failed' | 'skipped' = 'skipped';
  if (textSettled.status === 'fulfilled') {
    const textFocused = textSettled.value;
    const { raw: raw2, parsed: parsed2 } = textFocused;
    await appendRawResponse(projectId, {
      stage: 0, kind: `${textFocused.kind}_video_text_focused`, response: raw2,
    });
    mergeTextFocusedIntoSpec(spec, parsed2);
    textFocusedStatus = 'ok';
  } else {
    const e: any = textSettled.reason;
    await appendRawResponse(projectId, {
      stage: 0, kind: 'gemini_pro_video_text_focused_failed', error: e?.message || String(e),
    });
    textFocusedStatus = 'failed';
  }

  // ---- 2.5차: 자막 크롭 정밀분석 → 컷편집(Stage 1)과 병렬로 이동 ----
  // 자막 스타일 정밀화(refineCaptionStylesViaCrops)는 Stage 0 의 가장 큰 추가 비용이었다
  // (Flash 1 + Pro 1 비전 호출 + ffmpeg 다수). 그 결과는 Stage 3(자막)에서만 쓰이므로
  // Stage 0 의 임계경로에서 빼고, 컷편집(Stage 1)의 무거운 소스 분석과 병렬로 돌린다.
  // (stage1.ts 가 refineReferenceCaptionStyles 를 동시에 실행하고, 매칭 직전 완료를 기다려
  //  갱신된 자막 스타일을 edit-plan 에 반영 → 자막 충실도는 100% 보존.)
  const captionCropStatus: 'ok' | 'failed' | 'skipped' | 'deferred' = 'deferred';

  // ---- 워터마크/지속 오버레이 제거 ----
  // 출처/핸들/가게 워터마크처럼 "영상 콘텐츠가 아닌" 지속 오버레이를 spec 에서 미리 제거.
  // (caption planning 단계의 LLM 판단에만 맡기지 않고, 원천 차단)
  onProgress?.('stage0_finalize', '분석 결과 정리 중');
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

  return { ok: true, shots: spec.shots.length, duration: spec.duration, text_focused_pass: textFocusedStatus, caption_crop_refine: captionCropStatus, reanalyzed };
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

type LogFn = (step: string, msg: string) => void;

// Pro 우선 호출 + capacity(429/5xx) 시 Flash(3.5) 폴백.
// (B) Pro 재시도를 짧게(2회)로 끊는다 — capacity 면 어차피 폴백할 거라 Pro 백오프로 분 단위를
//     허비하는 게 손해다. 2회 안에 capacity 에러가 나면 곧바로 Flash 로 내려간다.
//     Flash 폴백은 최후 수단이라 기본 재시도(5)를 그대로 둬 견고성을 유지한다.
async function analyzeWithProFallback(
  refFile: string,
  prompt: string,
  pass: 'main' | 'text_focused',
  onProgress?: LogFn,
): Promise<{ raw: any; parsed: any; kind: 'gemini_pro' | 'gemini_flash_fallback' }> {
  try {
    const result = await analyzeVideoStructured(refFile, prompt, config.GEMINI_PRO_MODEL, { maxAttempts: 2 });
    return { ...result, kind: 'gemini_pro' };
  } catch (e: any) {
    const message = e.message || String(e);
    if (!isRetryExhaustedCapacityError(message)) {
      // capacity 가 아닌 에러(잘못된 키/요청 등) → 폴백 의미 없음. 실패를 로그로 노출 후 throw.
      logApiFailure(`${pass} ${config.GEMINI_PRO_MODEL} 호출 실패`, message, onProgress);
      throw e;
    }
    logFallback(pass, config.GEMINI_PRO_MODEL, config.GEMINI_FLASH_MODEL, message, onProgress);
    try {
      const result = await analyzeVideoStructured(refFile, prompt, config.GEMINI_FLASH_MODEL);
      return {
        ...result,
        kind: 'gemini_flash_fallback',
        raw: {
          fallback_reason: `${pass}: ${message.slice(0, 500)}`,
          response: result.raw,
        },
      };
    } catch (e2: any) {
      logApiFailure(`${pass} ${config.GEMINI_FLASH_MODEL} 폴백도 실패`, e2?.message || String(e2), onProgress);
      throw e2;
    }
  }
}

// (A) Flash(3.5) 전용 호출 — text_focused 처럼 Pro 가 굳이 필요 없는 OCR/텍스트 패스용.
// Pro quota 를 안 건드려 main(Pro)과 진짜 병렬이 된다. 실패하면 로그로 노출 후 throw
// (text_focused 의 실패는 호출부에서 흡수해 분석을 계속한다).
async function analyzeWithFlashOnly(
  refFile: string,
  prompt: string,
  pass: 'main' | 'text_focused',
  onProgress?: LogFn,
): Promise<{ raw: any; parsed: any; kind: 'gemini_flash' }> {
  try {
    const result = await analyzeVideoStructured(refFile, prompt, config.GEMINI_FLASH_MODEL);
    return { ...result, kind: 'gemini_flash' };
  } catch (e: any) {
    logApiFailure(`${pass} ${config.GEMINI_FLASH_MODEL} 호출 실패`, e?.message || String(e), onProgress);
    throw e;
  }
}

function isRetryExhaustedCapacityError(message: string): boolean {
  return /Gemini .* (429|500|502|503|504):/.test(message);
}

// ── API 호출 실패/폴백 로그 — 백엔드 콘솔(터미널) + 잡 progress 양쪽에 노출 ──
// "왜 느린지/왜 실패했는지"가 raw json 에만 묻히지 않고 실행 중에 바로 보이게 한다.
// (progress 에 찍으면 프런트의 stall 타이머도 갱신돼 진행 중임이 드러난다.)
function logFallback(pass: string, from: string, to: string, reason: string, onProgress?: LogFn): void {
  // 기술 상세(모델명/사유)는 console(디버그 전용)로만. 사용자 progress 엔 중립 문구.
  console.warn(`[stage0] ${pass}: ${from} capacity/오류 → ${to} 폴백 — ${reason.slice(0, 180)}`);
  onProgress?.('stage0_fallback', '일시적으로 느려 대체 경로로 분석 중');
}

function logApiFailure(what: string, reason: string, onProgress?: LogFn): void {
  console.error(`[stage0] API 호출 실패 — ${what}: ${reason.slice(0, 220)}`);
  onProgress?.('stage0_api_error', '분석 중 일시적 오류 — 다시 시도 중');
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

  // 1. caption_pattern 머지 — OCR 은 텍스트 패턴(key_phrases 등)에 강하지만,
  //    geometry 계열(size_contrast/position_variety/layer_count_typical/font_variety)은
  //    시각 분석(main)이 더 정확하므로 main 값을 우선 보존한다.
  if (parsed2.caption_pattern && typeof parsed2.caption_pattern === 'object') {
    spec.caption_pattern = mergeCaptionPattern(spec.caption_pattern, parsed2.caption_pattern);
  }

  // 2. shots_text → shots[].caption_layers (통째 덮어쓰기 금지, 스마트 머지)
  const shotsText = Array.isArray(parsed2.shots_text) ? parsed2.shots_text : [];
  if (shotsText.length === 0) return;
  if (!Array.isArray(spec.shots) || spec.shots.length === 0) return;

  for (const st of shotsText) {
    const ocrLayers = Array.isArray(st?.layers)
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

    // 통째 덮어쓰기(X) → main 의 style/geometry/font/box 보존 + OCR text 보강 머지.
    target.caption_layers = mergeShotLayers(target.caption_layers, ocrLayers);
  }
}

// caption_pattern 머지 — OCR 우선이되 geometry 계열은 main 보존.
function mergeCaptionPattern(mainP: any, ocrP: any): any {
  const m = (mainP && typeof mainP === 'object') ? mainP : {};
  if (!ocrP || typeof ocrP !== 'object') return m;
  const GEOMETRY_KEYS = ['size_contrast', 'position_variety', 'layer_count_typical', 'font_variety'];
  const out: any = { ...m, ...ocrP };       // OCR base (텍스트 패턴 우선)
  for (const k of GEOMETRY_KEYS) if (m[k] !== undefined) out[k] = m[k]; // geometry 는 main 우선
  return out;
}

// 텍스트 유사도 (0~1) — 공백 제거 후 정확/포함/char-bigram Dice.
function textSimilarity(a: string, b: string): number {
  const na = String(a || '').replace(/\s+/g, '');
  const nb = String(b || '').replace(/\s+/g, '');
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const bigrams = (s: string) => {
    const g: string[] = [];
    for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
    return g.length ? g : [s];
  };
  const A = bigrams(na), B = bigrams(nb);
  const counts = new Map<string, number>();
  for (const x of B) counts.set(x, (counts.get(x) || 0) + 1);
  let inter = 0;
  for (const x of A) { const c = counts.get(x) || 0; if (c > 0) { inter++; counts.set(x, c - 1); } }
  return (2 * inter) / (A.length + B.length);
}

// 위치 근접도 (0~1) — vertical_ratio(있으면) 또는 position.
function layerPositionCloseness(a: any, b: any): number {
  const va = Number(a?.vertical_ratio), vb = Number(b?.vertical_ratio);
  if (Number.isFinite(va) && Number.isFinite(vb)) return Math.max(0, 1 - Math.abs(va - vb) * 2);
  if (a?.position && b?.position) return a.position === b.position ? 1 : 0.4;
  return 0.5;
}

// 한 shot 의 main(시각) layers + ocr(텍스트) layers 스마트 머지.
//  - OCR 비면 main 보존(콘텐츠 hook 안 지움). main 비면 OCR 채택.
//  - main↔ocr 를 text 유사도 + 위치 근접도로 매칭 → main style/geometry 유지, OCR text 채택,
//    main 이 비운 style field 만 OCR 로 보강(= OCR 가 더 잘 잡은 경우).
//  - 매칭 안 된 OCR text 는 main 이 놓친 것으로 보고 추가.
export function mergeShotLayers(main: any, ocr: any): any[] {
  const mainArr = Array.isArray(main) ? main : [];
  const ocrArr = Array.isArray(ocr) ? ocr : [];
  if (ocrArr.length === 0) return mainArr;   // OCR 텍스트 없음 → main 보존
  if (mainArr.length === 0) return ocrArr;   // main 못 잡음 → OCR 채택

  const usedOcr = new Set<number>();
  const MATCH_THRESHOLD = 0.4;
  const filled = (v: any) => String(v || '').trim().length > 0;

  const out = mainArr.map((m: any) => {
    let best = -1, bestScore = 0;
    for (let j = 0; j < ocrArr.length; j++) {
      if (usedOcr.has(j)) continue;
      const score = textSimilarity(m.text, ocrArr[j].text) * 0.75 + layerPositionCloseness(m, ocrArr[j]) * 0.25;
      if (score > bestScore) { bestScore = score; best = j; }
    }
    if (best < 0 || bestScore < MATCH_THRESHOLD) return m; // OCR 매치 없음 → main 그대로
    usedOcr.add(best);
    const o = ocrArr[best];
    const merged = { ...m };
    if (filled(o.text)) merged.text = o.text;                                   // OCR text 채택(한글 정확도)
    if (!filled(m.color_hex) && filled(o.color_hex)) merged.color_hex = o.color_hex;             // main 빈 것만 보강
    if (!filled(m.font_personality) && filled(o.font_personality)) merged.font_personality = o.font_personality;
    if (!filled(m.font_family_hint) && filled(o.font_family_hint)) merged.font_family_hint = o.font_family_hint;
    return merged;
  });

  // main 이 놓친 OCR-only text 추가
  for (let j = 0; j < ocrArr.length; j++) {
    if (!usedOcr.has(j) && filled(ocrArr[j].text)) out.push(ocrArr[j]);
  }
  return out;
}

// ============================================================
// 자막 크롭 정밀분석 (zoom-in) — Stage 0 2.5차 패스
// ----------------------------------------------------------------
// 풀프레임 분석은 자막이 화면의 작은 일부라 색/박스/그림자/굵기를 자주 오판한다
// (노란 글씨를 노란 박스로, 검은 외곽선을 검은 글씨로 등). 자막의 세로 위치 기준
// 가로 밴드를 크롭·업스케일해 자막이 이미지를 꽉 채우게 한 뒤 다시 LLM 에 물어,
// 스타일 필드(색/박스/그림자/외곽선/굵기/폰트)만 고신뢰로 덮어쓴다.
//   · 같은 자막(텍스트+세로위치+크기)은 한 번만 분석하고 모든 등장 레이어에 적용(비용 절감).
//   · 위치/크기/텍스트는 메인 분석 값을 유지(크롭은 절대 위치 정보를 잃으므로).
// ============================================================

type CropTarget = { si: number; li: number; vr: number; size: string; text: string };

// 동시 크롭 상한 — 비용/페이로드 보호. 보통 고유 자막은 몇 개뿐이라 거의 안 걸린다.
const MAX_CAPTION_CROPS = 40;

// size_level → 크롭 밴드 높이 비율(프레임 높이 대비). 박스/그림자 가장자리가 안 잘리게 넉넉히.
const CROP_BAND_FRAC: Record<string, number> = { huge: 0.34, large: 0.28, medium: 0.22, small: 0.18 };
export function bandFracForSize(size?: string): number {
  return CROP_BAND_FRAC[String(size || 'medium').toLowerCase()] ?? 0.24;
}

function positionToVr(position?: string): number {
  const p = String(position || 'bottom').toLowerCase();
  if (p === 'top') return 0.16;
  if (p === 'center' || p === 'middle') return 0.5;
  return 0.84;
}

// 같은 자막(텍스트 기준)을 한 그룹으로 묶는다. 대표(rep)는 첫 등장 레이어 = 자막이 실제로
// 보일 가능성이 가장 높은 프레임. (반복 자막을 1회만 분석하고, 한 좋은 프레임으로 모든 등장에 적용)
// vr/size 는 band 폴백용으로 rep 값을 보관하지만, 1차 위치는 LLM 로컬라이제이션으로 잡는다.
export function groupCaptionsForCrop(spec: any): { key: string; rep: CropTarget; members: CropTarget[] }[] {
  const groups = new Map<string, { rep: CropTarget; members: CropTarget[] }>();
  const shots: any[] = Array.isArray(spec?.shots) ? spec.shots : [];
  for (let si = 0; si < shots.length; si++) {
    const layers: any[] = Array.isArray(shots[si]?.caption_layers) ? shots[si].caption_layers : [];
    for (let li = 0; li < layers.length; li++) {
      const l = layers[li];
      const text = String(l?.text || '').trim();
      if (!text) continue;
      const vrRaw = Number(l?.vertical_ratio);
      const vr = Number.isFinite(vrRaw) ? Math.max(0, Math.min(1, vrRaw)) : positionToVr(l?.position);
      const size = String(l?.size_level || 'medium').toLowerCase();
      const key = text.replace(/\s+/g, ' ').trim();   // 텍스트 기준 그룹핑
      const t: CropTarget = { si, li, vr, size, text };
      const g = groups.get(key);
      if (g) g.members.push(t);
      else groups.set(key, { rep: t, members: [t] });
    }
  }
  return Array.from(groups.entries()).map(([key, v]) => ({ key, rep: v.rep, members: v.members }));
}

// 정규화 bbox.
type Bbox = { x: number; y: number; w: number; h: number };

// vr 밴드를 bbox 로 (가로 전체). 로컬라이제이션 실패 시 폴백.
export function bandBox(vr: number, frac: number): Bbox {
  const F = Math.max(0.05, Math.min(0.9, Number(frac) || 0.24));
  const v = Math.max(0, Math.min(1, Number(vr) || 0.5));
  return { x: 0, y: Math.max(0, Math.min(1 - F, v - F / 2)), w: 1, h: F };
}

// 로컬라이제이션 detections 중 기대 텍스트에 가장 잘 맞는 bbox 선택. 충분히 안 맞으면 null.
export function pickDetectionBox(expected: string, detections: any[]): Bbox | null {
  if (!Array.isArray(detections)) return null;
  const norm = (v: number) => (v > 1.5 ? v / 100 : v);   // 퍼센트로 준 경우 보정
  const c01 = (v: number) => Math.max(0, Math.min(1, v));
  let best: Bbox | null = null;
  let bestScore = 0;
  for (const d of detections) {
    const score = textSimilarity(expected, String(d?.text || ''));
    const x = norm(Number(d?.x)), y = norm(Number(d?.y)), w = norm(Number(d?.w)), h = norm(Number(d?.h));
    if (![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) continue;
    if (score > bestScore) {
      best = { x: c01(x), y: c01(y), w: Math.min(1, w), h: Math.min(1, h) };
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

// bbox 중심 → 정규화 세로/가로 위치. 레퍼런스 자막의 실제 위치를 그대로 복제하는 데 쓴다.
export function bboxCenter(box: Bbox): { vr: number; hr: number } {
  return {
    vr: Math.max(0, Math.min(1, box.y + box.h / 2)),
    hr: Math.max(0, Math.min(1, box.x + box.w / 2)),
  };
}

// 안전장치: 크롭이 '기대한 자막'을 실제로 담았는지 검증.
// 밴드가 자막을 빗나가면(분석 vertical_ratio 오차 등) LLM 이 엉뚱한 영역(예: 배경의 노란 봉지)을
// 읽어 분석을 오히려 망칠 수 있다. 크롭이 되읽은 text 가 기대 text 와 충분히 유사할 때만 스타일을 적용한다.
export function cropMatchesExpected(expected: string, got: string): boolean {
  const g = String(got || '').trim();
  if (!g) return false;
  return textSimilarity(expected, g) >= 0.5;
}

// 크롭 분석 결과(스타일)를 레이어에 머지 — 값이 있을 때만 덮어쓴다. 텍스트/위치/크기는 건드리지 않는다.
export function mergeCropStyleIntoLayer(layer: any, crop: any): void {
  if (!layer || !crop || typeof crop !== 'object') return;
  const str = (v: any) => (typeof v === 'string' && v.trim() ? v : undefined);
  const num = (v: any) => (Number.isFinite(v) ? Number(v) : undefined);

  if (str(crop.color_hex)) layer.color_hex = crop.color_hex;
  if (Array.isArray(crop.color_runs) && crop.color_runs.length >= 2) layer.color_runs = crop.color_runs;
  if (typeof crop.has_background_box === 'boolean') layer.has_background_box = crop.has_background_box;
  if (str(crop.background_color_hex)) layer.background_color_hex = crop.background_color_hex;
  if (num(crop.background_alpha) !== undefined) layer.background_alpha = crop.background_alpha;
  if (typeof crop.has_shadow === 'boolean') layer.has_shadow = crop.has_shadow;
  if (str(crop.shadow_color_hex)) layer.shadow_color_hex = crop.shadow_color_hex;
  if (num(crop.shadow_blur) !== undefined) layer.shadow_blur = crop.shadow_blur;
  if (typeof crop.has_glow === 'boolean') layer.has_glow = crop.has_glow;
  if (str(crop.glow_color_hex)) layer.glow_color_hex = crop.glow_color_hex;
  if (num(crop.glow_radius) !== undefined) layer.glow_radius = crop.glow_radius;
  if (str(crop.outline_color_hex)) layer.outline_color_hex = crop.outline_color_hex;
  if (str(crop.outline_thickness)) layer.outline_thickness = String(crop.outline_thickness).toLowerCase();
  if (str(crop.emphasis)) layer.emphasis = String(crop.emphasis).toLowerCase();
  if (str(crop.font_weight_hint)) layer.font_weight_hint = String(crop.font_weight_hint).toLowerCase();
  if (str(crop.font_family_hint)) layer.font_family_hint = crop.font_family_hint;
  if (str(crop.font_width)) layer.font_width = String(crop.font_width).toLowerCase();
  if (str(crop.letter_spacing)) layer.letter_spacing = String(crop.letter_spacing).toLowerCase();
}

// Stage 0 에서 분리한 자막 스타일 정밀화 — 컷편집(Stage 1)과 병렬로 실행하기 위한 진입점.
// edit-spec.json 을 읽어 caption_layers 의 "스타일" 필드만 크롭 정밀분석으로 보정하고 다시 쓴다.
// (텍스트/위치/크기/샷 구조는 안 건드리므로 Stage 1 의 매칭/임베딩과 독립적 → 병렬 안전.)
export async function refineReferenceCaptionStyles(
  projectId: string,
): Promise<{ refined: number; status: 'ok' | 'failed' | 'skipped'; spec: any | null }> {
  if (!config.GEMINI_API_KEY) return { refined: 0, status: 'skipped', spec: null };
  const spec: any = await readJson(ARTIFACTS.editSpec(projectId));
  if (!spec || !Array.isArray(spec.shots) || spec.shots.length === 0) return { refined: 0, status: 'skipped', spec: spec ?? null };
  // 이미 정밀화된 spec 이면 재실행하지 않는다 (Stage 1 재시도 시 Pro/Flash 호출 중복 방지).
  // reanalyze 는 새 spec 을 써서 이 마커가 없으므로 자연히 다시 정밀화된다.
  if (spec._caption_refined === true) return { refined: 0, status: 'skipped', spec };
  const refDir = referenceDir(projectId);
  const files = (await fs.readdir(refDir).catch(() => [])).filter(f => !f.startsWith('.'));
  if (files.length === 0) return { refined: 0, status: 'skipped', spec };
  const refFile = path.join(refDir, files[0]);
  try {
    const refined = await refineCaptionStylesViaCrops(projectId, spec, refFile);
    spec._caption_refined = true; // "정밀화 완료" 마커 — 재실행/다른 stage 에서 중복 비용 회피.
    await writeJson(ARTIFACTS.editSpec(projectId), spec);
    // 갱신된 spec 객체를 그대로 돌려준다 → 호출부(Stage 1)가 디스크를 다시 읽지 않고 바로 사용
    // (write 직후 read 가 어긋날 이론적 틈을 없앤다).
    return { refined, status: refined > 0 ? 'ok' : 'skipped', spec };
  } catch (e: any) {
    await appendRawResponse(projectId, {
      stage: 0, kind: 'caption_crop_refine_failed', error: e?.message || String(e),
    });
    return { refined: 0, status: 'failed', spec };
  }
}

async function refineCaptionStylesViaCrops(projectId: string, spec: any, refFile: string): Promise<number> {
  if (!config.GEMINI_API_KEY) return 0;
  const groups = groupCaptionsForCrop(spec).slice(0, MAX_CAPTION_CROPS);
  if (groups.length === 0) return 0;

  const cropDir = path.join(workDir(projectId), '_caption_crops');
  await ensureDir(cropDir);

  // 대표 shot 프레임 추출(캐시). rep.si = 첫 등장 = 자막이 보일 가능성이 가장 높은 프레임.
  const frameCache = new Map<number, string>();
  const ensureFrame = async (si: number): Promise<string> => {
    const cached = frameCache.get(si);
    if (cached) return cached;
    const shot = spec.shots?.[si] || {};
    const mid = Math.max(0, ((Number(shot.start) || 0) + (Number(shot.end) || 1)) / 2);
    const p = path.join(cropDir, `frame_${si}.jpg`);
    await extractFrame(refFile, mid, p, 1280);
    frameCache.set(si, p);
    return p;
  };

  // ── Phase 1: 자막 위치 로컬라이제이션 (풀프레임 → bbox). vertical_ratio 오차에 강함. ──
  const frameSis = Array.from(new Set(groups.map(g => g.rep.si)));
  const siToFrameIdx = new Map<number, number>();
  const frameParts: { filePath: string; mimeType: string }[] = [];
  const frameHints: { idx: number; hints: string[] }[] = [];
  for (let i = 0; i < frameSis.length; i++) {
    const si = frameSis[i];
    siToFrameIdx.set(si, i);
    frameParts.push({ filePath: await ensureFrame(si), mimeType: 'image/jpeg' });
    frameHints.push({ idx: i, hints: groups.filter(g => g.rep.si === si).map(g => g.rep.text) });
  }
  const frameDetections = new Map<number, any[]>();
  try {
    const r = await analyzeMultiPartStructured(frameParts, buildCaptionLocalizePrompt(frameHints), config.GEMINI_FLASH_MODEL);
    for (const f of (Array.isArray(r.parsed?.frames) ? r.parsed.frames : [])) {
      frameDetections.set(Number(f.idx), Array.isArray(f.captions) ? f.captions : []);
    }
    await appendRawResponse(projectId, { stage: 0, kind: 'caption_localize', frames: frameParts.length, response: r.raw });
  } catch (e: any) {
    // 로컬라이제이션 실패 → bbox 없이 vr-밴드 폴백으로 진행(게이트가 안전하게 거른다).
    await appendRawResponse(projectId, { stage: 0, kind: 'caption_localize_failed', error: (e?.message || String(e)).slice(0, 300) });
  }

  // ── 각 그룹: bbox(로컬라이즈) 우선, 실패 시 vr-밴드 폴백으로 크롭 ──
  const cropParts: { filePath: string; mimeType: string }[] = [];
  const promptCrops: { idx: number; text: string; size_level?: string }[] = [];
  const cropToGroup: number[] = [];
  const groupDetBox: (Bbox | null)[] = [];
  let localized = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const rep = groups[gi].rep;
    const fp = await ensureFrame(rep.si);
    const dets = frameDetections.get(siToFrameIdx.get(rep.si) ?? -1) || [];
    const detBox = pickDetectionBox(rep.text, dets);
    groupDetBox[gi] = detBox;
    if (detBox) localized++;
    const box = detBox || bandBox(rep.vr, bandFracForSize(rep.size));
    const cropPath = path.join(cropDir, `crop_${gi}.jpg`);
    await cropRegion(fp, cropPath, box.x, box.y, box.w, box.h, 0.04);
    cropParts.push({ filePath: cropPath, mimeType: 'image/jpeg' });
    promptCrops.push({ idx: cropParts.length - 1, text: rep.text, size_level: rep.size });
    cropToGroup.push(gi);
  }

  // ── Phase 2: 크롭 정밀 스타일 분석 (확대 이미지 → 색/박스/그림자/굵기/폰트). Pro 우선. ──
  let parsed: any;
  try {
    // (B) crop Pro 호출도 capacity 면 2회만에 끊고 곧바로 Flash 로 폴백.
    const r = await analyzeMultiPartStructured(cropParts, buildCaptionCropAnalysisPrompt(promptCrops), config.GEMINI_PRO_MODEL, { maxAttempts: 2 });
    parsed = r.parsed;
    await appendRawResponse(projectId, { stage: 0, kind: 'gemini_pro_caption_crop', crops: cropParts.length, localized, response: r.raw });
  } catch (e: any) {
    console.warn(`[stage0] caption_crop: ${config.GEMINI_PRO_MODEL} capacity/오류 → ${config.GEMINI_FLASH_MODEL} 폴백 — ${(e?.message || String(e)).slice(0, 160)}`);
    const r = await analyzeMultiPartStructured(cropParts, buildCaptionCropAnalysisPrompt(promptCrops), config.GEMINI_FLASH_MODEL);
    parsed = r.parsed;
    await appendRawResponse(projectId, { stage: 0, kind: 'gemini_flash_caption_crop_fallback', crops: cropParts.length, localized, fallback_reason: (e?.message || String(e)).slice(0, 300), response: r.raw });
  }

  const caps: any[] = Array.isArray(parsed?.captions) ? parsed.captions : [];
  const byIdx = new Map<number, any>();
  for (const c of caps) byIdx.set(Number(c.idx), c);

  let applied = 0;
  let skipped = 0;
  for (let ci = 0; ci < cropToGroup.length; ci++) {
    const crop = byIdx.get(ci);
    const gi = cropToGroup[ci];
    if (!crop) continue;
    // 크롭이 기대 자막을 못 담았으면(빗나감) 적용하지 않는다 — 오판 주입 방지.
    if (!cropMatchesExpected(groups[gi].rep.text, crop.text)) { skipped++; continue; }
    // 로컬라이즈로 자막 위치를 찾았으면 그 bbox 중심을 vertical/horizontal_ratio 로 복제(정밀 위치).
    // (폭/높이(box_w/h)는 더 이상 사용하지 않는다 — 사이징은 size_ratio, 줄 구조는 \n 존중이 담당.)
    const detBox = groupDetBox[gi];
    const pos = detBox ? bboxCenter(detBox) : null;
    for (const m of groups[gi].members) {
      const layer = spec.shots?.[m.si]?.caption_layers?.[m.li];
      if (!layer) continue;
      mergeCropStyleIntoLayer(layer, crop);
      if (detBox && pos) {
        layer.vertical_ratio = pos.vr;
        layer.horizontal_ratio = pos.hr;
      }
      applied++;
    }
  }
  if (skipped > 0) {
    await appendRawResponse(projectId, {
      stage: 0, kind: 'caption_crop_skipped', skipped_groups: skipped, applied_layers: applied,
      note: '크롭이 기대 자막과 불일치(자막을 못 담음) → 해당 그룹 스타일 미적용',
    });
  }

  // 전역 박스 플래그 정합화 — 어떤 레이어도 박스가 아니면 전역도 false.
  if (spec.caption_global_style && typeof spec.caption_global_style === 'object') {
    const anyBox = (spec.shots || []).some((s: any) => (s.caption_layers || []).some((l: any) => l?.has_background_box === true));
    spec.caption_global_style.has_background_box = anyBox;
  }
  return applied;
}
