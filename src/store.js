'use strict';

const { computeSnapshots } = require('./calc');

// Snapshot assembly on top of the backend-agnostic data interface.
// Snapshots for all tasks are computed globally (cross-task overtime), then
// enriched with names/assignees; projects get money-mode rollups.
function createStore(data, clock, org) {
  async function allSnapshots() {
    const [bundle, calcOrg] = await Promise.all([data.getSnapshotBundle(), org.calcOrg()]);
    const nowMs = clock.now();
    const cores = computeSnapshots(bundle.tasks, bundle.sessions, nowMs, calcOrg);
    const names = new Map(bundle.employeeNames.map((e) => [e.id, e.name]));

    const tasks = bundle.tasks.map((task) => {
      const snap = cores.get(task.id);
      for (const line of snap.employees) {
        line.name = names.get(line.employee_id) || `#${line.employee_id}`;
      }
      snap.name = task.name;
      snap.status = task.status;
      snap.project_id = task.project_id ?? null;
      snap.show_countdown_to_employees = !!task.show_countdown_to_employees;
      snap.assignees = bundle.assignments
        .filter((a) => a.task_id === task.id)
        .map(({ id, name, hourly_rate_cents }) => ({ id, name, hourly_rate_cents }));
      return snap;
    });

    // project rollups (money-mode tasks only; hours-mode tasks contribute
    // burn/consumed dollars but no dollar budget)
    const projects = bundle.projects.map((p) => {
      const mine = tasks.filter((t) => t.project_id === p.id);
      const money = mine.filter((t) => t.budget_mode === 'money');
      const budget = money.reduce((sum, t) => sum + t.budget_cents, 0);
      const consumed = mine.reduce((sum, t) => sum + t.consumed_cents, 0);
      const burn = mine.reduce((sum, t) => sum + t.burn_rate_cents_per_hour, 0);
      const remaining = budget - money.reduce((sum, t) => sum + t.consumed_cents, 0);
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        task_count: mine.length,
        budget_cents: budget,
        consumed_cents: consumed,
        remaining_cents: remaining,
        burn_rate_cents_per_hour: burn,
        remaining_seconds: burn > 0 ? Math.floor(Math.max(0, remaining) / (burn / 3_600_000) / 1000) : null,
        at_ms: nowMs,
      };
    });

    return { tasks, projects };
  }

  async function snapshot(taskId) {
    const { tasks } = await allSnapshots();
    return tasks.find((t) => t.task_id === taskId) || null;
  }

  return { snapshot, allSnapshots };
}

module.exports = { createStore };
