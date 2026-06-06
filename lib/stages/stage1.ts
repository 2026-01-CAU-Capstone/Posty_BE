// ============================================================
// Stage 1: 컷편집
// 1a) FFmpeg scene detection 으로 각 소스 영상의 shot 경계 찾기
// 1b) Gemini Flash 로 각 shot 묘사 + tags + highlight + subject 위치 추출
// 1c) OpenAI embedding 으로 ref shot ↔ source shot 벡터 매칭
// 1d) 매칭 결과를 edit-plan.json 으로 저장
// 1e) FFmpeg 로 trim + 9:16 smart-reframe crop + concat → cut.mp4
//
// 핵심 정책:
// - 모든 source shot 을 한 컷씩 사용 (ref 길이에 매이지 않음)
// - 각 source shot 은 가장 잘 어울리는 ref shot 에서 STYLE 만 빌려옴
//   (caption 텍스트·위치·크기·색·굵기, transition)
// - source 정렬: 업로드 순서 그대로 (영상 N 안에서는 시간 순)
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import {
  ARTIFACTS, appendRawResponse, ensureDir, readJson, readStyleNote, sourcesDir, stageDir, workDir, writeJson,
} from '../paths';
import { detectShots, extractAudio, extractAudioRange, extractFrame, hasAudioStream, probeDuration, runFfmpeg, Shot } from '../ffmpeg';
import { analyzeMultiPartStructured, analyzeVideoStructured, callGeminiTextOnly, MediaPart } from '../gemini';
import { cosineSim, embedTexts } from '../openai';
import { buildCaptionPlanningPrompt, buildImageSourceDescriptionPrompt, buildSourceDescriptionPrompt, buildSourceDescriptionPromptMultipart, styleNoteBlock } from '../prompts';
import { briefToPromptBlock, readStyleBrief } from '../style-brief';
import { reduceSourceShots, ReduceCandidate } from '../source-reduce';
import { CaptionLayer, preserveLayerDesign } from '../caption-ass';
import { config } from '../config';

const OUT_W = 1080;
const OUT_H = 1920;

// ---- 긴 소스 대응 ----
// 한 소스의 shot 이 이 수를 넘으면 분석을 여러 batch 로 쪼개 호출 (요청총량/출력잘림 회피).
const SINGLE_CALL_SHOT_MAX = 150;
const SOURCE_SHOT_BATCH = 120;
// 전체 추정 출력이 TARGET_MAX_SEC 를 넘으면 큐레이션(reduce) 으로 30~60초로 축약.
const TARGET_MIN_SEC = 30;
const TARGET_MAX_SEC = 60;
const TARGET_SEC = 45;

