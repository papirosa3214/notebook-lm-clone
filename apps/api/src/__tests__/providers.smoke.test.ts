/**
 * GET /api/providers is the catalogue the chat header renders its
 * provider/model pickers from. If it silently drops a backend, that
 * backend becomes unreachable from the UI (no picker entry, no model
 * list) — so this pins that every registered provider is present and
 * carries a non-empty default model plus a model list.
 *
 * Mocking Ollama is mandatory: OllamaProvider.listModels() calls
 * /api/tags and would otherwise reach the real inference box.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withApiTestEnv } from './helpers.js';

const env = withApiTestEnv();

beforeAll(async () => {
  await env.install();
});
afterAll(async () => {
  await env.restore();
});

describe('GET /api/providers', () => {
  test('lists every registered backend with its default model and models', async () => {
    env.mockOllama();
    try {
      const app = await env.getApp();
      const res = await app.inject({ method: 'GET', url: '/api/providers' });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        providers: Array<{ id: string; defaultModel: string; models: string[] }>;
      };

      // Registering a provider in providers/index.ts must show up here —
      // this is the list the UI renders, not a second hardcoded one.
      expect(body.providers.map((p) => p.id).sort()).toEqual([
        'anthropic',
        'minimax',
        'ollama',
        'openai',
      ]);

      for (const p of body.providers) {
        expect(p.defaultModel.length).toBeGreaterThan(0);
        expect(Array.isArray(p.models)).toBe(true);
      }

      // MiniMax is the backend whose key lives in .env; its default has to
      // match what the provider class advertises.
      expect(body.providers.find((p) => p.id === 'minimax')?.defaultModel).toBe('MiniMax-M3');
    } finally {
      env.unmockOllama();
    }
  });
});
