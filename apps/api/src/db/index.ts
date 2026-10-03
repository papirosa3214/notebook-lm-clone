import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getLoadablePath as sqliteVecPath } from 'sqlite-vec';
import { config } from '../config.js';
import * as schema from './schema.js';

export type DB = BetterSQLite3Database<typeof schema>;

let _db: DB | null = null;
let _sqlite: Database.Database | null = null;

export function getDb(): DB {
  if (_db) return _db;
  const path = resolve(config.DB_PATH);
  mkdirSync(dirname(path), { recursive: true });
  _sqlite = new Database(path);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');
  // Load the sqlite-vec extension for KNN queries on float[N] columns.
  _sqlite.loadExtension(sqliteVecPath());
  migrate(_sqlite);
  _db = drizzle(_sqlite, { schema });
  return _db;
}

/**
 * Raw better-sqlite3 handle — used by modules that need sqlite-vec operations
 * or fine-grained transaction control that drizzle doesn't expose well.
 */
export function getRawSqlite(): Database.Database {
  if (!_sqlite) getDb();
  return _sqlite!;
}

function migrate(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      default_provider TEXT NOT NULL DEFAULT 'anthropic',
      default_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('url', 'file', 'youtube')),
      title TEXT NOT NULL,
      url TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'parsing', 'ready', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      -- Per-source summary cache; populated by summarizeSource()
      summary TEXT,
      summary_topics TEXT,
      summarized_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sources_notebook ON sources(notebook_id);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content_md TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_notebook ON artifacts(notebook_id);

    -- Chunk metadata; one row per inserted vec_chunks rowid.
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vec_rowid INTEGER NOT NULL,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      content TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_notebook ON chunks(notebook_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_vec_rowid ON chunks(vec_rowid);

    -- Persistent chat log. One row per turn. Kept in a separate CREATE so the
    -- SQL above stays readable (CHECK (...) with quoted strings confuses some
    -- parsers when mixed into a giant template literal).
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations TEXT,
      provider TEXT,
      model TEXT,
      top_k INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_notebook_created
      ON messages(notebook_id, created_at);

    -- Lightweight knowledge-graph storage. One row per subject-predicate-object
    -- triple extracted from a source. The graph is built at ingest by calling
    -- an LLM in graph.ts; queries match by LIKE on subject/object/predicate.
    CREATE TABLE IF NOT EXISTS graph_triples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_graph_triples_notebook
      ON graph_triples(notebook_id);
    CREATE INDEX IF NOT EXISTS idx_graph_triples_source
      ON graph_triples(source_id);

    -- Vector index. Dimension is fixed at module level (1024 for bge-m3-embed).
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[1024]
    );

    -- FTS5 (BM25) lexical index. External-content mode so storage isn't
    -- duplicated; the rowid here is the chunks.id primary key. We index
    -- title and content for keyword matching, which complements dense
    -- retrieval on unique terms (URLs, model names, dates) that
    -- embedding models tend to flatten.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      title,
      content,
      content='chunks',
      content_rowid='id',
      tokenize='unicode61'
    );
  `);

  // One-shot migration from the pre-0.2 Ragflow-era schema.
  // SQLite can't ALTER DROP a UNIQUE column, so we rebuild the affected tables.
  // Safe to run repeatedly — guarded by columnExists check.
  if (columnExists(sqlite, 'notebooks', 'ragflow_dataset_id')) {
    sqlite.exec(`
      CREATE TABLE _notebooks_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        default_provider TEXT NOT NULL DEFAULT 'anthropic',
        default_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO _notebooks_new (id, title, default_provider, default_model, created_at)
        SELECT id, title, default_provider, default_model, created_at FROM notebooks;
      DROP TABLE notebooks;
      ALTER TABLE _notebooks_new RENAME TO notebooks;
    `);
  }
  if (columnExists(sqlite, 'sources', 'ragflow_doc_id')) {
    sqlite.exec(`
      CREATE TABLE _sources_new (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('url', 'file', 'youtube')),
        title TEXT NOT NULL,
        url TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'parsing', 'ready', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        summary TEXT,
        summary_topics TEXT,
        summarized_at TEXT
      );
      INSERT INTO _sources_new (id, notebook_id, kind, title, url, status, error, created_at,
                               summary, summary_topics, summarized_at)
        SELECT id, notebook_id, kind, title, url, status, error, created_at,
               summary, summary_topics, summarized_at FROM sources;
      DROP TABLE sources;
      ALTER TABLE _sources_new RENAME TO sources;
      CREATE INDEX idx_sources_notebook ON sources(notebook_id);
    `);
  }

  // Forward-only ADD COLUMN migrations. SQLite ALTER TABLE ADD COLUMN
  // never fails on an existing column (it's a no-op) so this is safe to
  // run on every boot. We keep one block per phase so it's clear which
  // migration introduced which column.
  addColumnIfMissing(sqlite, 'sources', 'summary', 'TEXT');
  addColumnIfMissing(sqlite, 'sources', 'summary_topics', 'TEXT');
  addColumnIfMissing(sqlite, 'sources', 'summarized_at', 'TEXT');

  // Audio Overview (Milestone B). artifacts.kind + artifacts.meta.
  // Existing rows backfill kind='note' implicitly through the SQL default.
  addColumnIfMissing(
    sqlite,
    'artifacts',
    'kind',
    `TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'audio_overview', 'report'))`,
  );
  addColumnIfMissing(sqlite, 'artifacts', 'meta', 'TEXT');
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: string,
  column: string,
  typeDecl: string,
): void {
  if (!columnExists(sqlite, table, column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
  }
}

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export function closeDb() {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}