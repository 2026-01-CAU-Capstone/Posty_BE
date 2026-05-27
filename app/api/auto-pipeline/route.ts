// ============================================================
// 자동 파이프라인: IG URL → ig-fetch 다운로드 → create-project → Stage 0 → Stage 1
//
// body: {
//   referenceUrl: string,
//   sourceUrls: string[],
//   styleNote?: string,        // 선택: Stage 0 / Stage 1 자막 플래닝에 반영
// }
//
// 응답은 SSE (text/event-stream) 로 진행 상황을 실시간 전송한다.
// 각 event 의 data 는 JSON. 마지막 event 는 type='done' 또는 'error'.
//
//   event: progress  data: {"step":"create_project","msg":"..."}
//   event: progress  data: {"step":"ig_import_reference","msg":"...","files":["..."]}
//   event: progress  data: {"step":"ig_import_sources","msg":"...","count":3}
//   event: progress  data: {"step":"stage0_start","msg":"..."}
//   event: progress  data: {"step":"stage0_done","msg":"...","result":{...}}
//   event: progress  data: {"step":"stage1_start","msg":"..."}
//   event: progress  data: {"step":"stage1_done","msg":"...","result":{...}}
//   event: done      data: {"projectId":"proj_..."}
//   event: error     data: {"projectId":"proj_..."?,"error":"..."}
//
// 클라이언트는 EventSource 가 아니라 fetch + ReadableStream 으로 받는 게 단순함
// (POST body 가 필요해서 EventSource 불가).
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

interface Body {
  referenceUrl?: string;
  sourceUrls?: string[];
  styleNote?: string;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'JSON 파싱 실패');
  }

  const referenceUrl = String(body.referenceUrl || '').trim();
  const sourceUrls = (Array.isArray(body.sourceUrls) ? body.sourceUrls : [])
    .map(u => String(u || '').trim())
    .filter(Boolean);
  const styleNote = String(body.styleNote || '').trim();

  if (!referenceUrl) return jsonError(400, 'referenceUrl 누락');
  if (sourceUrls.length === 0) return jsonError(400, 'sourceUrls 가 비어 있음');

  // Stage 0/1 키가 없으면 IG 다운로드 다 받아놓고 마지막에 실패하는 게 아니라
  // 시작 전에 막아준다.
  const cfg0 = checkStageConfig(0);
  if (cfg0) return jsonError(400, cfg0);
  const cfg1 = checkStageConfig(1);
  if (cfg1) return jsonError(400, cfg1);

  // ig-fetch alive 검증 — 다운로드 시작 전 fast-fail.
  try {
    await ensureIgFetchAlive();
  } catch (e: any) {
    return jsonError(502, e.message);
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

        // -------- 3) 레퍼런스 다운로드 --------
        progress('ig_import_reference_start', `레퍼런스 ig-fetch: ${referenceUrl}`);
        const refResult = await importInstagramUrl(referenceUrl, referenceDir(projectId), {
          onlyVideo: true,
        });
        progress('ig_import_reference', `레퍼런스 다운로드 완료: ${refResult.shortcode}`, {
          files: refResult.files.map(p => path.basename(p)),
        });

        // -------- 4) 소스 다운로드 (순차) --------
        progress('ig_import_sources_start', `소스 ${sourceUrls.length}개 다운로드 시작`);
        const sourceErrors: { url: string; error: string }[] = [];
        let savedSourceCount = 0;
        for (let i = 0; i < sourceUrls.length; i++) {
          const url = sourceUrls[i];
          try {
            const r = await importInstagramUrl(url, sourcesDir(projectId), {
              // 소스는 이미지도 OK (Stage 1 이 단일 still shot 으로 처리)
              onlyVideo: false,
            });
            savedSourceCount += r.files.length;
            progress('ig_import_source_one', `(${i + 1}/${sourceUrls.length}) ${r.shortcode}`, {
              files: r.files.map(p => path.basename(p)),
              media_types: r.media_types,
            });
          } catch (e: any) {
            sourceErrors.push({ url, error: e.message || String(e) });
            progress('ig_import_source_error', `(${i + 1}/${sourceUrls.length}) 실패: ${url}`, {
              error: e.message || String(e),
            });
          }
        }
        if (savedSourceCount === 0) {
          throw new Error(
            `모든 소스 URL 다운로드 실패. 첫 에러: ${sourceErrors[0]?.error || '(없음)'}`,
          );
        }
        progress('ig_import_sources_done', `소스 ${savedSourceCount}개 다운로드 완료`, {
          source_errors: sourceErrors,
        });

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
