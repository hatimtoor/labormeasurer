'use strict';

// Pure calculation engine. No imports of db/clock — everything derives from
// immutable session rows + a caller-supplied nowMs, so history is never lost
// and there is nothing to keep in sync.
//
// v2: labor burden (baked into per-session burdened rate snapshots), budgets
// in dollars OR person-hours, and daily overtime. Overtime is per employee
// per LOCAL day across ALL tasks, so snapshots are computed globally: each
// worker's sessions are sliced chronologically into base/OT segments and the
// cost of each segment lands on the task where those minutes were worked.
//
// Precision: without OT every numerator term is an exact integer (cents×ms).
// OT multiplies segments by pct/100 — a float — but each term stays ≤ ~1e15,
// so cumulative error is far below one cent at any realistic scale.

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const DEFAULT_ORG = {
  otThresholdMs: 0, // 0 = overtime disabled
  otMultiplierPct: 150,
  utcOffsetMin: 0, // org-local timezone offset for day boundaries
};

function sessionRate(s) {
  return s.burdened_rate_cents_snapshot ?? s.rate_cents_snapshot;
}

// Split [startMs, endMs) into org-local calendar days.
function* dayWindows(startMs, endMs, utcOffsetMin) {
  const offset = utcOffsetMin * 60_000;
  let cursor = startMs;
  while (cursor < endMs) {
    const dayIndex = Math.floor((cursor + offset) / MS_PER_DAY);
    const dayEnd = (dayIndex + 1) * MS_PER_DAY - offset;
    const end = Math.min(endMs, dayEnd);
    yield { dayIndex, start: cursor, end };
    cursor = end;
  }
}

// Slice one employee's chronological sessions into cost segments.
// Returns per-task accumulators plus whether the employee is in OT "now".
function sliceEmployee(sessions, nowMs, org) {
  const perTask = new Map(); // task_id -> {numerator, workedMs}
  const workedByDay = new Map(); // dayIndex -> ms accumulated (chronological)
  let inOtNow = false;

  const acc = (taskId) => {
    let entry = perTask.get(taskId);
    if (!entry) {
      entry = { numerator: 0, workedMs: 0 };
      perTask.set(taskId, entry);
    }
    return entry;
  };

  for (const s of sessions) {
    const open = s.clock_out_ms == null;
    const end = open ? nowMs : s.clock_out_ms;
    if (end <= s.clock_in_ms) continue;
    const rate = sessionRate(s);
    const entry = acc(s.task_id);

    if (!org.otThresholdMs) {
      const len = end - s.clock_in_ms;
      entry.numerator += rate * len;
      entry.workedMs += len;
      continue;
    }

    for (const win of dayWindows(s.clock_in_ms, end, org.utcOffsetMin)) {
      const before = workedByDay.get(win.dayIndex) || 0;
      const len = win.end - win.start;
      const baseLen = Math.max(0, Math.min(len, org.otThresholdMs - before));
      const otLen = len - baseLen;
      entry.numerator += rate * baseLen + rate * otLen * (org.otMultiplierPct / 100);
      entry.workedMs += len;
      workedByDay.set(win.dayIndex, before + len);
    }
  }

  if (org.otThresholdMs) {
    const offset = org.utcOffsetMin * 60_000;
    const todayIndex = Math.floor((nowMs + offset) / MS_PER_DAY);
    inOtNow = (workedByDay.get(todayIndex) || 0) >= org.otThresholdMs;
  }

  return { perTask, inOtNow };
}

/**
 * Compute snapshots for ALL tasks at once (required for cross-task overtime).
 * @param {Array} tasks
 * @param {Array} sessions - non-voided sessions for all tasks, ordered by clock_in_ms
 * @param {number} nowMs
 * @param {object} orgOverrides - {otThresholdMs, otMultiplierPct, utcOffsetMin}
 * @returns {Map<number, object>} task_id -> snapshot core
 */
