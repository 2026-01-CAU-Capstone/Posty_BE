// ============================================================
// 프로젝트별 디렉토리 구조 (단계별 산출물 분리).
//
// data/projects/{projectId}/
//   reference/                  업로드한 레퍼런스 영상 (1개)
//   sources/                    업로드한 소스 영상들
//   bgm/                        선택: 사용자가 올린 BGM 파일
//   raw-api-responses.json      모든 API 원본 응답 (디버깅)
//   0_spec/
//     edit-spec.json            레퍼런스 분석 결과 (전체 스펙)
//   1_cut/
//     source-shots.json         FFmpeg 컷 검출 + Flash 묘사 결과
//     edit-plan.json            매칭 결과 (어떤 source 가 어떤 ref shot 에)
//     cut.mp4                   1단계 산출물: 컷만 한 영상
//     work/                     중간 segment 들
//   2_grade/
//     color-stats.json          ref/cut 색 측정값 + 적용 transform
//     graded.mp4                2단계 산출물
//   3_caption/
//     captions.ass
//     captioned.mp4             3단계 산출물
//   4_final/
//     final.mp4                 4단계 산출물 (최종)
// ============================================================

import fs from 'fs/promises';
import path from 'path';

export function dataRoot(): string {
  return path.join(process.cwd(), 'data', 'projects');
}

export function projectDir(projectId: string): string {
  return path.join(dataRoot(), projectId);
}

export function referenceDir(projectId: string): string {
  return path.join(projectDir(projectId), 'reference');
}

export function sourcesDir(projectId: string): string {
  return path.join(projectDir(projectId), 'sources');
}

export function bgmDir(projectId: string): string {
  return path.join(projectDir(projectId), 'bgm');
}

export function stageDir(projectId: string, stage: 0 | 1 | 2 | 3 | 4): string {
  const names = ['0_spec', '1_cut', '2_grade', '3_caption', '4_final'];
  return path.join(projectDir(projectId), names[stage]);
}

export function workDir(projectId: string): string {
  return path.join(stageDir(projectId, 1), 'work');
}

// ---- 산출물 파일 경로 ----
export const ARTIFACTS = {
  editSpec: (pid: string) => path.join(stageDir(pid, 0), 'edit-spec.json'),
  sourceShots: (pid: string) => path.join(stageDir(pid, 1), 'source-shots.json'),
  editPlan: (pid: string) => path.join(stageDir(pid, 1), 'edit-plan.json'),
  cutMp4: (pid: string) => path.join(stageDir(pid, 1), 'cut.mp4'),
  colorStats: (pid: string) => path.join(stageDir(pid, 2), 'color-stats.json'),
  gradedMp4: (pid: string) => path.join(stageDir(pid, 2), 'graded.mp4'),
  captionsAss: (pid: string) => path.join(stageDir(pid, 3), 'captions.ass'),
  captionedMp4: (pid: string) => path.join(stageDir(pid, 3), 'captioned.mp4'),
  finalMp4: (pid: string) => path.join(stageDir(pid, 4), 'final.mp4'),
  bgmIdentity: (pid: string) => path.join(stageDir(pid, 4), 'bgm-identity.json'),
  // 사용자의 BGM 선택 결정. { none: true } 면 BGM 없이 진행(자동 다운로드 금지).
  bgmPick: (pid: string) => path.join(stageDir(pid, 4), 'bgm-pick.json'),
  ttsConfig: (pid: string) => path.join(projectDir(pid), 'tts-config.json'),
  ttsOutline: (pid: string) => path.join(projectDir(pid), 'tts-outline.json'),
  audioConfig: (pid: string) => path.join(projectDir(pid), 'audio-config.json'),
  cutConfig: (pid: string) => path.join(projectDir(pid), 'cut-config.json'),
  ttsAudioDir: (pid: string) => path.join(stageDir(pid, 4), 'tts'),
  rawResponses: (pid: string) => path.join(projectDir(pid), 'raw-api-responses.json'),
  styleNote: (pid: string) => path.join(projectDir(pid), 'style-note.txt'),
  styleBrief: (pid: string) => path.join(projectDir(pid), 'style-brief.json'),
};

// 사용자가 입력한 스타일 노트 (없으면 빈 문자열)
export async function readStyleNote(projectId: string): Promise<string> {
  try {
    const t = await fs.readFile(ARTIFACTS.styleNote(projectId), 'utf-8');
    return t.trim();
  } catch { return ''; }
}
export async function writeStyleNote(projectId: string, text: string): Promise<void> {
  await ensureDir(projectDir(projectId));
  await fs.writeFile(ARTIFACTS.styleNote(projectId), text ?? '', 'utf-8');
}


// ---- 파일 헬퍼 ----
export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function writeJson(filePath: string, data: any): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function readJson<T = any>(filePath: string): Promise<T | null> {
  try {
    const t = (await fs.readFile(filePath, 'utf-8')).replace(/^\uFEFF/, '');
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// raw-api-responses.json 은 read-modify-write 라 동시 호출이 겹치면 항목 유실/손상이 난다.
// (예: 레퍼런스 자막 정밀화를 컷편집과 병렬로 돌릴 때 양쪽이 동시에 append.)
// 프로세스 내 단일 큐로 직렬화해 안전하게 만든다. (반환 promise 는 이 항목 기록 완료 시 resolve.)
let rawResponseQueue: Promise<void> = Promise.resolve();
export function appendRawResponse(projectId: string, entry: any): Promise<void> {
  rawResponseQueue = rawResponseQueue.then(() => appendRawResponseUnlocked(projectId, entry).catch((e) => {
    // 진단 로그라 비치명적 — 큐가 막히지 않도록 삼키되, 조용히 사라지진 않게 경고만 남긴다.
    try { console.warn('[appendRawResponse] 기록 실패(무시):', (e && e.message) || e); } catch { /* noop */ }
  }));
  return rawResponseQueue;
}

async function appendRawResponseUnlocked(projectId: string, entry: any): Promise<void> {
  const p = ARTIFACTS.rawResponses(projectId);
  await ensureDir(path.dirname(p));
  let arr: any[] = [];
  try {
    const t = await fs.readFile(p, 'utf-8');
    arr = JSON.parse(t);
    if (!Array.isArray(arr)) arr = [];
  } catch {}
  arr.push({ at: new Date().toISOString(), ...entry });
  await fs.writeFile(p, JSON.stringify(arr, null, 2), 'utf-8');
}

export function newProjectId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `proj_${ts}_${rand}`;
}
