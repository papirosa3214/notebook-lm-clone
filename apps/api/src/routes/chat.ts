import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { ChatRequestSchema, ChatDeltaSchema, type CitationChunk } from '@notebook/shared';
import { CITATION_INSTRUCTIONS, formatContextForPrompt } from '@notebook/shared/providers';
import { getDb } from '../db/index.js';
import { notebooks, messages } from '../db/schema.js';
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

    // 4. Optional graph-enriched context. We query the knowledge-graph store
    //    for triples connected to the user's question — gives the LLM
    //    explicit subject-predicate-object relations that the retrieval
    //    embedding alone might have missed (GraphRAG-flavored, lightweight).
    let graphContext = '';
    try {
      const { queryTriples, formatTriplesForPrompt } = await import('../vectordb/graph.js');
      const triples = queryTriples(req.params.id, parsed.data.message, 10);
      graphContext = formatTriplesForPrompt(triples);
    } catch (err) {
      req.log.warn({ err }, 'graph query failed; continuing without graph context');
    }

    // 4. build messages
    const systemPrompt = `${CITATION_INSTRUCTIONS}\n\nSOURCES:\n${formatContextForPrompt(citations)}${graphContext ? `\n\n${graphContext}` : ''}`;
    const chatMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...(parsed.data.history ?? []),
      { role: 'user' as const, content: parsed.data.message },
    ];

    // 4. Persist the user's turn BEFORE streaming so a crashed provider
    //    still leaves a record of what was asked. We use a single nanoid that
    //    we later reuse as a sibling assistant row's id-prefix for traceability.
    const turnId = nanoid(12);
    try {
      db.insert(messages)
        .values({
          id: turnId,
          notebookId: req.params.id,
          role: 'user',
          content: parsed.data.message,
          citations: null,
          provider: providerId,
          model,
        })
        .run();
    } catch (err) {
      req.log.warn({ err }, 'failed to persist user turn — continuing');
    }

    // 5. stream from provider. We accumulate the assistant text in `textBuf`
    //    so we can persist it once the stream ends (success or error).
    const assistantTurnId = `${turnId}-a`;
    let textBuf = '';
    const messageId = assistantTurnId;
    try {
      for await (const ev of provider.chat({
        providerId,
        model,
        messages: chatMessages,
        context: citations,
        temperature: 0.2,
        maxTokens: 1024,
      })) {
        if (ev.text) {
          textBuf += ev.text;
          send({ type: 'token', text: ev.text });
        }
        if (ev.done) break;
      }
      send({ type: 'done', messageId });
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      // Persist assistant turn (full text + citations) regardless of whether
      // streaming succeeded — errors are visible as completed rows with err
      // text rather than silently missing turns.
      try {
        db.insert(messages)
          .values({
            id: assistantTurnId,
            notebookId: req.params.id,
            role: 'assistant',
            content: textBuf,
            citations: JSON.stringify(citations),
            provider: providerId,
            model,
            topK,
          })
          .run();
      } catch (err) {
        req.log.warn({ err }, 'failed to persist assistant turn');
      }
      reply.raw.end();
    }
  });

  // Chat history — newest first, paginated by `before` (created_at cursor) and `limit`.
  // Returns rows with citations already parsed back into Citation[] so the UI
  // doesn't need to JSON.parse() each row.
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; before?: string };
  }>('/api/notebooks/:id/messages', async (req, reply) => {
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });

    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const before = req.query.before;

    const rows = before
      ? db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.notebookId, req.params.id),
              lt(messages.createdAt, before),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(limit)
          .all()
      : db
          .select()
          .from(messages)
          .where(eq(messages.notebookId, req.params.id))
          .orderBy(desc(messages.createdAt))
          .limit(limit)
          .all();

    return {
      messages: rows.reverse().map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        citations: r.citations ? (JSON.parse(r.citations) as CitationChunk[]) : null,
        provider: r.provider,
        model: r.model,
        topK: r.topK,
        createdAt: r.createdAt,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]?.createdAt : null,
    };
  });
};