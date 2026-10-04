import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  // LLM providers (all optional; UI lets user pick)
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://192.168.1.110:11434'),

  // Embeddings (Ollama, same host as chat LLM)
  EMBEDDING_BASE_URL: z.string().url().default('http://192.168.1.110:11434'),
  EMBEDDING_MODEL: z.string().default('bge-m3-embed'),
  EMBEDDING_DIM: z.coerce.number().int().min(64).max(4096).default(1024),

  // Storage
  DB_PATH: z.string().default('./data/notebook.db'),

  // ASR (local Whisper). Used by the "YouTube → распознать" flow.
  // Default points at a locally-running whisper-server on the same host.
  WHISPER_BASE_URL: z.string().url().default('http://127.0.0.1:8000'),
  WHISPER_LANGUAGE: z.string().default('ru'),

  // Path to a Netscape-format cookies.txt for yt-dlp (optional). Required
  // for YouTube downloads without bot walls; empty disables cookies.
  YT_COOKIES_PATH: z.string().optional(),

  // Rerank provider. Pluggable so we can swap the slow LLM-rerank for a
  // TEI-hosted cross-encoder (bge-reranker-v2-m3) without touching the
  // retrieval pipeline. `llm` is the default and works without extra
  // infrastructure; `http` requires a TEI / FlagEmbedding / Infinity
  // server reachable at RERANK_HTTP_URL; `noop` disables rerank entirely
  // (RRF merge alone).
  RERANK_PROVIDER: z.enum(['llm', 'http', 'noop']).default('llm'),
  RERANK_HTTP_URL: z.string().url().optional(),
  RERANK_HTTP_MODEL: z.string().optional(),
  RERANK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

  // Audio Overview TTS provider. Pluggable; default 'noop' means
  // script-only mode (no audio is rendered, artifact has status='ready'
  // with audioFilename=null). Real engines (openai / mac-say / kokoro)
  // are stubbed in the factory and will land in subsequent commits.
  TTS_PROVIDER: z.enum(['noop', 'openai', 'mac-say', 'kokoro']).default('noop'),

  // Public base URL used to build share links. Falls back to a
  // relative path (`/shared/:token`) so dev still works without
  // configuring it. In Coolify / production set this to the public
  // origin (e.g. https://notebook.example.com).
  PUBLIC_BASE_URL: z.string().optional(),

  // Suggested follow-up questions after a chat answer. Off by
  // default in tests (faster) and on by default in dev/prod.
  // Set to 'false' on weak hardware to skip the second LLM call.
  SUGGESTIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Deep Research agent — plan queries, search the web, ingest the
  // hits as real sources, synthesise a cited report. Needs outgoing
  // network to DuckDuckGo and the target sites; turn off in an
  // air-gapped deployment.
  DEEP_RESEARCH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;