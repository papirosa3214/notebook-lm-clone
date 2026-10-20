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

/**
 * Run the migration set against an arbitrary database handle.
 *
 * Exported for the migration regression tests, which build a database
 * with an older schema by hand and then assert `migrate()` upgrades it.
 * Production code goes through `getDb()`.
 */
export function migrateForTests(sqlite: Database.Database): void {
  migrate(sqlite);
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

  // SQLite cannot ALTER a CHECK constraint. A database created by an
  // earlier build has `kind IN ('note','audio_overview')` baked into
  // the table definition, and `addColumnIfMissing` is a no-op there
  // because the column already exists — so every `kind='report'`
  // insert (Studio reports, Deep Research) fails with "CHECK
  // constraint failed". Rebuild the table when we detect the stale
  // two-value constraint.
  rebuildArtifactsIfKindConstraintStale(sqlite);

  // Sharing (Milestone D). Both columns are nullable; revoking a
  // share sets shareToken = NULL while keeping shareEnabledAt as
  // the timestamp of the last enable.
  addColumnIfMissing(sqlite, 'notebooks', 'share_token', 'TEXT');
  addColumnIfMissing(sqlite, 'notebooks', 'share_enabled_at', 'TEXT');

  // Notebook cover art. cover_spec holds the JSON recipe produced by
  // lib/coverArt.ts (palette + motif + symbol), never raw markup.
  addColumnIfMissing(sqlite, 'notebooks', 'cover_spec', 'TEXT');

  // Per-source picture (og:image / YouTube thumbnail). The notebook
  // cover is chosen from this column; NULL just means this source
  // offered no picture.
  addColumnIfMissing(sqlite, 'sources', 'cover_image', 'TEXT');

  // Thematic grouping of sources. One row per notebook; `signature`
  // encodes the exact source set the grouping was built from, so a
  // changed source list is detected on read instead of by polling.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS source_groups (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_source_groups_notebook
      ON source_groups(notebook_id);
  `);
}

/**
 * Rebuild the `artifacts` table when its CHECK constraint predates the
 * `'report'` kind. Forward-only and idempotent: after the rebuild the
 * constraint contains `'report'`, so the guard stops firing.
 *
 * The rebuild follows the documented SQLite recipe (create new table →
 * copy → drop old → rename → recreate indexes). It runs inside the
 * caller's transaction, so a crash mid-way leaves the old table intact.
 */
function rebuildArtifactsIfKindConstraintStale(sqlite: Database.Database): void {
  const row = sqlite
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'`)
    .get() as { sql: string } | undefined;
  if (!row) return;
  const sql = row.sql ?? '';
  // Only rebuild when the table defines a kind CHECK that omits 'report'.
  const hasKindCheck = /CHECK\s*\(\s*kind\s+IN\s*\(/i.test(sql);
  if (!hasKindCheck) return;
  if (/['"]report['"]/.test(sql)) return; // already current

  // The canonical SQLite table-rebuild recipe: FKs off (the pragma is
  // a no-op inside a transaction, so it must come first), swap inside
  // a transaction, then FKs back on. `artifacts` is a child table
  // (it references notebooks) and nothing references it, so the drop
  // cannot orphan rows.
  sqlite.pragma('foreign_keys = OFF');
  try {
    sqlite.exec('BEGIN');
    sqlite.exec(`
      CREATE TABLE artifacts__new (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content_md TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        kind TEXT NOT NULL DEFAULT 'note'
          CHECK (kind IN ('note', 'audio_overview', 'report')),
        meta TEXT
      );
      INSERT INTO artifacts__new
        (id, notebook_id, title, content_md, created_at, updated_at, kind, meta)
        SELECT id, notebook_id, title, content_md, created_at, updated_at, kind, meta
        FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts__new RENAME TO artifacts;
      CREATE INDEX IF NOT EXISTS idx_artifacts_notebook ON artifacts(notebook_id);
    `);
    sqlite.exec('COMMIT');
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // Rollback itself can fail if the transaction never opened.
    }
    throw err;
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
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