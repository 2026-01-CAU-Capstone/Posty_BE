// ============================================================
// 프로젝트별 TTS 설정 (Stage 4 narration).
//
// 옵션 트리:
//   enabled = false                       → TTS 끔 (원본/ BGM 만)
//   enabled = true
//     source = 'captions'                 → 자막 읽기: 화면 자막을 그대로 음성으로
//     source = 'generate'                 → 새로 생성
//       genMode = 'auto'                  →   자동 생성 (LLM 이 나레이션 작성)
//       genMode = 'manual'                →   수동 작업 (사용자가 script 직접 작성)
//
// 실제 나레이션 segment 생성은 lib/narration.ts 의 prepareNarrationOutline 이
// 이 설정을 보고 처리한다. Stage 4 는 그 결과(segments)를 합성·배치한다.
// ============================================================

import fs from 'fs/promises';
import { ARTIFACTS, ensureDir, projectDir } from './paths';
import { DEFAULT_VOICE, PREBUILT_VOICES } from './tts';

export type TtsSource = 'captions' | 'generate';
export type TtsGenMode = 'auto' | 'manual';

export type TtsConfig = {
  enabled: boolean;
  source: TtsSource;        // 자막 읽기 vs 새로 생성
  genMode: TtsGenMode;      // source='generate' 일 때만 의미: 자동 vs 수동
  voice: string;            // PrebuiltVoice 중 하나. 빈 값이면 DEFAULT_VOICE.
  script: string;           // source='generate' + genMode='manual' 일 때 사용자가 쓴 나레이션
};

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  enabled: false,
  source: 'captions',
  genMode: 'auto',
  voice: DEFAULT_VOICE,
  script: '',
};

// 사용자 작성 나레이션 대본 최대 길이 (글자). normalize 에서 잘라낸다.
const MAX_TTS_SCRIPT_LEN = 5000;

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
  // ---- 하위호환 ----
  // 구버전 스키마: { mode: 'captions' | 'script' }.
  //   mode='captions' → source='captions'
  //   mode='script'   → source='generate', genMode='manual' (사용자가 대본을 직접 넣던 모드)
  let source: TtsSource;
  let genMode: TtsGenMode;
  if (raw?.source === 'captions' || raw?.source === 'generate') {
    source = raw.source;
    genMode = raw?.genMode === 'manual' ? 'manual' : 'auto';
  } else if (raw?.mode === 'script') {
    source = 'generate';
    genMode = 'manual';
  } else {
    source = 'captions';
    genMode = 'auto';
  }

  const voiceRaw = String(raw?.voice || '').trim();
  const voice: string = (PREBUILT_VOICES as readonly string[]).includes(voiceRaw)
    ? voiceRaw
    : DEFAULT_VOICE;

  return {
    enabled: raw?.enabled === true,
    source,
    genMode,
    voice,
    script: String(raw?.script || '').slice(0, MAX_TTS_SCRIPT_LEN),
  };
}
