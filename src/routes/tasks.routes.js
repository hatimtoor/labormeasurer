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

module.exports = function taskRoutes({ data, store, auth, clock, broadcast }) {
  const router = express.Router();

  // role-filtered list with embedded snapshots (initial paint before SSE connects)
  router.get('/', auth.requireAuth, async (req, res, next) => {
    try {
      const snaps = await store.allSnapshots();
      if (req.user.is_admin) return res.json(snaps);
      const mine = snaps
        .filter((s) => s.assignees.some((a) => a.id === req.user.id))
        .map((s) => redactForEmployee(s, req.user.id));
      res.json(mine);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', auth.requireAdmin, async (req, res, next) => {
    try {
      const { name, budget_cents, show_countdown_to_employees } = req.body || {};
      const budget = parseBudgetCents(budget_cents);
      if (!name || budget == null) {
        return res.status(400).json({ error: `name and budget_cents (0..${MAX_BUDGET_CENTS}) required` });
      }
      // same truthiness rule as PATCH; omitted field defaults to visible
      const show = show_countdown_to_employees === undefined ? 1 : show_countdown_to_employees ? 1 : 0;
      const id = await data.insertTask({
        name: String(name),
        budget_cents: budget,
        show_countdown_to_employees: show,
      });
      broadcast();
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', auth.requireAdmin, async (req, res, next) => {
    try {
      const taskId = intParam(req.params.id);
      if (taskId == null) return res.status(400).json({ error: 'invalid task id' });
      const task = await data.getTask(taskId);
      if (!task) return res.status(404).json({ error: 'no such task' });
      const { name, budget_cents, status, show_countdown_to_employees } = req.body || {};
      const fields = {};
      if (name != null) fields.name = String(name);
      if (budget_cents != null) {
        const budget = parseBudgetCents(budget_cents);
        if (budget == null) return res.status(400).json({ error: 'invalid budget_cents' });
        fields.budget_cents = budget;
      }
      if (status != null) {
        if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: 'invalid status' });
        fields.status = status;
      }
      if (show_countdown_to_employees != null) {
        fields.show_countdown_to_employees = show_countdown_to_employees ? 1 : 0;
      }
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to update' });
      await data.updateTask(task.id, fields);
      broadcast();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // full-replace assignment set; closes open sessions of removed workers
  router.put('/:id/assignments', auth.requireAdmin, async (req, res, next) => {
    try {
      const taskId = intParam(req.params.id);
      if (taskId == null) return res.status(400).json({ error: 'invalid task id' });
      const task = await data.getTask(taskId);
      if (!task) return res.status(404).json({ error: 'no such task' });
      const ids = req.body?.employee_ids;
      if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(i))) {
        return res.status(400).json({ error: 'employee_ids must be an array of integers' });
      }
      const unknown = [];
      for (const id of ids) {
        if (!(await data.getEmployee(id))) unknown.push(id);
      }
      if (unknown.length) {
        return res.status(400).json({ error: `unknown employee ids: ${unknown.join(', ')}` });
      }
      await data.replaceAssignments(task.id, ids, clock.now());
      broadcast();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
