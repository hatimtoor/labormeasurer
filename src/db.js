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
CREATE TABLE IF NOT EXISTS projects (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);

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
  show_countdown_to_employees INTEGER NOT NULL DEFAULT 1,
  project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  budget_mode   TEXT NOT NULL DEFAULT 'money' CHECK (budget_mode IN ('money', 'hours')),
  budget_hours_ms INTEGER NOT NULL DEFAULT 0 CHECK (budget_hours_ms >= 0)
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
  burdened_rate_cents_snapshot INTEGER,
  clock_in_ms  INTEGER NOT NULL,
  clock_out_ms INTEGER CHECK (clock_out_ms IS NULL OR clock_out_ms >= clock_in_ms),
  voided       INTEGER NOT NULL DEFAULT 0,
  corrected_from INTEGER,
  note         TEXT,
  created_by   INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_open_session
  ON sessions(employee_id) WHERE clock_out_ms IS NULL AND voided = 0;

CREATE INDEX IF NOT EXISTS ix_sessions_task ON sessions(task_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_ms  INTEGER NOT NULL,
  expires_ms  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms     INTEGER NOT NULL,
  actor_id  INTEGER,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id INTEGER,
  details   TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// column additions for databases created before schema v2. The v1 unique index
// must also be swapped for the voided-aware one.
const SQLITE_MIGRATIONS = [
  "ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL",
  "ALTER TABLE tasks ADD COLUMN budget_mode TEXT NOT NULL DEFAULT 'money'",
  'ALTER TABLE tasks ADD COLUMN budget_hours_ms INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sessions ADD COLUMN burdened_rate_cents_snapshot INTEGER',
  'ALTER TABLE sessions ADD COLUMN voided INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sessions ADD COLUMN corrected_from INTEGER',
  'ALTER TABLE sessions ADD COLUMN note TEXT',
  'ALTER TABLE sessions ADD COLUMN created_by INTEGER',
  'DROP INDEX IF EXISTS ux_open_session',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_open_session ON sessions(employee_id) WHERE clock_out_ms IS NULL AND voided = 0',
];

function isUniqueViolation(err) {
  return err && (err.code === '23505' || /UNIQUE/i.test(String(err.message)));
}

function createSqliteAdapter(file = 'labormeasurer.db') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SQLITE_SCHEMA);
  for (const migration of SQLITE_MIGRATIONS) {
    try {
      db.exec(migration);
    } catch (err) {
      if (!/duplicate column/i.test(String(err.message))) throw err;
    }
  }

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
