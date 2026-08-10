-- ============================================================
-- LaborMeasurer schema v2 migration (run in the Supabase SQL
-- Editor). Safe to re-run. Brings a v1 database up to the
-- Phase 1+2 product: projects, revocable auth sessions, audit
-- log, timesheet corrections, burden/overtime snapshots,
-- hours-mode budgets, and the atomic assignment-swap function.
-- ============================================================

-- new tables ---------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name   TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_ms  BIGINT NOT NULL,
  expires_ms  BIGINT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at_ms     BIGINT NOT NULL,
  actor_id  BIGINT,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id BIGINT,
  details   TEXT
);

-- new columns --------------------------------------------------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_mode TEXT NOT NULL DEFAULT 'money';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_hours_ms BIGINT NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_budget_mode_check CHECK (budget_mode IN ('money', 'hours'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS burdened_rate_cents_snapshot BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS voided INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS corrected_from BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_by BIGINT;

-- backfill: pre-v2 sessions have no burden applied
UPDATE sessions SET burdened_rate_cents_snapshot = rate_cents_snapshot
WHERE burdened_rate_cents_snapshot IS NULL;

-- the one-open-session invariant must ignore voided rows -------
DROP INDEX IF EXISTS ux_open_session;
CREATE UNIQUE INDEX ux_open_session
  ON sessions(employee_id) WHERE clock_out_ms IS NULL AND voided = 0;

-- atomic assignment swap (called via RPC; the app falls back to a
-- REST sequence if this function is missing) -------------------
CREATE OR REPLACE FUNCTION lm_replace_assignments(
  p_task_id BIGINT,
  p_employee_ids BIGINT[],
  p_now_ms BIGINT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- close open sessions of workers being removed from the task,
  -- clamping so clock_out can never precede clock_in
  UPDATE sessions
     SET clock_out_ms = GREATEST(p_now_ms, clock_in_ms)
   WHERE task_id = p_task_id
     AND clock_out_ms IS NULL
     AND voided = 0
     AND NOT (employee_id = ANY (p_employee_ids));

  DELETE FROM assignments WHERE task_id = p_task_id;

  INSERT INTO assignments (task_id, employee_id)
  SELECT p_task_id, unnest(p_employee_ids);
END;
$$;

-- lock the function down to service-role usage only
REVOKE ALL ON FUNCTION lm_replace_assignments(BIGINT, BIGINT[], BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lm_replace_assignments(BIGINT, BIGINT[], BIGINT) TO service_role;

-- sanity check -------------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.tables
    WHERE table_name IN ('projects', 'auth_sessions', 'audit_log')) AS new_tables,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'sessions'
      AND column_name IN ('burdened_rate_cents_snapshot', 'voided', 'corrected_from', 'note', 'created_by')) AS new_session_columns,
  (SELECT count(*) FROM pg_proc WHERE proname = 'lm_replace_assignments') AS rpc_functions;
-- expected result: 3 | 5 | 1
