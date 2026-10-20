/**
 * Integration smoke for the two new endpoints.
 *
 * The point isn't the model's taste in colours — it's the contracts
 * around it: /cover must always answer with an image for an existing
 * notebook, and /source-groups must pay for the LLM exactly once per
 * source set no matter how many times the panel refetches.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { withApiTestEnv } from './helpers.js';
import { notebooks, sources } from '../db/schema.js';

const env = withApiTestEnv();

const COVER_REPLY = JSON.stringify({
  palette: ['#102040', '#3060a0', '#90c0ff'],
  motif: 'waves',
  symbol: 'brain',
  tagline: 'кванты и ключи',
});

const TITLES = ['Шифр', 'Ключи', 'Кубиты', 'Алгоритм'];

/** Ids are unique per notebook — sources.id is a global primary key, and
 *  several notebooks get seeded inside one test file. */
function groupsReplyFor(ids: string[]): string {
  return JSON.stringify([
    { title: 'Шифрование', sourceIds: [ids[0], ids[1]] },
    { title: 'Кванты', sourceIds: [ids[2], ids[3]] },
  ]);
}

beforeAll(async () => {
  await env.install();
});

afterEach(() => {
  env.unmockOllama();
});

afterAll(async () => {
  env.unmockOllama();
  await env.restore();
});

async function seedNotebook(opts: { withSources?: boolean } = {}): Promise<string> {
  const db = await env.getDb();
  const id = `nb_${nanoid(8)}`;
  db.insert(notebooks)
    .values({
      id,
      title: 'Квантовые вычисления',
      defaultProvider: 'ollama',
      defaultModel: 'test-model',
    })
    .run();

  if (opts.withSources) {
    const rows = TITLES.map((title, i) => ({
      id: `s_${id}_${i}`,
      notebookId: id,
      kind: 'url' as const,
      title,
      url: `https://example.com/${i + 1}`,
      status: 'ready' as const,
      summary: `Суть источника ${i + 1}.`,
      summaryTopics: JSON.stringify(i < 2 ? ['шифрование'] : ['кванты']),
      summarizedAt: '2026-10-13T00:00:00.000Z',
    }));
    db.insert(sources).values(rows).run();
  }
  return id;
}

/** Source ids of a notebook seeded with `withSources`. */
function idsOf(notebookId: string): string[] {
  return TITLES.map((_, i) => `s_${notebookId}_${i}`);
}

