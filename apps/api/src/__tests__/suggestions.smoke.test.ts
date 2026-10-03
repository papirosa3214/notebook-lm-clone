/**
 * End-to-end smoke for the suggested follow-up questions route.
 *
 * The route streams an SSE; we read it raw and split on `\n\n`
 * (the SSE separator) the same way the web client does. Then we
 * assert the contract: at least one `token` event while the LLM
 * is producing, a final `suggestions` event with the parsed
 * JSON array, and a `done` to close the stream.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { withApiTestEnv } from './helpers.js';
import { notebooks } from '../db/schema.js';

const env = withApiTestEnv();
const NB_ID = `nb_sugg_${nanoid(6)}`;

beforeAll(async () => {
  await env.install();
  const db = await env.getDb();
  db.insert(notebooks)
    .values({
      id: NB_ID,
      title: 'suggestions smoke',
      defaultProvider: 'ollama',
      defaultModel: 'qwen-test',
    })
    .run();
});

afterEach(() => {
  env.unmockOllama();
});

afterAll(async () => {
  env.unmockOllama();
  await env.restore();
});

/** Parse the raw SSE stream (a string of `data: {...}\n\n` blocks)
 *  into a list of parsed JSON events. Tolerates `\n` line endings
 *  and the test runner's possible buffered state. */
function parseSse(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const json = line.slice(5).trim();
    if (!json) continue;
    try {
      events.push(JSON.parse(json));
    } catch {
      // ignore malformed
    }
  }
  return events;
}

describe('POST /api/notebooks/:id/suggestions', () => {
  it('streams token + suggestions + done for a clean JSON-array reply', async () => {
    env.mockOllama({
      chatText: [
        '["А какие ещё источники упоминают A2A?",',
        ' "Чем MCP отличается на практике?",',
        ' "Что почитать дальше?"]',
      ].join('\n'),
    });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/suggestions`,
      payload: {
        question: 'Что такое A2A?',
        answer: 'A2A — протокол межагентного взаимодействия от Google.',
      },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body) as Array<{ type: string; suggestions?: string[]; text?: string }>;
    const tokens = events.filter((e) => e.type === 'token');
    const final = events.find((e) => e.type === 'suggestions');
    const done = events.find((e) => e.type === 'done');
    expect(tokens.length).toBeGreaterThan(0);
    expect(final).toBeDefined();
    expect(final!.suggestions).toEqual([
      'А какие ещё источники упоминают A2A?',
      'Чем MCP отличается на практике?',
      'Что почитать дальше?',
    ]);
    expect(done).toBeDefined();
  });

  it('tolerates ```json fences around the array', async () => {
    env.mockOllama({
      chatText: 'Вот:\n```json\n["q1","q2","q3"]\n```\nУдачи!',
    });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/suggestions`,
      payload: { question: 'q', answer: 'a' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body) as Array<{ type: string; suggestions?: string[] }>;
    const final = events.find((e) => e.type === 'suggestions');
    expect(final?.suggestions).toEqual(['q1', 'q2', 'q3']);
  });

  it('trims whitespace and caps each suggestion at the documented length', async () => {
    const long = 'x'.repeat(500);
    env.mockOllama({
      chatText: JSON.stringify([`  ${long}  `, '  short  ']),
    });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/suggestions`,
      payload: { question: 'q', answer: 'a', count: 5 },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body) as Array<{ type: string; suggestions?: string[] }>;
    const final = events.find((e) => e.type === 'suggestions');
    expect(final).toBeDefined();
    expect(final!.suggestions).toHaveLength(2);
    expect(final!.suggestions![0]!.length).toBe(200);
    expect(final!.suggestions![1]).toBe('short');
  });

  it('sends an error event when the LLM output is not parseable JSON', async () => {
    env.mockOllama({ chatText: 'Совсем не JSON, никаких массивов.' });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/suggestions`,
      payload: { question: 'q', answer: 'a' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body) as Array<{ type: string; message?: string }>;
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/parseable/i);
  });

  it('rejects unknown sourceIds with 400', async () => {
    env.mockOllama({ chatText: '["q"]' });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/suggestions`,
      payload: { question: 'q', answer: 'a', sourceIds: [`unknown_${nanoid(6)}`] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown notebook', async () => {
    env.mockOllama({ chatText: '["q"]' });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/nb_does_not_exist_${nanoid(6)}/suggestions`,
      payload: { question: 'q', answer: 'a' },
    });
    expect(res.statusCode).toBe(404);
  });
});
