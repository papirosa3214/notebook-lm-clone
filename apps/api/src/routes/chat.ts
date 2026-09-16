import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { ChatDeltaSchema, ChatRequestSchema, type CitationChunk } from '@notebook/shared';
import { CITATION_INSTRUCTIONS, formatContextForPrompt } from '@notebook/shared/providers';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { retrieve } from '../ragflow/client.js';
import { getProvider } from '../providers/index.js';

function mapChunk(sourceId: string, sourceTitle: string, sourceKind: 'url' | 'file' | 'youtube', c: Awaited<ReturnType<typeof retrieve>>[number]): CitationChunk {
  return {
    id: c.id ?? c.chunk_id ?? '',
    sourceId,
    sourceTitle,
    sourceKind,
    text: c.content ?? c.content_with_weight ?? '',
    score: c.similarity ?? c.score ?? 0,
  };
}

export const chatRoutes: FastifyPluginAsync = async (app) => {
  // list models per provider
  app.get('/api/providers/:id/models', async (req) => {
    const { id } = req.params as { id: 'ollama' | 'anthropic' | 'openai' };
    const provider = getProvider(id);
    const models = await provider.listModels();
    return { provider: id, default: provider.defaultModel, models };
  });

  // debug: dry-run retrieval (returns top-k without calling LLM)
  app.get<{ Params: { id: string }; Querystring: { q?: string; topK?: string } }>(
    '/api/notebooks/:id/retrieve',
    async (req, reply) => {
      const q = req.query.q;
      if (!q) return reply.code(400).send({ error: 'q is required' });
      const topK = Number(req.query.topK ?? '5');
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });
      const chunks = await retrieve(nb.ragflowDatasetId, q, topK);
      const sourceMap = new Map(
        db.select().from(sources).where(eq(sources.notebookId, req.params.id)).all().map((s) => [s.ragflowDocId, s]),
      );
      const citations: CitationChunk[] = chunks.map((c) => {
        const s = sourceMap.get(c.document_id ?? c.doc_id);
        return mapChunk(
          s?.id ?? c.doc_id,
          c.document_keyword ?? c.docnm_kwd ?? 'source',
          s?.kind ?? 'url',
          c,
        );
      });
      return { chunks, citations };
    },
  );

  // SSE chat
  app.post<{ Params: { id: string } }>('/api/notebooks/:id/chat', async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.format() });
    }
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });

    const providerId = (parsed.data.provider ?? nb.defaultProvider) as 'anthropic' | 'openai' | 'ollama';
    const model = parsed.data.model ?? nb.defaultModel;
    const provider = getProvider(providerId);

    // 1. retrieve top-k chunks as citations
    const topK = parsed.data.topK ?? 5;
    let citations: CitationChunk[] = [];
    try {
      const raw = await retrieve(nb.ragflowDatasetId, parsed.data.message, topK);
      const sourceMap = new Map(
        db.select().from(sources).where(eq(sources.notebookId, req.params.id)).all().map((s) => [s.ragflowDocId, s]),
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
      req.log.warn({ err }, 'retrieve failed; proceeding without context');
    }

    // 2. SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (delta: unknown) => {
      const parsed = ChatDeltaSchema.safeParse(delta);
      if (!parsed.success) return;
      reply.raw.write(`data: ${JSON.stringify(parsed.data)}\n\n`);
    };

    // 3. send citations first
    send({ type: 'citations', chunks: citations });

    // 4. build messages: system (instructions + context) + history + user
    const systemPrompt = `${CITATION_INSTRUCTIONS}\n\nSOURCES:\n${formatContextForPrompt(citations)}`;
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...(parsed.data.history ?? []),
      { role: 'user' as const, content: parsed.data.message },
    ];

    // 5. stream from provider
    const messageId = nanoid(12);
    try {
      for await (const ev of provider.chat({
        providerId,
        model,
        messages,
        context: citations,
        temperature: 0.2,
        maxTokens: 1024,
      })) {
        if (ev.text) send({ type: 'token', text: ev.text });
        if (ev.done) break;
      }
      send({ type: 'done', messageId });
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
  });
};
