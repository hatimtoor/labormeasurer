'use strict';

const express = require('express');
const { MS_PER_HOUR } = require('../calc');

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => c.label).join(',');
  const lines = rows.map((r) => columns.map((c) => csvEscape(c.value(r))).join(','));
  return `${header}\n${lines.join('\n')}\n`;
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

module.exports = function reportRoutes({ data, store, auth, clock }) {
  const router = express.Router();

  // one row per work session in the window (corrections resolved: voided
  // sessions excluded, replacements included)
  router.get('/sessions.csv', auth.requireAdmin, async (req, res, next) => {
    try {
      const from = Number(req.query.from_ms) || 0;
      const to = Number(req.query.to_ms) || clock.now();
      const bundle = await data.getSnapshotBundle();
      const names = new Map(bundle.employeeNames.map((e) => [e.id, e.name]));
      const taskNames = new Map(bundle.tasks.map((t) => [t.id, t.name]));
      const rows = bundle.sessions
        .filter((s) => s.clock_in_ms < to && (s.clock_out_ms == null || s.clock_out_ms > from))
        .map((s) => {
          const end = s.clock_out_ms == null ? clock.now() : s.clock_out_ms;
          const ms = Math.max(0, end - s.clock_in_ms);
          const rate = s.burdened_rate_cents_snapshot ?? s.rate_cents_snapshot;
          return {
            task: taskNames.get(s.task_id) || `#${s.task_id}`,
            employee: names.get(s.employee_id) || `#${s.employee_id}`,
            clock_in: new Date(s.clock_in_ms).toISOString(),
            clock_out: s.clock_out_ms == null ? '(open)' : new Date(s.clock_out_ms).toISOString(),
            hours: (ms / MS_PER_HOUR).toFixed(4),
            wage_rate: (s.rate_cents_snapshot / 100).toFixed(2),
            burdened_rate: (rate / 100).toFixed(2),
            cost: (Math.round((rate * ms) / MS_PER_HOUR) / 100).toFixed(2),
          };
        });
      sendCsv(
        res,
        'sessions.csv',
        toCsv(rows, [
          { label: 'Task', value: (r) => r.task },
          { label: 'Employee', value: (r) => r.employee },
          { label: 'Clock in (UTC)', value: (r) => r.clock_in },
          { label: 'Clock out (UTC)', value: (r) => r.clock_out },
          { label: 'Hours', value: (r) => r.hours },
          { label: 'Wage $/hr', value: (r) => r.wage_rate },
          { label: 'Burdened $/hr', value: (r) => r.burdened_rate },
          { label: 'Cost $', value: (r) => r.cost },
        ])
      );
    } catch (err) {
      next(err);
    }
  });

  // one row per task: budget vs actual
  router.get('/tasks.csv', auth.requireAdmin, async (_req, res, next) => {
    try {
      const { tasks } = await store.allSnapshots();
      sendCsv(
        res,
        'tasks.csv',
        toCsv(tasks, [
          { label: 'Task', value: (t) => t.name },
          { label: 'Status', value: (t) => t.status },
          { label: 'Budget mode', value: (t) => t.budget_mode },
          { label: 'Budget $', value: (t) => (t.budget_cents / 100).toFixed(2) },
          { label: 'Budget person-hours', value: (t) => (t.budget_hours_ms / MS_PER_HOUR).toFixed(2) },
          { label: 'Consumed $', value: (t) => (t.consumed_cents / 100).toFixed(2) },
          {
            label: 'Remaining $',
            value: (t) => (t.remaining_cents != null ? (t.remaining_cents / 100).toFixed(2) : ''),
          },
          { label: 'Hours worked', value: (t) => (t.total_worked_ms / MS_PER_HOUR).toFixed(2) },
          { label: '% consumed', value: (t) => t.pct_consumed },
          { label: 'Over budget $', value: (t) => (t.over_budget_cents / 100).toFixed(2) },
          { label: 'Crew now', value: (t) => t.active_employee_ids.length },
          { label: 'Crew $/hr', value: (t) => (t.burn_rate_cents_per_hour / 100).toFixed(2) },
        ])
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
};
