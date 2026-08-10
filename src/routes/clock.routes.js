'use strict';

const express = require('express');
const { isUniqueViolation } = require('../db');

module.exports = function clockRoutes({ store, auth, clock, broadcast }) {
  const router = express.Router();

  async function resolveTarget(req, res) {
    let employeeId = req.user.id;
    if (req.body?.employee_id != null) {
      if (!req.user.is_admin) {
        res.status(403).json({ error: 'only admins may clock others in/out' });
        return null;
      }
      employeeId = Number(req.body.employee_id);
      if (!Number.isInteger(employeeId)) {
        res.status(400).json({ error: 'invalid employee_id' });
        return null;
      }
    }
    const employee = await store.q.employee(employeeId);
    if (!employee) {
      res.status(404).json({ error: 'no such employee' });
      return null;
    }
    return employee;
  }

  router.post('/:id/clock-in', auth.requireAuth, async (req, res, next) => {
    try {
      const task = await store.q.task(Number(req.params.id));
      if (!task) return res.status(404).json({ error: 'no such task' });
      if (task.status !== 'active') return res.status(409).json({ error: 'task is archived' });
      const employee = await resolveTarget(req, res);
      if (!employee) return;
      if (!req.user.is_admin && !(await store.q.isAssigned(task.id, employee.id))) {
        return res.status(403).json({ error: 'not assigned to this task' });
      }

      const open = await store.q.openSessionForEmployee(employee.id);
      if (open) {
        if (open.task_id === task.id) {
          // idempotent double clock-in
          return res.json({ ok: true, session_id: open.id, already: true });
        }
        return res.status(409).json({ error: 'already clocked into another task', open_task_id: open.task_id });
      }

      let row;
      try {
        row = await store.q.insertSession(task.id, employee.id, employee.hourly_rate_cents, clock.now());
      } catch (err) {
        // ux_open_session partial unique index — lost a race with a concurrent clock-in
        if (isUniqueViolation(err)) {
          return res.status(409).json({ error: 'already clocked in' });
        }
        throw err;
      }
      broadcast();
      res.status(201).json({ ok: true, session_id: row.id });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/clock-out', auth.requireAuth, async (req, res, next) => {
    try {
      const task = await store.q.task(Number(req.params.id));
      if (!task) return res.status(404).json({ error: 'no such task' });
      const employee = await resolveTarget(req, res);
      if (!employee) return;

      const open = await store.q.openSessionForEmployee(employee.id);
      if (!open || open.task_id !== task.id) {
        // idempotent no-op
        return res.json({ ok: true, already: true });
      }
      // clamp so an NTP step backwards can never violate clock_out >= clock_in
      await store.q.closeSession(Math.max(clock.now(), open.clock_in_ms), open.id);
      broadcast();
      res.json({ ok: true, session_id: open.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
