'use strict';

const Database = require('better-sqlite3');

const SCHEMA = `
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

-- invariant: an employee can have at most one open session across all tasks
CREATE UNIQUE INDEX IF NOT EXISTS ux_open_session
  ON sessions(employee_id) WHERE clock_out_ms IS NULL;

CREATE INDEX IF NOT EXISTS ix_sessions_task ON sessions(task_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function openDb(file = 'labormeasurer.db') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
