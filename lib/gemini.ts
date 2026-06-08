// ============================================================
// Gemini generateContent + Files API 래퍼.
// 18MB 초과 영상은 자동으로 Files API resumable upload 로 전환.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { config } from './config';

export type GeminiResult = { raw: any; parsed: any; rawText: string };

const INLINE_MAX_BYTES = 18 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function analyzeVideoStructured(
  filePath: string,
  prompt: string,
  model?: string,
): Promise<GeminiResult> {
  if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다');

  const useModel = model || config.GEMINI_PRO_MODEL;
  const url = `${config.GEMINI_API_BASE}/v1beta/models/${useModel}:generateContent`;

  const stat = await fs.stat(filePath);
  const mimeType = guessMimeType(filePath);

  let mediaPart: any;
  if (stat.size <= INLINE_MAX_BYTES) {
    const buf = await fs.readFile(filePath);
    mediaPart = { inline_data: { mime_type: mimeType, data: buf.toString('base64') } };
  } else {
    const uploaded = await uploadFile(filePath, mimeType);
    mediaPart = { file_data: { mime_type: mimeType, file_uri: uploaded.uri } };
  }

  const body = {
    contents: [{ role: 'user', parts: [mediaPart, { text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      // 기본값이 8K 라 영상 segment 가 많으면 JSON 이 잘림.
      // Flash/Pro 모두 65K 까지 지원.
      maxOutputTokens: 65536,
    },
  };

  const rawText = await fetchGeminiJsonWithRetry(url, body, `Gemini ${useModel}`);
  let raw: any;
  try { raw = JSON.parse(rawText); } catch { raw = { non_json_response: rawText }; }

  const text = extractText(raw) ?? rawText;
  const parsed = parseJsonLoose(text);
  return { raw, parsed, rawText: text };
}

// ============================================================
// 멀티파트 (이미지 N장 + 오디오 1개 등) 호출.
// 풀 영상을 업로드하지 않고 keyframe + 오디오만 보낼 때 사용.
// parts 배열 순서는 prompt 에서 인덱스로 참조하도록 caller 가 설명한다.
// ============================================================

export type MediaPart = {
  filePath: string;
  mimeType?: string;        // 미지정이면 확장자로 추정
};

export async function analyzeMultiPartStructured(
  mediaParts: MediaPart[],
  prompt: string,
  model?: string,
  opts?: { temperature?: number },
): Promise<GeminiResult> {
  if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다');

  const useModel = model || config.GEMINI_FLASH_MODEL;
  const url = `${config.GEMINI_API_BASE}/v1beta/models/${useModel}:generateContent`;

  const parts: any[] = [];
  for (const m of mediaParts) {
    const mime = m.mimeType || guessAnyMimeType(m.filePath);
    const stat = await fs.stat(m.filePath);
    if (stat.size <= INLINE_MAX_BYTES) {
      const buf = await fs.readFile(m.filePath);
      parts.push({ inline_data: { mime_type: mime, data: buf.toString('base64') } });
    } else {
      const uploaded = await uploadFile(m.filePath, mime);
      parts.push({ file_data: { mime_type: mime, file_uri: uploaded.uri } });
    }
  }
  parts.push({ text: prompt });

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      // 기본은 낮은 temperature(충실한 묘사/분석). 재생성 등 변형이 필요하면 caller 가 올린다.
      temperature: opts?.temperature ?? 0.2,
      maxOutputTokens: 65536,
    },
  };

  const rawText = await fetchGeminiJsonWithRetry(url, body, `Gemini ${useModel} multipart`);
  let raw: any;
  try { raw = JSON.parse(rawText); } catch { raw = { non_json_response: rawText }; }
  const text = extractText(raw) ?? rawText;
  const parsed = parseJsonLoose(text);
  return { raw, parsed, rawText: text };
}

// ============================================================
// Files API: resumable upload + ACTIVE 대기
// ============================================================

async function uploadFile(filePath: string, mimeType: string): Promise<{ uri: string; name: string }> {
  const buf = await fs.readFile(filePath);
  const displayName = path.basename(filePath);

  // 1) start upload session
  const startRes = await fetch(`${config.GEMINI_API_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': config.GEMINI_API_KEY,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!startRes.ok) {
    const t = await startRes.text();
    throw new Error(`Files API start ${startRes.status}: ${t.slice(0, 400)}`);
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url') || startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('Files API: upload URL 헤더 없음');

  // 2) upload + finalize
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buf.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buf,
  });
  if (!upRes.ok) {
    const t = await upRes.text();
    throw new Error(`Files API upload ${upRes.status}: ${t.slice(0, 400)}`);
  }
  const upJson: any = await upRes.json().catch(() => ({}));
  const file = upJson?.file;
  if (!file?.uri || !file?.name) {
    throw new Error(`Files API upload 응답 파싱 실패: ${JSON.stringify(upJson).slice(0, 400)}`);
  }

  // 3) poll until ACTIVE
  const maxWaitMs = 5 * 60 * 1000;
  const start = Date.now();
  let state = file.state ?? 'PROCESSING';
  let uri = file.uri as string;
  while (state !== 'ACTIVE') {
    if (state === 'FAILED') throw new Error(`Files API: 파일 처리 실패 (${file.name})`);
    if (Date.now() - start > maxWaitMs) throw new Error(`Files API: 5분 안에 ACTIVE 안 됨 (${file.name})`);
    await sleep(2000);
    const r = await fetch(`${config.GEMINI_API_BASE}/v1beta/${file.name}`, {
      headers: { 'x-goog-api-key': config.GEMINI_API_KEY },
    });
    if (!r.ok) throw new Error(`Files API state ${r.status}`);
    const j: any = await r.json();
    state = j?.state ?? state;
    uri = j?.uri ?? uri;
  }
  return { uri, name: file.name };
}

// ============================================================
// 텍스트 단독 호출 (영상 없이 prompt 만으로 JSON 결과 받기)
// Stage 1 의 caption planning 등에서 사용.
// ============================================================
export async function callGeminiTextOnly(
  prompt: string,
  opts?: {
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
    // Gemini 2.5/3 계열은 thinking 모델 — maxOutputTokens 안에 추론 토큰도 포함된다.
    // 단순 추출/요약처럼 추론이 거의 필요 없으면 0 으로 끄는 게 안전 (출력 토큰 보존).
    // undefined 면 모델 기본값(=자동).
    thinkingBudget?: number;
    // 구글 검색 그라운딩 — 응답 전에 웹을 검색해 최신 정보(트렌드 등)를 반영한다.
    // 검색 도구는 JSON 강제 모드(responseMimeType)와 함께 못 쓰므로, 켜면 JSON 강제를 끄고
    // 응답 텍스트에서 JSON 을 느슨 파싱한다 (parseJsonLoose).
    groundWithSearch?: boolean;
  },
): Promise<any> {
  if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다');
  const model = opts?.model || config.GEMINI_FLASH_MODEL;
  const url = `${config.GEMINI_API_BASE}/v1beta/models/${model}:generateContent`;
  const grounded = opts?.groundWithSearch === true;
  const generationConfig: any = {
    temperature: opts?.temperature ?? 0.6,
    maxOutputTokens: opts?.maxOutputTokens ?? 16384,
  };
  // 그라운딩이 아닐 때만 JSON 강제 (검색 도구와 동시 사용 불가).
  if (!grounded) generationConfig.responseMimeType = 'application/json';
  if (typeof opts?.thinkingBudget === 'number') {
    generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
  }
  const body: any = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (grounded) body.tools = [{ google_search: {} }];
  const rawText = await fetchGeminiJsonWithRetry(url, body, `Gemini text ${model}`);
  let raw: any;
  try { raw = JSON.parse(rawText); } catch { raw = { non_json_response: rawText }; }
  const text = extractText(raw) ?? rawText;
  const parsed = parseJsonLoose(text);
  return { raw, parsed };
}

async function fetchGeminiJsonWithRetry(url: string, body: any, label: string): Promise<string> {
  const maxAttempts = 4;
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    const rawText = await res.text();
    if (res.ok) return rawText;

    lastError = `${label} ${res.status}: ${rawText.slice(0, 800)}`;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === maxAttempts) {
      throw new Error(lastError);
    }

    await sleep(retryDelayMs(attempt, res.headers.get('retry-after')));
  }

  throw new Error(lastError || `${label}: unknown error`);
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const retryAfterSec = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(30_000, retryAfterSec * 1000);
  }
  const base = Math.min(30_000, 1500 * Math.pow(2, attempt - 1));
  return base + Math.floor(Math.random() * 500);
}

function extractText(raw: any): string | null {
  try {
    const parts = raw?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const merged = parts.map((p: any) => p?.text ?? '').join('');
      if (merged) return merged;
    }
    if (typeof raw?.output_text === 'string') return raw.output_text;
    return null;
  } catch { return null; }
}

function parseJsonLoose(text: string): any {
  if (!text) throw new Error('빈 응답');
  const stripped = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // 1) 그대로 시도
  try { return JSON.parse(stripped); } catch {}

  // 2) 첫 { ~ 마지막 } 잘라서 시도
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(stripped.slice(first, last + 1)); } catch {}
  }

  // 3) 응답이 잘린 경우: 마지막 완전 element 까지 자르고 stack 으로 닫기
  const recovered = recoverTruncatedJson(stripped);
  if (recovered) {
    try { return JSON.parse(recovered); } catch {}
  }

  throw new Error(
    `JSON 파싱 실패. 응답이 maxOutputTokens 한도에 의해 잘렸을 가능성 큼.\n` +
    `응답 시작 200자: ${stripped.slice(0, 200)}\n` +
    `응답 끝 200자: ${stripped.slice(-200)}`
  );
}

/**
 * 잘린 JSON 복구:
 * 마지막으로 깊이 0 으로 닫혔던 위치까지 자른 뒤, 남은 stack 을 역순으로 닫는다.
 * 예: '{"shots":[{"a":1},{"a":2},{"a":3' → '{"shots":[{"a":1},{"a":2}]}'
 */
function recoverTruncatedJson(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  s = s.slice(start);

  let inString = false;
  let escape = false;
  const stack: string[] = [];
  // 각 깊이가 닫혔던 마지막 인덱스. stack pop 시 새 길이의 인덱스를 기록.
  const lastClosedAtDepth: number[] = [];

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') {
      stack.push(c);
    } else if (c === '}' || c === ']') {
      stack.pop();
      lastClosedAtDepth[stack.length] = i;
    }
  }

  if (stack.length === 0) return s; // 이미 균형

  // 현재 stack.length 깊이에서 마지막으로 닫혔던 위치 (= 마지막 완전 element 끝)
  // 그 위치 + 1 부터는 미완성, 잘라내고 stack 을 역순으로 닫는다.
  const cutAt = lastClosedAtDepth[stack.length];
  if (cutAt === undefined) return null;

  let out = s.slice(0, cutAt + 1);
  while (stack.length > 0) {
    const opener = stack.pop()!;
    out += opener === '{' ? '}' : ']';
  }
  return out;
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.avi') return 'video/x-msvideo';
  return 'video/mp4';
}

// 이미지·오디오·영상 모두 커버하는 mime 추정. 멀티파트 호출에서 사용.
function guessAnyMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  // 이미지
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  // 오디오
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a') return 'audio/mp4';
  // 영상 (기존 매핑)
  return guessMimeType(filePath);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
