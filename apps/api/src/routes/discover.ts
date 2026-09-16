import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import {
  SearchAddBatchRequestSchema,
  SearchAddBatchResponseSchema,
  SearchPreviewRequestSchema,
  SearchPreviewResponseSchema,
} from '@notebook/shared';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { fetchUrlToMarkdown } from '../extractors/url.js';
import { searchWeb } from '../extractors/websearch.js';
import { addSourceText } from '../vectordb/client.js';

/**
 * Discover / search-and-add (NotebookLM-style):
 *   1. POST /search-preview     → just DuckDuckGo hits, no fetching/ingest
 *   2. POST /search-add-batch   → ingest the URLs the user actually picked
 */
export const discoverRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/search-preview',
    async (req, reply) => {
      const parsed = SearchPreviewRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });

      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      try {
        const results = await searchWeb(parsed.data.query, parsed.data.maxResults);
        return SearchPreviewResponseSchema.parse({ query: parsed.data.query, results });
      } catch (err) {
        return reply.code(502).send({
          error: 'web search failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/search-add-batch',
    async (req, reply) => {
      const parsed = SearchAddBatchRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });

      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      // Insert pending rows up front so the UI sees them appear immediately.
      const localIds = parsed.data.urls.map(() => nanoid(12));
      parsed.data.urls.forEach((url, i) => {
        const u = new URL(url);
        db.insert(sources)
          .values({
            id: localIds[i]!,
            notebookId: req.params.id,
            kind: 'url',
            title: u.hostname + ' — ' + new Date().toISOString().slice(0, 10),
            url,
            status: 'pending',
          })
          .run();
      });

      const added: Array<{ id: string; title: string; url: string; status: string; error?: string }> = [];
      for (let i = 0; i < parsed.data.urls.length; i++) {
        const url = parsed.data.urls[i]!;
        const localId = localIds[i]!;
        try {
          const { markdown, title: fetchedTitle } = await fetchUrlToMarkdown(url);
          await addSourceText({
            notebookId: req.params.id,
            sourceId: localId,
            kind: 'url',
            title: fetchedTitle,
            url,
            content: markdown,
          });
          db.update(sources)
            .set({ title: fetchedTitle, status: 'ready' })
            .where(eq(sources.id, localId))
            .run();
          added.push({ id: localId, title: fetchedTitle, url, status: 'ready' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          db.update(sources)
            .set({ status: 'failed', error: msg })
            .where(eq(sources.id, localId))
            .run();
          added.push({ id: localId, title: url, url, status: 'failed', error: msg });
        }
      }

      return SearchAddBatchResponseSchema.parse({ added });
    },
  );
};