// 정지 이미지 소스의 기본 cut 길이.
const IMAGE_CLIP_DURATION_SEC = 3.0;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.bmp']);
function isImageFile(filename: string): boolean {
  return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

type SourceShot = {
  video_id: string;
  source_index: number;
  start: number;
  end: number;
  duration: number;
  shot_type: string;
  subject: string;
  scene_description: string;
  tags: string[];
  camera_motion: string;
  spoken_text: string;
  quality_score: number;
  highlight_start: number;
  highlight_end: number;
  highlight_reason: string;
  subject_center_x: number;
  subject_center_y: number;
};

type SourceVideo = {
  video_id: string;
  filename: string;
  duration: number;
  shots: SourceShot[];
  is_image: boolean;       // 정지 이미지 소스 여부 (true 면 단일 still shot)
};

// CaptionLayer 타입은 caption-ass.ts(렌더러)와 단일 소스로 통일한다.
// (예전엔 여기서 기본 11개 필드만 가진 중복 타입을 따로 둬서, 디자인 필드가
//  normalize 단계에서 버려지는 버그의 원인이 됐다.)

type EditPlanItem = {
  // 어떤 ref shot 의 STYLE 을 빌렸는지
  ref_index: number;
  ref_caption_layers: CaptionLayer[];        // ref shot 의 자막 layers (있으면)
  ref_transition: string;

  // 실제 사용된 소스
  source_video_id: string;
  source_filename: string;
  source_shot_index: number;
  source_start: number;
  source_end: number;
  source_spoken_text: string;
  source_scene_description: string;
  source_shot_type: string;
  source_has_speech: boolean;       // spoken_text 가 의미 있게 있으면 true. Stage 4 에서 노이즈 판단에 사용.

  // 출력 타임라인
  output_start: number;
  output_end: number;

  // 매칭 메타
  match_score: number;
  match_reason: string;

  // smart reframe
  subject_center_x: number;
  subject_center_y: number;

  // punch-in 줌 배수 (1.0 = 줌 없음). ref shot_type 의 프레이밍 강도를 모방.
  // 영상 렌더 시 9:16 crop 후 가운데(=주체)로 추가 확대.
  zoom: number;

  // ▼ caption planning 결과 — Stage 3 가 이걸로 렌더링
  planned_caption_layers: CaptionLayer[];
};

// ref shot_type → punch-in 줌 배수. 클로즈업/제품처럼 타이트한 프레이밍이면 더 확대.
// 화질 손실 방지를 위해 최대 1.3 으로 제한.
function zoomForShotType(shotType?: string): number {
  switch (String(shotType || '').toLowerCase()) {
    case 'close_up': return 1.30;
    case 'product': return 1.25;
    case 'selfie': return 1.15;
    case 'medium': return 1.12;
    default: return 1.0;   // wide / pov / b_roll / text_only / 미상
  }
}

// 줌 배수 안전 클램프 — 화질 손실 방지를 위해 1.0~1.3.
function clampZoom(z: any): number {
  const n = Number(z);
  if (!Number.isFinite(n)) return 1.0;
  return Math.max(1.0, Math.min(1.3, n));
}

export async function runStage1(projectId: string): Promise<{
  ok: true;
  total_cuts: number;
  output_duration: number;
  sources_used: number;
  cuts_with_caption: number;
  total_caption_layers: number;
}> {
  // ---- spec 로드 ----
  const spec: any = await readJson(ARTIFACTS.editSpec(projectId));
  if (!spec) throw new Error('Stage 0 (edit-spec.json) 결과가 없습니다. 먼저 Stage 0 을 실행하세요.');
  if (!Array.isArray(spec.shots) || spec.shots.length === 0) throw new Error('edit-spec.shots 가 비어 있습니다');

  // ---- 소스 영상 목록 ----
  const srcDir = sourcesDir(projectId);
  const srcFiles = (await fs.readdir(srcDir).catch(() => []))
    .filter(f => !f.startsWith('.'));
  if (srcFiles.length === 0) throw new Error('소스 영상이 없습니다');

  // ---- 1a + 1b: 각 소스에 대해 shot 검출 + Flash 묘사 ----
  const styleNote = await readStyleNote(projectId);
  const styleBlock = styleNoteBlock(styleNote);

  // 각 소스 영상은 독립적이라 병렬로 처리. 입력 순서를 그대로 유지하기 위해
  // Promise.all 결과를 인덱스로 매핑.
  const sourceVideos: SourceVideo[] = await Promise.all(srcFiles.map(async (filename, i) => {
    const filePath = path.join(srcDir, filename);
    const videoId = `vid_${i}`;

    if (isImageFile(filename)) {
      const merged = await analyzeImageSource({ projectId, videoId, filename, filePath, styleBlock });
      return {
        video_id: videoId,
        filename,
        duration: IMAGE_CLIP_DURATION_SEC,
        shots: [merged],
        is_image: true,
      };
    }

    const duration = await probeDuration(filePath);
    const ffShots: Shot[] = await detectShots(filePath, 0.22);
    // shot 이 많으면 batch 로 쪼개 분석 (요청총량/출력잘림 회피). 적으면 단일 호출.
    const merged = await analyzeSourceMerged({ projectId, videoId, filePath, ffShots, styleBlock, filename });
    return { video_id: videoId, filename, duration, shots: merged, is_image: false };
  }));
  await writeJson(ARTIFACTS.sourceShots(projectId), { videos: sourceVideos });

  // ---- 1c: embedding (source 먼저 — 긴 소스 reduce 가 임베딩을 필요로 함) ----
  let srcEntries: { v: SourceVideo; s: SourceShot; text: string }[] = [];
  for (const v of sourceVideos) for (const s of v.shots) {
    srcEntries.push({ v, s, text: buildSrcEmbedText(s) });
  }
  if (srcEntries.length === 0) throw new Error('소스 shot 이 비어 있습니다 (Flash 응답 확인 필요)');

  let srcVecs = await embedTexts(srcEntries.map(e => e.text));

  // ---- 1c-bis: 긴 소스 축약 (추정 출력이 TARGET_MAX_SEC 초과일 때만) ----
  const estimatedSec = srcEntries.reduce(
    (sum, e) => sum + Math.max(0.05, Math.min(e.s.end - e.s.start, MAX_CUT_DUR)), 0,
  );
  if (estimatedSec > TARGET_MAX_SEC) {
    const userDirectionBlock = styleNote.trim() ? styleNote.trim() : undefined;
    const cands: ReduceCandidate[] = srcEntries.map(e => ({
      video_id: e.v.video_id,
      start: e.s.start,
      end: e.s.end,
      quality_score: e.s.quality_score,
      shot_type: e.s.shot_type,
      scene_description: e.s.scene_description,
      spoken_text: e.s.spoken_text,
      tags: e.s.tags,
    }));
    const reduced = await reduceSourceShots(cands, srcVecs, {
      targetSec: TARGET_SEC, minSec: TARGET_MIN_SEC, maxSec: TARGET_MAX_SEC,
      maxCutDur: MAX_CUT_DUR, userDirectionBlock,
    });
    await appendRawResponse(projectId, {
      stage: 1, kind: 'source_reduction',
      input_shots: srcEntries.length, estimated_sec: round3(estimatedSec),
      method: reduced.method, kept: reduced.keptOrder.length,
      dedup_removed: reduced.dedupRemoved, result_sec: reduced.estimatedSec,
    });
    srcEntries = reduced.keptOrder.map(i => srcEntries[i]);
    srcVecs = reduced.keptOrder.map(i => srcVecs[i]);
  }

  // ---- ref embedding ----
  const refTexts = spec.shots.map((s: any) => buildRefEmbedText(s));
  const refVecs = await embedTexts(refTexts);
  await appendRawResponse(projectId, {
    stage: 1, kind: 'openai_embeddings',
    count: refTexts.length + srcEntries.length, model: config.OPENAI_EMBEDDING_MODEL,
  });

  // ---- 1d: 각 source shot 마다 가장 잘 어울리는 ref shot 의 STYLE 을 빌려온다 ----
  // (ref 는 재사용 OK — 스타일은 여러 source 에 적용 가능. source 는 한 번씩만 사용.)
  const plan: EditPlanItem[] = [];
  let outCursor = 0;

  for (let i = 0; i < srcEntries.length; i++) {
    const e = srcEntries[i];

    // 가장 어울리는 ref shot 찾기 (스타일 빌려오기 위해)
    let bestRefIdx = 0;
    let bestSim = -1;
    for (let j = 0; j < spec.shots.length; j++) {
      const sim = cosineSim(refVecs[j], srcVecs[i]);
      const styleSim = shotTypeBonus(spec.shots[j].shot_type, e.s.shot_type) * 0.2;
      const score = sim + styleSim;
      if (score > bestSim) { bestSim = score; bestRefIdx = j; }
    }
    const ref = spec.shots[bestRefIdx];

    const win = pickWindow(e.s);
    const useDur = Math.max(0.05, win.end - win.start);

    plan.push({
      ref_index: typeof ref.index === 'number' ? ref.index : bestRefIdx,
      ref_caption_layers: normalizeLayers(ref.caption_layers),
      ref_transition: ref.transition_to_next || 'cut',

      source_video_id: e.v.video_id,
      source_filename: e.v.filename,
      source_shot_index: e.s.source_index,
      source_start: round3(win.start),
      source_end: round3(win.end),
      source_spoken_text: e.s.spoken_text || '',
      source_scene_description: e.s.scene_description || '',
      source_shot_type: e.s.shot_type || '',
      // 의미 있는 발화가 있는지 — 빈/매우 짧은 spoken_text 는 노이즈로 간주
      source_has_speech: !!(e.s.spoken_text && e.s.spoken_text.trim().length >= 3),

      output_start: round3(outCursor),
      output_end: round3(outCursor + useDur),

      match_score: round3(bestSim),
      match_reason: `style←ref#${bestRefIdx} sim=${bestSim.toFixed(2)}`,

      subject_center_x: round3(e.s.subject_center_x),
      subject_center_y: round3(e.s.subject_center_y),

      zoom: zoomForShotType(ref.shot_type),

      planned_caption_layers: [], // caption planning 단계에서 채움
    });

    outCursor += useDur;
  }

  // ---- 1d-bis: caption planning (각 컷의 자막을 ref 패턴 + 소스 내용 + styleBrief + styleNote 로 미리 작성) ----
  await planCaptions(projectId, plan, spec);

  const editPlan = {
    aspect_ratio: '9:16',
    output_duration: round3(outCursor),
    items: plan,
    note: '각 source shot 이 한 컷씩 사용됨. ref shot 은 STYLE 만 제공. 자막은 Stage 1 끝에서 미리 작성됨.',
  };
  await writeJson(ARTIFACTS.editPlan(projectId), editPlan);

  // ---- 1e: 실제 FFmpeg 렌더 ----
  await renderCut(projectId, editPlan, sourceVideos);

  const cutsWithCaption = plan.filter(p => (p.planned_caption_layers || []).length > 0).length;
  const totalLayers = plan.reduce((s, p) => s + (p.planned_caption_layers?.length || 0), 0);
  return {
    ok: true,
    total_cuts: plan.length,
    output_duration: editPlan.output_duration,
    sources_used: sourceVideos.length,
    cuts_with_caption: cutsWithCaption,
    total_caption_layers: totalLayers,
  };
}

// ============================================================
// Caption Planning (layer 기반)
// ref shot 의 caption_layers + caption_pattern + 소스 내용 + styleNote +
// (선택) extraFeedback 으로 각 컷의 layers 를 미리 작성.
// /api/replan-captions 에서도 재사용하기 위해 export.
// ============================================================
// ============================================================
// 소스 분석 fast path:
//   1) shot 당 대표 프레임 1장 추출
//   2) 영상 전체 오디오를 mp3 로 디멀티플렉스 (오디오 있을 때만)
//   3) (frames[], audio?) + prompt 를 멀티파트로 Gemini Flash 에 호출
// 풀 영상 업로드 대비 페이로드 1/10~1/50.
//
// 폴백 사다리:
//   multipart Flash → multipart Pro → 풀 영상 Pro → 로컬 기본값
// ============================================================
// ============================================================
// 소스 분석 진입점: shot 수가 많으면 batch 로 쪼개 호출하고 합친다.
// (batch 모드는 audio 도 구간만 잘라 보내고, 풀영상 폴백은 끄고 로컬 폴백만 — 인덱스 정합 보장)
// ============================================================
async function analyzeSourceMerged(args: {
  projectId: string;
  videoId: string;
  filePath: string;
  ffShots: Shot[];
  styleBlock: string;
  filename: string;
}): Promise<SourceShot[]> {
  const { ffShots } = args;
  if (ffShots.length <= SINGLE_CALL_SHOT_MAX) {
    return analyzeOneBatch({ ...args, batchShots: ffShots, globalOffset: 0, batched: false });
  }
  const out: SourceShot[] = [];
  for (let b = 0; b < ffShots.length; b += SOURCE_SHOT_BATCH) {
    const batchShots = ffShots.slice(b, b + SOURCE_SHOT_BATCH);
    const merged = await analyzeOneBatch({ ...args, batchShots, globalOffset: b, batched: true });
    out.push(...merged);
  }
  return out;
}

async function analyzeOneBatch(args: {
  projectId: string;
  videoId: string;
  filePath: string;
  batchShots: Shot[];
  globalOffset: number;
  styleBlock: string;
  filename: string;
  batched: boolean;
}): Promise<SourceShot[]> {
  const { projectId, videoId, filePath, batchShots, globalOffset, styleBlock, filename, batched } = args;

  // batch-로컬 인덱스로 프롬프트 작성 (응답은 위치 기준으로 매핑)
  const shotsForPrompt = batchShots.map((s, k) => ({ index: k, start: s.start, end: s.end }));
  const audioRange = batched && batchShots.length > 0
    ? { start: batchShots[0].start, end: batchShots[batchShots.length - 1].end }
    : undefined;

  const { raw, parsed, kind } = await analyzeSourceWithMultipartFallback({
    projectId, videoId, filePath,
    ffShots: batchShots,
    shotsJsonForPrompt: JSON.stringify(shotsForPrompt, null, 2),
    styleBlock,
    audioRange,
    allowFullVideoFallback: !batched,   // batch 모드는 풀영상 폴백 끔 (인덱스 어긋남 방지)
  });
  await appendRawResponse(projectId, {
    stage: 1, kind, video_id: videoId, filename,
    batched, batch_offset: globalOffset, batch_size: batchShots.length,
    response: raw,
  });

  const flashShots: any[] = Array.isArray(parsed?.shots) ? parsed.shots : [];
  return batchShots.map((ff, k) => {
    const f = flashShots[k] || {};
    const hs = Number(f.highlight_start);
    const he = Number(f.highlight_end);
    const validHighlight = isFinite(hs) && isFinite(he) && he > hs && hs >= ff.start - 0.05 && he <= ff.end + 0.05;
    const sxRaw = Number(f.subject_center_x);
    const syRaw = Number(f.subject_center_y);
    return {
      video_id: videoId,
      source_index: globalOffset + k,
      start: ff.start,
      end: ff.end,
      duration: ff.duration,
      shot_type: String(f.shot_type || 'medium'),
      subject: String(f.subject || ''),
      scene_description: String(f.scene_description || ''),
      tags: Array.isArray(f.tags) ? f.tags.map(String) : [],
      camera_motion: String(f.camera_motion || 'static'),
      spoken_text: String(f.spoken_text || ''),
      quality_score: clamp01(Number(f.quality_score)),
      highlight_start: validHighlight ? hs : ff.start,
      highlight_end: validHighlight ? he : Math.min(ff.end, ff.start + Math.min(2.0, ff.duration)),
      highlight_reason: String(f.highlight_reason || ''),
      subject_center_x: isFinite(sxRaw) ? clamp01(sxRaw) : 0.5,
      subject_center_y: isFinite(syRaw) ? clamp01(syRaw) : 0.5,
    };
  });
}

async function analyzeSourceWithMultipartFallback(args: {
  projectId: string;
  videoId: string;
  filePath: string;
  ffShots: Shot[];
  shotsJsonForPrompt: string;
  styleBlock: string;
  audioRange?: { start: number; end: number };
  allowFullVideoFallback?: boolean;
}): Promise<{ raw: any; parsed: any; kind: string }> {
  const { projectId, videoId, filePath, ffShots, shotsJsonForPrompt, styleBlock, audioRange } = args;
  const allowFullVideoFallback = args.allowFullVideoFallback !== false;

  // 폴백: 풀영상 허용이면 풀영상 Pro → 로컬, 아니면 곧장 로컬.
  const doFallback = (reason: string): Promise<{ raw: any; parsed: any; kind: string }> =>
    allowFullVideoFallback
      ? fallbackToFullVideo({ filePath, ffShots, styleBlock, shotsJsonForPrompt, reason })
      : Promise.resolve(localFallback(ffShots, reason));

  // 1) 매체 추출 (work 디렉토리에 임시 저장)
  const work = workDir(projectId);
  await ensureDir(work);
  const tmpRoot = path.join(work, `_analyze_${videoId}_${audioRange ? Math.round(audioRange.start) : 'all'}`);
  await ensureDir(tmpRoot);

  let frames: string[] = [];
  let audioPath: string | null = null;
  try {
    frames = await extractShotFrames(filePath, ffShots, tmpRoot);
    const audible = await hasAudioStream(filePath);
    if (audible) {
      const audioOut = path.join(tmpRoot, 'audio.mp3');
      try {
        if (audioRange) {
          await extractAudioRange(filePath, audioRange.start, audioRange.end - audioRange.start, audioOut);
        } else {
          await extractAudio(filePath, audioOut);
        }
        audioPath = audioOut;
      } catch {
        audioPath = null; // 오디오 추출 실패해도 분석은 계속.
      }
    }
  } catch (extractErr: any) {
    return doFallback(`media_extract_failed: ${extractErr?.message || String(extractErr)}`);
  }

  const promptMulti = styleBlock + buildSourceDescriptionPromptMultipart({
    shotsJson: shotsJsonForPrompt,
    framesPerShot: 1,
    hasAudio: !!audioPath,
  });

  const mediaParts: MediaPart[] = [
    ...frames.map(f => ({ filePath: f, mimeType: 'image/jpeg' } as MediaPart)),
    ...(audioPath ? [{ filePath: audioPath, mimeType: 'audio/mpeg' } as MediaPart] : []),
  ];

  // 2) Flash 멀티파트
  try {
    const result = await analyzeMultiPartStructured(mediaParts, promptMulti, config.GEMINI_FLASH_MODEL);
    return { ...result, kind: 'gemini_flash_multipart' };
  } catch (flashErr: any) {
    const flashError = flashErr?.message || String(flashErr);
    if (!isRetryableGeminiError(flashError)) {
      return doFallback(`multipart_flash_fatal: ${flashError.slice(0, 300)}`);
    }

    // 3) Pro 멀티파트
    try {
      const result = await analyzeMultiPartStructured(mediaParts, promptMulti, config.GEMINI_PRO_MODEL);
      return {
        ...result,
        kind: 'gemini_pro_multipart_fallback',
        raw: {
          ...result.raw,
          fallback_reason: flashError.slice(0, 500),
        },
      };
    } catch (proErr: any) {
      const proError = proErr?.message || String(proErr);
      return doFallback(`multipart_failed flash=${flashError.slice(0, 200)} pro=${proError.slice(0, 200)}`);
    }
  }
}

// 로컬 폴백 결과 (Gemini 없이 FFmpeg shot 경계만으로 기본 묘사).
function localFallback(ffShots: Shot[], reason: string): { raw: any; parsed: any; kind: string } {
  return {
    raw: { fallback: true, fallback_reason: reason },
    parsed: fallbackSourceDescription(ffShots),
    kind: 'local_source_description_fallback',
  };
}

// ============================================================
// 이미지 소스 분석: 단일 이미지를 Gemini 에 보내 1-shot 정보를 받는다.
// camera_motion 은 항상 "static", spoken_text 는 항상 "".
// ============================================================
async function analyzeImageSource(args: {
  projectId: string;
  videoId: string;
  filename: string;
  filePath: string;
  styleBlock: string;
}): Promise<SourceShot> {
  const { projectId, videoId, filename, filePath, styleBlock } = args;
  const prompt = styleBlock + buildImageSourceDescriptionPrompt({ durationSec: IMAGE_CLIP_DURATION_SEC });

  let parsed: any = {};
  let kind = 'gemini_flash_image';
  try {
    const result = await analyzeMultiPartStructured(
      [{ filePath, mimeType: undefined }],
      prompt,
      config.GEMINI_FLASH_MODEL,
    );
    parsed = result.parsed || {};
    await appendRawResponse(projectId, {
      stage: 1, kind, video_id: videoId, filename, response: result.raw,
    });
  } catch (flashErr: any) {
    const flashError = flashErr?.message || String(flashErr);
    if (isRetryableGeminiError(flashError)) {
      try {
        const result = await analyzeMultiPartStructured(
          [{ filePath, mimeType: undefined }],
          prompt,
          config.GEMINI_PRO_MODEL,
        );
        parsed = result.parsed || {};
        kind = 'gemini_pro_image_fallback';
        await appendRawResponse(projectId, {
          stage: 1, kind, video_id: videoId, filename,
          response: { ...result.raw, fallback_reason: flashError.slice(0, 300) },
        });
      } catch (proErr: any) {
        kind = 'local_image_fallback';
        await appendRawResponse(projectId, {
          stage: 1, kind, video_id: videoId, filename,
          response: { fallback: true, flash_error: flashError.slice(0, 300), pro_error: (proErr?.message || String(proErr)).slice(0, 300) },
        });
      }
    } else {
      kind = 'local_image_fallback';
      await appendRawResponse(projectId, {
        stage: 1, kind, video_id: videoId, filename,
        response: { fallback: true, error: flashError.slice(0, 500) },
      });
    }
  }

  const sxRaw = Number(parsed.subject_center_x);
  const syRaw = Number(parsed.subject_center_y);
  return {
    video_id: videoId,
    source_index: 0,
    start: 0,
    end: IMAGE_CLIP_DURATION_SEC,
    duration: IMAGE_CLIP_DURATION_SEC,
    shot_type: String(parsed.shot_type || 'medium'),
    subject: String(parsed.subject || ''),
    scene_description: String(parsed.scene_description || 'still image source'),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : ['still_image', 'photo'],
    camera_motion: 'static',
    spoken_text: '',
    quality_score: clamp01(Number(parsed.quality_score)),
    highlight_start: 0,
    highlight_end: IMAGE_CLIP_DURATION_SEC,
    highlight_reason: 'still image',
    subject_center_x: isFinite(sxRaw) ? clamp01(sxRaw) : 0.5,
    subject_center_y: isFinite(syRaw) ? clamp01(syRaw) : 0.5,
  };
}

// shot 별로 대표 프레임 1장 (시작+50% 지점) 을 jpg 로 추출.
// shot 대표 프레임(중앙)을 제한된 동시성으로 병렬 추출.
// 프레임당 fast-seek 라 가벼워서, 순차보다 wall-clock 이 줄어든다.
// (소스들도 이미 병렬 처리되므로 동시성은 3 으로 보수적으로 둠.)
const FRAME_EXTRACT_CONCURRENCY = 3;

async function extractShotFrames(filePath: string, shots: Shot[], outDir: string): Promise<string[]> {
  const outPaths = shots.map((_, k) => path.join(outDir, `shot_${String(k).padStart(4, '0')}.jpg`));
  let next = 0;
  const worker = async () => {
    while (true) {
      const k = next++;                       // 단일스레드 이벤트루프라 원자적
      if (k >= shots.length) return;
      const s = shots[k];
      const mid = s.start + (s.end - s.start) / 2;
      await extractFrame(filePath, mid, outPaths[k]);
    }
  };
  const lanes = Math.min(FRAME_EXTRACT_CONCURRENCY, Math.max(1, shots.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return outPaths;
}

async function fallbackToFullVideo(args: {
  filePath: string;
  ffShots: Shot[];
  styleBlock: string;
  shotsJsonForPrompt: string;
  reason: string;
}): Promise<{ raw: any; parsed: any; kind: string }> {
  const { filePath, ffShots, styleBlock, shotsJsonForPrompt, reason } = args;
  // 풀 영상 prompt 는 별도로 빌드. 멀티파트와 스키마 동일.
  const fullPrompt = styleBlock + buildSourceDescriptionPrompt(shotsJsonForPrompt);
  try {
    const result = await analyzeVideoStructured(filePath, fullPrompt, config.GEMINI_PRO_MODEL);
    return {
      ...result,
      kind: 'gemini_pro_full_video_fallback',
      raw: { ...result.raw, fallback_reason: reason },
    };
  } catch (e: any) {
    const parsed = fallbackSourceDescription(ffShots);
    return {
      raw: {
        fallback: true,
        fallback_reason: reason,
        full_video_error: (e?.message || String(e)).slice(0, 500),
      },
      parsed,
      kind: 'local_source_description_fallback',
    };
  }
}

function isRetryableGeminiError(message: string): boolean {
  return /Gemini .* (429|500|502|503|504):/.test(message);
}

function fallbackSourceDescription(ffShots: Shot[]): { shots: any[] } {
  return {
    shots: ffShots.map((s, index) => ({
      index,
      start: s.start,
      end: s.end,
      shot_type: 'medium',
      subject: '',
      scene_description: `Source video segment ${index + 1}`,
      tags: ['source_video', 'auto_fallback'],
      camera_motion: 'static',
      spoken_text: '',
      quality_score: 0.5,
      highlight_start: s.start,
      highlight_end: Math.min(s.end, s.start + Math.min(2, s.duration)),
      highlight_reason: 'Fallback segment selected from FFmpeg shot boundaries.',
      subject_center_x: 0.5,
      subject_center_y: 0.5,
    })),
  };
}

export async function planCaptions(
  projectId: string,
  plan: EditPlanItem[],
  spec: any,
  extraFeedback?: string,
): Promise<void> {
  if (!config.GEMINI_API_KEY) {
    fallbackToRefLayers(plan);
    return;
  }

  // 사용자 방향 입력 결합: structured brief + freeform styleNote
  const brief = await readStyleBrief(projectId);
  const briefBlock = briefToPromptBlock(brief);
  const styleNote = await readStyleNote(projectId);
  const styleNoteBlockText = styleNote.trim()
    ? `\n[추가 자유 메모]\n${styleNote.trim()}\n`
    : '';
  const userDirectionBlock = briefBlock + styleNoteBlockText;

  const refCutsWithLayers = (spec?.shots || []).map((s: any, i: number) => ({
    idx: typeof s.index === 'number' ? s.index : i,
    layers: normalizeLayers(s.caption_layers),
  }));
  const refPattern = spec?.caption_pattern || {};

  const cuts = plan.map((it, i) => ({
    idx: i,
    duration: Math.max(0.05, (it.output_end - it.output_start)),
    spoken: it.source_spoken_text,
    description: it.source_scene_description,
    shot_type: it.source_shot_type,
    subject_center_x: it.subject_center_x,
    subject_center_y: it.subject_center_y,
    matched_ref_idx: it.ref_index,
    matched_ref_layers: it.ref_caption_layers || [],
  }));

      const prompt = buildCaptionPlanningPrompt({
        userDirectionBlock,
        captionMode: brief.caption_mode,
        captionLanguage: brief.caption_language,
        refCutsWithLayers,
        refPattern,
    cuts,
    extraFeedback,
  });

  try {
    // temperature 0.5: 창의적 변형 줄이고 지시(폰트 복사, 카테고리 유지 등) 충실하게.
    let { parsed } = await callGeminiTextOnly(prompt, { temperature: 0.5, maxOutputTokens: 16384 });
    await appendRawResponse(projectId, {
      stage: 1, kind: 'caption_planning',
      cuts_count: cuts.length, raw_returned: Array.isArray(parsed?.cuts) ? parsed.cuts.length : 0,
      with_feedback: !!extraFeedback,
      caption_language: brief.caption_language || 'ref',
    });

    if (!captionLanguageSatisfied(parsed, brief.caption_language)) {
      const retryPrompt = buildCaptionPlanningPrompt({
        userDirectionBlock,
        captionMode: brief.caption_mode,
        captionLanguage: brief.caption_language,
        refCutsWithLayers,
        refPattern,
        cuts,
        extraFeedback: [
          extraFeedback || '',
          languageRetryInstruction(brief.caption_language),
        ].filter(Boolean).join('\n\n'),
      });
      const retry = await callGeminiTextOnly(retryPrompt, { temperature: 0.35, maxOutputTokens: 16384 });
      parsed = retry.parsed;
      await appendRawResponse(projectId, {
        stage: 1, kind: 'caption_planning_language_retry',
        caption_language: brief.caption_language,
        raw_returned: Array.isArray(parsed?.cuts) ? parsed.cuts.length : 0,
      });
    }

    applyCaptionPlanFromParsed(plan, parsed, brief.caption_mode, brief.caption_density);
  } catch (e: any) {
    await appendRawResponse(projectId, {
      stage: 1, kind: 'caption_planning_failed',
      error: e.message || String(e),
    });
    fallbackToRefLayers(plan);
    enforceCaptionMode(plan, brief.caption_mode, brief.caption_density);
  }
}

function applyCaptionPlanFromParsed(plan: EditPlanItem[], parsed: any, captionMode?: string, captionDensity?: string): void {
  const arr: any[] = Array.isArray(parsed?.cuts) ? parsed.cuts : [];
  const byIdx = new Map<number, any>();
  for (const c of arr) byIdx.set(Number(c.cut_index), c);

  for (let i = 0; i < plan.length; i++) {
    const c = byIdx.get(i);
    if (!c || !Array.isArray(c.layers)) {
      // Gemini 가 cut 자체를 빠뜨렸을 때만 ref 의 layers 를 폴백한다.
      plan[i].planned_caption_layers = plan[i].ref_caption_layers || [];
      continue;
    }
    // layers: [] 는 "이 컷에는 자막 없음"이라는 정상 응답이므로 그대로 보존한다.
    plan[i].planned_caption_layers = normalizeLayers(c.layers);
  }
  enforceCaptionMode(plan, captionMode, captionDensity);
}

function enforceCaptionMode(plan: EditPlanItem[], captionMode?: string, captionDensity?: string): void {
  const mode = normalizeCaptionMode(captionMode, captionDensity);
  if (mode === 'none') {
    for (const it of plan) it.planned_caption_layers = [];
    return;
  }
  if (mode === 'continuous') {
    const layers = pickContinuousCaptionLayers(plan);
    for (const it of plan) it.planned_caption_layers = cloneLayers(layers);
    return;
  }
  if (!captionMode) enforceCaptionDensity(plan, captionDensity);
}

function normalizeCaptionMode(captionMode?: string, captionDensity?: string): 'none' | 'per_scene' | 'continuous' {
  if (captionMode === 'none' || captionMode === 'continuous' || captionMode === 'per_scene') return captionMode;
  if (captionDensity === 'none') return 'none';
  return 'per_scene';
}

function pickContinuousCaptionLayers(plan: EditPlanItem[]): CaptionLayer[] {
  const candidates = plan
    .map(it => (it.planned_caption_layers || []).filter(l => String(l.text || '').trim()))
    .filter(layers => layers.length > 0);
  if (candidates.length === 0) return [];

  const counted = new Map<string, { layers: CaptionLayer[]; count: number; first: number }>();
  candidates.forEach((layers, index) => {
    const key = layers.map(l => `${l.text}|${l.position}|${l.horizontal_align}|${l.size_level}`).join('||');
    const prev = counted.get(key);
    if (prev) prev.count += 1;
    else counted.set(key, { layers, count: 1, first: index });
  });

  return Array.from(counted.values())
    .sort((a, b) => b.count - a.count || a.first - b.first)[0]
    .layers
    .slice(0, 2);
}

function cloneLayers(layers: CaptionLayer[]): CaptionLayer[] {
  return layers.map(l => ({ ...l }));
}

function enforceCaptionDensity(plan: EditPlanItem[], captionDensity?: string): void {
  if (!captionDensity || captionDensity === 'every_cut') return;
  if (captionDensity === 'none') {
    for (const it of plan) it.planned_caption_layers = [];
    return;
  }

  const target = targetCaptionedCuts(plan.length, captionDensity);
  const captioned = plan
    .map((it, index) => ({ it, index }))
    .filter(x => (x.it.planned_caption_layers || []).length > 0);
  if (captioned.length <= target) return;

  const keep = new Set<number>();
  if (target > 0) {
    for (let i = 0; i < target; i++) {
      const pick = Math.round(i * (captioned.length - 1) / Math.max(1, target - 1));
      keep.add(captioned[pick].index);
    }
  }
  for (const { it, index } of captioned) {
    if (!keep.has(index)) it.planned_caption_layers = [];
  }
}

function targetCaptionedCuts(totalCuts: number, captionDensity: string): number {
  if (totalCuts <= 0) return 0;
  if (captionDensity === 'minimal') return Math.max(1, Math.ceil(totalCuts * 0.2));
  if (captionDensity === 'occasional') return Math.max(1, Math.ceil(totalCuts * 0.4));
  if (captionDensity === 'most_cuts') return Math.max(1, Math.ceil(totalCuts * 0.75));
  return totalCuts;
}

function captionLanguageSatisfied(parsed: any, mode?: string): boolean {
  if (!mode) return true;
  const cuts: any[] = Array.isArray(parsed?.cuts) ? parsed.cuts : [];
  const captioned = cuts
    .map(c => Array.isArray(c?.layers) ? c.layers.map((l: any) => String(l?.text || '')).join(' ') : '')
    .map(s => s.trim())
    .filter(Boolean);
  if (captioned.length === 0) return true;

  if (mode === 'en') return captioned.every(s => !hasHangul(s));
  if (mode === 'ko') return captioned.every(s => hasHangul(s));
  if (mode === 'mixed') return captioned.every(s => hasHangul(s) && hasLatin(s));
  return true;
}

function languageRetryInstruction(mode?: string): string {
  if (mode === 'mixed') {
    return '언어 모드 검증 실패: 자막이 있는 모든 cut 의 전체 text 에 한글과 영어 알파벳이 모두 포함되도록 다시 작성해라. 한글만 또는 영어만 있는 자막은 금지다.';
  }
  if (mode === 'en') {
    return '언어 모드 검증 실패: 모든 자막 text 를 영어로 다시 작성해라. 한국어 문장/조사/어미는 금지다.';
  }
  if (mode === 'ko') {
    return '언어 모드 검증 실패: 모든 자막 text 를 자연스러운 한국어로 다시 작성해라.';
  }
  return '';
}

function hasHangul(s: string): boolean {
  return /[가-힣]/.test(s);
}

function hasLatin(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

function fallbackToRefLayers(plan: EditPlanItem[]): void {
  for (const it of plan) {
    it.planned_caption_layers = it.ref_caption_layers || [];
  }
}

// 입력 layer 배열을 안전한 형태로 정제 (빈 객체/누락 필드 처리)
function normalizeLayers(raw: any): CaptionLayer[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptionLayer[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const text = String(r.text || '').trim();
    if (!text) continue;
    out.push({
      text,
      position: String(r.position || 'bottom').toLowerCase(),
      horizontal_align: String(r.horizontal_align || 'center').toLowerCase(),
      size_level: String(r.size_level || 'medium').toLowerCase(),
      color_hex: typeof r.color_hex === 'string' ? r.color_hex : '',
      emphasis: String(r.emphasis || 'bold').toLowerCase(),
      italic: r.italic === true,
      font_category: String(r.font_category || 'sans').toLowerCase(),
      font_personality: String(r.font_personality || '').toLowerCase(),
      role: String(r.role || 'none').toLowerCase(),
      tone: String(r.tone || 'none').toLowerCase(),
      // 외곽선/그림자/박스/그라데이션/글로우/자간/등장애니메이션 — 렌더러가 쓰는
      // 디자인 필드를 보존해야 레퍼런스 자막 형식이 결과물까지 전달된다.
      ...preserveLayerDesign(r),
    });
  }
  return out;
}

// ============================================================
// 매칭용 텍스트 빌더
// ============================================================
function buildRefEmbedText(s: any): string {
  const parts = [
    `shot_type:${s.shot_type || ''}`,
    `subject:${s.subject || ''}`,
    `scene:${s.scene_description || ''}`,
    `composition:${s.composition || ''}`,
    `camera_motion:${s.camera_motion || ''}`,
    `tags:${(s.required_tags || []).join(',')}`,
  ];
  return parts.filter(Boolean).join(' | ');
}
function buildSrcEmbedText(s: SourceShot): string {
  const parts = [
    `shot_type:${s.shot_type || ''}`,
    `subject:${s.subject || ''}`,
    `scene:${s.scene_description || ''}`,
    `camera_motion:${s.camera_motion || ''}`,
    `tags:${(s.tags || []).join(',')}`,
    `spoken:${s.spoken_text || ''}`,
  ];
  return parts.filter(Boolean).join(' | ');
}

function shotTypeBonus(a: string, b: string): number {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const groups = [
    ['close_up', 'closeup', 'macro', 'product', 'detail'],
    ['medium', 'mid', 'selfie', 'half_body'],
    ['wide', 'long', 'establishing', 'landscape'],
  ];
  for (const g of groups) if (g.includes(na) && g.includes(nb)) return 0.5;
  return 0;
}
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function clamp01(n: number): number {
  if (!isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// 한 컷 윈도우 결정. highlight 중심으로 ≤MAX_CUT_DUR 잘라낸다.
const MAX_CUT_DUR = 4.5;
function pickWindow(s: SourceShot): { start: number; end: number } {
  const segDur = Math.max(0.05, s.end - s.start);
  if (segDur <= MAX_CUT_DUR) {
    return { start: s.start, end: s.end };
  }
  const useDur = MAX_CUT_DUR;
  const c = (s.highlight_start + s.highlight_end) / 2;
  let start = c - useDur / 2;
  let end = start + useDur;
  if (start < s.start) { start = s.start; end = start + useDur; }
  if (end > s.end) { end = s.end; start = end - useDur; }
  return { start, end };
}

function round3(n: number) { return Math.round(n * 1000) / 1000; }

// ============================================================
// FFmpeg 렌더
// ============================================================
async function renderCut(
  projectId: string,
  plan: { items: EditPlanItem[] },
  sources: SourceVideo[],
): Promise<void> {
  const work = workDir(projectId);
  await ensureDir(work);

  for (const f of (await fs.readdir(work).catch(() => []))) {
    if (f.startsWith('seg_') || f === 'concat.txt') {
      await fs.rm(path.join(work, f), { force: true });
    }
  }

  const srcEntry = (videoId: string): SourceVideo => {
    const m = sources.find(s => s.video_id === videoId);
    if (!m) throw new Error(`source video_id ${videoId} not found`);
    return m;
  };
  const srcPath = (videoId: string) => path.join(sourcesDir(projectId), srcEntry(videoId).filename);

  const segOuts: string[] = [];
  for (let i = 0; i < plan.items.length; i++) {
    const it = plan.items[i];
    const src = srcEntry(it.source_video_id);
    const inFile = srcPath(it.source_video_id);
    const segOut = path.join(work, `seg_${String(i).padStart(4, '0')}.mp4`);
    const dur = Math.max(0.05, it.source_end - it.source_start);

    const sx = typeof it.subject_center_x === 'number' ? it.subject_center_x : 0.5;
    const sy = typeof it.subject_center_y === 'number' ? it.subject_center_y : 0.5;
    const cropX = `max(0,min(max(0,iw-${OUT_W}),iw*${sx.toFixed(3)}-${OUT_W / 2}))`;
    const cropY = `max(0,min(max(0,ih-${OUT_H}),ih*${sy.toFixed(3)}-${OUT_H / 2}))`;

    if (src.is_image) {
      // 정지 이미지 → 무음 오디오 + 다양한 Ken Burns 류 모션 적용.
      // 인덱스와 subject 위치로 motion type 선택 (인접 이미지가 같은 모션이 되지 않도록).
      const frames = Math.max(2, Math.round(dur * 30));
      const motion = pickImageMotion(i, sx, sy);
      const zoompan = buildZoompanFilter(motion, frames);
      // scale 을 약간 oversize 후 정확히 crop. 부동소수점 변환 오차로
      // 1px 부족해 가장자리에 검은 라인이 보이는 사례 방지.
      const vf = [
        `scale=${OUT_W + 8}:${OUT_H + 8}:force_original_aspect_ratio=increase`,
        `crop=${OUT_W}:${OUT_H}:x='${cropX}':y='${cropY}'`,
        zoompan,
        'setsar=1',
      ].join(',');

      await runFfmpeg([
        '-y',
        '-loop', '1', '-framerate', '30', '-i', inFile,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-t', dur.toFixed(3),
        '-vf', vf,
        '-r', '30',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-shortest',
        segOut,
      ]);
      segOuts.push(segOut);
      continue;
    }

    // 영상도 동일하게 oversize 후 crop. force_original_aspect_ratio=increase 의
    // 1px 변환 오차로 가장자리 검은 라인이 보이는 케이스 방지.
    const vfParts = [
      `scale=${OUT_W + 8}:${OUT_H + 8}:force_original_aspect_ratio=increase`,
      `crop=${OUT_W}:${OUT_H}:x='${cropX}':y='${cropY}'`,
    ];
    // punch-in 줌 — 9:16 crop(주체가 가운데로 옴) 후, zoom>1 이면 가운데를 더 확대.
    // (ref shot_type 기반. 정적 확대라 안정적이고 "특정 부분을 zoom"하는 효과)
    const zoom = clampZoom(it.zoom);
    if (zoom > 1.001) {
      const cw = Math.round(OUT_W / zoom);
      const ch = Math.round(OUT_H / zoom);
      const zx = Math.round((OUT_W - cw) / 2);
      const zy = Math.round((OUT_H - ch) / 2);
      vfParts.push(`crop=${cw}:${ch}:${zx}:${zy}`);
      vfParts.push(`scale=${OUT_W}:${OUT_H}`);
    }
    vfParts.push('setsar=1');
    const vf = vfParts.join(',');

    await runFfmpeg([
      '-y',
      '-ss', it.source_start.toFixed(3),
      '-i', inFile,
      '-t', dur.toFixed(3),
      '-vf', vf,
      '-r', '30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-shortest',
      segOut,
    ]);
    segOuts.push(segOut);
  }

  const concatPath = path.join(work, 'concat.txt');
  const body = segOuts
    .map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  await fs.writeFile(concatPath, body, 'utf-8');

  await ensureDir(stageDir(projectId, 1));
  await runFfmpeg([
    '-y',
    '-f', 'concat', '-safe', '0',
    '-i', concatPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    ARTIFACTS.cutMp4(projectId),
  ], work);
}

// ============================================================
// 이미지 소스 모션 패턴
// crop 으로 이미 9:16 (1080x1920) 캔버스가 만들어진 뒤 zoompan 이 적용된다.
// 모션 종류:
//   zoom_in              가운데 향해 천천히 확대 (1.0 → 1.15)
//   zoom_out             확대된 상태에서 천천히 빠짐 (1.15 → 1.0)
//   pan_left             1.15 배율 고정, 오른쪽 → 왼쪽으로 패닝
//   pan_right            1.15 배율 고정, 왼쪽 → 오른쪽으로 패닝
//   ken_burns_diagonal   1.0 → 1.15 확대 + 대각선 이동
//
// 인덱스 순환 + subject 위치로 선택 (인접 이미지가 같은 모션이 되지 않게 함).
// ============================================================
type ImageMotion = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'ken_burns_diagonal';

function pickImageMotion(idx: number, subjectX: number, subjectY: number): ImageMotion {
  const cycle: ImageMotion[] = ['zoom_in', 'pan_right', 'zoom_out', 'pan_left', 'ken_burns_diagonal'];
  let motion = cycle[idx % cycle.length];
  // subject 가 한쪽에 치우쳐 있으면 그 쪽으로 가는 pan 선택을 우선해서
  // 피사체가 화면 밖으로 빠지지 않게 한다.
  if (motion === 'pan_left' && subjectX > 0.7) motion = 'pan_right';
  if (motion === 'pan_right' && subjectX < 0.3) motion = 'pan_left';
  return motion;
}

function buildZoompanFilter(motion: ImageMotion, frames: number): string {
  const s = `${OUT_W}x${OUT_H}`;
  const f = Math.max(2, frames);
  // 시작/끝 zoom 을 정확히 1.0 으로 두지 않는다. 1.0 일 때 zoompan 이 입력 전체를
  // 출력 크기로 매핑하는 과정에서 부동소수점 오차로 가장자리에 1~2px 검은 라인이
  // 보이는 사례 방지.  최소 1.02 부터 시작.
  const zLo = 1.02;
  const zHi = 1.15;
  const span = (zHi - zLo).toFixed(3);
  switch (motion) {
    case 'zoom_in': {
      const z = `${zLo}+${span}*on/${f}`;
      return `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${s}:fps=30`;
    }
    case 'zoom_out': {
      const z = `${zHi}-${span}*on/${f}`;
      return `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${s}:fps=30`;
    }
    case 'pan_left': {
      const z = `${zHi}`;
      const x = `(iw-iw/${z})*(1-on/${f})`;
      const y = `(ih-ih/${z})/2`;
      return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${s}:fps=30`;
    }
    case 'pan_right': {
      const z = `${zHi}`;
      const x = `(iw-iw/${z})*(on/${f})`;
      const y = `(ih-ih/${z})/2`;
      return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${s}:fps=30`;
    }
    case 'ken_burns_diagonal': {
      const z = `${zLo}+${span}*on/${f}`;
      // 좌상단 부근에서 시작해 가운데로 이동하며 확대.
      const x = `(iw-iw/zoom)*(on/${f})*0.5`;
      const y = `(ih-ih/zoom)*(on/${f})*0.5`;
      return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${s}:fps=30`;
    }
  }
}
