import { getProvider } from '../../providers/index.js';
import type { RetrievalChunk } from '../../vectordb/client.js';
import type { RerankProvider } from './provider.js';

/**
 * LLM-based reranking.
 *
 * The model is asked to assign a relevance score 0-10 to each candidate
 * (truncated to a short preview so the prompt stays small). We parse
 * the JSON array it returns and re-rank. Anything that fails to parse
 * keeps its original RRF order so a flustered model can't degrade
 * retrieval quality below dense+BM25.
 *
 * Cost is ~one extra LLM call per chat/summary turn, which is fine at
 * our traffic level. For a heavier workload, swap in `HttpRerankProvider`
 * (bge-reranker-v2-m3 via TEI) — same interface, ~10× faster.
 */
export class LlmRerankProvider implements RerankProvider {
  readonly id = 'llm';

  async rerank(
    query: string,
    candidates: RetrievalChunk[],
    topN: number,
    opts: { provider?: string; model?: string } = {},
  ): Promise<RetrievalChunk[]> {
    if (candidates.length <= 1) return candidates.slice(0, topN);
    const effectiveTopN = Math.min(topN, candidates.length);

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
        if (ev.text) acc += ev.text;
        if (ev.done) break;
      }
    } catch {
      return candidates.slice(0, effectiveTopN);
    }

    const scores = parseScoreArray(acc, candidates.length);
    if (!scores) return candidates.slice(0, effectiveTopN);

    return [...candidates]
      .map((c, i) => ({ c, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, effectiveTopN)
      .map((entry) => entry.c);
  }
}

/**
 * Parse the LLM response into a per-candidate score array. Tolerates
 * trailing junk, fence-wrapped JSON, missing entries, and out-of-range
 * indices. Returns null on unrecoverable parse failure so the caller
 * can fall back to the RRF ordering.
 */
export function parseScoreArray(raw: string, expectedLen: number): number[] | null {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
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
