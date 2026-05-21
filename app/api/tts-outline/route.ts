// 나레이션 개요 (TTS 합성 전 검토용)
// - POST  { projectId } : Gemini Flash 로 새 개요 생성 (approved=false 로 저장)
// - PATCH { projectId, segments?, approved? } : 사용자가 편집/확인
import { NextRequest, NextResponse } from 'next/server';
import { ARTIFACTS, appendRawResponse, fileExists, readJson, readStyleNote } from '@/lib/paths';
import { readStyleBrief, briefToPromptBlock } from '@/lib/style-brief';
import { readTtsOutline, validateOutline, writeTtsOutline } from '@/lib/tts-outline';
import { analyzeVideoStructured, callGeminiTextOnly } from '@/lib/gemini';
import { buildNarrationOutlinePrompt, buildVideoEvaluationPrompt } from '@/lib/prompts';
import { config } from '@/lib/config';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { projectId } = await req.json();
  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });
  if (!config.GEMINI_API_KEY) return NextResponse.json({ error: 'GEMINI_API_KEY 없음' }, { status: 400 });

  const plan: any = await readJson(ARTIFACTS.editPlan(projectId));
  if (!plan?.items || !Array.isArray(plan.items) || plan.items.length === 0) {
    return NextResponse.json({ error: 'edit-plan.json 이 없습니다. Stage 1 을 먼저 실행하세요.' }, { status: 400 });
  }

  const brief = await readStyleBrief(projectId);
  const styleNote = await readStyleNote(projectId);
  const userDirectionBlock = briefToPromptBlock(brief) + (styleNote.trim() ? `\n[추가 자유 메모]\n${styleNote.trim()}\n` : '');

  // source-shots.json 에서 컷별 풍부한 메타 (subject / shot_type / tags) 끌어오기.
  // edit-plan 의 source_video_id + source_shot_index 로 매칭.
  const sourceShots: any = await readJson(ARTIFACTS.sourceShots(projectId));
  const sourceLookup = new Map<string, any>();
  if (Array.isArray(sourceShots?.videos)) {
    for (const v of sourceShots.videos) {
      const shots = Array.isArray(v?.shots) ? v.shots : [];
      for (const s of shots) {
        sourceLookup.set(`${v.video_id}_${s.source_index}`, { ...s, video_filename: v.filename });
      }
    }
  }

  const cuts = plan.items.map((it: any, i: number) => {
    const srcMeta = sourceLookup.get(`${it.source_video_id}_${it.source_shot_index}`) || {};
    return {
      cut_index: typeof it.cut_index === 'number' ? it.cut_index : i,
      output_start: Number(it.output_start),
      output_end: Number(it.output_end),
      spoken: String(it.source_spoken_text || ''),
      scene: String(it.source_scene_description || ''),
      caption_text: (Array.isArray(it.planned_caption_layers) ? it.planned_caption_layers : [])
        .map((l: any) => String(l.text || '').trim())
        .filter(Boolean)
        .join(' / '),
      subject: srcMeta.subject || '',
      shot_type: srcMeta.shot_type || it.source_shot_type || '',
      tags: Array.isArray(srcMeta.tags) ? srcMeta.tags : [],
      source_filename: String(it.source_filename || srcMeta.video_filename || ''),
    };
  });

  const totalDuration = Number(plan.output_duration) || cuts.reduce((m: number, c: any) => Math.max(m, c.output_end), 0);

  // 영상 전체 컨텍스트 블록: 사용된 소스 파일명 목록 + reference 의 topic 정보.
  // 사용자가 파일명을 의미있게 지었거나(예: "강원도_바다.mp4") reference 분석에서
  // topic 이 잡혀있으면 LLM 의 narration 다양성에 도움.
  const sourceContext = await buildSourceContextBlock(projectId, sourceShots);

  // cut.mp4 가 있으면 2단계 흐름:
  //   (1) Gemini Pro + cut.mp4 → 컷별 평가 JSON (실제 내용 / 자막 합리성 / 나레이션 가이드)
  //   (2) Flash text-only + 평가 결과 → 나레이션 segments
  // 영상이 없거나 평가가 실패하면 평가 없이 Flash 텍스트 폴백.
  const cutPath = ARTIFACTS.cutMp4(projectId);
  const hasCutVideo = await fileExists(cutPath);

  let evaluation: any = null;
  let evaluationError = '';

  if (hasCutVideo) {
    const evalPrompt = buildVideoEvaluationPrompt({ totalDuration, sourceContext, cuts });
    try {
      const result = await analyzeVideoStructured(cutPath, evalPrompt, config.GEMINI_PRO_MODEL);
      evaluation = result.parsed;
      await appendRawResponse(projectId, {
        kind: 'tts_outline_evaluation',
        model: config.GEMINI_PRO_MODEL,
        cuts_count: Array.isArray(evaluation?.cuts) ? evaluation.cuts.length : 0,
        has_summary: !!evaluation?.video_summary,
        response: result.raw,
      });
    } catch (e: any) {
      evaluationError = e?.message || String(e);
      await appendRawResponse(projectId, {
        kind: 'tts_outline_evaluation_failed',
        error: evaluationError.slice(0, 500),
      });
    }
  }

  const narrationPrompt = buildNarrationOutlinePrompt({
    userDirectionBlock,
    totalDuration,
    videoAttached: false,
    sourceContext,
    evaluation: evaluation || undefined,
    cuts,
  });

  let parsed: any = null;
  let modelUsed = '';
  let mode = '';

  try {
    const result = await callGeminiTextOnly(narrationPrompt, { temperature: 0.6, maxOutputTokens: 8192 });
    parsed = result.parsed;
    modelUsed = config.GEMINI_FLASH_MODEL;
    if (evaluation) mode = 'pro_evaluation_then_flash';
    else if (hasCutVideo) mode = 'flash_text_after_eval_failure';
    else mode = 'flash_text_no_cut';
  } catch (e: any) {
    await appendRawResponse(projectId, {
      kind: 'tts_outline_failed',
      evaluation_error: evaluationError.slice(0, 500),
      narration_error: (e?.message || String(e)).slice(0, 500),
    });
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }

  const rawSegments: any[] = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const saved = await writeTtsOutline(projectId, {
    generated_at: new Date().toISOString(),
    generated_model: modelUsed,
    total_duration: totalDuration,
    segments: rawSegments,
    approved: false,
    approved_at: null,
  });
  const issues = validateOutline(saved);
  await appendRawResponse(projectId, {
    kind: 'tts_outline_generated',
    mode,
    model: modelUsed,
    segments_count: saved.segments.length,
    total_duration: totalDuration,
    issues_count: issues.length,
    evaluation_used: !!evaluation,
    evaluation_error: evaluationError ? evaluationError.slice(0, 300) : undefined,
  });
  return NextResponse.json({ ok: true, outline: saved, issues });
}

