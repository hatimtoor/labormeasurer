'use strict';

const { createClient } = require('@supabase/supabase-js');

// Supabase REST implementation of the data interface (see data-sql.js).
// Uses the service-role key — this code runs only on the server; the key must
// never reach a browser. Caveat vs the SQL backends: replaceAssignments is a
// sequence of REST calls, not a single transaction.

function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message);
    err.code = error.code; // '23505' on unique violations, matching pg
    throw err;
  }
  return data;
}

function createSupabaseData(projectUrl, serviceRoleKey) {
  const sb = createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const EMPLOYEE_COLUMNS = 'id, name, username, hourly_rate_cents, is_admin';

  return {
    // --- tasks ---
    getTask: async (id) => unwrap(await sb.from('tasks').select('*').eq('id', id).maybeSingle()) || undefined,
    getTasks: async () => unwrap(await sb.from('tasks').select('*').order('id')),
    insertTask: async (row) => unwrap(await sb.from('tasks').insert(row).select('id').single()).id,
    async updateTask(id, fields) {
      const clean = {};
      for (const key of ['name', 'budget_cents', 'status', 'show_countdown_to_employees']) {
        if (fields[key] !== undefined) clean[key] = fields[key];
      }
      if (Object.keys(clean).length) unwrap(await sb.from('tasks').update(clean).eq('id', id));
    },

    // --- employees ---
    getEmployees: async () => unwrap(await sb.from('employees').select(EMPLOYEE_COLUMNS).order('name')),
    getEmployee: async (id) =>
      unwrap(await sb.from('employees').select(EMPLOYEE_COLUMNS).eq('id', id).maybeSingle()) || undefined,
    getEmployeeByUsername: async (username) =>
      unwrap(await sb.from('employees').select('*').eq('username', username).maybeSingle()) || undefined,
    insertEmployee: async (row) => unwrap(await sb.from('employees').insert(row).select('id').single()).id,
    async updateEmployee(id, fields) {
      const clean = {};
      for (const key of ['name', 'hourly_rate_cents', 'password_hash']) {
        if (fields[key] !== undefined) clean[key] = fields[key];
      }
      if (Object.keys(clean).length) unwrap(await sb.from('employees').update(clean).eq('id', id));
    },
    countEmployees: async () => {
      const { count, error } = await sb.from('employees').select('id', { count: 'exact', head: true });
      if (error) throw new Error(error.message);
      return count ?? 0;
    },

    // --- assignments ---
    isAssigned: async (taskId, employeeId) =>
      !!unwrap(
        await sb.from('assignments').select('task_id').eq('task_id', taskId).eq('employee_id', employeeId).maybeSingle()
      ),
    async replaceAssignments(taskId, employeeIds, nowMs) {
      // best-effort sequence (PostgREST has no multi-statement transactions);
      // order matters: close removed workers' sessions BEFORE touching rows
      const keep = new Set(employeeIds);
      const open = unwrap(
        await sb.from('sessions').select('id, employee_id, clock_in_ms').eq('task_id', taskId).is('clock_out_ms', null)
      );
      for (const s of open) {
        if (!keep.has(s.employee_id)) {
          unwrap(
            await sb.from('sessions').update({ clock_out_ms: Math.max(nowMs, s.clock_in_ms) }).eq('id', s.id)
          );
        }
      }
      unwrap(await sb.from('assignments').delete().eq('task_id', taskId));
      if (employeeIds.length) {
        unwrap(
          await sb.from('assignments').insert(employeeIds.map((employee_id) => ({ task_id: taskId, employee_id })))
        );
      }
    },

    // --- sessions ---
    getOpenSession: async (employeeId) =>
      unwrap(await sb.from('sessions').select('*').eq('employee_id', employeeId).is('clock_out_ms', null).maybeSingle()) ||
      undefined,
    insertSession: async (row) => unwrap(await sb.from('sessions').insert(row).select('id').single()).id,
    closeSession: async (id, outMs) => {
      unwrap(await sb.from('sessions').update({ clock_out_ms: outMs }).eq('id', id));
    },

    // --- snapshot bundle ---
    async getSnapshotBundle() {
      const [tasks, sessions, assignmentRows, employeeNames] = await Promise.all([
        sb.from('tasks').select('*').order('id').then(unwrap),
        sb.from('sessions').select('*').order('clock_in_ms').then(unwrap),
        sb.from('assignments').select('task_id, employees(id, name, hourly_rate_cents)').then(unwrap),
        sb.from('employees').select('id, name').then(unwrap),
      ]);
      const assignments = assignmentRows
        .map((r) => ({
          task_id: r.task_id,
          id: r.employees.id,
          name: r.employees.name,
          hourly_rate_cents: r.employees.hourly_rate_cents,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { tasks, sessions, assignments, employeeNames };
    },

    // --- settings ---
    getSetting: async (key) =>
      (unwrap(await sb.from('settings').select('value').eq('key', key).maybeSingle()) || undefined)?.value,
    setSetting: async (key, value) => {
      unwrap(await sb.from('settings').upsert({ key, value }));
    },

    // --- maintenance ---
    async wipeAll() {
      for (const table of ['sessions', 'assignments', 'tasks', 'employees', 'settings']) {
        const keyCol = table === 'settings' ? 'key' : 'id';
        unwrap(await sb.from(table).delete().neq(keyCol, table === 'settings' ? '' : -1));
      }
    },
    close: async () => {},
  };
}

module.exports = { createSupabaseData };
