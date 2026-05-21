// 통합 업로드 엔드포인트
// formData: projectId, kind ('reference'|'source'|'bgm'), file
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { bgmDir, ensureDir, referenceDir, sourcesDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const projectId = String(form.get('projectId') || '');
  const kind = String(form.get('kind') || '');
  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });
  if (!['reference', 'source', 'bgm'].includes(kind)) {
    return NextResponse.json({ error: `kind 가 잘못됨: ${kind}` }, { status: 400 });
  }

  const files = form.getAll('file').filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: 'file 누락' }, { status: 400 });

  const dir =
    kind === 'reference' ? referenceDir(projectId) :
    kind === 'source' ? sourcesDir(projectId) :
    bgmDir(projectId);
  await ensureDir(dir);

  // reference 는 1개만 허용 → 기존 파일 삭제
  if (kind === 'reference' || kind === 'bgm') {
    for (const f of await fs.readdir(dir).catch(() => [])) {
      await fs.rm(path.join(dir, f), { force: true });
    }
  }

  const saved: string[] = [];
  for (const file of files) {
    const safeName = sanitizeFileName(file.name);
    const dest = path.join(dir, safeName);
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(dest, buf);
    saved.push(safeName);
  }

  return NextResponse.json({ ok: true, kind, saved });
}

function sanitizeFileName(name: string): string {
  // 경로구분자/제어문자 제거, 길이 제한
  const base = name.replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return base.length > 0 ? base.slice(0, 200) : `upload_${Date.now()}`;
}
