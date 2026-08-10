'use strict';

// Pure calculation engine. No imports of db/clock — everything derives from
// immutable session rows + a caller-supplied nowMs, so history is never lost
// and there is nothing to keep in sync.

const MS_PER_HOUR = 3_600_000;

// Exact-arithmetic note: N = Σ(rate_cents × duration_ms) stays an exact
// integer (cents·ms). It exceeds 2^53 only past roughly $100/hr aggregate
// sustained for ~28 years, so plain Number is safe here. All divisions happen
// once, on totals, at this serialization boundary — never per session.

/**
 * @param {{id:number, budget_cents:number}} task
 * @param {Array<{employee_id:number, rate_cents_snapshot:number, clock_in_ms:number, clock_out_ms:number|null}>} sessions
 * @param {number} nowMs
 */
function computeTaskSnapshot(task, sessions, nowMs) {
  let numerator = 0; // cents·ms consumed
  let burnRateCentsPerHour = 0;
  const byEmployee = new Map(); // employee_id -> {numerator, worked_ms, open, rate}
  const activeEmployeeIds = [];

  for (const s of sessions) {
    const open = s.clock_out_ms == null;
    const end = open ? nowMs : s.clock_out_ms;
    const durationMs = Math.max(0, end - s.clock_in_ms);
    const contribution = s.rate_cents_snapshot * durationMs;
    numerator += contribution;

    if (open) {
      burnRateCentsPerHour += s.rate_cents_snapshot;
      activeEmployeeIds.push(s.employee_id);
    }

    let agg = byEmployee.get(s.employee_id);
    if (!agg) {
      agg = { numerator: 0, worked_ms: 0, open: false, rate_cents_snapshot: s.rate_cents_snapshot };
      byEmployee.set(s.employee_id, agg);
    }
    agg.numerator += contribution;
    agg.worked_ms += durationMs;
    if (open) {
      agg.open = true;
      agg.rate_cents_snapshot = s.rate_cents_snapshot;
    }
  }

  const budgetNumerator = task.budget_cents * MS_PER_HOUR;
  // pure integer comparison — the exhaustion decision never touches rounding
  const exhausted = numerator >= budgetNumerator;
  const consumedCents = Math.round(numerator / MS_PER_HOUR);
  const remainingCents = task.budget_cents - consumedCents; // may be negative = over budget

  let remainingSeconds = null; // null = paused (no one clocked in)
  if (burnRateCentsPerHour > 0) {
    remainingSeconds = Math.floor(
      Math.max(0, budgetNumerator - numerator) / burnRateCentsPerHour / 1000
    );
  }

  const employees = [...byEmployee.entries()].map(([employee_id, agg]) => ({
    employee_id,
    worked_ms: agg.worked_ms,
    cost_cents: Math.round(agg.numerator / MS_PER_HOUR),
    clocked_in: agg.open,
    rate_cents_snapshot: agg.rate_cents_snapshot,
  }));

  return {
    task_id: task.id,
    at_ms: nowMs,
    budget_cents: task.budget_cents,
    consumed_cents: consumedCents,
    remaining_cents: remainingCents,
    over_budget_cents: Math.max(0, -remainingCents),
    burn_rate_cents_per_hour: burnRateCentsPerHour,
    remaining_seconds: remainingSeconds,
    exhausted,
    // original budgeted hours at the current crew burn rate (null when paused)
    budgeted_seconds_at_current_burn:
      burnRateCentsPerHour > 0 ? Math.floor(budgetNumerator / burnRateCentsPerHour / 1000) : null,
    pct_consumed: task.budget_cents > 0 ? Math.min(999, Math.round((consumedCents / task.budget_cents) * 100)) : (numerator > 0 ? 100 : 0),
    total_worked_ms: employees.reduce((sum, e) => sum + e.worked_ms, 0),
    active_employee_ids: activeEmployeeIds,
    employees,
  };
}

module.exports = { computeTaskSnapshot, MS_PER_HOUR };
