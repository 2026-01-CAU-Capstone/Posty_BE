// 프로젝트 상태 조회
// GET ?projectId=...
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import {
  ARTIFACTS, bgmDir, fileExists, projectDir, readJson, readStyleNote, referenceDir, sourcesDir,
} from '@/lib/paths';
import { readStyleBrief } from '@/lib/style-brief';
import { readTtsConfig } from '@/lib/tts-config';
import { readTtsOutline, validateOutline } from '@/lib/tts-outline';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId') || '';
  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });

  try {
    await fs.access(projectDir(projectId));
  } catch {
    return NextResponse.json({ error: 'project 가 존재하지 않습니다' }, { status: 404 });
  }

  const reference = (await fs.readdir(referenceDir(projectId)).catch(() => []))
    .filter(f => !f.startsWith('.'));
  const sources = (await fs.readdir(sourcesDir(projectId)).catch(() => []))
    .filter(f => !f.startsWith('.'));
  const bgm = (await fs.readdir(bgmDir(projectId)).catch(() => []))
    .filter(f => !f.startsWith('.'));

  const stages = {
    s0_spec: await fileExists(ARTIFACTS.editSpec(projectId)),
    s1_cut: await fileExists(ARTIFACTS.cutMp4(projectId)),
    s2_graded: await fileExists(ARTIFACTS.gradedMp4(projectId)),
    s3_captioned: await fileExists(ARTIFACTS.captionedMp4(projectId)),
    s4_final: await fileExists(ARTIFACTS.finalMp4(projectId)),
  };

  const spec = await readJson<any>(ARTIFACTS.editSpec(projectId));
  const plan = await readJson<any>(ARTIFACTS.editPlan(projectId));
  const colorStats = await readJson<any>(ARTIFACTS.colorStats(projectId));
  const styleNote = await readStyleNote(projectId);
  const styleBrief = await readStyleBrief(projectId);
  const ttsConfig = await readTtsConfig(projectId);
  const ttsOutline = await readTtsOutline(projectId);
  const ttsOutlineIssues = validateOutline(ttsOutline);

  return NextResponse.json({
    ok: true,
    projectId,
    styleNote,
    styleBrief,
    ttsConfig,
    ttsOutline,
    ttsOutlineIssues,
    uploads: { reference, sources, bgm },
    stages,
    artifacts: {
      editSpec: spec ? summarizeSpec(spec) : null,
      editPlan: plan ? summarizePlan(plan) : null,
      colorStats: colorStats?.transform || null,
    },
    paths: {
      // 클라이언트가 file 라우트로 받을 수 있게 상대 경로 제공
      finalMp4: stages.s4_final ? relForServe(ARTIFACTS.finalMp4(projectId)) : null,
      captionedMp4: stages.s3_captioned ? relForServe(ARTIFACTS.captionedMp4(projectId)) : null,
      gradedMp4: stages.s2_graded ? relForServe(ARTIFACTS.gradedMp4(projectId)) : null,
      cutMp4: stages.s1_cut ? relForServe(ARTIFACTS.cutMp4(projectId)) : null,
    },
  });
}

function summarizeSpec(spec: any) {
  return {
    duration: spec.duration,
    aspect_ratio: spec.aspect_ratio,
    pacing: spec.pacing,
    shots_count: Array.isArray(spec.shots) ? spec.shots.length : 0,
    color_style: spec.color_style,
    audio_profile: spec.audio_profile,
    shots: Array.isArray(spec.shots) ? spec.shots.slice(0, 30) : [],
  };
}
function summarizePlan(plan: any) {
  return {
    aspect_ratio: plan.aspect_ratio,
    output_duration: plan.output_duration,
    items_count: Array.isArray(plan.items) ? plan.items.length : 0,
    items: Array.isArray(plan.items) ? plan.items : [],
  };
}
function relForServe(absPath: string): string {
  // /api/file?path=... 에 그대로 넘길 수 있게 cwd 기준 상대경로
  return path.relative(process.cwd(), absPath).replace(/\\/g, '/');
}
