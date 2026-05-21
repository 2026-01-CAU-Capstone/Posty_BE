// 스타일 브리프 저장
// body: { projectId, brief: StyleBrief }
import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_BRIEF, writeStyleBrief } from '@/lib/style-brief';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { projectId, brief } = await req.json();
  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });
  const safe = { ...DEFAULT_BRIEF, ...(brief || {}) };
  await writeStyleBrief(projectId, safe);
  return NextResponse.json({ ok: true });
}
