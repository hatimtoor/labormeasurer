'use strict';

const { computeTaskSnapshot } = require('./calc');

const EMPLOYEE_COLUMNS = 'id, name, username, hourly_rate_cents, is_admin';

// Async data-access layer over the db adapter (SQLite or Postgres).
function createStore(db, clock) {
  const q = {
    task: (id) => db.get('SELECT * FROM tasks WHERE id = ?', [id]),
    tasks: () => db.all('SELECT * FROM tasks ORDER BY id'),
    taskSessions: (taskId) => db.all('SELECT * FROM sessions WHERE task_id = ? ORDER BY clock_in_ms', [taskId]),
    assignees: (taskId) =>
      db.all(
        `SELECT e.id, e.name, e.hourly_rate_cents FROM assignments a
         JOIN employees e ON e.id = a.employee_id WHERE a.task_id = ? ORDER BY e.name`,
        [taskId]
      ),
    isAssigned: (taskId, employeeId) =>
      db.get('SELECT 1 AS x FROM assignments WHERE task_id = ? AND employee_id = ?', [taskId, employeeId]),
    employees: () => db.all(`SELECT ${EMPLOYEE_COLUMNS} FROM employees ORDER BY name`),
    employee: (id) => db.get(`SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE id = ?`, [id]),
    openSessionForEmployee: (employeeId) =>
      db.get('SELECT * FROM sessions WHERE employee_id = ? AND clock_out_ms IS NULL', [employeeId]),
    insertSession: (taskId, employeeId, rateCents, nowMs) =>
      db.get(
        'INSERT INTO sessions (task_id, employee_id, rate_cents_snapshot, clock_in_ms) VALUES (?, ?, ?, ?) RETURNING id',
        [taskId, employeeId, rateCents, nowMs]
      ),
    closeSession: (outMs, sessionId) =>
      db.run('UPDATE sessions SET clock_out_ms = ? WHERE id = ?', [outMs, sessionId]),
  };

  async function snapshot(taskId, taskRow = null) {
    const task = taskRow || (await q.task(taskId));
    if (!task) return null;
    const [sessions, assignees] = await Promise.all([q.taskSessions(task.id), q.assignees(task.id)]);
    const snap = computeTaskSnapshot(task, sessions, clock.now());
    const names = new Map(assignees.map((e) => [e.id, e]));
    for (const line of snap.employees) {
      const emp = names.get(line.employee_id) || (await q.employee(line.employee_id));
      line.name = emp ? emp.name : `#${line.employee_id}`;
    }
    snap.name = task.name;
    snap.status = task.status;
    snap.show_countdown_to_employees = !!task.show_countdown_to_employees;
    snap.assignees = assignees;
    return snap;
  }

  async function allSnapshots() {
    const tasks = await q.tasks();
    return Promise.all(tasks.map((t) => snapshot(t.id, t)));
  }

  return { q, snapshot, allSnapshots };
}

module.exports = { createStore };
