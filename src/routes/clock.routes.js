'use strict';

const express = require('express');
const { isUniqueViolation } = require('../db');

module.exports = function clockRoutes({ data, auth, clock, org, audit, broadcast }) {
  const router = express.Router();

  // Determines who is being clocked in/out and validates permission for it.
  // Returns null after writing the error response.
  function resolveTargetId(req, res) {
    if (req.body?.employee_id == null) return req.user.id;
    if (!req.user.is_admin) {
      res.status(403).json({ error: 'only admins may clock others in/out' });
      return null;
    }
    const id = Number(req.body.employee_id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'invalid employee_id' });
      return null;
    }
    return id;
  }

  router.post('/:id/clock-in', auth.requireAuth, async (req, res, next) => {
    try {
      const taskId = Number(req.params.id);
      const targetId = resolveTargetId(req, res);
      if (targetId == null) return;

      // one parallel burst — REST round-trips dominate latency on Supabase
      const [task, employee, assigned, open] = await Promise.all([
        data.getTask(taskId),
        data.getEmployee(targetId),
        data.isAssigned(taskId, targetId),
        data.getOpenSession(targetId),
      ]);
      if (!task) return res.status(404).json({ error: 'no such task' });
      if (task.status !== 'active') return res.status(409).json({ error: 'task is archived' });
      if (!employee) return res.status(404).json({ error: 'no such employee' });
      if (!req.user.is_admin && !assigned) {
        return res.status(403).json({ error: 'not assigned to this task' });
      }
      if (open) {
        if (open.task_id === task.id) {
          // idempotent double clock-in
          return res.json({ ok: true, session_id: open.id, already: true });
        }
        return res.status(409).json({ error: 'already clocked into another task', open_task_id: open.task_id });
      }

      let sessionId;
      try {
        sessionId = await data.insertSession({
          task_id: task.id,
          employee_id: employee.id,
          rate_cents_snapshot: employee.hourly_rate_cents,
          // true labor cost: wage × org burden multiplier, frozen at clock-in
          burdened_rate_cents_snapshot: await org.burdenedRate(employee.hourly_rate_cents),
          clock_in_ms: clock.now(),
          created_by: req.user.id,
        });
      } catch (err) {
        // ux_open_session partial unique index — lost a race with a concurrent clock-in
        if (isUniqueViolation(err)) {
          return res.status(409).json({ error: 'already clocked in' });
        }
        throw err;
      }
      if (employee.id !== req.user.id) {
        audit(req, 'clock.in_for', 'employee', employee.id, { task_id: task.id });
      }
      broadcast();
      res.status(201).json({ ok: true, session_id: sessionId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/clock-out', auth.requireAuth, async (req, res, next) => {
    try {
      const taskId = Number(req.params.id);
      const targetId = resolveTargetId(req, res);
      if (targetId == null) return;

      const [task, employee, open] = await Promise.all([
        data.getTask(taskId),
        data.getEmployee(targetId),
        data.getOpenSession(targetId),
      ]);
      if (!task) return res.status(404).json({ error: 'no such task' });
      if (!employee) return res.status(404).json({ error: 'no such employee' });
      if (!open || open.task_id !== task.id) {
        // idempotent no-op
        return res.json({ ok: true, already: true });
      }
      // clamp so an NTP step backwards can never violate clock_out >= clock_in
      await data.closeSession(open.id, Math.max(clock.now(), open.clock_in_ms));
      if (employee.id !== req.user.id) {
        audit(req, 'clock.out_for', 'employee', employee.id, { task_id: task.id });
      }
      broadcast();
      res.json({ ok: true, session_id: open.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
