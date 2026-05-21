// 자막만 다시 생성하는 엔드포인트.
// - edit-plan.json 의 plan items 에 planCaptions() 를 다시 호출
// - feedback 텍스트가 들어오면 styleNote 와 함께 프롬프트에 주입
// - 끝나면 Stage 3 도 자동으로 다시 돌려서 captioned.mp4 갱신
//
// body: { projectId, feedback?: string }
import { NextRequest, NextResponse } from 'next/server';
import { ARTIFACTS, appendRawResponse, readJson, writeJson } from '@/lib/paths';
import { planCaptions } from '@/lib/stages/stage1';
import { runStage3 } from '@/lib/stages/stage3';

export const runtime = 'nodejs';
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  const { projectId, feedback } = await req.json();
  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });

  const plan: any = await readJson(ARTIFACTS.editPlan(projectId));
  const spec: any = await readJson(ARTIFACTS.editSpec(projectId));
  if (!plan?.items) return NextResponse.json({ error: 'edit-plan.json 이 없습니다 (Stage 1 을 먼저 실행)' }, { status: 400 });
  if (!spec) return NextResponse.json({ error: 'edit-spec.json 이 없습니다 (Stage 0 을 먼저 실행)' }, { status: 400 });

  const extra = typeof feedback === 'string' ? feedback.slice(0, 2000) : '';

  try {
    await planCaptions(projectId, plan.items, spec, extra);
    await writeJson(ARTIFACTS.editPlan(projectId), plan);
    await appendRawResponse(projectId, {
      kind: 'replan_captions_done',
      with_feedback: !!extra,
    });
    // 자동으로 Stage 3 다시 실행해서 captioned.mp4 갱신
    const renderResult = await runStage3(projectId);
    return NextResponse.json({
      ok: true,
      cuts_with_caption: plan.items.filter((p: any) => (p.planned_caption_layers || []).length > 0).length,
      total_layers: plan.items.reduce((s: number, p: any) => s + (p.planned_caption_layers?.length || 0), 0),
      render: renderResult,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}
