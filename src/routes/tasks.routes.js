'use strict';

const express = require('express');
const { redactForEmployee } = require('../sse');
const { computeHistory } = require('../calc');

// keeps budget_cents * 3.6e6 comfortably inside Number.MAX_SAFE_INTEGER
const MAX_BUDGET_CENTS = 100_000_000_000; // $1 billion
const MAX_BUDGET_HOURS_MS = 1_000_000 * 3_600_000; // 1M person-hours

function parseBudgetCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_BUDGET_CENTS) return null;
  return Math.round(n);
}

function parseBudgetHoursMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_BUDGET_HOURS_MS) return null;
  return Math.round(n);
}

function intParam(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

module.exports = function taskRoutes({ data, store, auth, clock, org, audit, broadcast }) {
  const router = express.Router();

  // role-filtered state with embedded snapshots (initial paint before SSE connects)
  router.get('/', auth.requireAuth, async (req, res, next) => {
    try {
      const state = await store.allSnapshots();
      if (req.user.is_admin) return res.json(state);
      const tasks = state.tasks
        .filter((s) => s.assignees.some((a) => a.id === req.user.id))
        .map((s) => redactForEmployee(s, req.user.id));
      res.json({ tasks });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', auth.requireAdmin, async (req, res, next) => {
    try {
      const { name, budget_cents, budget_mode, budget_hours_ms, show_countdown_to_employees, project_id } =
        req.body || {};
      const mode = budget_mode === 'hours' ? 'hours' : 'money';
      const budget = mode === 'money' ? parseBudgetCents(budget_cents) : 0;
      const budgetHours = mode === 'hours' ? parseBudgetHoursMs(budget_hours_ms) : 0;
      if (!name || (mode === 'money' && budget == null) || (mode === 'hours' && budgetHours == null)) {
        return res.status(400).json({ error: 'name and a valid budget are required' });
      }
      if (project_id != null && !(await data.getProject(Number(project_id)))) {
        return res.status(400).json({ error: 'unknown project' });
      }
      const show = show_countdown_to_employees === undefined ? 1 : show_countdown_to_employees ? 1 : 0;
      const id = await data.insertTask({
        name: String(name),
        budget_cents: budget ?? 0,
        budget_mode: mode,
        budget_hours_ms: budgetHours ?? 0,
        show_countdown_to_employees: show,
        project_id: project_id != null ? Number(project_id) : null,
      });
      audit(req, 'task.create', 'task', id, { name: String(name), budget_mode: mode, budget_cents: budget, budget_hours_ms: budgetHours });
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
      const { name, budget_cents, budget_hours_ms, status, show_countdown_to_employees, project_id } = req.body || {};
      const fields = {};
      const changes = {};
      if (name != null) {
        fields.name = String(name);
        changes.name = { from: task.name, to: fields.name };
      }
      if (budget_cents != null) {
        const budget = parseBudgetCents(budget_cents);
        if (budget == null) return res.status(400).json({ error: 'invalid budget_cents' });
        fields.budget_cents = budget;
        changes.budget_cents = { from: task.budget_cents, to: budget };
      }
      if (budget_hours_ms != null) {
        const budgetHours = parseBudgetHoursMs(budget_hours_ms);
        if (budgetHours == null) return res.status(400).json({ error: 'invalid budget_hours_ms' });
        fields.budget_hours_ms = budgetHours;
        changes.budget_hours_ms = { from: task.budget_hours_ms, to: budgetHours };
      }
      if (status != null) {
        if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: 'invalid status' });
        fields.status = status;
        changes.status = { from: task.status, to: status };
      }
      if (show_countdown_to_employees != null) {
        fields.show_countdown_to_employees = show_countdown_to_employees ? 1 : 0;
        changes.show_countdown_to_employees = fields.show_countdown_to_employees;
      }
      if (project_id !== undefined) {
        if (project_id != null && !(await data.getProject(Number(project_id)))) {
          return res.status(400).json({ error: 'unknown project' });
        }
        fields.project_id = project_id != null ? Number(project_id) : null;
        changes.project_id = { from: task.project_id ?? null, to: fields.project_id };
      }
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to update' });
      await data.updateTask(task.id, fields);
      audit(req, 'task.update', 'task', task.id, changes);
      broadcast();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // permanent removal — history goes with it (archive keeps history instead)
  router.delete('/:id', auth.requireAdmin, async (req, res, next) => {
    try {
      const taskId = intParam(req.params.id);
      if (taskId == null) return res.status(400).json({ error: 'invalid task id' });
      const task = await data.getTask(taskId);
      if (!task) return res.status(404).json({ error: 'no such task' });
      await data.deleteTask(taskId);
      audit(req, 'task.delete', 'task', taskId, { name: task.name });
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
      const ids = req.body?.employee_ids;
      if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(i))) {
        return res.status(400).json({ error: 'employee_ids must be an array of integers' });
      }
      // task fetch + employee validation in one parallel burst
      const [task, ...found] = await Promise.all([data.getTask(taskId), ...ids.map((id) => data.getEmployee(id))]);
      if (!task) return res.status(404).json({ error: 'no such task' });
      const unknown = ids.filter((_, i) => !found[i]);
      if (unknown.length) {
        return res.status(400).json({ error: `unknown employee ids: ${unknown.join(', ')}` });
      }
      await data.replaceAssignments(task.id, ids, clock.now());
      audit(req, 'task.assignments', 'task', task.id, { employee_ids: ids });
      broadcast();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- corrections (admin): session listing, void, adjust -----------------
  router.get('/:id/sessions', auth.requireAdmin, async (req, res, next) => {
    try {
      const taskId = intParam(req.params.id);
      if (taskId == null) return res.status(400).json({ error: 'invalid task id' });
      const [rows, employees] = await Promise.all([data.getTaskSessions(taskId), data.getEmployees()]);
      const names = new Map(employees.map((e) => [e.id, e.name]));
      res.json(rows.map((s) => ({ ...s, employee_name: names.get(s.employee_id) || `#${s.employee_id}` })));
    } catch (err) {
      next(err);
    }
  });

  router.post('/sessions/:sessionId/void', auth.requireAdmin, async (req, res, next) => {
    try {
      const id = intParam(req.params.sessionId);
      if (id == null) return res.status(400).json({ error: 'invalid session id' });
      const session = await data.getSession(id);
      if (!session) return res.status(404).json({ error: 'no such session' });
      if (session.voided) return res.json({ ok: true, already: true });
      await data.voidSession(id);
      audit(req, 'session.void', 'session', id, {
        task_id: session.task_id,
        employee_id: session.employee_id,
        reason: String(req.body?.reason || ''),
      });
      broadcast();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // adjust = void the original and insert a corrected, closed copy — the
  // original row survives for the audit trail
  router.post('/sessions/:sessionId/adjust', auth.requireAdmin, async (req, res, next) => {
    try {
      const id = intParam(req.params.sessionId);
      if (id == null) return res.status(400).json({ error: 'invalid session id' });
      const session = await data.getSession(id);
      if (!session) return res.status(404).json({ error: 'no such session' });
      if (session.voided) return res.status(409).json({ error: 'session already voided' });
      const clockIn = Number(req.body?.clock_in_ms);
      const clockOut = Number(req.body?.clock_out_ms);
      if (!Number.isInteger(clockIn) || !Number.isInteger(clockOut) || clockOut < clockIn) {
        return res.status(400).json({ error: 'clock_in_ms and clock_out_ms (>= in) required' });
      }
      await data.voidSession(id);
      const newId = await data.insertSession({
        task_id: session.task_id,
        employee_id: session.employee_id,
        rate_cents_snapshot: session.rate_cents_snapshot,
        burdened_rate_cents_snapshot: session.burdened_rate_cents_snapshot ?? session.rate_cents_snapshot,
        clock_in_ms: clockIn,
        clock_out_ms: clockOut,
        corrected_from: id,
        note: String(req.body?.reason || ''),
        created_by: req.user.id,
      });
      audit(req, 'session.adjust', 'session', id, {
        replacement_id: newId,
        from: { in: session.clock_in_ms, out: session.clock_out_ms },
        to: { in: clockIn, out: clockOut },
        reason: String(req.body?.reason || ''),
      });
      broadcast();
      res.json({ ok: true, replacement_id: newId });
    } catch (err) {
      next(err);
    }
  });

  // ---- burn-down history ---------------------------------------------------
  router.get('/:id/history', auth.requireAdmin, async (req, res, next) => {
    try {
      const taskId = intParam(req.params.id);
      if (taskId == null) return res.status(400).json({ error: 'invalid task id' });
      const task = await data.getTask(taskId);
      if (!task) return res.status(404).json({ error: 'no such task' });
      const [sessions, calcOrg] = await Promise.all([data.getTaskSessions(taskId), org.calcOrg()]);
      const live = sessions.filter((s) => !s.voided).sort((a, b) => a.clock_in_ms - b.clock_in_ms);
      res.json({
        task_id: taskId,
        budget_mode: task.budget_mode,
        budget_cents: task.budget_cents,
        budget_hours_ms: task.budget_hours_ms,
        points: computeHistory(task, live, clock.now(), calcOrg),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
