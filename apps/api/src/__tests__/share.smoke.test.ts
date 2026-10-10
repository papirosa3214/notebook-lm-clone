/**
 * End-to-end smoke for the Sharing routes.
 *
 * Covers the owner-side endpoints (POST/GET/DELETE /share) plus the
 * public /api/shared/:token route. We also assert the 404 contract
 * for unknown / revoked / malformed tokens — the public endpoint
 * must not leak which tokens ever existed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { withApiTestEnv } from './helpers.js';
import { artifacts, notebooks, sources } from '../db/schema.js';

const env = withApiTestEnv();
const NB_ID = `nb_share_${nanoid(6)}`;
const SRC_ID = `src_share_${nanoid(6)}`;

beforeAll(async () => {
  await env.install();
  const db = await env.getDb();
  db.insert(notebooks)
    .values({
      id: NB_ID,
      title: 'share smoke',
      defaultProvider: 'ollama',
      defaultModel: 'qwen-test',
    })
    .run();
  db.insert(sources)
    .values({
      id: SRC_ID,
      notebookId: NB_ID,
      kind: 'url',
      title: 'Example source',
      url: 'https://example.com/article',
      status: 'ready',
      summary: 'Краткий обзор источника для теста.',
    })
    .run();
  db.insert(artifacts)
    .values({
      id: `art_share_${nanoid(6)}`,
      notebookId: NB_ID,
      title: 'Заметка',
      contentMd: '## Содержимое\n\nЭто тестовая заметка для проверки share-снапшота.',
      kind: 'note',
    })
    .run();
});

afterAll(async () => {
  await env.restore();
});

describe('Sharing — owner endpoints', () => {
  it('POST issues a shareToken + shareUrl', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/share`,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      enabled: boolean;
      shareToken: string;
      shareUrl: string;
      shareEnabledAt: string;
    };
    expect(body.enabled).toBe(true);
    expect(body.shareToken).toMatch(/^[A-Za-z0-9_-]{12,40}$/);
    expect(body.shareUrl).toContain(body.shareToken);
    expect(body.shareEnabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('GET returns the current share state', async () => {
    const app = await env.getApp();
    const post = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/share`,
    });
    const created = post.json() as { shareToken: string };
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${NB_ID}/share`,
    });
    const body = res.json() as { enabled: boolean; shareToken: string | null; shareUrl: string | null };
    expect(res.statusCode).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.shareToken).toBe(created.shareToken);
    expect(body.shareUrl).toContain(created.shareToken);
  });

  it('DELETE revokes the token; subsequent GET reports enabled=false', async () => {
    const app = await env.getApp();
    // Issue, then revoke.
    await app.inject({ method: 'POST', url: `/api/notebooks/${NB_ID}/share` });
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/notebooks/${NB_ID}/share`,
    });
    expect(del.statusCode).toBe(204);
    const get = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${NB_ID}/share`,
    });
    const body = get.json() as { enabled: boolean; shareToken: string | null; shareUrl: string | null };
    expect(body.enabled).toBe(false);
    expect(body.shareToken).toBeNull();
    expect(body.shareUrl).toBeNull();
  });

  it('POST on unknown notebook returns 404', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/nb_does_not_exist_${nanoid(6)}/share`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Sharing — public snapshot', () => {
  it('GET /api/shared/:token returns a stripped-down snapshot', async () => {
    const app = await env.getApp();
    const post = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/share`,
    });
    const { shareToken } = post.json() as { shareToken: string };

    const res = await app.inject({
      method: 'GET',
      url: `/api/shared/${shareToken}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      title: string;
      createdAt: string;
      sources: Array<{ id: string; title: string; status: string; summary: string | null; kind: string; url: string | null }>;
      artifacts: Array<{ id: string; title: string; kind: string; contentPreview: string; createdAt: string; updatedAt: string }>;
    };
    expect(body.title).toBe('share smoke');
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]!.id).toBe(SRC_ID);
    expect(body.sources[0]!.summary).toBe('Краткий обзор источника для теста.');
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]!.kind).toBe('note');
    expect(body.artifacts[0]!.contentPreview).toContain('тестовая заметка');
  });

  it('truncates long artifact content to ~300 chars in the preview', async () => {
    const app = await env.getApp();
    // Insert a long-content artifact.
    const longId = `art_long_${nanoid(6)}`;
    const db = await env.getDb();
    db.insert(artifacts)
      .values({
        id: longId,
        notebookId: NB_ID,
        title: 'Long',
        contentMd: 'x'.repeat(2000),
        kind: 'note',
      })
      .run();
    // Re-issue share so the snapshot includes the new artifact.
    const post = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/share`,
    });
    const { shareToken } = post.json() as { shareToken: string };
    const res = await app.inject({
      method: 'GET',
      url: `/api/shared/${shareToken}`,
    });
    const body = res.json() as { artifacts: Array<{ id: string; contentPreview: string }> };
    const long = body.artifacts.find((a) => a.id === longId)!;
    expect(long.contentPreview.length).toBeLessThanOrEqual(300);
    expect(long.contentPreview.endsWith('…')).toBe(true);
  });

  it('returns 404 for unknown token (never 401/403 — no probe leak)', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/shared/${nanoid(24)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for revoked token', async () => {
    const app = await env.getApp();
    const post = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/share`,
    });
    const { shareToken } = post.json() as { shareToken: string };
    await app.inject({
      method: 'DELETE',
      url: `/api/notebooks/${NB_ID}/share`,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/shared/${shareToken}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for malformed token (no probe via 400)', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/shared/../etc/passwd`,
    });
    expect(res.statusCode).toBe(404);
  });
});
