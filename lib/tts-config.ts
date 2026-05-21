// ============================================================
// 프로젝트별 TTS 설정 (Stage 4 narration).
// - mode='captions': edit-plan.json 의 각 cut.planned_caption_layers[0].text 를
//   cut.output_start 시점에 맞춰 개별 TTS 합성 + 배치.
// - mode='script': script 텍스트 한 번에 합성 → 영상 시작에 깔기.
// - enabled=false 면 Stage 4 가 기존처럼 voice+BGM 만 처리.
// ============================================================

import fs from 'fs/promises';
import { ARTIFACTS, ensureDir, projectDir } from './paths';
import { DEFAULT_VOICE, PrebuiltVoice, PREBUILT_VOICES } from './tts';

export type TtsConfig = {
  enabled: boolean;
  mode: 'captions' | 'script';
  voice: string;        // PrebuiltVoice 중 하나. 빈 값이면 DEFAULT_VOICE.
  script: string;       // mode='script' 일 때 합성할 대본
};

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  enabled: false,
  mode: 'captions',
  voice: DEFAULT_VOICE,
  script: '',
};

export async function readTtsConfig(projectId: string): Promise<TtsConfig> {
  try {
    const t = await fs.readFile(ARTIFACTS.ttsConfig(projectId), 'utf-8');
    const parsed = JSON.parse(t);
    return normalize(parsed);
  } catch {
    return { ...DEFAULT_TTS_CONFIG };
  }
}

export async function writeTtsConfig(projectId: string, cfg: Partial<TtsConfig>): Promise<void> {
  await ensureDir(projectDir(projectId));
  const merged = normalize({ ...DEFAULT_TTS_CONFIG, ...cfg });
  await fs.writeFile(ARTIFACTS.ttsConfig(projectId), JSON.stringify(merged, null, 2), 'utf-8');
}

function normalize(raw: any): TtsConfig {
  const mode = raw?.mode === 'script' ? 'script' : 'captions';
  const voiceRaw = String(raw?.voice || '').trim();
  const voice: string = (PREBUILT_VOICES as readonly string[]).includes(voiceRaw)
    ? voiceRaw
    : DEFAULT_VOICE;
  return {
    enabled: raw?.enabled === true,
    mode,
    voice,
    script: String(raw?.script || '').slice(0, 5000),
  };
}
