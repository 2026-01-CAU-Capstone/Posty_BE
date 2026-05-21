// ============================================================
// OpenAI Embeddings API (Stage 1 매칭용)
// text-embedding-3-small : 1536 차원, $0.02 / 1M tokens
// ============================================================

import { config } from './config';

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 가 설정되지 않았습니다');
  if (texts.length === 0) return [];

  // OpenAI 는 한 번에 여러 input 가능
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
