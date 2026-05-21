// 스타일 노트 저장
// body: { projectId, text }
import { NextRequest, NextResponse } from 'next/server';
import { writeStyleNote } from '@/lib/paths';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { projectId, text } = await req.json();
  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });
  const safeText = typeof text === 'string' ? text.slice(0, 4000) : '';
  await writeStyleNote(projectId, safeText);
  return NextResponse.json({ ok: true, length: safeText.length });
}
