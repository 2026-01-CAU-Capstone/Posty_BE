// ============================================================
// 미리보기 프레임 추출 — UI 캐러셀에서 "이런 장면들 위주로 하고 있어요" 시각화용.
// 레퍼런스 + 모든 소스 영상에서 N개의 프레임을 균등/랜덤 시점으로 뽑아 jpg 로 저장.
// 정지 이미지 소스(.jpg/.png 등)는 그대로 복사한다.
// 결과는 data/projects/{pid}/_preview/ 에 캐시된다.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { ensureDir, projectDir, referenceDir, sourcesDir } from './paths';
import { extractFrame, probeDuration } from './ffmpeg';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

export type PreviewFrame = { path: string; source: 'reference' | 'source'; sourceFile: string };

export function previewDir(projectId: string): string {
  return path.join(projectDir(projectId), '_preview');
}

async function listFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => []))
    .filter(f => !f.startsWith('.'))
    .map(f => path.join(dir, f));
}

function ext(p: string): string {
  return path.extname(p).toLowerCase();
}

// 추출할 timestamp 들을 영상 길이 안에서 골고루 분포시킨다.
// (0% 와 100% 는 피해서 검은 프레임/인트로 가능성 제거)
function pickTimestamps(duration: number, count: number): number[] {
  if (duration <= 0.3 || count <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const frac = (i + 1) / (count + 1);
    // 약간의 jitter — 같은 영상 매번 다른 프레임이 나오도록
    const jitter = (Math.random() - 0.5) * 0.05;
    const t = duration * Math.max(0.02, Math.min(0.98, frac + jitter));
    out.push(t);
  }
  return out;
}

export async function ensurePreviewFrames(
  projectId: string,
  totalCount = 16,
): Promise<PreviewFrame[]> {
  const outDir = previewDir(projectId);
  await ensureDir(outDir);

  // 이미 충분히 있으면 캐시 사용.
  const existing = (await fs.readdir(outDir).catch(() => []))
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort();
  if (existing.length >= Math.min(totalCount, 8)) {
    return existing.map(f => ({
      path: path.join(outDir, f),
      source: f.startsWith('ref_') ? 'reference' : 'source',
      sourceFile: f,
    }));
  }

  const refFiles = await listFiles(referenceDir(projectId));
  const srcFiles = await listFiles(sourcesDir(projectId));

  // ref 에 약 30% 비중, src 에 70% — 소스가 메인 소재.
  const refTarget = refFiles.length > 0 ? Math.max(3, Math.round(totalCount * 0.3)) : 0;
  const srcTarget = Math.max(0, totalCount - refTarget);

  const out: PreviewFrame[] = [];

  // ── 레퍼런스 ──
  for (let i = 0; i < refFiles.length && refTarget > 0; i++) {
    const file = refFiles[i];
    const e = ext(file);
    const perFile = Math.ceil(refTarget / refFiles.length);
    if (IMAGE_EXTS.has(e)) {
      const dest = path.join(outDir, `ref_${pad(out.length)}${e}`);
      await fs.copyFile(file, dest).catch(() => {});
      out.push({ path: dest, source: 'reference', sourceFile: path.basename(file) });
      continue;
    }
    if (!VIDEO_EXTS.has(e)) continue;
    const dur = await probeDuration(file).catch(() => 0);
    const ts = pickTimestamps(dur, perFile);
    for (const t of ts) {
      const dest = path.join(outDir, `ref_${pad(out.length)}.jpg`);
      try {
        await extractFrame(file, t, dest);
        out.push({ path: dest, source: 'reference', sourceFile: path.basename(file) });
      } catch { /* skip */ }
    }
  }

  // ── 소스 ──
  if (srcFiles.length > 0 && srcTarget > 0) {
    const perFile = Math.max(1, Math.ceil(srcTarget / srcFiles.length));
    for (let i = 0; i < srcFiles.length; i++) {
      const file = srcFiles[i];
      const e = ext(file);
      if (IMAGE_EXTS.has(e)) {
        const dest = path.join(outDir, `src_${pad(out.length)}${e}`);
        await fs.copyFile(file, dest).catch(() => {});
        out.push({ path: dest, source: 'source', sourceFile: path.basename(file) });
        continue;
      }
      if (!VIDEO_EXTS.has(e)) continue;
      const dur = await probeDuration(file).catch(() => 0);
      const ts = pickTimestamps(dur, perFile);
      for (const t of ts) {
        const dest = path.join(outDir, `src_${pad(out.length)}.jpg`);
        try {
          await extractFrame(file, t, dest);
          out.push({ path: dest, source: 'source', sourceFile: path.basename(file) });
        } catch { /* skip */ }
      }
    }
  }

  // 너무 많으면 균등 다운샘플
  if (out.length > totalCount) {
    const stride = out.length / totalCount;
    const picked: PreviewFrame[] = [];
    for (let i = 0; i < totalCount; i++) picked.push(out[Math.floor(i * stride)]);
    return picked;
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(3, '0');
}
