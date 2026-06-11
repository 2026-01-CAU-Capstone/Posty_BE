// ============================================================
// 처리 시간 예상 (보수적 = 과대 추정 → 실제로는 더 빨리 끝나도록).
// 업로드된 레퍼런스/소스 길이 + 소스 개수(편집 정도 근사)로 stage별 초를 계산.
// 정확한 shot 수는 Stage 1 의 scene detection 전엔 모르므로, 길이·개수로 보수 추정.
// ============================================================

import path from 'path';
import fsp from 'fs/promises';
import { referenceDir, sourcesDir } from '../../lib/paths';
import { probeDuration } from '../../lib/ffmpeg';
import { readTtsConfig } from '../../lib/tts-config';

export type Estimate = {
  refDur: number;        // 레퍼런스 길이(초)
  srcDur: number;        // 소스 총 길이(초)
  nSources: number;      // 소스 개수
  outDurEst: number;     // 결과물 길이 추정(초)
  perStage: number[];    // [s0,s1,s2,s3,s4] 보수적 초
  total04: number;       // 전체 (Stage 0~4)
  total14: number;       // 생성 단계 (Stage 1~4)
};

// 보수 계수 — 과대 추정 (실측보다 충분히 넉넉하게).
// "예상보다 빨리 끝났네!" 가 "왜 이렇게 오래 걸려?" 보다 UX 가 훨씬 좋아서 의도적으로 크게 잡는다.
const SAFETY = 1.6;

async function dirDuration(dir: string): Promise<{ total: number; count: number }> {
  const files = (await fsp.readdir(dir).catch(() => [])).filter(f => !f.startsWith('.'));
  let total = 0;
  for (const f of files) total += await probeDuration(path.join(dir, f)).catch(() => 0);
  return { total, count: files.length };
}

export function computeEstimate(
  refDur: number,
  srcDur: number,
  nSources: number,
  ttsEnabled = false,
): Estimate {
  // 결과물 길이: 컷 4.5s 캡 + 60s 축약 정책 → 보수적으로 min(srcDur, 75), 최소 8s.
  const outDurEst = Math.max(8, Math.min(srcDur || 0, 75));
  const up = (x: number) => Math.ceil(x * SAFETY);

  // 기본값을 보수적으로 (실측의 worst-case 에 가깝게).
  // 큰 영상/소스가 많을수록 실측 변동성이 커지므로 srcDur·nSources 계수도 키운다.
  const s0 = up(90  + 1.6 * refDur);                  // 레퍼런스 분석 (Pro 2패스 업로드 + 텍스트 OCR)
  const s1 = up(40  + 4.0 * srcDur + 18 * nSources);  // 디코드 + Gemini 소스별 + 렌더
  const s2 = up(20  + 2.0 * outDurEst);               // 색보정
  const s3 = up(20  + 1.6 * outDurEst);               // 자막 (libass)
  // TTS 켜면 나레이션 segment 합성(Gemini TTS, segment 당 네트워크 왕복)이 추가된다.
  // 대략 결과물 길이에 비례하는 합성 시간을 보수적으로 더한다.
  const ttsOverhead = ttsEnabled ? (25 + 1.8 * outDurEst) : 0;
  const s4 = up(50  + 2.4 * outDurEst + ttsOverhead);  // BGM 다운로드(네트워크) + 믹스 (+ TTS 합성)

  const perStage = [s0, s1, s2, s3, s4];
  return {
    refDur, srcDur, nSources, outDurEst,
    perStage,
    total04: perStage.reduce((a, b) => a + b, 0),
    total14: s1 + s2 + s3 + s4,
  };
}

export async function estimateProject(projectId: string): Promise<Estimate> {
  const ref = await dirDuration(referenceDir(projectId));
  const src = await dirDuration(sourcesDir(projectId));
  const tts = await readTtsConfig(projectId).catch(() => null);
  return computeEstimate(ref.total, src.total, src.count, tts?.enabled === true);
}
