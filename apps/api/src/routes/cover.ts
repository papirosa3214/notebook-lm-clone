import type { FastifyPluginAsync } from 'fastify';
import { eq, asc } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { ensureCoverSpec, readCoverSpec, renderCoverSvg } from '../lib/coverArt.js';

const PostBody = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
});

/**
 * The notebook's real picture: the first source that offered one, in the
 * order it was added. First-wins keeps the cover stable while the user
 * keeps adding material — a cover that changes every time a source lands
 * reads as a glitch, not as freshness.
 */
function pickSourcePicture(notebookId: string): string | null {
  const row = getDb()
    .select({ coverImage: sources.coverImage })
    .from(sources)
    .where(eq(sources.notebookId, notebookId))
    .orderBy(asc(sources.createdAt))
    .all()
    .find((r) => Boolean(r.coverImage));
  return row?.coverImage ?? null;
}

/**
 * Cover art endpoints.
 *
 * GET /api/notebooks/:id/cover
 *   Redirects to a real picture taken from the notebook's own sources —
 *   the og:image of a page, the poster frame of a video. That's what the
 *   user actually recognises the notebook by, so we never draw a
 *   competing abstraction over it.
 *
 *   When no source offered a picture (PDFs, plain pages), we fall back
 *   to the generated recipe rather than an empty card. The answer is
 *   always an image for an existing notebook, and it never blocks on
 *   the LLM, so the home grid can render it as a plain <img>.
 *
 * POST /api/notebooks/:id/cover
 *   Re-rolls the fallback recipe ("перерисовать обложку"). It never
 *   overrides a real source picture — there is nothing to regenerate
 *   there, the picture is whatever the source serves.
 */
export const coverRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/api/notebooks/:id/cover', async (req, reply) => {
    const db = getDb();
    const nb = db
      .select({ id: notebooks.id, title: notebooks.title })
      .from(notebooks)
      .where(eq(notebooks.id, req.params.id))
      .get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });

    const picture = pickSourcePicture(req.params.id);
    if (picture) {
      return reply
        .code(302)
        .header('Location', picture)
        .header('Cache-Control', 'public, max-age=600')
        .send();
    }

    const spec = readCoverSpec(req.params.id);
    const svg = renderCoverSvg(spec);
    return reply
      .code(200)
      .header('Content-Type', 'image/svg+xml; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .send(svg);
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/notebooks/:id/cover',
    async (req, reply) => {
      const db = getDb();
      const nb = db
        .select({ id: notebooks.id })
        .from(notebooks)
        .where(eq(notebooks.id, req.params.id))
        .get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const body = PostBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.format() });

      try {
        const { spec } = await ensureCoverSpec(req.params.id, {
          provider: body.data.provider,
          model: body.data.model,
          force: true,
        });
        return { spec, svg: renderCoverSvg(spec) };
      } catch (err) {
        app.log.warn({ err, notebookId: req.params.id }, 'cover regeneration failed');
        return reply.code(502).send({
          error: 'cover-generation-failed',
          detail: 'Не удалось перегенерировать обложку — провайдер недоступен.',
        });
      }
    },
  );
};