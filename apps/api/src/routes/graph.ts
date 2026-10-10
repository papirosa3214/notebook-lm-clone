import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { notebooks } from '../db/schema.js';
import { getRawSqlite } from '../db/index.js';

/**
 * Lightweight knowledge-graph endpoints.
 *
 * GET /graph          → all triples for a notebook (mind-map seed)
 * GET /graph/related  → triples connected to a query string (called by chat
 *                       to expand retrieval context)
 */
export const graphRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    '/api/notebooks/:id/graph',
    async (req, reply) => {
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });
      const sqlite = getRawSqlite();
      const rows = sqlite
        .prepare(
          `SELECT id, source_id AS sourceId, subject, predicate, object
           FROM graph_triples
           WHERE notebook_id = ?
           ORDER BY id DESC
           LIMIT 1000`,
        )
        .all(req.params.id);
      return { triples: rows };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { q?: string; limit?: string };
  }>('/api/notebooks/:id/graph/related', async (req, reply) => {
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });
    const q = req.query.q;
    if (!q) return reply.code(400).send({ error: 'q is required' });
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
    const { queryTriples } = await import('../vectordb/graph.js');
    return { triples: queryTriples(req.params.id, q, limit) };
  });
};