function computeSnapshots(tasks, sessions, nowMs, orgOverrides = {}) {
  const org = { ...DEFAULT_ORG, ...orgOverrides };

  // group sessions per employee, preserving chronological order
  const byEmployee = new Map();
  for (const s of sessions) {
    let list = byEmployee.get(s.employee_id);
    if (!list) {
      list = [];
      byEmployee.set(s.employee_id, list);
    }
    list.push(s);
  }

  // per-task per-employee accumulation
  const taskAgg = new Map(); // task_id -> Map(employee_id -> {numerator, workedMs, open, rate})
  const activeByTask = new Map(); // task_id -> [{employee_id, currentRate}]
  for (const t of tasks) {
    taskAgg.set(t.id, new Map());
    activeByTask.set(t.id, []);
  }

  for (const [employeeId, empSessions] of byEmployee) {
    const { perTask, inOtNow } = sliceEmployee(empSessions, nowMs, org);
    for (const [taskId, agg] of perTask) {
      const empMap = taskAgg.get(taskId);
      if (!empMap) continue; // session for a task not in the list (deleted)
      empMap.set(employeeId, {
        numerator: agg.numerator,
        workedMs: agg.workedMs,
        open: false,
        rate_cents_snapshot: null,
      });
    }
    // open session determines active state + current burn contribution
    const openSession = empSessions.find((s) => s.clock_out_ms == null);
    if (openSession) {
      const empMap = taskAgg.get(openSession.task_id);
      if (empMap) {
        const line = empMap.get(employeeId);
        if (line) {
          line.open = true;
          line.rate_cents_snapshot = openSession.rate_cents_snapshot;
        }
        const base = sessionRate(openSession);
        const currentRate = inOtNow ? (base * org.otMultiplierPct) / 100 : base;
        activeByTask.get(openSession.task_id).push({ employee_id: employeeId, currentRate });
      }
    }
  }

  const snapshots = new Map();
  for (const task of tasks) {
    const empMap = taskAgg.get(task.id);
    const active = activeByTask.get(task.id);

    let numerator = 0;
    let totalWorkedMs = 0;
    const employees = [];
    for (const [employee_id, agg] of empMap) {
      numerator += agg.numerator;
      totalWorkedMs += agg.workedMs;
      employees.push({
        employee_id,
        worked_ms: agg.workedMs,
        cost_cents: Math.round(agg.numerator / MS_PER_HOUR),
        clocked_in: agg.open,
        rate_cents_snapshot: agg.rate_cents_snapshot,
      });
    }

    const burnRateCentsPerHour = active.reduce((sum, a) => sum + a.currentRate, 0);
    const consumedCents = Math.round(numerator / MS_PER_HOUR);
    const activeIds = active.map((a) => a.employee_id);

    let snap;
    if (task.budget_mode === 'hours') {
      // budget is person-hours; the countdown divides remaining person-time
      // across the currently clocked-in crew
      const budgetMs = task.budget_hours_ms;
      const remainingMs = budgetMs - totalWorkedMs;
      const exhausted = totalWorkedMs >= budgetMs;
      snap = {
        budget_mode: 'hours',
        budget_hours_ms: budgetMs,
        budget_cents: task.budget_cents,
        consumed_cents: consumedCents,
        remaining_cents: null,
        over_budget_cents: 0,
        consumed_person_ms: totalWorkedMs,
        remaining_person_ms: remainingMs,
        over_budget_ms: Math.max(0, -remainingMs),
        exhausted,
        remaining_seconds:
          activeIds.length > 0 ? Math.floor(Math.max(0, remainingMs) / activeIds.length / 1000) : null,
        budgeted_seconds_at_current_burn:
          activeIds.length > 0 ? Math.floor(budgetMs / activeIds.length / 1000) : null,
        pct_consumed: budgetMs > 0 ? Math.min(999, Math.round((totalWorkedMs / budgetMs) * 100)) : totalWorkedMs > 0 ? 100 : 0,
      };
    } else {
      const budgetNumerator = task.budget_cents * MS_PER_HOUR;
      // exact integer comparison whenever OT is off (all terms integral)
      const exhausted = numerator >= budgetNumerator;
      const remainingCents = task.budget_cents - consumedCents;
      snap = {
        budget_mode: 'money',
        budget_hours_ms: 0,
        budget_cents: task.budget_cents,
        consumed_cents: consumedCents,
        remaining_cents: remainingCents,
        over_budget_cents: Math.max(0, -remainingCents),
        consumed_person_ms: totalWorkedMs,
        remaining_person_ms: null,
        over_budget_ms: 0,
        exhausted,
        remaining_seconds:
          burnRateCentsPerHour > 0
            ? Math.floor(Math.max(0, budgetNumerator - numerator) / burnRateCentsPerHour / 1000)
            : null,
        budgeted_seconds_at_current_burn:
          burnRateCentsPerHour > 0 ? Math.floor(budgetNumerator / burnRateCentsPerHour / 1000) : null,
        pct_consumed:
          task.budget_cents > 0
            ? Math.min(999, Math.round((consumedCents / task.budget_cents) * 100))
            : numerator > 0
              ? 100
              : 0,
      };
    }

    snapshots.set(task.id, {
      task_id: task.id,
      at_ms: nowMs,
      ...snap,
      burn_rate_cents_per_hour: Math.round(burnRateCentsPerHour),
      total_worked_ms: totalWorkedMs,
      active_employee_ids: activeIds,
      employees,
    });
  }

  return snapshots;
}

// Back-compat convenience for single-task computation (no cross-task OT
// interaction when given only one task's sessions).
function computeTaskSnapshot(task, sessions, nowMs, orgOverrides = {}) {
  return computeSnapshots([task], sessions, nowMs, orgOverrides).get(task.id);
}

// Consumption history for burn-down charts: piecewise-linear curve of
// consumed cents (or person-ms) over time, reconstructed exactly from the
// session records. Returns [{t, consumed_cents, consumed_person_ms}].
function computeHistory(task, sessions, nowMs, orgOverrides = {}, points = 120) {
  const times = new Set([nowMs]);
  for (const s of sessions) {
    times.add(s.clock_in_ms);
    times.add(s.clock_out_ms == null ? nowMs : s.clock_out_ms);
  }
  const sorted = [...times].filter((t) => t <= nowMs).sort((a, b) => a - b);
  if (!sorted.length) return [];
  // densify long gaps so the chart curve is smooth, then cap total points
  const first = sorted[0];
  const span = Math.max(1, nowMs - first);
  const step = span / points;
  const sampled = new Set(sorted);
  for (let t = first; t < nowMs; t += step) sampled.add(Math.round(t));
  const curve = [...sampled]
    .sort((a, b) => a - b)
    .map((t) => {
      // clamp sessions at the sample time: anything still running at t is
      // treated as open so the snapshot cuts it off at t
      const visible = sessions
        .filter((s) => s.clock_in_ms <= t)
        .map((s) => (s.clock_out_ms != null && s.clock_out_ms > t ? { ...s, clock_out_ms: null } : s));
      const snap = computeTaskSnapshot(task, visible, t, orgOverrides);
      return { t, consumed_cents: snap.consumed_cents, consumed_person_ms: snap.consumed_person_ms };
    });
  return curve;
}

module.exports = { computeSnapshots, computeTaskSnapshot, computeHistory, MS_PER_HOUR, MS_PER_DAY };
