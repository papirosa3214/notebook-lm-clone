import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { notebooks } from '../db/schema.js';
import { ensureSourceGroups } from '../lib/sourceGroups.js';

const Query = z.object({
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  provider: z.string().optional(),
  model: z.string().optional(),
});

/**
 * GET /api/notebooks/:id/source-groups
 *
 * Returns the notebook's sources split into named thematic sections.
 * The grouping is cached by source-set signature, so mounting the left
 * panel is a cheap read; `?refresh=true` forces a rebuild (the "Перегруппировать"
 * button in the panel).
 *
 * `groups: []` is a normal answer, not an error — it means the notebook
 * has too few sources to split, or no clustering could be derived. The
 * panel then renders the flat list it always had.
 */
export const sourceGroupRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string }; Querystring: unknown }>(
    '/api/notebooks/:id/source-groups',
    async (req, reply) => {
      const nb = getDb()
        .select({ id: notebooks.id })
        .from(notebooks)
        .where(eq(notebooks.id, req.params.id))
        .get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const q = Query.safeParse(req.query ?? {});
      const refresh = q.success ? (q.data.refresh ?? false) : false;
      const provider = q.success ? q.data.provider : undefined;
      const model = q.success ? q.data.model : undefined;

      try {
        const result = await ensureSourceGroups(req.params.id, {
          provider,
          model,
          force: refresh,
        });
        return {
          groups: result.groups,
          signature: result.signature,
          strategy: result.strategy,
          cached: result.cached,
        };
      } catch (err) {
        // Grouping is a convenience layer — a failure here must not
        // take down the sources list it decorates.
        app.log.warn({ err, notebookId: req.params.id }, 'source grouping failed');
        return reply.code(502).send({
          error: 'source-groups-failed',
          detail: 'Не удалось сгруппировать источники — показываю плоский список.',
        });
      }
    },
  );
};