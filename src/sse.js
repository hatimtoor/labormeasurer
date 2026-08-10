'use strict';

// SSE hub: one global stream, full-state snapshots (no deltas, no replay).
// Redaction happens server-side per role — hidden dollar figures never reach
// an employee's browser.

function redactForEmployee(snap, employeeId) {
  if (snap.show_countdown_to_employees) return snap;
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

function createSseHub(store) {
  const clients = new Set(); // {res, employeeId, isAdmin}
  let nextEventId = 1;

  function payloadFor(client, snaps) {
    const visible = client.isAdmin
      ? snaps
      : snaps
          .filter((s) => s.assignees.some((a) => a.id === client.employeeId))
          .map((s) => redactForEmployee(s, client.employeeId));
    return visible;
  }

  function writeEvent(client, event, data) {
    try {
      client.res.write(`id: ${nextEventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }

  function broadcast() {
    nextEventId += 1;
    const snaps = store.allSnapshots();
    for (const client of [...clients]) {
      writeEvent(client, 'snapshot', payloadFor(client, snaps));
    }
  }

  function handler(req, res) {
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
    writeEvent(client, 'init', payloadFor(client, store.allSnapshots()));

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
