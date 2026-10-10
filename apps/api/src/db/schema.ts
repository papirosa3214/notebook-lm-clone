import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const notebooks = sqliteTable('notebooks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  // По умолчанию — MiniMax через прокси api.minimax.io/anthropic, модель M3.
  // Для старых БД default в самой SQLite-схеме останется прежним, пока кто-то
  // не выполнит ALTER TABLE. Runtime default при создании ноутбука подставляется
  // явно в routes/notebooks.ts — этот default здесь для Drizzle-INSERT-ов без
  // явного указания и для новых таблиц при первой миграции.
  defaultProvider: text('default_provider').notNull().default('minimax'),
  defaultModel: text('default_model').notNull().default('MiniMax-M3'),
  createdAt: text('created_at').notNull().default(isoNow),
  // Sharing (Milestone D). shareToken is a long random nanoid;
  // shareEnabledAt is the ISO timestamp of the last enable. Revoke
  // sets shareToken = NULL; the token itself is not re-used, so a
  // revoked link returns 404 forever.
  shareToken: text('share_token'),
  shareEnabledAt: text('share_enabled_at'),
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
  // 'note' (default — pure markdown), 'audio_overview' (script + audio),
  // or 'report' (Studio template: FAQ, TL;DR, timeline, contradictions).
  // Picked by the create endpoint; UI uses it to decide between markdown
  // preview, audio player, or report card.
  kind: text('kind', { enum: ['note', 'audio_overview', 'report'] })
    .notNull()
    .default('note'),
  // JSON-encoded artifact-specific metadata. For audio_overview this is
  // AudioOverviewMeta (status, lineCount, durationSec, audioFilename, …).
  // For 'note' it stays null. Adding new artifact kinds shouldn't require
  // a migration — just extend the meta schema in shared/.
  meta: text('meta'),
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

// Persistent chat log per notebook. Each row is one turn (user or assistant).
// `citations` is a JSON-encoded Citation[] (matches the shape stream emits in
// the SSE 'citations' event). `provider`/`model` are denormalised for filtering
// and re-using the same provider in /messages reflow without re-reading
// notebooks.defaultProvider.
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  notebookId: text('notebook_id')
    .notNull()
    .references(() => notebooks.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  citations: text('citations'), // JSON-encoded Citation[] | null
  provider: text('provider'),
  model: text('model'),
  // Optional: how many top-K retrieved chunks fed into this assistant turn.
  // Nullable for legacy / system rows.
  topK: integer('top_k'),
  createdAt: text('created_at').notNull().default(isoNow),
});