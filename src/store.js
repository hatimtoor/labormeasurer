'use strict';

const { computeTaskSnapshot } = require('./calc');

// Thin data-access layer: prepared statements + snapshot assembly.
function createStore(db, clock) {
  const q = {
    task: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id'),
    taskSessions: db.prepare('SELECT * FROM sessions WHERE task_id = ? ORDER BY clock_in_ms'),
    assignees: db.prepare(
      `SELECT e.id, e.name, e.hourly_rate_cents FROM assignments a
       JOIN employees e ON e.id = a.employee_id WHERE a.task_id = ? ORDER BY e.name`
    ),
    assignedTaskIds: db.prepare('SELECT task_id FROM assignments WHERE employee_id = ?'),
    isAssigned: db.prepare('SELECT 1 FROM assignments WHERE task_id = ? AND employee_id = ?'),
    employees: db.prepare('SELECT id, name, username, hourly_rate_cents, is_admin FROM employees ORDER BY name'),
    employee: db.prepare('SELECT id, name, username, hourly_rate_cents, is_admin FROM employees WHERE id = ?'),
    openSessionForEmployee: db.prepare('SELECT * FROM sessions WHERE employee_id = ? AND clock_out_ms IS NULL'),
    insertSession: db.prepare(
      'INSERT INTO sessions (task_id, employee_id, rate_cents_snapshot, clock_in_ms) VALUES (?, ?, ?, ?)'
    ),
    closeSession: db.prepare('UPDATE sessions SET clock_out_ms = ? WHERE id = ?'),
  };

  function snapshot(taskId) {
    const task = q.task.get(taskId);
    if (!task) return null;
    const snap = computeTaskSnapshot(task, q.taskSessions.all(taskId), clock.now());
    const names = new Map(q.assignees.all(taskId).map((e) => [e.id, e]));
    // enrich employee lines with names for display (unknown = unassigned-but-worked)
    for (const line of snap.employees) {
      const emp = names.get(line.employee_id) || q.employee.get(line.employee_id);
      line.name = emp ? emp.name : `#${line.employee_id}`;
    }
    snap.name = task.name;
    snap.status = task.status;
    snap.show_countdown_to_employees = !!task.show_countdown_to_employees;
    snap.assignees = [...names.values()];
    return snap;
  }

  function allSnapshots() {
    return q.tasks.all().map((t) => snapshot(t.id));
  }

  return { q, snapshot, allSnapshots };
}

module.exports = { createStore };
