'use strict';

// Drift-free countdown rendering. The client NEVER decrements a counter:
// every tick recomputes from the last server snapshot plus a performance.now()
// delta since the snapshot was received. Immune to timer jitter, wall-clock
// changes, and server time-warps (a warp just produces a fresh snapshot).

const LM = (() => {
  const MS_PER_HOUR = 3_600_000;
  // task_id -> {snap, receivedAtPerf}
  const snapshots = new Map();
  let projects = [];

  // accepts the server payload {tasks, projects} or a bare task array
  function ingest(payload) {
    const receivedAtPerf = performance.now();
    const tasks = Array.isArray(payload) ? payload : payload.tasks || [];
    if (!Array.isArray(payload) && payload.projects) projects = payload.projects;
    const seen = new Set();
    for (const snap of tasks) {
      snapshots.set(snap.task_id, { snap, receivedAtPerf });
      seen.add(snap.task_id);
    }
    // full-state protocol: anything not in the payload no longer exists/visible
    for (const id of [...snapshots.keys()]) {
      if (!seen.has(id)) snapshots.delete(id);
    }
  }

  // Live numbers for a task right now, extrapolated from its snapshot.
  function liveState(taskId) {
    const entry = snapshots.get(taskId);
    if (!entry) return null;
    const { snap } = entry;
    if (snap.redacted) return { ...snap, live: false };

    const elapsedMs = performance.now() - entry.receivedAtPerf;
    const activeCount = (snap.active_employee_ids || []).length;
    const burn = snap.burn_rate_cents_per_hour;
    const extraCents = (burn * elapsedMs) / MS_PER_HOUR;
    const consumedCents = snap.consumed_cents + extraCents;

    if (snap.budget_mode === 'hours') {
      const consumedPersonMs = snap.consumed_person_ms + activeCount * elapsedMs;
      const remainingPersonMs = snap.budget_hours_ms - consumedPersonMs;
      const exhausted = snap.exhausted || remainingPersonMs <= 0;
      return {
        ...snap,
        live: activeCount > 0,
        consumed_cents_live: consumedCents,
        remaining_cents_live: 0,
        over_budget_cents_live: 0,
        consumed_person_ms_live: consumedPersonMs,
        remaining_person_ms_live: remainingPersonMs,
        over_budget_ms_live: Math.max(0, -remainingPersonMs),
        remaining_seconds_live:
          activeCount > 0 ? Math.max(0, remainingPersonMs / activeCount / 1000) : null,
        exhausted_live: exhausted,
        pct_consumed_live:
          snap.budget_hours_ms > 0
            ? Math.min(999, (consumedPersonMs / snap.budget_hours_ms) * 100)
            : consumedPersonMs > 0
              ? 100
              : 0,
      };
    }

    const remainingCents = snap.budget_cents - consumedCents;
    let remainingSeconds = null;
    if (burn > 0) {
      remainingSeconds = Math.max(0, snap.remaining_seconds - elapsedMs / 1000);
    }
    return {
      ...snap,
      live: burn > 0,
      consumed_cents_live: consumedCents,
      remaining_cents_live: remainingCents,
      over_budget_cents_live: Math.max(0, -remainingCents),
      consumed_person_ms_live: snap.consumed_person_ms + activeCount * elapsedMs,
      remaining_seconds_live: remainingSeconds,
      exhausted_live: snap.exhausted || (burn > 0 && remainingCents <= 0),
      // mirror the server: uncapped-to-999, and 0 for an untouched zero budget
      pct_consumed_live:
        snap.budget_cents > 0
          ? Math.min(999, (consumedCents / snap.budget_cents) * 100)
          : consumedCents > 0
            ? 100
            : 0,
    };
  }

  function fmtClock(totalSeconds) {
    if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '—:—:—';
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function fmtMoney(cents) {
    if (!Number.isFinite(cents)) return '$—';
    const sign = cents < 0 ? '−' : '';
    return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  function fmtHours(ms) {
    if (!Number.isFinite(ms)) return '— h';
    return `${(ms / MS_PER_HOUR).toFixed(2)} h`;
  }

  return {
    ingest,
    liveState,
    fmtClock,
    fmtMoney,
    fmtHours,
    snapshots,
    getProjects: () => projects,
  };
})();
