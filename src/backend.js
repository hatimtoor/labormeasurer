'use strict';

// Backend selection, shared by server.js and seed.js. Priority:
//   1. SUPABASE_DB_URL / DATABASE_URL  -> direct Postgres (full transactions)
//   2. SUPABASE_PROJECT_URL + SUPABASE_SERVICE_ROLE_KEY -> Supabase REST API
//   3. local SQLite file (zero config; also what the tests use)
async function openDatabase() {
  // explicit override (e.g. LM_BACKEND=sqlite for local E2E against a file DB
  // even when Supabase credentials are present in .env)
  if (process.env.LM_BACKEND === 'sqlite') {
    const { createSqliteAdapter } = require('./db');
    const { createSqlData } = require('./data-sql');
    return { data: createSqlData(createSqliteAdapter(process.env.LM_DB || 'labormeasurer.db')), label: 'local SQLite' };
  }
  const pgUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (pgUrl) {
    if (!/^postgres(ql)?:\/\//.test(pgUrl)) {
      throw new Error(
        'SUPABASE_DB_URL must be a postgresql:// connection string (Supabase dashboard -> Connect). ' +
        'For the https:// project URL + service-role key, use SUPABASE_PROJECT_URL and SUPABASE_SERVICE_ROLE_KEY instead.'
      );
    }
    const { createPgAdapter } = require('./db-pg');
    const { createSqlData } = require('./data-sql');
    const data = createSqlData(await createPgAdapter(pgUrl));
    return { data, label: 'Supabase Postgres (direct)' };
  }

  const projectUrl = process.env.SUPABASE_PROJECT_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (projectUrl && serviceKey) {
    if (!/^https:\/\//.test(projectUrl)) {
      throw new Error('SUPABASE_PROJECT_URL must be the https://<ref>.supabase.co project URL');
    }
    const { createSupabaseData } = require('./data-supabase');
    return { data: createSupabaseData(projectUrl, serviceKey), label: 'Supabase (REST API)' };
  }

  const { createSqliteAdapter } = require('./db');
  const { createSqlData } = require('./data-sql');
  const data = createSqlData(createSqliteAdapter(process.env.LM_DB || 'labormeasurer.db'));
  return { data, label: 'local SQLite' };
}

module.exports = { openDatabase };
