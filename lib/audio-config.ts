// ============================================================
// 프로젝트별 오디오 밸런스 설정 (Stage 4).
//
// originalVolume — 원본 영상 소리(현장음·발화)를 결과물에 얼마나 넣을지.
//   'mute' (기본) → 원본 소리는 빼고 BGM(음원) 만 들리게. (= "음원만")
//   'low'         → 원본 소리를 작게 깔고 BGM 을 그 위에 (BGM 이 발화 중 살짝 ducking).
//   'full'        → 원본 소리를 충분히 키우고 BGM 은 그 아래로 ducking.
//
// 참고: TTS(나레이션) 가 켜져 있으면 나레이션이 메인 음성이므로 원본은
//       이 설정과 무관하게 항상 mute 된다 (stage4 에서 처리).
// ============================================================

import fs from 'fs/promises';
import { ARTIFACTS, ensureDir, projectDir } from './paths';

export type OriginalVolume = 'mute' | 'low' | 'full';

export type AudioConfig = {
  originalVolume: OriginalVolume;
};

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  originalVolume: 'mute',
};

// originalVolume 레벨 → 실제 ffmpeg volume 배수.
// 'mute' 는 0 (= BGM only). 나머지는 loudnorm 이 마지막에 전체를 평준화하므로
// 상대 게인 개념으로만 의미가 있다.
export const ORIGINAL_VOLUME_GAIN: Record<OriginalVolume, number> = {
  mute: 0,
  low: 0.35,
  full: 1.0,
};

export async function readAudioConfig(projectId: string): Promise<AudioConfig> {
  try {
    const t = await fs.readFile(ARTIFACTS.audioConfig(projectId), 'utf-8');
    return normalize(JSON.parse(t));
  } catch {
    return { ...DEFAULT_AUDIO_CONFIG };
  }
}

export async function writeAudioConfig(projectId: string, cfg: Partial<AudioConfig>): Promise<void> {
  await ensureDir(projectDir(projectId));
  const merged = normalize({ ...DEFAULT_AUDIO_CONFIG, ...cfg });
  await fs.writeFile(ARTIFACTS.audioConfig(projectId), JSON.stringify(merged, null, 2), 'utf-8');
}

function normalize(raw: any): AudioConfig {
  const v = String(raw?.originalVolume || '').trim();
  const originalVolume: OriginalVolume =
    v === 'low' || v === 'full' ? v : 'mute';
  return { originalVolume };
}
