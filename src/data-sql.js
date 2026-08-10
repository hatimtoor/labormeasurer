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
    insertTask: async (t) =>
      (
        await db.get(
          `INSERT INTO tasks (name, budget_cents, show_countdown_to_employees, budget_mode, budget_hours_ms, project_id)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            t.name,
            t.budget_cents ?? 0,
            t.show_countdown_to_employees ?? 1,
            t.budget_mode ?? 'money',
            t.budget_hours_ms ?? 0,
            t.project_id ?? null,
          ]
        )
      ).id,
    deleteTask: (id) => db.run('DELETE FROM tasks WHERE id = ?', [id]), // cascades sessions/assignments
    async updateTask(id, fields) {
      const allowed = ['name', 'budget_cents', 'status', 'show_countdown_to_employees', 'budget_hours_ms', 'project_id'];
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
          'SELECT id, employee_id, clock_in_ms FROM sessions WHERE task_id = ? AND clock_out_ms IS NULL AND voided = 0',
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
      db.get('SELECT * FROM sessions WHERE employee_id = ? AND clock_out_ms IS NULL AND voided = 0', [employeeId]),
    getSession: (id) => db.get('SELECT * FROM sessions WHERE id = ?', [id]),
    getTaskSessions: (taskId) =>
      db.all('SELECT * FROM sessions WHERE task_id = ? ORDER BY clock_in_ms DESC, id DESC LIMIT 200', [taskId]),
    insertSession: async (s) =>
      (
        await db.get(
          `INSERT INTO sessions (task_id, employee_id, rate_cents_snapshot, burdened_rate_cents_snapshot,
             clock_in_ms, clock_out_ms, corrected_from, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            s.task_id,
            s.employee_id,
            s.rate_cents_snapshot,
            s.burdened_rate_cents_snapshot ?? s.rate_cents_snapshot,
            s.clock_in_ms,
            s.clock_out_ms ?? null,
            s.corrected_from ?? null,
            s.note ?? null,
            s.created_by ?? null,
          ]
        )
      ).id,
    closeSession: (id, outMs) => db.run('UPDATE sessions SET clock_out_ms = ? WHERE id = ?', [outMs, id]),
    voidSession: (id) => db.run('UPDATE sessions SET voided = 1 WHERE id = ?', [id]),

    // --- auth sessions ---
    createAuthSession: (s) =>
      db.run('INSERT INTO auth_sessions (token_hash, employee_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)', [
        s.token_hash,
        s.employee_id,
        s.created_ms,
        s.expires_ms,
      ]),
    getAuthSession: (tokenHash) => db.get('SELECT * FROM auth_sessions WHERE token_hash = ?', [tokenHash]),
    revokeAuthSession: (tokenHash) =>
      db.run('UPDATE auth_sessions SET revoked = 1 WHERE token_hash = ?', [tokenHash]),
    revokeAllAuthSessionsFor: (employeeId) =>
      db.run('UPDATE auth_sessions SET revoked = 1 WHERE employee_id = ?', [employeeId]),

    // --- audit ---
    insertAudit: (a) =>
      db.run('INSERT INTO audit_log (at_ms, actor_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)', [
        a.at_ms,
        a.actor_id ?? null,
        a.action,
        a.entity,
        a.entity_id ?? null,
        a.details ?? null,
      ]),
    getAuditLog: (limit = 100) => db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit]),

    // --- projects ---
    getProjects: () => db.all('SELECT * FROM projects ORDER BY name'),
    getProject: (id) => db.get('SELECT * FROM projects WHERE id = ?', [id]),
    insertProject: async ({ name }) =>
      (await db.get('INSERT INTO projects (name) VALUES (?) RETURNING id', [name])).id,
    updateProject: async (id, fields) => {
      const updates = [];
      const params = [];
      for (const key of ['name', 'status']) {
        if (fields[key] !== undefined) {
          updates.push(`${key} = ?`);
          params.push(fields[key]);
        }
      }
      if (updates.length) await db.run(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
    },
    deleteProject: (id) => db.run('DELETE FROM projects WHERE id = ?', [id]),

    getAllSettings: async () => {
      const rows = await db.all('SELECT key, value FROM settings');
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },

    // --- snapshot bundle: everything needed to compute task snapshots ---
    async getSnapshotBundle() {
      const [tasks, sessions, assignments, employeeNames, projects] = await Promise.all([
        db.all('SELECT * FROM tasks ORDER BY id'),
        db.all('SELECT * FROM sessions WHERE voided = 0 ORDER BY clock_in_ms'),
        db.all(
          `SELECT a.task_id, e.id, e.name, e.hourly_rate_cents FROM assignments a
           JOIN employees e ON e.id = a.employee_id ORDER BY e.name`
        ),
        db.all('SELECT id, name FROM employees'),
        db.all('SELECT * FROM projects ORDER BY name'),
      ]);
      return { tasks, sessions, assignments, employeeNames, projects };
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
      for (const table of ['audit_log', 'auth_sessions', 'sessions', 'assignments', 'tasks', 'projects', 'employees', 'settings']) {
        await db.run(`DELETE FROM ${table}`);
      }
    },
    close: () => db.close(),
  };
}

module.exports = { createSqlData };
