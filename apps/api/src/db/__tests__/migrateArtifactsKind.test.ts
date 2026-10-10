/**
 * Regression tests for the `artifacts.kind` CHECK-constraint migration.
 *
 * SQLite cannot ALTER a CHECK constraint, so a database created by an
 * older build keeps `kind IN ('note','audio_overview')` forever and
 * every `kind='report'` insert (Studio reports, Deep Research) fails.
 * `addColumnIfMissing` cannot fix this because the column already
 * exists — hence the explicit table rebuild in migrate().
 *
 * These tests build a database with the stale two-value constraint by
 * hand, run migrate() over it, and assert:
 *   1. the constraint now accepts 'report'
 *   2. existing rows survive the rebuild
 *   3. the rebuild is idempotent (a second migrate() is a no-op)
 */
import Database from 'better-sqlite3';
import { getLoadablePath as sqliteVecPath } from 'sqlite-vec';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateForTests } from '../index.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-migrate-'));
  dbPath = join(dir, 'stale.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Create the minimum schema migrate() expects, but with the OLD
 *  two-value kind CHECK that shipped before 'report' existed. */
function createStaleDb(): Database.Database {
  const sqlite = new Database(dbPath);
  sqlite.loadExtension(sqliteVecPath()); // migrate() creates vec0 virtual tables
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE notebooks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content_md TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','audio_overview'))
    );
    CREATE INDEX idx_artifacts_notebook ON artifacts(notebook_id);
    INSERT INTO notebooks (id, title) VALUES ('nb1','Stale notebook');
    INSERT INTO artifacts (id, notebook_id, title, content_md, kind)
      VALUES ('a1','nb1','Existing note','body','note');
    INSERT INTO artifacts (id, notebook_id, title, content_md, kind)
      VALUES ('a2','nb1','Existing audio','body','audio_overview');
  `);
  return sqlite;
}

describe('artifacts.kind CHECK constraint migration', () => {
  it('rebuilds a stale table so kind="report" is accepted', () => {
    const sqlite = createStaleDb();

    // The bug: inserting a report fails on the stale schema.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO artifacts (id,notebook_id,title,content_md,kind) VALUES (?,?,?,?,?)`,
        )
        .run('bad','nb1','Report','body','report'),
    ).toThrow(/CHECK constraint failed/);

    migrateForTests(sqlite);

    // After migrate the same insert succeeds.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO artifacts (id,notebook_id,title,content_md,kind) VALUES (?,?,?,?,?)`,
        )
        .run('good','nb1','Report','body','report'),
    ).not.toThrow();

    const row = sqlite.prepare(`SELECT kind FROM artifacts WHERE id='good'`).get() as {
      kind: string;
    };
    expect(row.kind).toBe('report');

    // An invalid kind is still rejected — the CHECK wasn't dropped.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO artifacts (id,notebook_id,title,content_md,kind) VALUES (?,?,?,?,?)`,
        )
        .run('evil','nb1','Bad','body','malware'),
    ).toThrow(/CHECK constraint failed/);

    sqlite.close();
  });

  it('preserves existing rows through the rebuild', () => {
    const sqlite = createStaleDb();
    migrateForTests(sqlite);

    const rows = sqlite
      .prepare(`SELECT id, title, kind FROM artifacts ORDER BY id`)
      .all() as Array<{ id: string; title: string; kind: string }>;
    expect(rows).toEqual([
      { id: 'a1', title: 'Existing note', kind: 'note' },
      { id: 'a2', title: 'Existing audio', kind: 'audio_overview' },
    ]);

    // The index survived too.
    const idx = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_artifacts_notebook'`)
      .get();
    expect(idx).toBeDefined();

    sqlite.close();
  });

  it('is idempotent — a second migrate() leaves the schema alone', () => {
    const sqlite = createStaleDb();
    migrateForTests(sqlite);
    const firstSql = (
      sqlite.prepare(`SELECT sql FROM sqlite_master WHERE name='artifacts'`).get() as {
        sql: string;
      }
    ).sql;

    migrateForTests(sqlite);
    const secondSql = (
      sqlite.prepare(`SELECT sql FROM sqlite_master WHERE name='artifacts'`).get() as {
        sql: string;
      }
    ).sql;

    expect(secondSql).toBe(firstSql);
    // No leftover temp table.
    const leftovers = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'artifacts__new%'`)
      .all();
    expect(leftovers).toEqual([]);

    sqlite.close();
  });
});
