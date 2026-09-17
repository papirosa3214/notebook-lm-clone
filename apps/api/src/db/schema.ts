import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const notebooks = sqliteTable('notebooks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  // Default to local Ollama — qwen3.6-27b-iq4-16k is the 27B model
  // currently installed on the inference box. Same model Mnemosyne uses
  // (MNEMOSYNE_LLM_MODEL), so behaviour stays consistent across apps.
  // KV cache is Q4 and num_ctx is capped at 16384 in providers/ollama.ts.
  defaultProvider: text('default_provider').notNull().default('ollama'),
  defaultModel: text('default_model').notNull().default('qwen3.6-27b-iq4-16k:latest'),
  createdAt: text('created_at').notNull().default(isoNow),
});

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  notebookId: text('notebook_id')
    .notNull()
    .references(() => notebooks.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['url', 'file', 'youtube'] }).notNull(),
  title: text('title').notNull(),
  url: text('url'),
  status: text('status', {
    enum: ['pending', 'parsing', 'ready', 'failed'],
  })
    .notNull()
    .default('pending'),
  error: text('error'),
  createdAt: text('created_at').notNull().default(isoNow),
  // Per-source summary (2-3 sentences) + topics + timestamp.
  // Populated by `summarizeSource()` after the source reaches status='ready'.
  // Nullable: legacy rows have no summary; the UI shows "✨ саммаризировать"
  // until the user (or fire-and-forget ingest) fills these in.
  summary: text('summary'),
  summaryTopics: text('summary_topics'), // JSON-encoded string[] — SQLite has no array type
  summarizedAt: text('summarized_at'),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  notebookId: text('notebook_id')
    .notNull()
    .references(() => notebooks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  contentMd: text('content_md').notNull(),
  createdAt: text('created_at').notNull().default(isoNow),
  updatedAt: text('updated_at').notNull().default(isoNow),
});

export const chunks = sqliteTable('chunks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vecRowid: integer('vec_rowid').notNull(),
  notebookId: text('notebook_id')
    .notNull()
    .references(() => notebooks.id, { onDelete: 'cascade' }),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['url', 'file', 'youtube'] }).notNull(),
  title: text('title').notNull(),
  url: text('url'),
  content: text('content').notNull(),
  ordinal: integer('ordinal').notNull().default(0),
});