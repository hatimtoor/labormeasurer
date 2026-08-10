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

  // PostgREST silently caps result sets (default max-rows 1000). Session
  // history grows without bound, and a truncated read would silently
  // under-report consumed budget — so page through explicitly.
  const PAGE = 1000;
  async function fetchAllSessions() {
    const all = [];
    for (let from = 0; ; from += PAGE) {
      const rows = unwrap(
        await sb.from('sessions').select('*').order('clock_in_ms').order('id').range(from, from + PAGE - 1)
      );
      all.push(...rows);
      if (rows.length < PAGE) return all;
    }
  }

  const EMPLOYEE_COLUMNS = 'id, name, username, hourly_rate_cents, is_admin';

  return {
    // --- tasks ---
    getTask: async (id) => unwrap(await sb.from('tasks').select('*').eq('id', id).maybeSingle()) || undefined,
    getTasks: async () => unwrap(await sb.from('tasks').select('*').order('id')),
    insertTask: async (row) => unwrap(await sb.from('tasks').insert(row).select('id').single()).id,
    deleteTask: async (id) => {
      unwrap(await sb.from('tasks').delete().eq('id', id)); // FK cascade removes sessions/assignments
    },
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
    countSessionsForEmployee: async (id) => {
      const { count, error } = await sb
        .from('sessions')
        .select('id', { count: 'exact', head: true })
        .eq('employee_id', id);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    deleteEmployee: async (id) => {
      unwrap(await sb.from('employees').delete().eq('id', id));
    },

    // --- assignments ---
    isAssigned: async (taskId, employeeId) =>
      !!unwrap(
        await sb.from('assignments').select('task_id').eq('task_id', taskId).eq('employee_id', employeeId).maybeSingle()
      ),
    async replaceAssignments(taskId, employeeIds, nowMs) {
      // best-effort sequence (PostgREST has no multi-statement transactions);
      // order matters: close removed workers' sessions BEFORE touching rows.
      // Bulk close in one call; fall back to per-row clamped closes only if
      // the clock_out >= clock_in CHECK rejects the bulk value.
      const closeQuery = sb
        .from('sessions')
        .update({ clock_out_ms: nowMs })
        .eq('task_id', taskId)
        .is('clock_out_ms', null);
      try {
        // session-close and assignment-delete touch different tables — parallel
        const [closed, deleted] = await Promise.all([
          employeeIds.length ? closeQuery.not('employee_id', 'in', `(${employeeIds.join(',')})`) : closeQuery,
          sb.from('assignments').delete().eq('task_id', taskId),
        ]);
        unwrap(closed);
        unwrap(deleted);
        if (employeeIds.length) {
          unwrap(
            await sb.from('assignments').insert(employeeIds.map((employee_id) => ({ task_id: taskId, employee_id })))
          );
        }
        return;
      } catch (err) {
        // only the clock_out >= clock_in CHECK rejection (clock stepped
        // backwards) is recoverable via the per-row clamped path — anything
        // else (outage, auth, timeout) must propagate
        if (err.code !== '23514' && !/check constraint/i.test(String(err.message))) throw err;
        const open = unwrap(
          await sb.from('sessions').select('id, employee_id, clock_in_ms').eq('task_id', taskId).is('clock_out_ms', null)
        );
        const keep = new Set(employeeIds);
        for (const s of open) {
          if (!keep.has(s.employee_id)) {
            unwrap(await sb.from('sessions').update({ clock_out_ms: Math.max(nowMs, s.clock_in_ms) }).eq('id', s.id));
          }
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
        fetchAllSessions(),
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
      // PostgREST requires a filter on DELETE; match-all via always-true bounds
      unwrap(await sb.from('sessions').delete().gte('id', 0));
      unwrap(await sb.from('assignments').delete().gte('task_id', 0)); // composite PK, no id column
      unwrap(await sb.from('tasks').delete().gte('id', 0));
      unwrap(await sb.from('employees').delete().gte('id', 0));
      unwrap(await sb.from('settings').delete().neq('key', ''));
    },
    close: async () => {},
  };
}

module.exports = { createSupabaseData };
