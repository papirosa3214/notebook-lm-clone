import type { RetrievalChunk } from '../vectordb/client.js';
import { getProvider } from '../providers/index.js';
import type { ChatStreamEvent } from '@notebook/shared/providers';

/**
 * LLM-based reranking of retrieval candidates.
 *
 * Why not a true cross-encoder like bge-reranker-v2-m3? It is not in
 * the official Ollama registry and pulling a custom GGUF on the
 * inference box would step outside the agreed model inventory. Using
 * the same qwen3.6-27b that does chat/summary gives a single point of
 * control over what runs on the GPU. The cost is ~one extra LLM call
 * per chat/summary turn, which is fine at our traffic level.
 *
 * The LLM is asked to assign a relevance score 0-10 to each candidate
 * (truncated to a short preview so the prompt stays small). We parse
 * the JSON array it returns and re-rank. Anything that fails to parse
 * keeps its original RRF order so a flustered model can't degrade
 * retrieval quality below dense+BM25.
 */
export async function rerank(
  query: string,
  candidates: RetrievalChunk[],
  opts: {
    topN?: number; // keep top-N after rerank (default: candidates.length capped at 10)
    provider?: string;
    model?: string;
  } = {},
): Promise<RetrievalChunk[]> {
  if (candidates.length <= 1) return candidates;
  const topN = Math.min(opts.topN ?? 10, candidates.length);

  // Truncate each candidate's content to keep the prompt small.
  const PREVIEW_CHARS = 320;
  const previewList = candidates.map((c, i) => ({
    idx: i,
    title: c.document_keyword,
    preview: c.content.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim(),
  }));

  const systemPrompt = [
    'Ты реранкер поисковой выдачи.',
    'Пользователь задал вопрос. Тебе дан список фрагментов текста (пронумерованных).',
    'Оцени релевантность каждого фрагмента вопросу по шкале 0-10, где 10 = точное попадание, 0 = не относится.',
    'Ответь строго JSON-массивом объектов в том же порядке: [{"idx":0,"score":7},{"idx":1,"score":2},…].',
    'Без markdown-обёрток, без комментариев.',
  ].join('\n');

  const userPrompt = `Вопрос: ${query}\n\nФрагменты:\n${previewList
    .map((p) => `[${p.idx}] ${p.title}\n${p.preview}`)
    .join('\n\n')}`;

  const providerId = (opts.provider ?? 'ollama') as 'ollama' | 'anthropic' | 'openai';
  const provider = getProvider(providerId);
  const model = opts.model ?? provider.defaultModel;

  let acc = '';
  try {
    for await (const ev of provider.chat({
      providerId,
      model,
      context: [],
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.0,
      maxTokens: 200 + candidates.length * 4,
    })) {
      const e = ev as ChatStreamEvent;
      if (e.text) acc += e.text;
      if (e.done) break;
    }
  } catch {
    return candidates.slice(0, topN);
  }

  // Parse JSON array; tolerate trailing junk, fence-wrapped JSON, etc.
  const scores = parseScoreArray(acc, candidates.length);
  if (!scores) return candidates.slice(0, topN);

  // Re-rank by score desc, keep topN.
  return [...candidates]
    .map((c, i) => ({ c, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((entry) => entry.c);
}

function parseScoreArray(raw: string, expectedLen: number): number[] | null {
  const trimmed = raw.trim();
  // Try direct JSON first.
  const candidates: string[] = [trimmed];
  // JSON inside ```json ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) candidates.push(fence[1] ?? '');

  for (const candidate of candidates) {
    try {
      const arr = JSON.parse(candidate) as unknown;
      if (!Array.isArray(arr)) continue;
      const scores = new Array<number>(expectedLen).fill(0);
      for (const item of arr) {
        if (typeof item !== 'object' || item === null) continue;
        const o = item as { idx?: unknown; score?: unknown };
        const idx = typeof o.idx === 'number' ? o.idx : NaN;
        const score = typeof o.score === 'number' ? o.score : NaN;
        if (!Number.isFinite(idx) || !Number.isFinite(score)) continue;
        if (idx < 0 || idx >= expectedLen) continue;
        scores[idx] = Math.max(0, Math.min(10, score));
      }
      return scores;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}
