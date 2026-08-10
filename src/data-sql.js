'use strict';

// Named data operations implemented over a SQL adapter (SQLite or direct
// Postgres). The same interface is implemented by data-supabase.js over the
// Supabase REST API — everything above this layer is backend-agnostic.

const EMPLOYEE_COLUMNS = 'id, name, username, hourly_rate_cents, is_admin';

function createSqlData(db) {
  return {
    // --- tasks ---
    getTask: (id) => db.get('SELECT * FROM tasks WHERE id = ?', [id]),
    getTasks: () => db.all('SELECT * FROM tasks ORDER BY id'),
    insertTask: async ({ name, budget_cents, show_countdown_to_employees }) =>
      (
        await db.get(
          'INSERT INTO tasks (name, budget_cents, show_countdown_to_employees) VALUES (?, ?, ?) RETURNING id',
          [name, budget_cents, show_countdown_to_employees]
        )
      ).id,
    deleteTask: (id) => db.run('DELETE FROM tasks WHERE id = ?', [id]), // cascades sessions/assignments
    async updateTask(id, fields) {
      const allowed = ['name', 'budget_cents', 'status', 'show_countdown_to_employees'];
      const updates = [];
      const params = [];
      for (const key of allowed) {
        if (fields[key] !== undefined) {
          updates.push(`${key} = ?`);
          params.push(fields[key]);
        }
      }
      if (updates.length) await db.run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
    },

    // --- employees ---
    getEmployees: () => db.all(`SELECT ${EMPLOYEE_COLUMNS} FROM employees ORDER BY name`),
    getEmployee: (id) => db.get(`SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE id = ?`, [id]),
    getEmployeeByUsername: (username) => db.get('SELECT * FROM employees WHERE username = ?', [username]),
    insertEmployee: async ({ name, username, password_hash, hourly_rate_cents, is_admin }) =>
      (
        await db.get(
          'INSERT INTO employees (name, username, password_hash, hourly_rate_cents, is_admin) VALUES (?, ?, ?, ?, ?) RETURNING id',
          [name, username, password_hash, hourly_rate_cents, is_admin]
        )
      ).id,
    async updateEmployee(id, fields) {
      const allowed = ['name', 'hourly_rate_cents', 'password_hash'];
      const updates = [];
      const params = [];
      for (const key of allowed) {
        if (fields[key] !== undefined) {
          updates.push(`${key} = ?`);
          params.push(fields[key]);
        }
      }
      if (updates.length) await db.run(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
    },
    countEmployees: async () => Number((await db.get('SELECT COUNT(*) AS n FROM employees')).n),
    countSessionsForEmployee: async (id) =>
      Number((await db.get('SELECT COUNT(*) AS n FROM sessions WHERE employee_id = ?', [id])).n),
    deleteEmployee: (id) => db.run('DELETE FROM employees WHERE id = ?', [id]),

    // --- assignments ---
    isAssigned: async (taskId, employeeId) =>
      !!(await db.get('SELECT 1 AS x FROM assignments WHERE task_id = ? AND employee_id = ?', [taskId, employeeId])),
    // closes open sessions of removed workers, then swaps the assignment set
    async replaceAssignments(taskId, employeeIds, nowMs) {
      await db.transaction(async (tx) => {
        const keep = new Set(employeeIds);
        const open = await tx.all(
          'SELECT id, employee_id, clock_in_ms FROM sessions WHERE task_id = ? AND clock_out_ms IS NULL',
          [taskId]
        );
        for (const s of open) {
          if (!keep.has(s.employee_id)) {
            await tx.run('UPDATE sessions SET clock_out_ms = ? WHERE id = ?', [Math.max(nowMs, s.clock_in_ms), s.id]);
          }
        }
        await tx.run('DELETE FROM assignments WHERE task_id = ?', [taskId]);
        for (const id of employeeIds) {
          await tx.run('INSERT INTO assignments (task_id, employee_id) VALUES (?, ?)', [taskId, id]);
        }
      });
    },

    // --- sessions ---
    getOpenSession: (employeeId) =>
      db.get('SELECT * FROM sessions WHERE employee_id = ? AND clock_out_ms IS NULL', [employeeId]),
    insertSession: async ({ task_id, employee_id, rate_cents_snapshot, clock_in_ms }) =>
      (
        await db.get(
          'INSERT INTO sessions (task_id, employee_id, rate_cents_snapshot, clock_in_ms) VALUES (?, ?, ?, ?) RETURNING id',
          [task_id, employee_id, rate_cents_snapshot, clock_in_ms]
        )
      ).id,
    closeSession: (id, outMs) => db.run('UPDATE sessions SET clock_out_ms = ? WHERE id = ?', [outMs, id]),

    // --- snapshot bundle: everything needed to compute task snapshots ---
    async getSnapshotBundle() {
      const [tasks, sessions, assignments, employeeNames] = await Promise.all([
        db.all('SELECT * FROM tasks ORDER BY id'),
        db.all('SELECT * FROM sessions ORDER BY clock_in_ms'),
        db.all(
          `SELECT a.task_id, e.id, e.name, e.hourly_rate_cents FROM assignments a
           JOIN employees e ON e.id = a.employee_id ORDER BY e.name`
        ),
        db.all('SELECT id, name FROM employees'),
      ]);
      return { tasks, sessions, assignments, employeeNames };
    },

    // --- settings ---
    getSetting: async (key) => (await db.get('SELECT value FROM settings WHERE key = ?', [key]))?.value,
    setSetting: (key, value) =>
      db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, value]
      ),

    // --- maintenance ---
    async wipeAll() {
      for (const table of ['sessions', 'assignments', 'tasks', 'employees', 'settings']) {
        await db.run(`DELETE FROM ${table}`);
      }
    },
    close: () => db.close(),
  };
}

module.exports = { createSqlData };
