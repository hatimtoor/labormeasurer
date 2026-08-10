'use strict';

const { computeTaskSnapshot } = require('./calc');

// Snapshot assembly on top of the backend-agnostic data interface.
function createStore(data, clock) {
  function buildSnapshot(task, bundle) {
    const sessions = bundle.sessions.filter((s) => s.task_id === task.id);
    const assignees = bundle.assignments
      .filter((a) => a.task_id === task.id)
      .map(({ id, name, hourly_rate_cents }) => ({ id, name, hourly_rate_cents }));
    const names = new Map(bundle.employeeNames.map((e) => [e.id, e.name]));

    const snap = computeTaskSnapshot(task, sessions, clock.now());
    for (const line of snap.employees) {
      line.name = names.get(line.employee_id) || `#${line.employee_id}`;
    }
    snap.name = task.name;
    snap.status = task.status;
    snap.show_countdown_to_employees = !!task.show_countdown_to_employees;
    snap.assignees = assignees;
    return snap;
  }

  async function allSnapshots() {
    const bundle = await data.getSnapshotBundle();
    return bundle.tasks.map((t) => buildSnapshot(t, bundle));
  }

  async function snapshot(taskId) {
    const bundle = await data.getSnapshotBundle();
    const task = bundle.tasks.find((t) => t.id === taskId);
    return task ? buildSnapshot(task, bundle) : null;
  }

  return { snapshot, allSnapshots };
}

module.exports = { createStore };
