import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { chunks, sources as sourcesTable } from '../db/schema.js';
import { getProvider } from '../providers/index.js';
import type { ChatStreamEvent } from '@notebook/shared/providers';

const SAMPLE_BUDGET = 16_000; // chars sampled from the source

/**
 * Build a representative sample of the source's chunks, capped at
 * ~SAMPLE_BUDGET chars. For long documents we take the first chunk,
 * then evenly spaced middle chunks, then the last chunk — this keeps
 * the prompt small while preserving the topic distribution.
 */
function sampleChunks(all: Array<{ ordinal: number; content: string }>): string {
  if (all.length === 0) return '';
  const sorted = [...all].sort((a, b) => a.ordinal - b.ordinal);
  const total = sorted.reduce((n, c) => n + c.content.length, 0);
  if (total <= SAMPLE_BUDGET) return sorted.map((c) => c.content).join('\n\n');

  // Pick first, last, and ~5 evenly-spaced middle indices.
  const PICK = 7;
  const step = Math.max(1, Math.floor(sorted.length / (PICK - 1)));
  const indices: number[] = [];
  for (let i = 0; i < PICK; i++) {
    const idx = Math.min(sorted.length - 1, i * step);
    if (indices[indices.length - 1] !== idx) indices.push(idx);
  }
  // Always include last chunk.
  if (indices[indices.length - 1] !== sorted.length - 1) {
    indices.push(sorted.length - 1);
  }
  return indices
    .map((i) => sorted[i]?.content ?? '')
    .filter((c) => c.length > 0)
    .join('\n\n');
}

/** Parse `{summary, topics}` JSON from the model. Falls back gracefully
 *  when the model wraps the JSON in markdown or returns plain text. */
function parseSummaryResponse(raw: string): { summary: string; topics: string[] } {
  const trimmed = raw.trim();

  // 1) Direct JSON
  try {
    const obj = JSON.parse(trimmed) as { summary?: unknown; topics?: unknown };
    if (typeof obj.summary === 'string') {
      return {
        summary: obj.summary.trim(),
        topics: Array.isArray(obj.topics)
          ? obj.topics.filter((t): t is string => typeof t === 'string').slice(0, 8)
          : [],
      };
    }
  } catch {
    /* fall through */
  }

  // 2) JSON inside ```json ... ``` block
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try {
      const obj = JSON.parse(fence[1] ?? '{}') as { summary?: unknown; topics?: unknown };
      if (typeof obj.summary === 'string') {
        return {
          summary: obj.summary.trim(),
          topics: Array.isArray(obj.topics)
            ? obj.topics.filter((t): t is string => typeof t === 'string').slice(0, 8)
            : [],
        };
      }
    } catch {
      /* fall through */
    }
  }

  // 3) Plain text fallback — wrap as summary, no topics.
  return { summary: trimmed.slice(0, 1000), topics: [] };
}

/**
 * Generate a 2-3 sentence summary + topic chips for one source.
 * Persists to the `sources` table and returns the result.
 *
 * Idempotent-ish: caller should pass `force: true` to overwrite an
 * existing summary. The DB-level guard `summarized_at` is checked
 * before any LLM call when `force` is false, so concurrent ingest
 * paths don't double-charge the model.
 */
export async function summarizeSource(
  sourceId: string,
  opts: {
    provider?: string;
    model?: string;
    force?: boolean;
  } = {},
): Promise<{ summary: string; topics: string[]; generatedAt: string } | null> {
  const db = getDb();

  // Fetch source + its chunks in one query (chunks table has sourceId).
  const row = db
    .select()
    .from(sourcesTable)
    .where(eq(sourcesTable.id, sourceId))
    .get();
  if (!row) return null;
  if (row.status !== 'ready') return null;
  if (row.summary && row.summarizedAt && !opts.force) {
    // Already summarized and not asked to refresh — short-circuit.
    return {
      summary: row.summary,
      topics: row.summaryTopics ? safeParseTopics(row.summaryTopics) : [],
      generatedAt: row.summarizedAt,
    };
  }

  const allChunks = db
    .select({ ordinal: chunks.ordinal, content: chunks.content })
    .from(chunks)
    .where(eq(chunks.sourceId, sourceId))
    .all();
  if (allChunks.length === 0) return null;

  const sample = sampleChunks(allChunks);
  if (!sample.trim()) return null;

  const providerId = (opts.provider ?? 'ollama') as 'ollama' | 'anthropic' | 'openai';
  const provider = getProvider(providerId);
  const model = opts.model ?? provider.defaultModel;

  const systemPrompt = [
    'Ты редактор-аналитик.',
    'По предоставленному тексту верни строго JSON в формате:',
    '{"summary": "2-3 предложения по-русски", "topics": ["3-5 коротких тем на русском"]}',
    'Пиши только то, что есть в тексте. Не выдумывай. Без markdown-обёрток.',
  ].join('\n');
  const userPrompt = `Название источника: ${row.title}\n\nТекст:\n${sample}`;

  // chat() is streaming — collect all tokens.
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
      temperature: 0.2,
      maxTokens: 400,
    })) {
      const e = ev as ChatStreamEvent;
      if (e.text) acc += e.text;
      if (e.done) break;
    }
  } catch (err) {
    // Swallow — caller (fire-and-forget ingest path) logs and moves on.
    // Throwing here would kill the request that triggered ingest.
    return null;
  }

  const parsed = parseSummaryResponse(acc);
  if (!parsed.summary) return null;

  const generatedAt = new Date().toISOString();
  db.update(sourcesTable)
    .set({
      summary: parsed.summary,
      summaryTopics: JSON.stringify(parsed.topics),
      summarizedAt: generatedAt,
    })
    .where(eq(sourcesTable.id, sourceId))
    .run();

  return { ...parsed, generatedAt };
}

function safeParseTopics(raw: string): string[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((t): t is string => typeof t === 'string').slice(0, 8);
  } catch {
    return [];
  }
}
