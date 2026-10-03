import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { ChatRequestSchema, ChatDeltaSchema, type CitationChunk } from '@notebook/shared';
import {
  CITATION_INSTRUCTIONS,
  formatContextForPrompt,
  isUnsupported,
  sanitizeCitations,
} from '@notebook/shared/providers';
import { getDb } from '../db/index.js';
import { notebooks, messages, sources } from '../db/schema.js';
import { retrieve, retrieveWithRerank, type RetrievalChunk } from '../vectordb/client.js';
import { getProvider } from '../providers/index.js';

/**
 * Validate the client-supplied source filter. Three outcomes:
 *  - empty input: return `ids: undefined` so the retrieval pipeline
 *    searches the whole notebook (preserves pre-sourceIds behaviour).
 *  - all ids resolve to sources in this notebook: return the deduped
 *    list so retrieval can use it as an IN (...) filter.
 *  - any id is missing or belongs to a different notebook: return
 *    a 400 error rather than silently dropping the bad id (which
 *    would let a stale id from a previous notebook change the
 *    behaviour of the request without the user noticing).
 */
async function resolveScopedSources(
  notebookId: string,
  requested: string[],
): Promise<{ ids?: string[] } | { error: string }> {
  if (requested.length === 0) return { ids: undefined };
  const dedup = Array.from(new Set(requested));
  const db = getDb();
  const found = db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.notebookId, notebookId), inArray(sources.id, dedup)))
    .all();
  if (found.length !== dedup.length) {
    const foundSet = new Set(found.map((r) => r.id));
    const missing = dedup.filter((id) => !foundSet.has(id));
    return { error: `unknown or cross-notebook sourceIds: ${missing.join(', ')}` };
  }
  return { ids: found.map((r) => r.id) };
}

export function mapChunk(c: RetrievalChunk): CitationChunk {
  return {
    id: c.id,
    sourceId: c.sourceId ?? c.doc_id,
    sourceTitle: c.docnm_kwd,
    // Use the kind we attached at retrieval time so file/YouTube sources
    // are no longer mislabelled as 'url'. Defensive fallback for old
    // cache rows that pre-date the field.
    sourceKind: c.sourceKind ?? 'url',
    text: c.content,
    score: c.similarity,
    location:
      typeof c.ordinal === 'number' ? `Фрагмент ${c.ordinal + 1}` : undefined,
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

  // dry-run retrieval. Accepts optional ?sourceIds=a,b,c so the
  // /retrieve endpoint can also be used to preview the effect of a
  // source scope without running a full /chat round-trip. The
  // SQL-side filter is the same one /chat applies via retrieveRaw.
  app.get<{
    Params: { id: string };
    Querystring: { q?: string; topK?: string; sourceIds?: string };
  }>('/api/notebooks/:id/retrieve', async (req, reply) => {
    const q = req.query.q;
    if (!q) return reply.code(400).send({ error: 'q is required' });
    const topK = Number(req.query.topK ?? '5');
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });
    const sourceIds = req.query.sourceIds
      ? req.query.sourceIds.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const chunks = await retrieve(req.params.id, q, topK, sourceIds);
    return { chunks, citations: chunks.map(mapChunk) };
  });

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
    //
    // sourceIds filter: when the client asks for a subset of sources,
    // we validate every id belongs to this notebook *before* calling
    // retrieval so a stale id from a previous notebook can't leak
    // across. Absent or empty = search all sources in the notebook.
    const topK = parsed.data.topK ?? 5;
    const requestedSources = parsed.data.sourceIds ?? [];
    const scopedSourceIds = await resolveScopedSources(req.params.id, requestedSources);
    if ('error' in scopedSourceIds) {
      return reply.code(400).send({ error: scopedSourceIds.error });
    }
    let citations: CitationChunk[] = [];
    try {
      const raw = await retrieveWithRerank(
        req.params.id,
        parsed.data.message,
        topK,
        { provider: providerId, model, sourceIds: scopedSourceIds.ids },
      );
      citations = raw.map(mapChunk);
    } catch (err) {
      req.log.warn({ err }, 'retrieve+rerank failed; falling back to plain retrieve');
      try {
        const raw = await retrieve(
          req.params.id,
          parsed.data.message,
          topK,
          scopedSourceIds.ids,
        );
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
      // Verified-answering post-processing: the model already saw a strict
      // CITATION_INSTRUCTIONS prompt that forbids invented [N] markers, but
      // we still defensively run `sanitizeCitations` on the final buffer
      // before persisting. Anything the model wrote that points at a chunk
      // it was never shown becomes `[?]` in the database — and therefore in
      // the next `GET /messages` reply — even if the user already saw the
      // un-sanitised version during streaming.
      //
      // We deliberately do NOT try to rewrite the user's screen mid-stream
      // (no DOM patches, no replacement tokens): the prompt is the
      // primary defence, this is a backstop.
      const sanitised = isUnsupported(textBuf)
        ? textBuf
        : sanitizeCitations(textBuf, citations.length);
      if (sanitised !== textBuf) {
        req.log.info(
          { before: textBuf.length, after: sanitised.length, citations: citations.length },
          'citation sanitiser rewrote streamed text before persisting',
        );
      }
      send({ type: 'done', messageId });
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      // Persist assistant turn (full text + citations) regardless of whether
      // streaming succeeded — errors are visible as completed rows with err
      // text rather than silently missing turns. Use the sanitised buffer
      // so DB reads (`GET /messages`) never expose a `[N]` outside the
      // supplied citation range.
      const persisted = isUnsupported(textBuf)
        ? textBuf
        : sanitizeCitations(textBuf, citations.length);
      try {
        db.insert(messages)
          .values({
            id: assistantTurnId,
            notebookId: req.params.id,
            role: 'assistant',
            content: persisted,
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