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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;