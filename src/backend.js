'use strict';

const { createSqliteAdapter } = require('./db');

// Backend selection, shared by server.js and seed.js.
// Set SUPABASE_DB_URL (or DATABASE_URL) in .env to run on Supabase Postgres;
// without it the app uses a local SQLite file. Find the connection string in
// the Supabase dashboard: Project Settings -> Database -> Connection string
// (URI). The "Transaction pooler" URI is recommended.
async function openDatabase() {
  const pgUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (pgUrl) {
    if (!/^postgres(ql)?:\/\//.test(pgUrl)) {
      throw new Error(
        'SUPABASE_DB_URL must be a postgresql:// connection string (Supabase dashboard -> Project Settings -> Database -> Connection string). ' +
        'The SUPABASE_URL https:// endpoint and anon/service keys are not database connections.'
      );
    }
    const { createPgAdapter } = require('./db-pg');
    const db = await createPgAdapter(pgUrl);
    return { db, label: 'Supabase Postgres' };
  }
  const db = createSqliteAdapter(process.env.LM_DB || 'labormeasurer.db');
  return { db, label: 'local SQLite' };
}

module.exports = { openDatabase };
