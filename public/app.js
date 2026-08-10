'use strict';

/* SPA: login → tabbed admin view or employee view. State arrives via SSE
   full-state snapshots (LM.ingest). Cards fully rebuild ONLY when their
   snapshot/selection/roster changes; the 1 Hz tick just rewrites numbers
   in place — rebuilding DOM every second eats clicks and wipes UI state. */

let me = null;
let employees = []; // admin only
let employeesVersion = ''; // roster fingerprint
let rosterRev = 0; // bumped when the roster changes; part of the card signature
let eventSource = null;
let selectedTaskId = null; // clicked card highlight
let lastEmployeesFetch = 0;

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

function toast(message, isError = false) {
  let stack = $('#toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------- view switching ---------- */

function show(view) {
  for (const id of ['login-view', 'admin-view', 'employee-view']) $(`#${id}`).hidden = id !== view;
  $('#topbar').hidden = view === 'login-view';
}

async function boot() {
  try {
    me = await api('/api/me');
    enterApp();
  } catch {
    show('login-view');
  }
}

function enterApp() {
  $('#whoami').textContent = `${me.name}${me.is_admin ? ' (admin)' : ''}`;
  $('#warp-controls').hidden = !me.is_admin;
  $('#admin-tabs').hidden = !me.is_admin;
  show(me.is_admin ? 'admin-view' : 'employee-view');
  connectSse();
  refreshTasks();
  if (me.is_admin) refreshEmployees(true);
}

/* ---------- data ---------- */

// after a mutation: SSE broadcast delivers the update; only refetch when the
// stream is down, so mutations don't pay for a redundant GET round-trip
function syncTasks() {
  if (!eventSource || eventSource.readyState !== EventSource.OPEN) refreshTasks();
}

async function refreshTasks() {
  try {
    LM.ingest(await api('/api/tasks'));
    render();
  } catch (err) {
    if (err.status === 401) show('login-view');
  }
}

// throttled: SSE fires this on every snapshot, but the roster rarely changes
async function refreshEmployees(force = false) {
  if (!force && Date.now() - lastEmployeesFetch < 15000) return;
  lastEmployeesFetch = Date.now();
  employees = await api('/api/employees');
  const version = JSON.stringify(employees.map((e) => [e.id, e.name, e.hourly_rate_cents]));
  if (version !== employeesVersion) {
    employeesVersion = version;
    rosterRev += 1;
    renderEmployeeList();
    render(); // admin-control rosters inside cards depend on the roster
  }
}

function connectSse() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  const onSnap = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return; // malformed frame — next broadcast will resync
    }
    setConnectionState(true);
    LM.ingest(data);
    render();
    if (me?.is_admin) refreshEmployees().catch(() => {});
  };
  eventSource.addEventListener('init', onSnap);
  eventSource.addEventListener('snapshot', onSnap);
  eventSource.onerror = () => {
    setConnectionState(false);
    // A 401 (expired cookie, deleted user) closes the EventSource permanently —
    // without this the countdown would keep ticking on stale data forever.
    if (eventSource.readyState === EventSource.CLOSED) {
      setTimeout(async () => {
        try {
          await api('/api/me');
          connectSse();
          syncTasks();
        } catch {
          location.reload(); // session gone — back to login
        }
      }, 3000);
    }
  };
}

function setConnectionState(up) {
  let badge = $('#conn-badge');
  if (up) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'conn-badge';
    badge.className = 'badge conn-lost';
    badge.textContent = 'reconnecting…';
    $('#topbar .topbar-right').prepend(badge);
  }
}

/* ---------- rendering ---------- */

