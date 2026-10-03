import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import {
  type SharedNotebook,
  type NotebookShare,
} from '@notebook/shared';
import { getDb } from '../db/index.js';
import { artifacts, notebooks, sources } from '../db/schema.js';

const SHARE_TOKEN_LENGTH = 24;
const PREVIEW_CHARS = 300;

function publicBaseUrl(): string {
  // PUBLIC_BASE_URL is the URL the user pastes into chat/email.
  // Falls back to a relative path so dev still works without
  // configuring it.
  return config.PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? '';
}

function buildShareUrl(token: string): string {
  const base = publicBaseUrl();
  return base ? `${base}/shared/${token}` : `/shared/${token}`;
}

/**
 * Sharing routes.
 *
 *   POST   /api/notebooks/:id/share  — issue a fresh shareToken
 *   GET    /api/notebooks/:id/share  — current share state
 *   DELETE /api/notebooks/:id/share  — revoke
 *
 *   GET    /api/shared/:token        — public, no auth; returns a
 *                                       read-only snapshot
 *
 * Single-user assumption: any caller of the per-notebook endpoints
 * owns the notebook. The public endpoint takes only the token;
 * a revoked or unknown token returns 404 (never 401) so the URL
 * space can't be probed for valid ids.
 */
export const shareRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/share',
    async (req, reply) => {
      const db = getDb();
      const nb = db
        .select()
        .from(notebooks)
        .where(eq(notebooks.id, req.params.id))
        .get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const token = nanoid(SHARE_TOKEN_LENGTH);
      const enabledAt = new Date().toISOString();
      db.update(notebooks)
        .set({ shareToken: token, shareEnabledAt: enabledAt })
        .where(eq(notebooks.id, req.params.id))
        .run();
      const body: NotebookShare = {
        enabled: true,
        shareToken: token,
        shareUrl: buildShareUrl(token),
        shareEnabledAt: enabledAt,
      };
      return reply.code(201).send(body);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/notebooks/:id/share',
    async (req, reply) => {
      const db = getDb();
      const nb = db
        .select({
          shareToken: notebooks.shareToken,
          shareEnabledAt: notebooks.shareEnabledAt,
        })
        .from(notebooks)
        .where(eq(notebooks.id, req.params.id))
        .get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });
      const body: NotebookShare = {
        enabled: nb.shareToken !== null,
        shareToken: nb.shareToken,
        shareUrl: nb.shareToken ? buildShareUrl(nb.shareToken) : null,
        shareEnabledAt: nb.shareEnabledAt,
      };
      return reply.send(body);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/notebooks/:id/share',
    async (req, reply) => {
      const db = getDb();
      const nb = db
        .select({ id: notebooks.id })
        .from(notebooks)
        .where(eq(notebooks.id, req.params.id))
        .get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });
      db.update(notebooks)
        .set({ shareToken: null })
        .where(eq(notebooks.id, req.params.id))
        .run();
      return reply.code(204).send();
    },
  );

  // Public read-only view. No auth header expected; the token is the
  // only credential. Returns 404 for unknown or revoked tokens (never
  // 401/403, to avoid leaking which tokens ever existed).
  app.get<{ Params: { token: string } }>(
    '/api/shared/:token',
    async (req, reply) => {
      if (!/^[A-Za-z0-9_-]{12,40}$/.test(req.params.token)) {
        return reply.code(404).send({ error: 'not found' });
      }
      const db = getDb();
      const nb = db
        .select()
        .from(notebooks)
        .where(eq(notebooks.shareToken, req.params.token))
        .get();
      if (!nb) return reply.code(404).send({ error: 'not found' });

      // We deliberately project only the safe fields. No chat
      // history, no chunk text, no API config, no provider/model
      // (which is private infrastructure detail).
      const sourceRows = db
        .select({
          id: sources.id,
          kind: sources.kind,
          title: sources.title,
          url: sources.url,
          status: sources.status,
          summary: sources.summary,
        })
        .from(sources)
        .where(eq(sources.notebookId, nb.id))
        .all();

      const artifactRows = db
        .select({
          id: artifacts.id,
          title: artifacts.title,
          kind: artifacts.kind,
          contentMd: artifacts.contentMd,
          createdAt: artifacts.createdAt,
          updatedAt: artifacts.updatedAt,
        })
        .from(artifacts)
        .where(eq(artifacts.notebookId, nb.id))
        .all();

      const body: SharedNotebook = {
        title: nb.title,
        createdAt: nb.createdAt,
        sources: sourceRows.map((s) => ({
          id: s.id,
          kind: s.kind,
          title: s.title,
          url: s.url,
          status: s.status,
          summary: s.summary,
        })),
        artifacts: artifactRows
          .filter((a): a is typeof a & { kind: 'note' | 'audio_overview' | 'report' } =>
            a.kind === 'note' || a.kind === 'audio_overview' || a.kind === 'report',
          )
          .map((a) => {
            const preview =
              a.contentMd.length <= PREVIEW_CHARS
                ? a.contentMd
                : a.contentMd.slice(0, PREVIEW_CHARS - 1).trimEnd() + '…';
            return {
              id: a.id,
              title: a.title,
              kind: a.kind,
              contentPreview: preview,
              createdAt: a.createdAt,
              updatedAt: a.updatedAt,
            };
          }),
      };
      return reply.send(body);
    },
  );
};
