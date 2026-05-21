import { NextResponse } from 'next/server';
import { ensureDir, newProjectId, projectDir, referenceDir, sourcesDir, bgmDir } from '@/lib/paths';

export const runtime = 'nodejs';

export async function POST() {
  const id = newProjectId();
  await ensureDir(projectDir(id));
  await ensureDir(referenceDir(id));
  await ensureDir(sourcesDir(id));
  await ensureDir(bgmDir(id));
  return NextResponse.json({ ok: true, projectId: id });
}
