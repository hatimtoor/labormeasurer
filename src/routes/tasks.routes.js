'use strict';

const express = require('express');
const { redactForEmployee } = require('../sse');

module.exports = function taskRoutes({ db, store, auth, broadcast }) {
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
    const budget = Number(budget_cents);
    if (!name || !Number.isFinite(budget) || budget < 0) {
      return res.status(400).json({ error: 'name and non-negative budget_cents required' });
    }
    const info = db
      .prepare('INSERT INTO tasks (name, budget_cents, show_countdown_to_employees) VALUES (?, ?, ?)')
      .run(String(name), Math.round(budget), show_countdown_to_employees === false ? 0 : 1);
    broadcast();
    res.status(201).json({ id: info.lastInsertRowid });
  });

  router.patch('/:id', auth.requireAdmin, (req, res) => {
    const task = store.q.task.get(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'no such task' });
    const { name, budget_cents, status, show_countdown_to_employees } = req.body || {};
    const updates = [];
    const params = [];
    if (name != null) { updates.push('name = ?'); params.push(String(name)); }
    if (budget_cents != null) {
      const budget = Number(budget_cents);
      if (!Number.isFinite(budget) || budget < 0) return res.status(400).json({ error: 'invalid budget_cents' });
      updates.push('budget_cents = ?'); params.push(Math.round(budget));
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
    const replace = db.transaction(() => {
      db.prepare('DELETE FROM assignments WHERE task_id = ?').run(task.id);
      const insert = db.prepare('INSERT OR IGNORE INTO assignments (task_id, employee_id) VALUES (?, ?)');
      for (const id of ids) insert.run(task.id, id);
    });
    replace();
    broadcast();
    res.json({ ok: true });
  });

  return router;
};
