'use strict';

const express = require('express');
const { redactForEmployee } = require('../sse');

// keeps budget_cents * 3.6e6 comfortably inside Number.MAX_SAFE_INTEGER
const MAX_BUDGET_CENTS = 100_000_000_000; // $1 billion

function parseBudgetCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_BUDGET_CENTS) return null;
  return Math.round(n);
}

function intParam(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

module.exports = function taskRoutes({ db, store, auth, clock, broadcast }) {
  const router = express.Router();

  // role-filtered list with embedded snapshots (initial paint before SSE connects)
  router.get('/', auth.requireAuth, (req, res) => {
    const snaps = store.allSnapshots();
    if (req.user.is_admin) return res.json(snaps);
    const mine = snaps
      .filter((s) => s.assignees.some((a) => a.id === req.user.id))
      .map((s) => redactForEmployee(s, req.user.id));
    res.json(mine);
  });

  router.post('/', auth.requireAdmin, (req, res) => {
    const { name, budget_cents, show_countdown_to_employees } = req.body || {};
    const budget = parseBudgetCents(budget_cents);
    if (!name || budget == null) {
      return res.status(400).json({ error: `name and budget_cents (0..${MAX_BUDGET_CENTS}) required` });
    }
    // same truthiness rule as PATCH; omitted field defaults to visible
    const show = show_countdown_to_employees === undefined ? 1 : show_countdown_to_employees ? 1 : 0;
    const info = db
      .prepare('INSERT INTO tasks (name, budget_cents, show_countdown_to_employees) VALUES (?, ?, ?)')
      .run(String(name), budget, show);
    broadcast();
    res.status(201).json({ id: info.lastInsertRowid });
  });

  router.patch('/:id', auth.requireAdmin, (req, res) => {
    const taskId = intParam(req.params.id);
    if (taskId == null) return res.status(400).json({ error: 'invalid task id' });
    const task = store.q.task.get(taskId);
    if (!task) return res.status(404).json({ error: 'no such task' });
    const { name, budget_cents, status, show_countdown_to_employees } = req.body || {};
    const updates = [];
    const params = [];
    if (name != null) { updates.push('name = ?'); params.push(String(name)); }
    if (budget_cents != null) {
      const budget = parseBudgetCents(budget_cents);
      if (budget == null) return res.status(400).json({ error: 'invalid budget_cents' });
      updates.push('budget_cents = ?'); params.push(budget);
    }
    if (status != null) {
      if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: 'invalid status' });
      updates.push('status = ?'); params.push(status);
    }
    if (show_countdown_to_employees != null) {
      updates.push('show_countdown_to_employees = ?'); params.push(show_countdown_to_employees ? 1 : 0);
    }
    if (!updates.length) return res.status(400).json({ error: 'nothing to update' });
    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params, task.id);
    broadcast();
    res.json({ ok: true });
  });

  // full-replace assignment set
  router.put('/:id/assignments', auth.requireAdmin, (req, res) => {
    const task = store.q.task.get(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'no such task' });
    const ids = req.body?.employee_ids;
    if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(i))) {
      return res.status(400).json({ error: 'employee_ids must be an array of integers' });
    }
    const unknown = ids.filter((id) => !store.q.employee.get(id));
    if (unknown.length) {
      return res.status(400).json({ error: `unknown employee ids: ${unknown.join(', ')}` });
    }
    const replace = db.transaction(() => {
      // a worker removed from the task must not keep an open session silently
      // draining the budget (and blocking them from clocking in elsewhere)
      const keep = new Set(ids);
      const openSessions = db
        .prepare('SELECT id, employee_id, clock_in_ms FROM sessions WHERE task_id = ? AND clock_out_ms IS NULL')
        .all(task.id);
      for (const s of openSessions) {
        if (!keep.has(s.employee_id)) store.q.closeSession.run(Math.max(clock.now(), s.clock_in_ms), s.id);
      }
      db.prepare('DELETE FROM assignments WHERE task_id = ?').run(task.id);
      const insert = db.prepare('INSERT INTO assignments (task_id, employee_id) VALUES (?, ?)');
      for (const id of ids) insert.run(task.id, id);
    });
    replace();
    broadcast();
    res.json({ ok: true });
  });

  return router;
};
