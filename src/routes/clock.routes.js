'use strict';

const express = require('express');

module.exports = function clockRoutes({ db, store, auth, clock, broadcast }) {
  const router = express.Router();

  function resolveTarget(req, res) {
    let employeeId = req.user.id;
    if (req.body?.employee_id != null) {
      if (!req.user.is_admin) {
        res.status(403).json({ error: 'only admins may clock others in/out' });
        return null;
      }
      employeeId = Number(req.body.employee_id);
    }
    const employee = store.q.employee.get(employeeId);
    if (!employee) {
      res.status(404).json({ error: 'no such employee' });
      return null;
    }
    return employee;
  }

  router.post('/:id/clock-in', auth.requireAuth, (req, res) => {
    const task = store.q.task.get(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'no such task' });
    if (task.status !== 'active') return res.status(409).json({ error: 'task is archived' });
    const employee = resolveTarget(req, res);
    if (!employee) return;
    if (!req.user.is_admin && !store.q.isAssigned.get(task.id, employee.id)) {
      return res.status(403).json({ error: 'not assigned to this task' });
    }

    const open = store.q.openSessionForEmployee.get(employee.id);
    if (open) {
      if (open.task_id === task.id) {
        // idempotent double clock-in
        return res.json({ ok: true, session_id: open.id, already: true });
      }
      return res.status(409).json({ error: 'already clocked into another task', open_task_id: open.task_id });
    }

    const info = store.q.insertSession.run(task.id, employee.id, employee.hourly_rate_cents, clock.now());
    broadcast();
    res.status(201).json({ ok: true, session_id: info.lastInsertRowid });
  });

  router.post('/:id/clock-out', auth.requireAuth, (req, res) => {
    const task = store.q.task.get(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'no such task' });
    const employee = resolveTarget(req, res);
    if (!employee) return;

    const open = store.q.openSessionForEmployee.get(employee.id);
    if (!open || open.task_id !== task.id) {
      // idempotent no-op
      return res.json({ ok: true, already: true });
    }
    store.q.closeSession.run(clock.now(), open.id);
    broadcast();
    res.json({ ok: true, session_id: open.id });
  });

  return router;
};