describe('GET /api/notebooks/:id/cover', () => {
  it('falls back to an SVG when no source brought a picture', async () => {
    const id = await seedNotebook();
    const app = await env.getApp();
    const res = await app.inject({ method: 'GET', url: `/api/notebooks/${id}/cover` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.body).toContain('<svg');
    expect(res.body).toContain('</svg>');
  });

  it('redirects to the picture of the first source that has one', async () => {
    const id = await seedNotebook();
    const db = await env.getDb();
    // Inserted out of creation order on purpose: the endpoint picks the
    // oldest source with a picture, not the newest row.
    db.insert(sources)
      .values({
        id: `pic_late_${id}`,
        notebookId: id,
        kind: 'url',
        title: 'Поздний источник',
        url: 'https://example.com/late',
        status: 'ready',
        coverImage: 'https://example.com/late.png',
        createdAt: '2026-10-20T00:00:00.000Z',
      })
      .run();
    db.insert(sources)
      .values({
        id: `pic_early_${id}`,
        notebookId: id,
        kind: 'youtube',
        title: 'Ранний источник',
        url: 'https://youtu.be/x',
        status: 'ready',
        coverImage: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
        createdAt: '2026-10-10T00:00:00.000Z',
      })
      .run();

    const app = await env.getApp();
    const res = await app.inject({ method: 'GET', url: `/api/notebooks/${id}/cover` });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('https://i.ytimg.com/vi/x/hqdefault.jpg');
  });

  it('skips sources without a picture', async () => {
    const id = await seedNotebook();
    const db = await env.getDb();
    db.insert(sources)
      .values({
        id: `nopic_old_${id}`,
        notebookId: id,
        kind: 'file',
        title: 'PDF без картинки',
        status: 'ready',
        createdAt: '2026-10-01T00:00:00.000Z',
      })
      .run();
    db.insert(sources)
      .values({
        id: `pic_new_${id}`,
        notebookId: id,
        kind: 'url',
        title: 'Статья',
        status: 'ready',
        coverImage: 'https://example.com/og.png',
        createdAt: '2026-10-15T00:00:00.000Z',
      })
      .run();

    const app = await env.getApp();
    const res = await app.inject({ method: 'GET', url: `/api/notebooks/${id}/cover` });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('https://example.com/og.png');
  });

  it('404s for a notebook that does not exist', async () => {
    const app = await env.getApp();
    const res = await app.inject({ method: 'GET', url: '/api/notebooks/nope/cover' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/notebooks/:id/cover', () => {
  it('stores the model recipe and reflects it in the SVG', async () => {
    const id = await seedNotebook();
    const app = await env.getApp();
    env.mockOllama({ chatText: COVER_REPLY });

    const res = await app.inject({ method: 'POST', url: `/api/notebooks/${id}/cover` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { spec: { motif: string; symbol: string } };
    expect(body.spec.motif).toBe('waves');
    expect(body.spec.symbol).toBe('brain');

    // A notebook without source pictures keeps serving the recipe.
    const svg = await app.inject({ method: 'GET', url: `/api/notebooks/${id}/cover` });
    expect(svg.statusCode).toBe(200);
    expect(svg.body).toContain('#102040');
    expect(svg.body).toContain('кванты и ключи');
  });

  it('falls back to a title-derived cover when the model returns prose', async () => {
    const id = await seedNotebook();
    const app = await env.getApp();
    env.mockOllama({ chatText: 'К сожалению, я не могу подобрать обложку.' });

    const res = await app.inject({ method: 'POST', url: `/api/notebooks/${id}/cover` });
    expect(res.statusCode).toBe(200);
    const svg = await app.inject({ method: 'GET', url: `/api/notebooks/${id}/cover` });
    expect(svg.statusCode).toBe(200);
    expect(svg.body).toContain('<svg');
  });
});

describe('GET /api/notebooks/:id/source-groups', () => {
  it('returns no groups for a notebook with too few sources', async () => {
    const id = await seedNotebook();
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${id}/source-groups`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ groups: [], strategy: 'none' });
  });

  it('clusters sources and serves the split from cache on the second call', async () => {
    const id = await seedNotebook({ withSources: true });
    const app = await env.getApp();
    const mock = env.mockOllama({ chatText: groupsReplyFor(idsOf(id)) });

    const first = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${id}/source-groups`,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      groups: Array<{ title: string; sourceIds: string[] }>;
      cached: boolean;
    };
    expect(firstBody.cached).toBe(false);
    expect(firstBody.groups.map((g) => g.title)).toEqual(['Шифрование', 'Кванты']);
    const callsAfterFirst = mock.callCount();

    const second = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${id}/source-groups`,
    });
    const secondBody = second.json() as { cached: boolean };
    expect(secondBody.cached).toBe(true);
    expect(mock.callCount()).toBe(callsAfterFirst);
  });

  it('rebuilds on ?refresh=true', async () => {
    const id = await seedNotebook({ withSources: true });
    const app = await env.getApp();
    env.mockOllama({ chatText: groupsReplyFor(idsOf(id)) });

    await app.inject({ method: 'GET', url: `/api/notebooks/${id}/source-groups` });
    // Fresh mock so the counter below measures the refresh call alone.
    env.unmockOllama();
    const mock = env.mockOllama({ chatText: groupsReplyFor(idsOf(id)) });
    const before = mock.callCount();

    const refreshed = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${id}/source-groups?refresh=true`,
    });
    expect(refreshed.json()).toMatchObject({ cached: false });
    expect(mock.callCount()).toBeGreaterThan(before);
  });

  it('degrades to topic-based groups when the model returns junk', async () => {
    const id = await seedNotebook({ withSources: true });
    const app = await env.getApp();
    env.mockOllama({ chatText: 'не знаю' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${id}/source-groups`,
    });
    const body = res.json() as {
      groups: Array<{ title: string; sourceIds: string[] }>;
      strategy: string;
    };
    expect(body.strategy).toBe('fallback');
    const flat = body.groups.flatMap((g) => g.sourceIds).sort();
    expect(flat).toEqual(idsOf(id).slice().sort());
  });

  it('404s for a notebook that does not exist', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notebooks/nope/source-groups',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/notebooks list', () => {
  it('counts a notebook’s own sources instead of correlating against itself', async () => {
    const id = await seedNotebook({ withSources: true });
    const app = await env.getApp();

    const res = await app.inject({ method: 'GET', url: '/api/notebooks' });
    const body = res.json() as {
      notebooks: Array<{
        id: string;
        sourceCount: number;
        readySourceCount: number;
        coverSignature: string | null;
        coverSpec?: unknown;
      }>;
    };
    const row = body.notebooks.find((n) => n.id === id);
    // A correlated subquery written without table qualifiers compares
    // sources.notebook_id to sources.id and reports 0 for every notebook.
    expect(row?.sourceCount).toBe(4);
    expect(row?.readySourceCount).toBe(4);
    expect(row?.coverSpec).toBeUndefined();
  });

  it('exposes a cover signature instead of the raw recipe', async () => {
    const id = await seedNotebook();
    const app = await env.getApp();
    env.mockOllama({ chatText: COVER_REPLY });
    await app.inject({ method: 'POST', url: `/api/notebooks/${id}/cover` });

    const res = await app.inject({ method: 'GET', url: '/api/notebooks' });
    const body = res.json() as { notebooks: Array<{ id: string; coverSignature: string | null; coverSpec?: unknown }> };
    const row = body.notebooks.find((n) => n.id === id);
    expect(row?.coverSignature).toBeTruthy();
    expect(row?.coverSpec).toBeUndefined();
  });
});