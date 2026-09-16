import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { fetchUrlToMarkdown } from '../extractors/url.js';
import { searchWeb } from '../extractors/websearch.js';
import { addSourceText } from '../vectordb/client.js';

const Body = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(10).default(5),
});

/**
 * Legacy one-shot search-and-add: searches DDG and ingests every hit.
 * Kept for backward compatibility — UI uses /search-preview + /search-add-batch instead.
 */
export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/search-and-add',
    async (req, reply) => {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });

      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      let results: Array<{ title: string; url: string; snippet: string }>;
      try {
        results = await searchWeb(parsed.data.query, parsed.data.maxResults);
      } catch (err) {
        return reply.code(502).send({
          error: 'web search failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      if (results.length === 0) {
        return { query: parsed.data.query, searchResults: [], added: [] };
      }

      const localIds: string[] = [];
      for (const r of results) {
        const id = nanoid(12);
        localIds.push(id);
        db.insert(sources)
          .values({
            id,
            notebookId: req.params.id,
            kind: 'url',
            title: r.title,
            url: r.url,
            status: 'pending',
          })
          .run();
      }

      const added: Array<{ id: string; title: string; url: string; status: string; error?: string }> = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const localId = localIds[i]!;
        try {
          const { markdown, title: fetchedTitle } = await fetchUrlToMarkdown(r.url);
          await addSourceText({
            notebookId: req.params.id,
            sourceId: localId,
            kind: 'url',
            title: r.title || fetchedTitle,
            url: r.url,
            content: markdown,
          });
          db.update(sources)
            .set({ title: r.title || fetchedTitle, status: 'ready' })
            .where(eq(sources.id, localId))
            .run();
          added.push({ id: localId, title: r.title, url: r.url, status: 'ready' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          db.update(sources)
            .set({ status: 'failed', error: msg })
            .where(eq(sources.id, localId))
            .run();
          added.push({ id: localId, title: r.title, url: r.url, status: 'failed', error: msg });
        }
      }

      return { query: parsed.data.query, searchResults: results, added };
    },
  );
};