// ============================================================
// Gemini TTS 래퍼 (Stage 4 narration 용)
// - 모델: gemini-2.5-flash-preview-tts (기본값)
// - generateContent + responseModalities=['AUDIO'] + speechConfig.voiceConfig
// - 응답은 candidates[0].content.parts[0].inline_data.data (base64 PCM)
//   mimeType 예: "audio/L16;rate=24000" 또는 "audio/L16;codec=pcm;rate=24000"
// - PCM 을 WAV 컨테이너로 래핑해서 FFmpeg 가 그대로 입력 가능하게 저장
// ============================================================

import fs from 'fs/promises';
import { config } from './config';

// 사용 가능한 prebuilt voice (Gemini Live/TTS 공식 보이스).
// 한국어 발화는 모든 voice 가 multilingual 로 지원하지만 인상이 다르다.
export const PREBUILT_VOICES = [
  'Kore',        // 차분/명료 (한국어 권장 기본값)
  'Puck',        // 발랄/명랑
  'Charon',      // 깊고 묵직
  'Aoede',       // 부드러움
  'Fenrir',      // 강하고 단단함
  'Leda',        // 차분 여성
  'Orus',        // 중후 남성
  'Zephyr',      // 가볍고 빠른
] as const;
export type PrebuiltVoice = typeof PREBUILT_VOICES[number];
export const DEFAULT_VOICE: PrebuiltVoice = 'Kore';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export type TtsResult = {
  wavPath: string;
  sampleRate: number;
  durationSec: number;
  text: string;
};

/**
 * 한 텍스트를 합성해서 wavPath 에 저장.
 * 빈 텍스트면 throw.
 */
export async function synthesizeTtsToWav(
  text: string,
  wavPath: string,
  opts?: { voice?: string; model?: string; temperature?: number },
): Promise<TtsResult> {
  if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다');
  const cleaned = String(text || '').trim();
  if (!cleaned) throw new Error('TTS: 빈 텍스트');

  const model = opts?.model || config.GEMINI_TTS_MODEL;
  const voice = (opts?.voice || DEFAULT_VOICE).trim() || DEFAULT_VOICE;
  const url = `${config.GEMINI_API_BASE}/v1beta/models/${model}:generateContent`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: cleaned }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      temperature: opts?.temperature ?? 0.7,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  };

  const raw = await fetchTtsWithRetry(url, body, `Gemini TTS ${model}`);
  const part = raw?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inline_data || p?.inlineData);
  const inline = part?.inline_data || part?.inlineData;
  const base64 = inline?.data;
  const mime: string = inline?.mime_type || inline?.mimeType || '';
  if (!base64) {
    throw new Error(`TTS 응답에 오디오 데이터 없음: ${JSON.stringify(raw).slice(0, 400)}`);
  }

  const pcm = Buffer.from(base64, 'base64');
  const sampleRate = parseSampleRateFromMime(mime) ?? 24000;
  const wav = pcmToWav(pcm, sampleRate, 1, 16);

  await fs.writeFile(wavPath, wav);

  const durationSec = pcm.length / (sampleRate * 2 /* bytes per sample for 16-bit mono */);
  return { wavPath, sampleRate, durationSec, text: cleaned };
}

// ============================================================
// 보조: fetch + retry
// ============================================================
async function fetchTtsWithRetry(url: string, body: any, label: string): Promise<any> {
  const maxAttempts = 4;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      try { return JSON.parse(text); } catch {
        throw new Error(`${label}: JSON 파싱 실패. ${text.slice(0, 400)}`);
      }
    }
    lastError = `${label} ${res.status}: ${text.slice(0, 600)}`;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === maxAttempts) {
      throw new Error(lastError);
    }
    const ra = res.headers.get('retry-after');
    const delay = ra && Number.isFinite(Number(ra)) ? Number(ra) * 1000
      : Math.min(30_000, 1500 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 500);
    await sleep(delay);
  }
  throw new Error(lastError || `${label}: unknown`);
}

function parseSampleRateFromMime(mime: string): number | null {
  if (!mime) return null;
  // 예: "audio/L16;rate=24000" 또는 "audio/L16;codec=pcm;rate=24000"
  const m = /rate\s*=\s*(\d+)/i.exec(mime);
  if (m) return parseInt(m[1], 10);
  return null;
}

// ============================================================
// PCM (16-bit LE) → WAV 컨테이너
// ============================================================
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);                    // ChunkID
  header.writeUInt32LE(36 + dataSize, 4);     // ChunkSize
  header.write('WAVE', 8);                    // Format
  header.write('fmt ', 12);                   // Subchunk1ID
  header.writeUInt32LE(16, 16);               // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                // AudioFormat (1=PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);                   // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);         // Subchunk2Size

  return Buffer.concat([header, pcm]);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
