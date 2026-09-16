import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import {
  SummaryDeltaSchema,
  SummaryRequestSchema,
  type CitationChunk,
} from '@notebook/shared';
import { formatContextForPrompt } from '@notebook/shared/providers';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { retrieve } from '../ragflow/client.js';
import { getProvider } from '../providers/index.js';

const SUMMARY_SYSTEM_INSTRUCTIONS = [
  'You are an analyst that synthesises many sources into a structured overview.',
  'Write a response in Russian (the user interface is Russian).',
  'Use Markdown. Structure:',
  '  ## Краткое содержание — 2-3 предложения, о чём этот ноутбук.',
  '  ## Ключевые темы — список из 3-7 пунктов; каждый пункт начинается с жирной темы и короткого пояснения через двоеточие.',
  '  ## Противоречия и расхождения — если есть, перечисли; если источники согласованы — напиши "Не выявлены".',
  '  ## Пробелы и открытые вопросы — что НЕ покрыто источниками, но логически относится к теме.',
  'Be concise and faithful to the provided sources — do not invent facts.',
  'Reference sources inline with [N] markers where appropriate.',
].join('\n');

function buildUserPrompt(focus: string | undefined): string {
  const base = 'Сделай структурированный обзор всех источников в этом ноутбуке.';
  if (focus && focus.trim()) {
    return `${base}\n\nДополнительный акцент от пользователя: ${focus.trim()}`;
  }
  return base;
}

function mapChunk(
  sourceId: string,
  sourceTitle: string,
  sourceKind: 'url' | 'file' | 'youtube',
  c: Awaited<ReturnType<typeof retrieve>>[number],
): CitationChunk {
  return {
    id: c.id ?? c.chunk_id ?? '',
    sourceId,
    sourceTitle,
    sourceKind,
    text: c.content ?? c.content_with_weight ?? '',
    score: c.similarity ?? c.score ?? 0,
  };
}

export const summaryRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>('/api/notebooks/:id/summary', async (req, reply) => {
    const parsed = SummaryRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });

    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });

    // How many sources are ready? If none, short-circuit with a friendly error event.
    const readySources = db
      .select()
      .from(sources)
      .where(eq(sources.notebookId, req.params.id))
      .all()
      .filter((s) => s.status === 'ready');

    if (readySources.length === 0) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (delta: unknown) => {
        const ok = SummaryDeltaSchema.safeParse(delta);
        if (!ok.success) return;
        reply.raw.write(`data: ${JSON.stringify(ok.data)}\n\n`);
      };
      send({
        type: 'error',
        message: 'Нет готовых источников. Добавьте хотя бы один — обзор появится, как только он будет готов.',
      });
      reply.raw.end();
      return;
    }

    const providerId = (parsed.data.provider ?? nb.defaultProvider) as 'anthropic' | 'openai' | 'ollama';
    const model = parsed.data.model ?? nb.defaultModel;
    const provider = getProvider(providerId);
    const topK = parsed.data.topK ?? 12;

    // 1. Retrieve a broad set of chunks (more than chat — we want coverage, not precision)
    let citations: CitationChunk[] = [];
    try {
      const raw = await retrieve(nb.ragflowDatasetId, 'обзор тем и ключевых фактов', topK);
      const sourceMap = new Map(
        db
          .select()
          .from(sources)
          .where(eq(sources.notebookId, req.params.id))
          .all()
          .map((s) => [s.ragflowDocId, s]),
      );
      citations = raw.map((c) => {
        const s = sourceMap.get(c.document_id ?? c.doc_id);
        return mapChunk(
          s?.id ?? c.doc_id,
          c.document_keyword ?? c.docnm_kwd ?? 'source',
          s?.kind ?? 'url',
          c,
        );
      });
    } catch (err) {
      req.log.warn({ err }, 'summary retrieval failed');
      // Continue with empty citations — LLM will get a no-context prompt and produce a sensible message.
    }

    // 2. SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (delta: unknown) => {
      const ok = SummaryDeltaSchema.safeParse(delta);
      if (!ok.success) return;
      reply.raw.write(`data: ${JSON.stringify(ok.data)}\n\n`);
    };

    // 3. Emit citations first so the UI can show "based on N sources"
    send({ type: 'citations', chunks: citations });

    const systemPrompt = `${SUMMARY_SYSTEM_INSTRUCTIONS}\n\nSOURCES:\n${formatContextForPrompt(citations)}`;
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: buildUserPrompt(parsed.data.focus) },
    ];

    const summaryId = nanoid(12);
    try {
      for await (const ev of provider.chat({
        providerId,
        model,
        messages,
        context: citations,
        temperature: 0.3,
        maxTokens: 1200,
      })) {
        if (ev.text) send({ type: 'token', text: ev.text });
        if (ev.done) break;
      }
      send({ type: 'done', summaryId });
    } catch (err) {
      send({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reply.raw.end();
    }
  });
};