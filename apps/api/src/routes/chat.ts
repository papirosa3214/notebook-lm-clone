import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { ChatRequestSchema, ChatDeltaSchema, type CitationChunk } from '@notebook/shared';
import { CITATION_INSTRUCTIONS, formatContextForPrompt } from '@notebook/shared/providers';
import { getDb } from '../db/index.js';
import { notebooks } from '../db/schema.js';
import { retrieve, retrieveWithRerank, type RetrievalChunk } from '../vectordb/client.js';
import { getProvider } from '../providers/index.js';

function mapChunk(c: RetrievalChunk): CitationChunk {
  return {
    id: c.id,
    sourceId: c.doc_id,
    sourceTitle: c.docnm_kwd,
    sourceKind: 'url',
    text: c.content,
    score: c.similarity,
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

  // dry-run retrieval
  app.get<{ Params: { id: string }; Querystring: { q?: string; topK?: string } }>(
    '/api/notebooks/:id/retrieve',
    async (req, reply) => {
      const q = req.query.q;
      if (!q) return reply.code(400).send({ error: 'q is required' });
      const topK = Number(req.query.topK ?? '5');
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });
      const chunks = await retrieve(req.params.id, q, topK);
      return { chunks, citations: chunks.map(mapChunk) };
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

    // 1. retrieve top-k chunks as citations.
    // retrieveWithRerank pulls a wider candidate pool (16) and reranks
    // down to topK using an LLM-based scorer — better ordering for
    // queries where the best chunk isn't the closest by embedding or
    // BM25 alone. Falls back to plain retrieve on failure.
    const topK = parsed.data.topK ?? 5;
    let citations: CitationChunk[] = [];
    try {
      const raw = await retrieveWithRerank(
        req.params.id,
        parsed.data.message,
        topK,
        { provider: providerId, model },
      );
      citations = raw.map(mapChunk);
    } catch (err) {
      req.log.warn({ err }, 'retrieve+rerank failed; falling back to plain retrieve');
      try {
        const raw = await retrieve(req.params.id, parsed.data.message, topK);
        citations = raw.map(mapChunk);
      } catch (err2) {
        req.log.warn({ err: err2 }, 'retrieve failed; proceeding without context');
      }
    }

    // 2. SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (delta: unknown) => {
      const ok = ChatDeltaSchema.safeParse(delta);
      if (!ok.success) return;
      reply.raw.write(`data: ${JSON.stringify(ok.data)}\n\n`);
    };

    // 3. send citations first
    send({ type: 'citations', chunks: citations });

    // 4. build messages
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