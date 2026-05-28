// ============================================================
// 자동 파이프라인:
//   - 레퍼런스: IG URL (기본) 또는 로컬 파일 (선택)
//   - 소스: 로컬 파일만 (사용자가 직접 찍은 영상)
//   → 프로젝트 생성 → 다운로드/저장 → Stage 0 → Stage 1
//
// Content-Type: multipart/form-data
// 필드:
//   referenceUrl?: string    (referenceFile 과 XOR, 둘 중 하나는 필수)
//   referenceFile?: File     (referenceUrl 과 XOR)
//   sourceFiles: File[]      (1개 이상 필수)
//   styleNote?: string
//
// 응답은 SSE (text/event-stream). 기존 progress / done / error 포맷 유지.
// 추가/변경 step 이름:
//   ref_local_save           — 로컬 레퍼런스 파일 저장
//   src_local_save_start     — 로컬 소스 저장 시작
//   src_local_save_one       — 로컬 소스 1개 저장
//   src_local_save_done      — 로컬 소스 저장 모두 완료
// ============================================================

import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import {
  ensureDir,
  newProjectId,
  projectDir,
  referenceDir,
  sourcesDir,
  bgmDir,
  writeStyleNote,
} from '@/lib/paths';
import { checkStageConfig } from '@/lib/config';
import { ensureIgFetchAlive, importInstagramUrl } from '@/lib/ig-fetch';
import { runStage0 } from '@/lib/stages/stage0';
import { runStage1 } from '@/lib/stages/stage1';

export const runtime = 'nodejs';
export const maxDuration = 1800;

function sanitizeFileName(name: string): string {
  const base = name.replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return base.length > 0 ? base.slice(0, 200) : `upload_${Date.now()}`;
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, 'multipart/form-data 파싱 실패');
  }

  const referenceUrl = String(form.get('referenceUrl') || '').trim();
  const referenceFileEntry = form.get('referenceFile');
  const referenceFile =
    referenceFileEntry instanceof File && referenceFileEntry.size > 0
      ? referenceFileEntry
      : null;

  const sourceFiles = form
    .getAll('sourceFiles')
    .filter((f): f is File => f instanceof File && f.size > 0);

  const styleNote = String(form.get('styleNote') || '').trim();

  // -------- 레퍼런스 검증: URL 또는 File 중 정확히 하나 --------
  if (referenceUrl && referenceFile) {
    return jsonError(400, '레퍼런스는 IG URL 과 파일 중 하나만 제공하세요');
  }
  if (!referenceUrl && !referenceFile) {
    return jsonError(400, '레퍼런스 IG URL 또는 파일을 1개 제공하세요');
  }

  // -------- 소스 검증: 로컬 파일 1개 이상 --------
  if (sourceFiles.length === 0) {
    return jsonError(400, '소스 파일을 1개 이상 업로드하세요');
  }

  // -------- Stage 키 사전 검증 --------
  const cfg0 = checkStageConfig(0);
  if (cfg0) return jsonError(400, cfg0);
  const cfg1 = checkStageConfig(1);
  if (cfg1) return jsonError(400, cfg1);

  // -------- ig-fetch alive 검증 (레퍼런스가 URL 일 때만) --------
  if (referenceUrl) {
    try {
      await ensureIgFetchAlive();
    } catch (e: any) {
      return jsonError(502, e.message);
    }
  }

  // SSE 스트림 시작
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let projectId = '';

      const send = (event: 'progress' | 'done' | 'error', data: any) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };
      const progress = (step: string, msg: string, extra: Record<string, any> = {}) => {
        send('progress', { step, msg, ...extra });
      };

      try {
        // -------- 1) 프로젝트 생성 --------
        projectId = newProjectId();
        await ensureDir(projectDir(projectId));
        await ensureDir(referenceDir(projectId));
        await ensureDir(sourcesDir(projectId));
        await ensureDir(bgmDir(projectId));
        progress('create_project', `프로젝트 생성: ${projectId}`, { projectId });

        // -------- 2) styleNote 저장 (있을 때만) --------
        if (styleNote) {
          await writeStyleNote(projectId, styleNote);
          progress('style_note', `스타일 노트 저장 (${styleNote.length}자)`);
        }

        // -------- 3) 레퍼런스 (URL or File) --------
        if (referenceFile) {
          const safe = sanitizeFileName(referenceFile.name);
          const dest = path.join(referenceDir(projectId), safe);
          const buf = Buffer.from(await referenceFile.arrayBuffer());
          await fs.writeFile(dest, buf);
          progress('ref_local_save', `레퍼런스 로컬 파일 저장: ${safe}`, {
            file: safe,
            size: buf.length,
          });
        } else {
          progress('ig_import_reference_start', `레퍼런스 ig-fetch: ${referenceUrl}`);
          const refResult = await importInstagramUrl(referenceUrl, referenceDir(projectId), {
            onlyVideo: true,
          });
          progress('ig_import_reference', `레퍼런스 다운로드 완료: ${refResult.shortcode}`, {
            files: refResult.files.map(p => path.basename(p)),
          });
        }

        // -------- 4) 로컬 소스 파일 저장 --------
        progress('src_local_save_start', `소스 파일 ${sourceFiles.length}개 저장 시작`);
        for (let i = 0; i < sourceFiles.length; i++) {
          const f = sourceFiles[i];
          const safe = sanitizeFileName(f.name);
          const dest = path.join(sourcesDir(projectId), safe);
          const buf = Buffer.from(await f.arrayBuffer());
          await fs.writeFile(dest, buf);
          progress(
            'src_local_save_one',
            `(${i + 1}/${sourceFiles.length}) 소스 파일 저장: ${safe}`,
            { file: safe, size: buf.length },
          );
        }
        progress('src_local_save_done', `소스 파일 ${sourceFiles.length}개 저장 완료`);

        // -------- 5) Stage 0 실행 --------
        progress('stage0_start', 'Stage 0 (레퍼런스 분석) 시작 — 1~3분 소요');
        const s0 = await runStage0(projectId);
        progress('stage0_done', 'Stage 0 완료', { result: s0 });

        // -------- 6) Stage 1 실행 --------
        progress('stage1_start', `Stage 1 (컷편집) 시작 — 소스 1개당 1~2분 소요`);
        const s1 = await runStage1(projectId);
        progress('stage1_done', 'Stage 1 완료', { result: s1 });

        // -------- 7) 완료 --------
        send('done', { projectId });
      } catch (e: any) {
        send('error', {
          projectId: projectId || null,
          error: e?.message || String(e),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
