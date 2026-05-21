// TTS 설정 저장
// body: { projectId, tts: Partial<TtsConfig> }
import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_TTS_CONFIG, writeTtsConfig } from '@/lib/tts-config';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { projectId, tts } = await req.json();
  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });
  const safe = { ...DEFAULT_TTS_CONFIG, ...(tts || {}) };
  await writeTtsConfig(projectId, safe);
  return NextResponse.json({ ok: true });
}
