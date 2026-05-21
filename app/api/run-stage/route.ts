// 단계 실행 엔드포인트
// body: { projectId, stage: 0|1|2|3|4 }
import { NextRequest, NextResponse } from 'next/server';
import { checkStageConfig, StageId } from '@/lib/config';
import { runStage0 } from '@/lib/stages/stage0';
import { runStage1 } from '@/lib/stages/stage1';
import { runStage2 } from '@/lib/stages/stage2';
import { runStage3 } from '@/lib/stages/stage3';
import { runStage4 } from '@/lib/stages/stage4';

export const runtime = 'nodejs';
export const maxDuration = 1800;

export async function POST(req: NextRequest) {
  const { projectId, stage } = await req.json();
  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });

  const s = Number(stage) as StageId;
  if (![0, 1, 2, 3, 4].includes(s)) {
    return NextResponse.json({ error: `stage 가 잘못됨: ${stage}` }, { status: 400 });
  }

  const cfgErr = checkStageConfig(s);
  if (cfgErr) return NextResponse.json({ error: cfgErr }, { status: 400 });

  try {
    let result: any;
    if (s === 0) result = await runStage0(projectId);
    else if (s === 1) result = await runStage1(projectId);
    else if (s === 2) result = await runStage2(projectId);
    else if (s === 3) result = await runStage3(projectId);
    else result = await runStage4(projectId);

    return NextResponse.json({ ok: true, stage: s, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}
