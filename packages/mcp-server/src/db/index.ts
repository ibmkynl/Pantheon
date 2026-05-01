import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the SQLite DB path. Search order:
 *   1. $PANTHEON_DB_PATH (explicit override)
 *   2. ./pantheon.db (CWD project-local — when CWD already has one)
 *   3. $PANTHEON_HOME/data/pantheon.db (defaults to ~/.pantheon/data/pantheon.db)
 */
function resolveDbPath(): string {
  const env = process.env['PANTHEON_DB_PATH'];
  if (env) {
    fs.mkdirSync(path.dirname(env), { recursive: true });
    return env;
  }

  const cwdLocal = path.resolve(process.cwd(), 'pantheon.db');
  if (fs.existsSync(cwdLocal)) return cwdLocal;

  const home  = process.env['PANTHEON_HOME'] || path.join(os.homedir(), '.pantheon');
  const dbDir = path.join(home, 'data');
  fs.mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, 'pantheon.db');
}

const DB_PATH = resolveDbPath();
// Suppress unused-import warning when env path doesn't need __dirname
void __dirname;

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb() {
  if (_db) return _db;
  _sqlite = new Database(DB_PATH);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');
  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function getSqlite(): Database.Database {
  if (!_sqlite) getDb();
  return _sqlite!;
}

export function initSchema(): void {
  const sqlite = getSqlite();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      tags       TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(key, project_id)
    );

    CREATE TABLE IF NOT EXISTS files (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      path            TEXT NOT NULL,
      project_id      TEXT,
      last_written_by TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(path, project_id)
    );

    CREATE TABLE IF NOT EXISTS todos (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      assignee   TEXT,
      priority   TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      status     TEXT NOT NULL DEFAULT 'todo'   CHECK(status   IN ('todo','in-progress','done')),
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      status  TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','done','error')),
      plan    TEXT,
      context TEXT
    );

    CREATE TABLE IF NOT EXISTS project_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      message    TEXT NOT NULL,
      level      TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error','debug')),
      agent_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_queue (
      id            TEXT PRIMARY KEY,
      agent_name    TEXT NOT NULL,
      domain        TEXT NOT NULL,
      task          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'queued'
                    CHECK(status IN ('queued','running','done','error','cancelled')),
      depends_on    TEXT,
      project_id    TEXT,
      result        TEXT,
      error_message TEXT,
      position      INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      started_at    TEXT,
      completed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name     TEXT NOT NULL,
      project_id     TEXT,
      tokens_in      INTEGER NOT NULL,
      tokens_out     INTEGER NOT NULL,
      total_tokens   INTEGER NOT NULL,
      estimated_cost REAL,
      model          TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS token_budget (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   TEXT,
      limit_tokens INTEGER NOT NULL,
      used_tokens  INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
    USING fts5(key, value, tags, content='memory', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS memory_fts_insert
    AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, key, value, tags)
      VALUES (new.id, new.key, new.value, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_update
    AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
      VALUES ('delete', old.id, old.key, old.value, old.tags);
      INSERT INTO memory_fts(rowid, key, value, tags)
      VALUES (new.id, new.key, new.value, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_delete
    AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
      VALUES ('delete', old.id, old.key, old.value, old.tags);
    END;

    CREATE TABLE IF NOT EXISTS code_symbols (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      file_path  TEXT NOT NULL,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      language   TEXT,
      line_start INTEGER NOT NULL,
      line_end   INTEGER,
      signature  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS code_symbols_name_idx ON code_symbols(name, project_id);
    CREATE INDEX IF NOT EXISTS code_symbols_file_idx ON code_symbols(file_path, project_id);

    CREATE TABLE IF NOT EXISTS code_refs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      from_file  TEXT NOT NULL,
      to_symbol  TEXT NOT NULL,
      to_file    TEXT,
      kind       TEXT NOT NULL,
      line       INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS code_refs_symbol_idx ON code_refs(to_symbol, project_id);
    CREATE INDEX IF NOT EXISTS code_refs_file_idx   ON code_refs(from_file, project_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts
    USING fts5(name, signature, content='code_symbols', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS csyms_fts_insert
    AFTER INSERT ON code_symbols BEGIN
      INSERT INTO code_symbols_fts(rowid, name, signature)
      VALUES (new.id, new.name, new.signature);
    END;

    CREATE TRIGGER IF NOT EXISTS csyms_fts_update
    AFTER UPDATE ON code_symbols BEGIN
      INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, signature)
      VALUES ('delete', old.id, old.name, old.signature);
      INSERT INTO code_symbols_fts(rowid, name, signature)
      VALUES (new.id, new.name, new.signature);
    END;

    CREATE TRIGGER IF NOT EXISTS csyms_fts_delete
    AFTER DELETE ON code_symbols BEGIN
      INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, signature)
      VALUES ('delete', old.id, old.name, old.signature);
    END;

    CREATE TABLE IF NOT EXISTS agent_inbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id   TEXT,
      agent_name TEXT NOT NULL,
      project_id TEXT,
      type       TEXT NOT NULL DEFAULT 'message',
      payload    TEXT,
      read       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS agent_inbox_target_idx
    ON agent_inbox(queue_id, agent_name, project_id, read);
  `);

  // Additive column migrations — safe to run every startup
  const cols = sqlite.prepare('PRAGMA table_info(agent_queue)').all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'status_message')) {
    sqlite.exec('ALTER TABLE agent_queue ADD COLUMN status_message TEXT');
  }
}
