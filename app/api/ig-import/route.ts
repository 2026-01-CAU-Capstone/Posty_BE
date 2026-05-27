// IG URL → ig-fetch HTTP 호출 → 다운로드 → 프로젝트 reference/sources 디렉토리에 저장.
// body: { projectId, kind: 'reference'|'source', urls: string[] }
//
// reference 는 1개만 허용 (기존 업로드와 동일하게 폴더 비우고 새 파일 저장).
// source 는 누적.

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { ensureDir, referenceDir, sourcesDir } from '@/lib/paths';
import { ensureIgFetchAlive, importInstagramUrl } from '@/lib/ig-fetch';

export const runtime = 'nodejs';
export const maxDuration = 1800;

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON 파싱 실패' }, { status: 400 });
  }

  const projectId = String(body?.projectId || '').trim();
  const kind = String(body?.kind || '').trim();
  const urls: string[] = Array.isArray(body?.urls)
    ? body.urls.map((u: any) => String(u || '').trim()).filter(Boolean)
    : [];

  if (!projectId) return NextResponse.json({ error: 'projectId 누락' }, { status: 400 });
  if (kind !== 'reference' && kind !== 'source') {
    return NextResponse.json({ error: `kind 가 잘못됨: ${kind}` }, { status: 400 });
  }
  if (urls.length === 0) {
    return NextResponse.json({ error: 'urls 가 비어 있음' }, { status: 400 });
  }
  if (kind === 'reference' && urls.length > 1) {
    return NextResponse.json(
      { error: '레퍼런스는 1개의 URL 만 허용됩니다' },
      { status: 400 },
    );
  }

  try {
    await ensureIgFetchAlive();
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }

  const dir = kind === 'reference' ? referenceDir(projectId) : sourcesDir(projectId);
  await ensureDir(dir);

  // reference 는 기존 파일 청소 (업로드 엔드포인트와 동일한 동작)
  if (kind === 'reference') {
    for (const f of await fs.readdir(dir).catch(() => [])) {
      await fs.rm(path.join(dir, f), { force: true });
    }
  }

  const saved: { url: string; files: string[] }[] = [];
  const errors: { url: string; error: string }[] = [];

  for (const url of urls) {
    try {
      const result = await importInstagramUrl(url, dir, {
        // 레퍼런스는 영상이어야 의미가 있음 (Stage 0 가 영상을 Gemini 에 보냄)
        onlyVideo: kind === 'reference',
      });
      saved.push({
        url,
        files: result.files.map(p => path.basename(p)),
      });
    } catch (e: any) {
      errors.push({ url, error: e.message || String(e) });
    }
  }

  if (saved.length === 0) {
    return NextResponse.json(
      { error: '모든 URL 다운로드 실패', errors },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, kind, saved, errors });
}
