'use strict';

// SSE hub: one global stream, full-state snapshots (no deltas, no replay).
// Payload shape: admins get {tasks, projects}; employees get {tasks} filtered
// to their assignments with compensation data redacted server-side.
// The hub also runs the threshold-alert engine on every broadcast.

function redactForEmployee(snap, employeeId) {
  if (snap.show_countdown_to_employees) {
    // Employee may see the countdown and aggregates, but never a CO-WORKER's
    // hourly rate or individual cost — that is compensation data.
    return {
      ...snap,
      employees: snap.employees.map((line) =>
        line.employee_id === employeeId
          ? line
          : {
              employee_id: line.employee_id,
              name: line.name,
              worked_ms: line.worked_ms,
              clocked_in: line.clocked_in,
            }
      ),
      assignees: snap.assignees.map((a) => (a.id === employeeId ? a : { id: a.id, name: a.name })),
    };
  }
  return {
    task_id: snap.task_id,
    at_ms: snap.at_ms,
    name: snap.name,
    status: snap.status,
    show_countdown_to_employees: false,
    redacted: true,
    active_employee_ids: snap.active_employee_ids,
    clocked_in: snap.active_employee_ids.includes(employeeId),
  };
}

function createSseHub(store, { data, org, audit } = {}) {
  const clients = new Set(); // {res, employeeId, isAdmin}
  let nextEventId = 1;

  function payloadFor(client, state) {
    if (client.isAdmin) return state;
    const tasks = state.tasks
      .filter((s) => s.assignees.some((a) => a.id === client.employeeId))
      .map((s) => redactForEmployee(s, client.employeeId));
    return { tasks };
  }

  function writeEvent(client, event, dataStr) {
    try {
      client.res.write(`id: ${nextEventId}\nevent: ${event}\ndata: ${dataStr}\n\n`);
    } catch {
      clients.delete(client);
    }
  }

  // ---- threshold alerts ----------------------------------------------------
  async function checkAlerts(state) {
    if (!data || !org) return;
    const { thresholds, webhookUrl } = await org.alertConfig();
    if (!thresholds.length) return;
    for (const task of state.tasks) {
      if (task.status !== 'active') continue;
      const pct = task.pct_consumed;
      const crossed = thresholds.filter((t) => pct >= t);
      const highest = crossed.length ? crossed[crossed.length - 1] : 0;
      const key = `alert_state_${task.task_id}`;
      const prev = Number((await data.getSetting(key)) ?? 0);
      if (highest > prev) {
        await data.setSetting(key, String(highest));
        const alert = {
          task_id: task.task_id,
          task_name: task.name,
          threshold: highest,
          pct_consumed: pct,
          remaining_cents: task.remaining_cents,
          at_ms: Date.now(),
        };
        // in-app: push to admin clients
        nextEventId += 1;
        const payload = JSON.stringify(alert);
        for (const client of [...clients]) {
          if (client.isAdmin) writeEvent(client, 'alert', payload);
        }
        if (audit) audit(null, 'alert.threshold', 'task', task.task_id, alert);
        // webhook: fire-and-forget POST
        if (webhookUrl) {
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'labor_budget_threshold', ...alert }),
          }).catch((err) => console.error('alert webhook failed:', err.message));
        }
      } else if (highest < prev) {
        // budget raised / consumption corrected downward — re-arm
        await data.setSetting(key, String(highest));
      }
    }
  }

  // fire-and-forget from mutation routes; errors must never crash a request.
  // Coalesced: bursts of mutations trigger one snapshot fetch ~50ms later.
  let broadcastTimer = null;
  function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      nextEventId += 1;
      store
        .allSnapshots()
        .then((state) => {
          for (const client of [...clients]) {
            writeEvent(client, 'snapshot', JSON.stringify(payloadFor(client, state)));
          }
          return checkAlerts(state);
        })
        .catch((err) => console.error('broadcast failed:', err.message));
    }, 50);
  }

  const MAX_CONNECTIONS_PER_USER = 5;

  function handler(req, res) {
    // cap per-user streams; drop the oldest so a reconnect storm can't leak fds
    const mine = [...clients].filter((c) => c.employeeId === req.user.id);
    if (mine.length >= MAX_CONNECTIONS_PER_USER) {
      const oldest = mine[0];
      try { oldest.res.end(); } catch { /* already gone */ }
      clients.delete(oldest);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const client = { res, employeeId: req.user.id, isAdmin: !!req.user.is_admin };
    clients.add(client);
    nextEventId += 1;
    store
      .allSnapshots()
      .then((state) => writeEvent(client, 'init', JSON.stringify(payloadFor(client, state))))
      .catch((err) => console.error('sse init failed:', err.message));

    req.on('close', () => clients.delete(client));
  }

  // heartbeat uses REAL time (infrastructure, not domain time)
  const heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      try {
        client.res.write(':hb\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, 15000);
  heartbeat.unref();

  return { handler, broadcast, clientCount: () => clients.size };
}

module.exports = { createSseHub, redactForEmployee };