export async function PATCH(req: NextRequest) {
  const { projectId, segments, approved } = await req.json();
  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });

  const current = await readTtsOutline(projectId);
  if (!current.generated_at && !Array.isArray(segments)) {
    return NextResponse.json({ error: '먼저 POST 로 개요를 생성하세요.' }, { status: 400 });
  }

  const next = await writeTtsOutline(projectId, {
    ...current,
    segments: Array.isArray(segments) ? segments : current.segments,
    approved: typeof approved === 'boolean' ? approved : current.approved,
    approved_at: approved === true ? new Date().toISOString() : (approved === false ? null : current.approved_at),
  });
  const issues = validateOutline(next);
  return NextResponse.json({ ok: true, outline: next, issues });
}

// ============================================================
// 영상 전체 컨텍스트 블록 생성.
// - 사용된 소스 영상 파일명 목록
// - source-shots.json 에서 자주 등장한 tags (전체 영상의 주제 단서)
// - reference 분석에서 잡힌 topic_summary / topic_category / key_phrases
// LLM 호출 없이 기존 산출물에서만 구성. 비어 있으면 빈 문자열 반환.
// ============================================================
async function buildSourceContextBlock(projectId: string, sourceShots: any): Promise<string> {
  const lines: string[] = [];

  // 사용된 소스 영상 파일명
  if (Array.isArray(sourceShots?.videos)) {
    const files = sourceShots.videos.map((v: any) => v?.filename).filter(Boolean);
    if (files.length > 0) {
      lines.push(`- 사용된 소스 영상: ${files.join(', ')}`);
    }
  }

  // tags 집계 — 자주 등장하는 키워드는 영상 주제의 단서
  if (Array.isArray(sourceShots?.videos)) {
    const tagCount = new Map<string, number>();
    for (const v of sourceShots.videos) {
      for (const s of (v?.shots || [])) {
        for (const t of (s?.tags || [])) {
          const key = String(t).toLowerCase().trim();
          if (!key) continue;
          tagCount.set(key, (tagCount.get(key) || 0) + 1);
        }
      }
    }
    const top = Array.from(tagCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([t, c]) => `${t}(${c})`);
    if (top.length > 0) lines.push(`- 컷별 자주 등장한 시각 태그: ${top.join(', ')}`);
  }

  // 모든 컷의 subject 모음 — 사용자 영상의 실제 피사체들
  if (Array.isArray(sourceShots?.videos)) {
    const subjects = new Set<string>();
    for (const v of sourceShots.videos) {
      for (const s of (v?.shots || [])) {
        const sub = String(s?.subject || '').trim();
        if (sub) subjects.add(sub);
      }
    }
    if (subjects.size > 0) {
      lines.push(`- 컷별 주피사체: ${Array.from(subjects).slice(0, 10).join(' / ')}`);
    }
  }

  // reference spec 의 topic 정보 (참고만 — 사용자 영상의 주제와는 다를 수 있음)
  const spec: any = await readJson(ARTIFACTS.editSpec(projectId));
  const refTopic = spec?.caption_pattern?.topic_summary || '';
  const refCategory = spec?.caption_pattern?.topic_category || '';
  if (refTopic || refCategory) {
    lines.push(`- (참고) 레퍼런스 영상의 주제 카테고리: ${refCategory || '?'} — ${refTopic || ''}`);
  }

  return lines.length > 0 ? lines.join('\n') : '';
}
