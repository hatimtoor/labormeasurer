'use strict';

const { Pool, types } = require('pg');

// Postgres (Supabase) implementation of the adapter interface in db.js.
// BIGINT (int8) values are our millisecond timestamps — parse to Number
// (all values are far below 2^53).
types.setTypeParser(20, (v) => Number(v));

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  hourly_rate_cents BIGINT NOT NULL DEFAULT 0 CHECK (hourly_rate_cents >= 0),
  is_admin      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  budget_cents  BIGINT NOT NULL CHECK (budget_cents >= 0),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  show_countdown_to_employees INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assignments (
  task_id     BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, employee_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id  BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rate_cents_snapshot BIGINT NOT NULL,
  clock_in_ms  BIGINT NOT NULL,
  clock_out_ms BIGINT CHECK (clock_out_ms IS NULL OR clock_out_ms >= clock_in_ms)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_open_session
  ON sessions(employee_id) WHERE clock_out_ms IS NULL;

CREATE INDEX IF NOT EXISTS ix_sessions_task ON sessions(task_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// convert `?` placeholders to $1..$n
function toPgSql(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function makeQueryMethods(runQuery) {
  return {
    async get(sql, params = []) {
      const res = await runQuery(toPgSql(sql), params);
      return res.rows[0];
    },
    async all(sql, params = []) {
      const res = await runQuery(toPgSql(sql), params);
      return res.rows;
    },
    async run(sql, params = []) {
      await runQuery(toPgSql(sql), params);
    },
  };
}

async function createPgAdapter(connectionString) {
  const pool = new Pool({
    connectionString,
    max: 10,
    // Supabase requires TLS; their pooler certs verify via SNI, but local
    // environments often lack the CA chain — Supabase's own docs use this.
    ssl: { rejectUnauthorized: false },
  });

  await pool.query(PG_SCHEMA);

  const adapter = {
    kind: 'postgres',
    ...makeQueryMethods((sql, params) => pool.query(sql, params)),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = { kind: 'postgres', ...makeQueryMethods((sql, params) => client.query(sql, params)) };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return adapter;
}

module.exports = { createPgAdapter };
