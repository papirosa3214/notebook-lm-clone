import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb, getRawSqlite } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { extractDocx, extractPdf, extractPlainText } from '../extractors/index.js';
import { fetchUrlToMarkdown } from '../extractors/url.js';
import { fetchYouTubeTranscript } from '../extractors/youtube.js';
import { addSourceText, removeSource } from '../vectordb/client.js';
import { buildTriplesForSourceId, removeTriplesForSource } from '../vectordb/graph.js';
import { runIngest } from '../lib/ingestRun.js';
import { summarizeSource } from '../lib/summarizeSource.js';
import { autoPrepareEmbedding, autoReleaseEmbedding } from '../embedding/lifecycle.js';

const AddUrlBody = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});

const STAGES_PROGRESS_UPDATES = true;

function wantsStream(req: FastifyRequest): boolean {
  return (req.query as { stream?: string } | undefined)?.stream === '1';
}

export const sourceRoutes: FastifyPluginAsync = async (app) => {
  // List sources for a notebook.
  app.get<{ Params: { id: string } }>('/api/notebooks/:id/sources', async (req, reply) => {
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });
    const list = db
      .select()
      .from(sources)
      .where(eq(sources.notebookId, req.params.id))
      .all();
    return { sources: list };
  });

  // Get one source (SSE-fallback recovery). When the ingest stream dies
  // before `done` fires, the client polls this to recover the row by
  // sourceId. We verify the source belongs to :id so a stale id from
  // a previous notebook can't leak cross-notebook state.
  //
  // Optional `?include=chunks&limit=N` (default 50, max 200) returns
  // the source's chunk bodies in ordinal order so the source reader
  // can render them without a second roundtrip. We cap the limit so
  // a notebook with thousands of chunks can't be slurped in one call.
  app.get<{
    Params: { id: string; sourceId: string };
    Querystring: { include?: string; limit?: string };
  }>(
    '/api/notebooks/:id/sources/:sourceId',
    async (req, reply) => {
      const db = getDb();
      const src = db
        .select()
        .from(sources)
        .where(and(eq(sources.id, req.params.sourceId), eq(sources.notebookId, req.params.id)))
        .get();
      if (!src) return reply.code(404).send({ error: 'source not found' });
      if (req.query.include !== 'chunks') return src;

      const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10) || 50, 1), 200);
      const raw = getRawSqlite();
      const rows = raw
        .prepare(
          `SELECT id, ordinal, content, length(content) AS content_len
           FROM chunks
           WHERE source_id = ?
           ORDER BY ordinal ASC
           LIMIT ?`,
        )
        .all(src.id, limit) as Array<{
        id: number;
        ordinal: number;
        content: string;
        content_len: number;
      }>;
      return {
        ...src,
        chunks: rows.map((r) => ({
          id: r.id,
          ordinal: r.ordinal,
          content: r.content,
          contentLen: r.content_len,
        })),
        chunksReturned: rows.length,
      };
    },
  );

  // Add a URL — fetch → markdown → chunk → embed → store. With ?stream=1,
  // emits SSE progress events; otherwise returns the source as JSON.
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/sources/url',
    async (req, reply) => {
      const parsed = AddUrlBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.format() });
      }
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const { url, title } = parsed.data;
      const localId = nanoid(12);
      const titleFallback =
        title ?? new URL(url).hostname + ' — ' + new Date().toISOString().slice(0, 10);

      db.insert(sources)
        .values({
          id: localId,
          notebookId: req.params.id,
          kind: 'url',
          title: titleFallback,
          url,
          status: 'pending',
        })
        .run();

      const result = await runIngest({
        reply,
        wantsStream: wantsStream(req),
        ingest: async (emit) => {
          await autoPrepareEmbedding();
          try {
            emit.progress('fetching', 0.1, `Загружаю ${new URL(url).hostname}…`, localId);
            const { markdown, title: fetchedTitle } = await fetchUrlToMarkdown(url);

            const finalTitle = title ?? fetchedTitle;
            db.update(sources)
              .set({ title: finalTitle })
              .where(eq(sources.id, localId))
              .run();

            emit.progress('embedding', 0.5, 'Создаю embeddings…', localId);
            await addSourceText(
              {
                notebookId: req.params.id,
                sourceId: localId,
                kind: 'url',
                title: finalTitle,
                url,
                content: markdown,
              },
              (done, total) => {
                // Per-batch progress so the SSE stream stays alive during the
                // long embedding pass (otherwise idle timeout can drop it).
                emit.progress(
                  'embedding',
                  0.5 + (done / total) * 0.4,
                  `Эмбеддинг: ${done}/${total} чанков`,
                  localId,
                );
              },
            );

            emit.progress('storing', 0.95, 'Сохраняю…', localId);
            db.update(sources)
              .set({ status: 'ready' })
              .where(eq(sources.id, localId))
              .run();

            // Fire-and-forget per-source summary — we don't want ingest
            // latency to depend on a second LLM call. summarizeSource() is
            // idempotent (DB guard short-circuits if already filled).
            void summarizeSource(localId, {
              provider: nb.defaultProvider,
              model: nb.defaultModel,
            }).catch((err) => {
              app.log.warn({ err, sourceId: localId }, 'post-ingest summarize failed');
            });

            // Fire-and-forget knowledge-graph extraction. Same reasoning as
            // summarize: a few seconds of LLM work, but the source is already
            // usable without it. /graph-related will pick the triples up
            // on the next chat.
            void buildTriplesForSourceId({
              notebookId: req.params.id,
              sourceId: localId,
              providerId: nb.defaultProvider,
              model: nb.defaultModel,
            }).catch((err) => {
              app.log.warn({ err, sourceId: localId }, 'post-ingest graph triples failed');
            });

            const stored = db.select().from(sources).where(eq(sources.id, localId)).get();
            if (!stored) throw new Error('source disappeared after insert');
            return stored;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            db.update(sources)
              .set({ status: 'failed', error: msg })
              .where(eq(sources.id, localId))
              .run();
            throw err;
          } finally {
            await autoReleaseEmbedding();
          }
        },
      });

      if (result) return reply.code(201).send(result);
    },
  );

  // Per-source refresh — kept as a no-op for UI compatibility.
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/refresh',
    async (req, reply) => {
      const db = getDb();
      const src = db.select().from(sources).where(eq(sources.id, req.params.id)).get();
      if (!src) return reply.code(404).send({ error: 'source not found' });
      return src;
    },
  );

  // Bulk refresh — same no-op contract.
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/sources/refresh',
    async (req, reply) => {
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });
      const list = db
        .select()
        .from(sources)
        .where(eq(sources.notebookId, req.params.id))
        .all();
      return { sources: list, changed: 0 };
    },
  );

  // Delete a source (metadata + chunks via FK cascade).
  app.delete<{ Params: { id: string } }>('/api/sources/:id', async (req, reply) => {
    const db = getDb();
    const src = db.select().from(sources).where(eq(sources.id, req.params.id)).get();
    if (!src) return reply.code(404).send({ error: 'source not found' });
    removeSource(req.params.id);
    // Knowledge-graph triples live in a separate table (no FK) — clean them
    // up explicitly so we don't accumulate orphans across notebook churn.
    removeTriplesForSource(req.params.id);
    db.delete(sources).where(eq(sources.id, req.params.id)).run();
    return reply.code(204).send();
  });

  // File upload (PDF/DOCX/TXT/MD). Multipart can't stream-progress safely
  // (the request body has already been consumed), so we just block until done.
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/sources/upload',
    async (req, reply) => {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'multipart "file" field required' });
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const buffer = await file.toBuffer();
      if (buffer.length > 50 * 1024 * 1024) {
        return reply.code(413).send({ error: 'file exceeds 50MB limit' });
      }

      const filename = sanitizeFilename(file.filename);
      const lower = filename.toLowerCase();
      const localId = nanoid(12);
      db.insert(sources)
        .values({
          id: localId,
          notebookId: req.params.id,
          kind: 'file',
          title: filename,
          url: null,
          status: 'pending',
        })
        .run();

      try {
        let text: string;
        if (lower.endsWith('.pdf')) text = await extractPdf(buffer);
        else if (lower.endsWith('.docx')) text = await extractDocx(buffer);
        else if (lower.endsWith('.md') || lower.endsWith('.markdown')) text = buffer.toString('utf-8');
        else if (lower.endsWith('.txt') || lower.endsWith('.text')) text = await extractPlainText(buffer);
        else return reply.code(415).send({ error: `unsupported file type: ${filename}` });

        await addSourceText({
          notebookId: req.params.id,
          sourceId: localId,
          kind: 'file',
          title: filename,
          url: null,
          content: text,
        });
        db.update(sources)
          .set({ status: 'ready' })
          .where(eq(sources.id, localId))
          .run();
        // Fire-and-forget per-source summary — same rationale as URL/YouTube
        // paths above. The notebook's default provider/model is used.
        void summarizeSource(localId, {
          provider: nb.defaultProvider,
          model: nb.defaultModel,
        }).catch((err) => {
          app.log.warn({ err, sourceId: localId }, 'post-ingest summarize failed');
        });

        // Fire-and-forget knowledge-graph extraction. see URL handler.
        void buildTriplesForSourceId({
          notebookId: req.params.id,
          sourceId: localId,
          providerId: nb.defaultProvider,
          model: nb.defaultModel,
        }).catch((err) => {
          app.log.warn({ err, sourceId: localId }, 'post-ingest graph triples failed');
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.update(sources)
          .set({ status: 'failed', error: msg })
          .where(eq(sources.id, localId))
          .run();
      }

      const stored = db.select().from(sources).where(eq(sources.id, localId)).get();
      return reply.code(201).send(stored);
    },
  );

  // YouTube transcript.
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/sources/youtube',
    async (req, reply) => {
      const parsed = z.object({ url: z.string().min(1), title: z.string().optional() }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const localId = nanoid(12);
      db.insert(sources)
        .values({
          id: localId,
          notebookId: req.params.id,
          kind: 'youtube',
          title: parsed.data.title ?? parsed.data.url,
          url: parsed.data.url,
          status: 'pending',
        })
        .run();

      const result = await runIngest({
        reply,
        wantsStream: wantsStream(req),
        ingest: async (emit) => {
          await autoPrepareEmbedding();
          try {
            emit.progress('fetching', 0.1, 'Загружаю субтитры…', localId);
            const { text, title: fetchedTitle } = await fetchYouTubeTranscript(parsed.data.url);
            emit.progress('embedding', 0.5, 'Создаю embeddings…', localId);
            await addSourceText(
              {
                notebookId: req.params.id,
                sourceId: localId,
                kind: 'youtube',
                title: parsed.data.title ?? fetchedTitle,
                url: parsed.data.url,
                content: text,
              },
              (done, total) => {
                emit.progress(
                  'embedding',
                  0.5 + (done / total) * 0.4,
                  `Эмбеддинг: ${done}/${total} чанков`,
                  localId,
                );
              },
            );
            emit.progress('storing', 0.95, 'Сохраняю…', localId);
            db.update(sources)
              .set({ title: parsed.data.title ?? fetchedTitle, status: 'ready' })
              .where(eq(sources.id, localId))
              .run();
            // Fire-and-forget per-source summary.
            void summarizeSource(localId, {
              provider: nb.defaultProvider,
              model: nb.defaultModel,
            }).catch((err) => {
              app.log.warn({ err, sourceId: localId }, 'post-ingest summarize failed');
            });

            // Fire-and-forget knowledge-graph extraction. see URL handler
            // for rationale; same defaults.
            void buildTriplesForSourceId({
              notebookId: req.params.id,
              sourceId: localId,
              providerId: nb.defaultProvider,
              model: nb.defaultModel,
            }).catch((err) => {
              app.log.warn({ err, sourceId: localId }, 'post-ingest graph triples failed');
            });
            const stored = db.select().from(sources).where(eq(sources.id, localId)).get();
            if (!stored) throw new Error('source disappeared after insert');
            return stored;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            db.update(sources)
              .set({ status: 'failed', error: msg })
              .where(eq(sources.id, localId))
              .run();
            throw err;
          } finally {
            await autoReleaseEmbedding();
          }
        },
      });

      if (result) return reply.code(201).send(result);
    },
  );

  // Per-source summary — read or generate on demand.
  // Returns `{ summary, topics, generatedAt }` or 425 if the source is
  // not yet ready (chunks not ingested).
  app.get<{ Params: { id: string } }>('/api/sources/:id/summary', async (req, reply) => {
    const db = getDb();
    const row = db.select().from(sources).where(eq(sources.id, req.params.id)).get();
    if (!row) return reply.code(404).send({ error: 'source not found' });
    if (row.status !== 'ready') {
      return reply.code(425).send({ error: `source status is '${row.status}', not ready` });
    }
    if (row.summary && row.summarizedAt) {
      return {
        summary: row.summary,
        topics: row.summaryTopics ? safeParseTopics(row.summaryTopics) : [],
        generatedAt: row.summarizedAt,
      };
    }
    // Cached empty → generate synchronously and persist.
    const result = await summarizeSource(req.params.id, { force: false });
    if (!result) return reply.code(500).send({ error: 'summarization failed' });
    return result;
  });

  // Force-regenerate per-source summary (e.g. user clicks "Перегенерировать"
  // in the source-detail sheet). Bypasses the DB short-circuit.
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/summary/refresh',
    async (req, reply) => {
      const db = getDb();
      const row = db.select().from(sources).where(eq(sources.id, req.params.id)).get();
      if (!row) return reply.code(404).send({ error: 'source not found' });
      if (row.status !== 'ready') {
        return reply.code(425).send({ error: `source status is '${row.status}', not ready` });
      }
      const result = await summarizeSource(req.params.id, { force: true });
      if (!result) return reply.code(500).send({ error: 'summarization failed' });
      return result;
    },
  );
};

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'upload';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'upload';
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

// Suppress noUnusedLocals warnings for the optional constant.
void STAGES_PROGRESS_UPDATES;