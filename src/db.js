'use strict';

const Database = require('better-sqlite3');

// Unified async DB adapter. Two implementations share one interface:
//   get(sql, params)  -> row | undefined      (also used for INSERT ... RETURNING)
//   all(sql, params)  -> rows
//   run(sql, params)  -> void
//   transaction(fn)   -> awaits fn(txAdapter) atomically
//   close()
// SQL is written with `?` placeholders; the Postgres adapter converts them.
// Note on sqlite + async transactions: better-sqlite3 is synchronous, so every
// adapter promise resolves in a microtask — an async transaction body runs to
// completion inside one macrotask and no other request can interleave.

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (hourly_rate_cents >= 0),
  is_admin      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  budget_cents  INTEGER NOT NULL CHECK (budget_cents >= 0),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  show_countdown_to_employees INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assignments (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, employee_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rate_cents_snapshot INTEGER NOT NULL,
  clock_in_ms  INTEGER NOT NULL,
  clock_out_ms INTEGER CHECK (clock_out_ms IS NULL OR clock_out_ms >= clock_in_ms)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_open_session
  ON sessions(employee_id) WHERE clock_out_ms IS NULL;

CREATE INDEX IF NOT EXISTS ix_sessions_task ON sessions(task_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function isUniqueViolation(err) {
  return err && (err.code === '23505' || /UNIQUE/i.test(String(err.message)));
}

function createSqliteAdapter(file = 'labormeasurer.db') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SQLITE_SCHEMA);

  const adapter = {
    kind: 'sqlite',
    async get(sql, params = []) {
      const stmt = db.prepare(sql);
      return stmt.reader ? stmt.get(...params) : void stmt.run(...params);
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = await fn(adapter);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async close() {
      db.close();
    },
  };
  return adapter;
}

module.exports = { createSqliteAdapter, isUniqueViolation };
