import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  SuggestionsDeltaSchema,
  SuggestionsRequestSchema,
  type ChatMessage,
} from '@notebook/shared';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { config } from '../config.js';
import { getProvider } from '../providers/index.js';
import { parseJsonArray } from '../lib/studio/jsonArray.js';
// `parseJsonArray` lives in src/lib/studio/jsonArray.js (shared with
// the flashcards template). It returns the raw parsed elements; for
// suggestions we just keep the string entries.

const MAX_SUGGESTION_CHARS = 200;

/**
 * POST /api/notebooks/:id/suggestions
 *
 * Streams 3 follow-up question suggestions based on the last
 * user-question + assistant-answer. The same shape is used in
 * NotebookLM, where the chip row appears under the assistant
 * message.
 *
 * Implementation notes:
 *  - LLM is asked to emit a JSON array of N short questions. The
 *    streamed text is buffered and parsed on the server (we already
 *    have parseJsonArray for the same job), then a single
 *    `suggestions` event is sent with the clean list. This keeps
 *    the client dumb (no JSON parse on the wire) at the cost of
 *    a tiny per-suggestion latency. Cost is acceptable because
 *    suggestions are low-priority and we already pay the full
 *    chat turn latency.
 *  - sourceIds (when set) is validated the same way as /chat:
 *    unknown ids are rejected with 400 before we even start the LLM.
 *  - SUGGESTIONS_ENABLED=false turns the route into a 503-equivalent
 *    so the client knows to skip the chip row without a retry loop.
 */
export const suggestionRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/suggestions',
    async (req, reply) => {
      if (!config.SUGGESTIONS_ENABLED) {
        return reply.code(503).send({
          error: 'suggestions disabled (SUGGESTIONS_ENABLED=false)',
        });
      }

      const parsed = SuggestionsRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.format() });
      }

      const db = getDb();
      const nb = db
        .select({ id: notebooks.id })
        .from(notebooks)
        .where(eq(notebooks.id, req.params.id))
        .get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      // sourceIds validation, same as /chat and /audio-overview.
      const requested = parsed.data.sourceIds ?? [];
      if (requested.length > 0) {
        const dedup = Array.from(new Set(requested));
        const found = db
          .select({ id: sources.id })
          .from(sources)
          .where(eq(sources.notebookId, req.params.id))
          .all()
          .map((r) => r.id);
        const foundSet = new Set(found);
        const missing = dedup.filter((id) => !foundSet.has(id));
        if (missing.length > 0) {
          return reply.code(400).send({ error: `unknown sourceIds: ${missing.join(', ')}` });
        }
      }

      const notebook = db
        .select({
          defaultProvider: notebooks.defaultProvider,
          defaultModel: notebooks.defaultModel,
        })
        .from(notebooks)
        .where(eq(notebooks.id, req.params.id))
        .get()!;
      const providerId = (parsed.data.provider ?? notebook.defaultProvider) as
        | 'ollama'
        | 'anthropic'
        | 'openai';
      const model = parsed.data.model ?? notebook.defaultModel;
      const count = parsed.data.count;

      const historyText = (parsed.data.history ?? [])
        .slice(-6) // keep prompt small
        .map((m: ChatMessage) => `${m.role === 'user' ? 'Ты' : 'Ассистент'}: ${m.content}`)
        .join('\n');

      const systemPrompt =
        'Ты — ассистент NotebookLM. Тебе дают последний вопрос пользователя и ответ ассистента по материалам ноутбука. ' +
        'Предложи ровно N коротких follow-up вопросов на русском, которые естественно продолжают тему. ' +
        'Требования: 1) строго JSON-массив строк, 2) каждый вопрос < 200 символов, 3) без вводных фраз ' +
        'типа "вот варианты" и без markdown-обёрток, 4) разнообразь формулировки (что/как/почему/сравни).';
      const userPrompt = [
        historyText ? `## Контекст разговора\n${historyText}\n` : '',
        `## Последний вопрос\n${parsed.data.question}\n`,
        `## Ответ ассистента\n${parsed.data.answer}\n`,
        `\nВерни JSON-массив из ${count} строк-вопросов.`,
      ].join('');

      const provider = getProvider(providerId);

      // SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (delta: unknown) => {
        const ok = SuggestionsDeltaSchema.safeParse(delta);
        if (!ok.success) return;
        reply.raw.write(`data: ${JSON.stringify(ok.data)}\n\n`);
      };

      let raw = '';
      try {
        for await (const ev of provider.chat({
          providerId,
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          context: [],
          temperature: 0.4,
          maxTokens: 240,
        })) {
          if (ev.text) {
            raw += ev.text;
            send({ type: 'token', text: ev.text });
          }
          if (ev.done) break;
        }

        const items = parseJsonArray(raw, count).slice(0, count);
        if (items.length === 0) {
          send({ type: 'error', message: 'model did not return a parseable JSON array' });
        } else {
          const cleaned = items
            .map((s) => (typeof s === 'string' ? s.trim().slice(0, MAX_SUGGESTION_CHARS) : ''))
            .filter((s) => s.length > 0);
          if (cleaned.length === 0) {
            send({ type: 'error', message: 'all suggestions were empty after sanitisation' });
          } else {
            send({ type: 'suggestions', suggestions: cleaned });
            send({ type: 'done' });
          }
        }
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        reply.raw.end();
      }
    },
  );
};
