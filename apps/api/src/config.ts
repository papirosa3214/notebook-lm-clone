import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  // Ragflow
  RAGFLOW_BASE_URL: z.string().url().default('http://192.168.1.110:8080'),
  RAGFLOW_API_KEY: z.string().min(1, 'RAGFLOW_API_KEY is required'),

  // LLM providers (all optional; UI lets user pick)
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://192.168.1.110:11434'),

  // Storage
  DB_PATH: z.string().default('./data/notebook.db'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