function render() {
  if (!me) return;
  const container = me.is_admin ? $('#task-cards') : $('#employee-tasks');
  if (!container) return;
  const ids = [...LM.snapshots.keys()];
  for (const id of ids) {
    let card = container.querySelector(`[data-task="${id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.dataset.task = id;
      // click (outside any control) selects/deselects the card
      card.addEventListener('click', (e) => {
        if (e.target.closest('button, input, label, details, summary, table')) return;
        const cardId = Number(card.dataset.task);
        selectedTaskId = selectedTaskId === cardId ? null : cardId;
        render();
      });
      container.appendChild(card);
    }
    updateCard(card, id);
  }
  for (const card of [...container.querySelectorAll('[data-task]')]) {
    if (!ids.includes(Number(card.dataset.task))) card.remove();
  }
}

function updateCard(card, taskId) {
  const s = LM.liveState(taskId);
  if (!s) return;

  // Structural signature: rebuild only when the underlying snapshot, the
  // selection, the roster, or the live exhausted state changes.
  const selected = taskId === selectedTaskId;
  const sig = `${s.at_ms}|${selected ? 1 : 0}|${s.redacted ? 1 : 0}|${s.exhausted_live ? 1 : 0}|${rosterRev}`;

  const typing =
    card.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';

  if (card.dataset.sig === sig || typing) {
    tickLive(card, s);
    card.classList.toggle('selected', selected);
    return;
  }
  card.dataset.sig = sig;

  if (s.redacted) {
    card.className = `task-card redacted${selected ? ' selected' : ''}`;
    card.innerHTML = `
      <div class="card-head"><h3>${esc(s.name)}</h3><span class="badge">countdown hidden</span></div>
      <p class="muted">Management has not shared the budget countdown for this task.</p>
      <div class="clock-actions"></div>`;
    renderClockButtons(card.querySelector('.clock-actions'), s);
    return;
  }

  const exhausted = s.exhausted_live;
  const activeCount = (s.active_employee_ids || []).length;
  const paused = activeCount === 0;
  const freeCrew = !paused && s.burn_rate_cents_per_hour === 0; // $0/hr workers clocked in
  const detailsWasOpen = card.querySelector('.admin-controls')?.open;

  card.className =
    `task-card${exhausted ? ' exhausted' : ''}${paused ? ' paused' : ''}` +
    `${s.status === 'archived' ? ' archived' : ''}${selected ? ' selected' : ''}`;

  const crew = s.employees.filter((e) => e.clocked_in);
  card.innerHTML = `
    <div class="card-head">
      <h3>${esc(s.name)}</h3>
      ${s.status === 'archived' ? '<span class="badge">archived</span>' : ''}
      ${!s.show_countdown_to_employees ? '<span class="badge">hidden from crew</span>' : ''}
    </div>
    <div class="banner-slot">${exhausted ? '<div class="exhausted-banner">⚠ LABOR BUDGET EXHAUSTED</div>' : ''}</div>
    <div class="countdown ${exhausted ? 'red' : paused ? 'gray' : 'green'}">
      ${exhausted ? '0:00:00' : freeCrew ? '∞' : LM.fmtClock(s.remaining_seconds_live)}
    </div>
    <div class="countdown-sub"></div>
    <div class="bar"><div class="bar-fill ${exhausted ? 'red' : ''}"></div></div>
    <div class="stats">
      <div><span class="muted">Budget</span><strong>${LM.fmtMoney(s.budget_cents)}</strong></div>
      <div><span class="muted">Used</span><strong data-live="used"></strong></div>
      <div><span class="muted">Remaining</span><strong data-live="remaining"></strong></div>
      <div><span class="muted">Used %</span><strong data-live="pct"></strong></div>
      <div><span class="muted">Crew now</span><strong>${crew.length}</strong></div>
      <div><span class="muted">Crew cost</span><strong>${LM.fmtMoney(s.burn_rate_cents_per_hour)}/hr</strong></div>
      <div><span class="muted">Hours worked</span><strong data-live="hours"></strong></div>
      <div><span class="muted">Budget hours @ crew</span><strong>${s.budgeted_seconds_at_current_burn != null ? LM.fmtClock(s.budgeted_seconds_at_current_burn) : '—'}</strong></div>
    </div>
    ${renderEmployeeTable(s)}
    <div class="clock-actions"></div>
    ${me.is_admin ? renderAdminControls(s) : ''}`;

  tickLive(card, s);
  renderClockButtons(card.querySelector('.clock-actions'), s);
  if (me.is_admin) {
    wireAdminControls(card, s);
    const details = card.querySelector('.admin-controls');
    if (details && detailsWasOpen) details.open = true;
  }
}

// per-second update of live numbers only — never touches DOM structure
function tickLive(card, s) {
  if (s.redacted) return;
  const exhausted = s.exhausted_live;
  const paused = (s.active_employee_ids || []).length === 0;
  const freeCrew = !paused && s.burn_rate_cents_per_hour === 0;

  const clock = card.querySelector('.countdown');
  if (clock) {
    clock.textContent = exhausted ? '0:00:00' : freeCrew ? '∞' : LM.fmtClock(s.remaining_seconds_live);
    clock.className = `countdown ${exhausted ? 'red' : paused ? 'gray' : 'green'}`;
  }
  const sub = card.querySelector('.countdown-sub');
  if (sub) {
    sub.innerHTML = exhausted
      ? `<span class="over">${LM.fmtMoney(-s.over_budget_cents_live)} over budget</span>`
      : paused
        ? 'paused — no one clocked in'
        : freeCrew
          ? 'crew clocked in at $0/hr — budget not burning'
          : `remaining at ${LM.fmtMoney(s.burn_rate_cents_per_hour)}/hr crew burn rate`;
  }
  const fill = card.querySelector('.bar-fill');
  if (fill) {
    fill.style.width = `${Math.min(100, s.pct_consumed_live).toFixed(1)}%`;
    fill.classList.toggle('red', exhausted);
  }
  const set = (key, value) => {
    const el = card.querySelector(`[data-live="${key}"]`);
    if (el) el.textContent = value;
  };
  set('used', LM.fmtMoney(Math.round(s.consumed_cents_live)));
  set('remaining', LM.fmtMoney(Math.round(s.remaining_cents_live)));
  const rem = card.querySelector('[data-live="remaining"]');
  if (rem) rem.classList.toggle('neg', s.remaining_cents_live < 0);
  set('pct', `${s.pct_consumed_live.toFixed(1)}%`);
  set('hours', LM.fmtHours(s.total_worked_ms + liveExtraMs(s)));
}

// actual worked ms keeps growing while people are clocked in
function liveExtraMs(s) {
  const entry = LM.snapshots.get(s.task_id);
  if (!entry) return 0;
  const active = (s.active_employee_ids || []).length;
  return active * Math.max(0, performance.now() - entry.receivedAtPerf);
}

function renderEmployeeTable(s) {
  if (!s.employees.length && !(s.assignees || []).length) return '';
  const workedRows = s.employees
    .map(
      (e) => `<tr class="${e.clocked_in ? 'active-row' : ''}">
        <td>${e.clocked_in ? '🟢' : '⚪'} ${esc(e.name)}</td>
        <td>${e.rate_cents_snapshot != null ? `${LM.fmtMoney(e.rate_cents_snapshot)}/hr` : '—'}</td>
        <td>${LM.fmtHours(e.worked_ms)}</td>
        <td>${e.cost_cents != null ? LM.fmtMoney(e.cost_cents) : '—'}</td>
      </tr>`
    )
    .join('');
  const workedIds = new Set(s.employees.map((e) => e.employee_id));
  const idleRows = (s.assignees || [])
    .filter((a) => !workedIds.has(a.id))
    .map(
      (a) => `<tr><td>⚪ ${esc(a.name)}</td><td>${a.hourly_rate_cents != null ? `${LM.fmtMoney(a.hourly_rate_cents)}/hr` : '—'}</td><td>0.00 h</td><td>$0.00</td></tr>`
    )
    .join('');
  return `<table class="emp-table">
    <thead><tr><th>Employee</th><th>Rate</th><th>Hours</th><th>Cost</th></tr></thead>
    <tbody>${workedRows}${idleRows}</tbody>
  </table>`;
}

function renderClockButtons(el, s) {
  if (!el) return;
  el.innerHTML = '';
  if (me.is_admin) return; // admins use per-employee controls below
  const mine = s.redacted ? s.clocked_in : (s.active_employee_ids || []).includes(me.id);
  const btn = document.createElement('button');
  btn.className = `btn big ${mine ? 'toggle-on' : 'primary'}`;
  btn.textContent = mine ? '● On the clock — press to clock OUT' : 'Clock IN';
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api(`/api/tasks/${s.task_id}/clock-${mine ? 'out' : 'in'}`, { method: 'POST' });
      syncTasks();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  };
  el.appendChild(btn);
}

/* ---------- admin controls per card ---------- */

function renderAdminControls(s) {
  const assigned = new Set((s.assignees || []).map((a) => a.id));
  const rows = employees
    .filter((e) => !e.is_admin)
    .map((e) => {
      const active = (s.active_employee_ids || []).includes(e.id);
      return `<div class="assign-row">
        <label class="check"><input type="checkbox" data-assign="${e.id}" ${assigned.has(e.id) ? 'checked' : ''}/> ${esc(e.name)} <span class="muted">(${LM.fmtMoney(e.hourly_rate_cents)}/hr)</span></label>
        ${
          assigned.has(e.id)
            ? `<button class="btn small ${active ? 'toggle-on' : ''}" data-clock="${e.id}" data-dir="${active ? 'out' : 'in'}">${active ? '● On clock — out' : 'Clock in'}</button>`
            : ''
        }
      </div>`;
    })
    .join('');
  return `<details class="admin-controls">
    <summary>Manage task</summary>
    <div class="assign-list">${rows || '<p class="muted small">No employees yet.</p>'}</div>
    <div class="inline-form">
      <input type="number" min="0" step="0.01" data-budget placeholder="New budget ($)" />
      <button class="btn small" data-set-budget>Set budget</button>
    </div>
    <label class="check"><input type="checkbox" data-show-countdown ${s.show_countdown_to_employees ? 'checked' : ''}/> Crew can see countdown</label>
    <div class="inline-form">
      <button class="btn small" data-archive>${s.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
      <button class="btn small danger" data-delete>Delete task</button>
    </div>
  </details>`;
}

function wireAdminControls(card, s) {
  card.querySelectorAll('[data-assign]').forEach((box) => {
    box.onchange = async () => {
      // build from the LIVE snapshot (kept fresh by SSE), not the DOM —
      // stale checkboxes must not silently unassign someone another admin added
      const current = LM.liveState(s.task_id);
      const ids = new Set((current?.assignees || []).map((a) => a.id));
      const toggled = Number(box.dataset.assign);
      if (box.checked) ids.add(toggled);
      else ids.delete(toggled);
      try {
        await api(`/api/tasks/${s.task_id}/assignments`, { method: 'PUT', body: { employee_ids: [...ids] } });
        syncTasks();
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
  card.querySelectorAll('[data-clock]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/api/tasks/${s.task_id}/clock-${btn.dataset.dir}`, {
          method: 'POST',
          body: { employee_id: Number(btn.dataset.clock) },
        });
        syncTasks();
      } catch (err) {
        toast(err.data?.open_task_id ? 'Already clocked into another task' : err.message, true);
      } finally {
        btn.disabled = false;
      }
    };
  });
  const budgetBtn = card.querySelector('[data-set-budget]');
  if (budgetBtn) {
    budgetBtn.onclick = async () => {
      const dollars = Number(card.querySelector('[data-budget]').value);
      if (!Number.isFinite(dollars) || dollars < 0) return toast('Enter a valid budget', true);
      try {
        await api(`/api/tasks/${s.task_id}`, { method: 'PATCH', body: { budget_cents: Math.round(dollars * 100) } });
        toast('Budget updated');
        syncTasks();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  const archiveBtn = card.querySelector('[data-archive]');
  if (archiveBtn) {
    archiveBtn.onclick = async () => {
      try {
        await api(`/api/tasks/${s.task_id}`, {
          method: 'PATCH',
          body: { status: s.status === 'archived' ? 'active' : 'archived' },
        });
        syncTasks();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  const deleteBtn = card.querySelector('[data-delete]');
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (!confirm(`Permanently delete "${s.name}" and all its recorded hours? Archiving keeps history.`)) return;
      try {
        await api(`/api/tasks/${s.task_id}`, { method: 'DELETE' });
        toast('Task deleted');
        syncTasks();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  const showBox = card.querySelector('[data-show-countdown]');
  if (showBox) {
    showBox.onchange = async () => {
      try {
        await api(`/api/tasks/${s.task_id}`, { method: 'PATCH', body: { show_countdown_to_employees: showBox.checked } });
        syncTasks();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
}

function renderEmployeeList() {
  const el = $('#employee-list');
  if (!el) return;
  // never wipe the list while the admin is editing a rate in it
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  el.innerHTML = employees
    .map(
      (e) => `<div class="emp-row">
        <span>${esc(e.name)}${e.is_admin ? ' <span class="badge">admin</span>' : ''}</span>
        <span class="emp-rate">
          <input type="number" min="0" step="0.01" value="${(e.hourly_rate_cents / 100).toFixed(2)}" data-rate="${e.id}" aria-label="Hourly rate for ${esc(e.name)}" />
          <span class="muted">/hr</span>
          ${e.id !== me.id ? `<button class="btn small ghost" data-del-emp="${e.id}" title="Delete (only possible before any hours are recorded)">✕</button>` : ''}
        </span>
      </div>`
    )
    .join('');
  el.querySelectorAll('[data-del-emp]').forEach((btn) => {
    btn.onclick = async () => {
      const emp = employees.find((x) => x.id === Number(btn.dataset.delEmp));
      if (!confirm(`Delete ${emp?.name ?? 'this employee'}? Only possible if they have no recorded hours.`)) return;
      try {
        await api(`/api/employees/${btn.dataset.delEmp}`, { method: 'DELETE' });
        toast('Employee deleted');
        refreshEmployees(true);
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
  el.querySelectorAll('[data-rate]').forEach((input) => {
    input.onchange = async () => {
      try {
        await api(`/api/employees/${input.dataset.rate}`, {
          method: 'PATCH',
          body: { hourly_rate_cents: Math.round(Number(input.value) * 100) },
        });
        toast('Rate updated (applies to next clock-in)');
        refreshEmployees(true);
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------- forms & global wiring ---------- */

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    me = null;
    await api('/api/login', {
      method: 'POST',
      body: { username: $('#login-username').value.trim(), password: $('#login-password').value },
    });
    me = await api('/api/me');
    $('#login-error').hidden = true;
    enterApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // even if the server is unreachable, drop local state and show login
  }
  if (eventSource) eventSource.close();
  me = null;
  location.reload();
});

$('#new-task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: {
        name: $('#task-name').value.trim(),
        budget_cents: Math.round(Number($('#task-budget').value) * 100),
        show_countdown_to_employees: $('#task-show-countdown').checked,
      },
    });
    e.target.reset();
    $('#task-show-countdown').checked = true;
    toast('Task created');
    syncTasks();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#new-employee-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/employees', {
      method: 'POST',
      body: {
        name: $('#emp-name').value.trim(),
        username: $('#emp-username').value.trim(),
        password: $('#emp-password').value,
        hourly_rate_cents: Math.round(Number($('#emp-rate').value) * 100),
      },
    });
    e.target.reset();
    toast('Employee created');
    refreshEmployees(true);
  } catch (err) {
    toast(err.message, true);
  }
});

document.querySelectorAll('[data-warp]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await api('/api/timewarp', { method: 'POST', body: { advance_ms: Number(btn.dataset.warp) } });
      toast(`Clock advanced — ${(res.offset_ms / 3_600_000).toFixed(2)} h warped in total`);
      syncTasks();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
});

// admin tab switching — active tab gets the filled accent state
document.querySelectorAll('#admin-tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#admin-tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-body').forEach((s) => {
      s.hidden = s.id !== `tab-${btn.dataset.tab}`;
    });
  });
});

// 1 Hz tick — live numbers only; DOM structure changes only on real events
setInterval(() => {
  if (me) render();
}, 1000);

boot();
