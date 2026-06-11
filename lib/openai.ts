// ============================================================
// OpenAI Embeddings API (Stage 1 매칭용)
// text-embedding-3-small : 1536 차원, $0.02 / 1M tokens
// ============================================================

import { config } from './config';

// OpenAI embeddings 는 한 요청당 input 2048개 하드 한도가 있다.
// 긴 소스(수백~수천 shot)에서 한 번에 다 보내면 400 으로 터지므로 배치로 쪼갠다.
const EMBED_BATCH = 256;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 가 설정되지 않았습니다');
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const vecs = await embedBatch(batch);
    out.push(...vecs);
  }
  return out;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${config.OPENAI_API_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.OPENAI_EMBEDDING_MODEL,
      input: texts,
    }),
  });

  const rawText = await res.text();
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${rawText.slice(0, 600)}`);
  const json = JSON.parse(rawText);
  const data = json?.data;
  if (!Array.isArray(data)) throw new Error('OpenAI embeddings: data 배열 없음');

  // index 순서대로 정렬해서 반환
  const sorted = [...data].sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
  return sorted.map((d: any) => d.embedding as number[]);
}

// ============================================================
// OpenAI Chat (JSON 모드) — 긴 소스 축약의 "최종 컷 선별" 용.
// response_format=json_object 로 강제하고 파싱해서 객체를 돌려준다.
// ============================================================
export async function chatJson(
  prompt: string,
  opts?: { model?: string; temperature?: number; maxTokens?: number },
): Promise<any> {
  if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 가 설정되지 않았습니다');
  const model = opts?.model || config.OPENAI_CHAT_MODEL;

  const res = await fetch(`${config.OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: opts?.temperature ?? 0.3,
      max_tokens: opts?.maxTokens ?? 4096,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const rawText = await res.text();
  if (!res.ok) throw new Error(`OpenAI chat ${res.status}: ${rawText.slice(0, 600)}`);
  const json = JSON.parse(rawText);
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('OpenAI chat: content 없음');
  try {
    return JSON.parse(content);
  } catch {
    // json_object 모드라 보통 깨질 일 없지만, 방어적으로 { ~ } 잘라 재시도
    const a = content.indexOf('{');
    const b = content.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(content.slice(a, b + 1));
    throw new Error('OpenAI chat: JSON 파싱 실패');
  }
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
