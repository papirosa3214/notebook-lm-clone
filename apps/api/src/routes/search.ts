import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { fetchUrlToMarkdown, parseDocuments, uploadDocumentFile, type DocumentInfo } from '../ragflow/client.js';
import { searchWeb, type WebSearchResult } from '../extractors/websearch.js';

const Body = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(10).default(5),
});

function mapStatus(doc: DocumentInfo): 'pending' | 'parsing' | 'ready' | 'failed' {
  if (doc.run === 'FAIL') return 'failed';
  if (doc.run === 'DONE') return 'ready';
  return doc.chunk_count > 0 ? 'ready' : 'parsing';
}

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/search-and-add',
    async (req, reply) => {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });

      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      // 1. Search
      let results: WebSearchResult[];
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

      // 2. Insert pending sources up front so the UI sees them immediately
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

      // 3. Fetch + upload + kick for each, asynchronously-ish (in sequence to avoid hammering Ragflow)
      const added: Array<{ id: string; title: string; url: string; status: string; error?: string }> = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const localId = localIds[i]!;
        try {
          const { markdown, title: fetchedTitle } = await fetchUrlToMarkdown(r.url);
          const safeName = (r.title || fetchedTitle)
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .slice(0, 80) || `web-${Date.now()}`;
          const doc = await uploadDocumentFile(nb.ragflowDatasetId, {
            buffer: Buffer.from(markdown, 'utf-8'),
            filename: `${safeName}.md`,
          });
          try {
            await parseDocuments(nb.ragflowDatasetId, [doc.id]);
          } catch (kickErr) {
            req.log.warn({ err: kickErr, docId: doc.id }, 'parse kick failed; refresh will retry');
          }
          db.update(sources)
            .set({ ragflowDocId: doc.id, title: r.title || fetchedTitle, status: mapStatus(doc) })
            .where(eq(sources.id, localId))
            .run();
          added.push({ id: localId, title: r.title, url: r.url, status: mapStatus(doc) });
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
