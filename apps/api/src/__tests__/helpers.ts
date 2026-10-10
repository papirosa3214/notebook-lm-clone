/**
 * Shared test helpers for the API suite.
 *
 * Two responsibilities:
 *
 *  1. withApiTestEnv — set up a fresh tmp SQLite via DB_PATH env override
 *     so the real apps/api/data/notebook.db is never touched. The
 *     tmpdir is removed in teardown.
 *
 *  2. mockOllamaFetch — replace globalThis.fetch with a function that
 *     handles requests to 127.0.0.1:11434 with canned responses:
 *       /api/embeddings → a deterministic 1024-dim vector
 *       /api/chat       → NDJSON stream of the configured reply
 *       /api/generate   → JSON { response: "..." } (used by graph extract)
 *       /api/tags       → empty list (so listModels() returns defaults)
 *     Calls to any other host pass through to the original fetch
 *     (most tests don't hit anthropic / openai / external sites).
 *
 * Why globalThis.fetch and not a module-level spy: most call sites use
 * the global fetch (OllamaProvider, embedding/client, graph.ts,
 * lifecycle.ts). Replacing the global is one source of truth and works
 * for every code path without per-module patches.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';

const EMBEDDING_DIM = 1024;

export interface OllamaHandlers {
  /** Body returned by /api/chat (a single text reply, NDJSON-wrapped). */
  chatText?: string;
  /** Body returned by /api/generate (used by graph extract). */
  generateText?: string;
  /** Optional override for /api/embeddings (defaults to a dummy vector). */
  embedding?: number[];
}

export interface ApiTestEnv {
  readonly tmpDir: string;
  readonly dbPath: string;
  /** Set DB_PATH / OLLAMA_BASE_URL env and pre-run migrate(). */
  install(): Promise<void>;
  /** Restore env, unmock fetch, close DB, rm tmpdir. */
  restore(): Promise<void>;
  /** Returns the Fastify app via buildApp(); call only after install(). */
  getApp(): Promise<import('fastify').FastifyInstance>;
  getRawSqlite(): Promise<import('better-sqlite3').Database>;
  getDb(): Promise<import('../db/index.js').DB>;
  /**
   * Replace globalThis.fetch for the duration of one test. Returns a
   * handle exposing .callCount() to verify how many times the mock was
   * hit. Calling again without an intermediate restore() throws.
   */
  mockOllama(handlers?: OllamaHandlers): { callCount(): number };
  /** Restore globalThis.fetch to whatever it was before mockOllama. */
  unmockOllama(): void;
}

/**
 * Build an env object. Call `beforeAll(env.install)` and
 * `afterAll(env.restore)` to scope the DB to a test file.
 */
export function withApiTestEnv(): ApiTestEnv {
  const tmpDir = mkdtempSync(join(tmpdir(), 'notebook-api-test-'));
  const dbPath = join(tmpDir, 'test.db');

  // Env vars must be set BEFORE config.ts is loaded. Importing the db
  // module happens inside install(), so by then these are in place.
  process.env.DB_PATH = dbPath;
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
  process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:11434';
  process.env.EMBEDDING_MODEL = 'bge-m3-embed';
  process.env.EMBEDDING_DIM = String(EMBEDDING_DIM);
  process.env.NODE_ENV = 'test';

  // The process.env writes above only take effect if config.ts has not
  // been parsed yet. A test file that does `import { config } from
  // '../config.js'` at the top level can be evaluated *before* this
  // function runs (ESM hoists imports), which would leave config
  // pointing at the real dev database. We mutate the already-parsed
  // config object synchronously so isolation never depends on import
  // order. `config` is imported statically at the top of this file for
  // exactly this reason — a dynamic import here would race the first
  // `getDb()` call.
  const mutableConfig = config as unknown as Record<string, unknown>;
  mutableConfig.DB_PATH = dbPath;
  mutableConfig.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
  mutableConfig.EMBEDDING_BASE_URL = 'http://127.0.0.1:11434';
  mutableConfig.EMBEDDING_MODEL = 'bge-m3-embed';
  mutableConfig.EMBEDDING_DIM = EMBEDDING_DIM;
  mutableConfig.NODE_ENV = 'test';

  const originalFetch = globalThis.fetch;
  let dbModule: typeof import('../db/index.js') | null = null;
  let appModule: typeof import('../app.js') | null = null;
  let mockActive = false;
  let mockState: { count: number } = { count: 0 };

  async function loadDb() {
    if (dbModule) return dbModule;
    dbModule = await import('../db/index.js');
    return dbModule;
  }
  async function loadApp() {
    if (appModule) return appModule;
    appModule = await import('../app.js');
    return appModule;
  }

  return {
    tmpDir,
    dbPath,
    async install() {
      const db = await loadDb();
      db.getDb();
    },
    async restore() {
      if (mockActive) {
        globalThis.fetch = originalFetch;
        mockActive = false;
      }
      const db = await loadDb();
      db.closeDb();
      rmSync(tmpDir, { recursive: true, force: true });
    },
    async getApp() {
      const { buildApp } = await loadApp();
      return buildApp();
    },
    async getRawSqlite() {
      const db = await loadDb();
      return db.getRawSqlite();
    },
    async getDb() {
      const db = await loadDb();
      return db.getDb();
    },
    mockOllama(handlers: OllamaHandlers = {}) {
      if (mockActive) throw new Error('mockOllama already active; call unmockOllama() first');
      const localOriginal = originalFetch;
      const embeddingVec = handlers.embedding ?? makeDummyEmbedding();
      const chatText = handlers.chatText ?? 'OK';
      const generateText =
        handlers.generateText ??
        '[{"subject":"a","predicate":"relates to","object":"b"}]';
      const state = { count: 0 };
      mockState = state;
      const FAKE_HOST = '127.0.0.1:11434';

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        state.count++;
        if (!url.includes(FAKE_HOST)) {
          return localOriginal(input as RequestInfo, init);
        }
        if (url.includes('/api/chat')) {
          const body = `${JSON.stringify({ message: { content: chatText } })}\n${JSON.stringify({ done: true })}\n`;
          return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/x-ndjson' },
          });
        }
        if (url.includes('/api/embeddings')) {
          return new Response(JSON.stringify({ embedding: embeddingVec }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/generate')) {
          return new Response(JSON.stringify({ response: generateText }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('not mocked', { status: 404 });
      }) as typeof fetch;

      mockActive = true;
      return { callCount: () => state.count };
    },
    unmockOllama() {
      if (!mockActive) return;
      globalThis.fetch = originalFetch;
      mockActive = false;
    },
  };
}

function makeDummyEmbedding(): number[] {
  const v = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = 0.01 + (i % 7) * 0.001;
  return v;
}
