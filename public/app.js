'use strict';

/* SPA: login → admin dashboard or employee view. State arrives via SSE
   full-state snapshots (LM.ingest); a 1 Hz render loop extrapolates. */

let me = null;
let employees = []; // admin only
let eventSource = null;

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
  show(me.is_admin ? 'admin-view' : 'employee-view');
  connectSse();
  refreshTasks();
  if (me.is_admin) refreshEmployees();
}

/* ---------- data ---------- */

async function refreshTasks() {
  try {
    LM.ingest(await api('/api/tasks'));
    render();
  } catch (err) {
    if (err.status === 401) show('login-view');
  }
}

async function refreshEmployees() {
  employees = await api('/api/employees');
  renderEmployeeList();
  render();
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
    if (me?.is_admin) refreshEmployees(); // keep roster in sync across admin tabs
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
          refreshTasks();
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
  const ids = [...LM.snapshots.keys()];
  // rebuild cards only when the set of tasks changes; otherwise update in place
  for (const id of ids) {
    let card = container.querySelector(`[data-task="${id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.dataset.task = id;
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

  // don't clobber the card only while the user is TYPING in a text field —
  // focus on summaries/checkboxes/buttons must not freeze live updates
  const active = document.activeElement;
  const typing =
    card.contains(active) &&
    active.tagName === 'INPUT' &&
    ['number', 'text', 'password'].includes(active.type);
  if (typing) {
    tickCountdownOnly(card, s);
    return;
  }
  const detailsWasOpen = card.querySelector('.admin-controls')?.open;

  if (s.redacted) {
    card.className = 'task-card redacted';
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
  card.className = `task-card${exhausted ? ' exhausted' : ''}${paused ? ' paused' : ''}${s.status === 'archived' ? ' archived' : ''}`;

  const crew = s.employees.filter((e) => e.clocked_in);
  card.innerHTML = `
    <div class="card-head">
      <h3>${esc(s.name)}</h3>
      ${s.status === 'archived' ? '<span class="badge">archived</span>' : ''}
      ${!s.show_countdown_to_employees ? '<span class="badge">hidden from crew</span>' : ''}
    </div>
    ${exhausted ? '<div class="exhausted-banner">⚠ LABOR BUDGET EXHAUSTED</div>' : ''}
    <div class="countdown ${exhausted ? 'red' : paused ? 'gray' : 'green'}">
      ${exhausted ? '0:00:00' : freeCrew ? '∞' : LM.fmtClock(s.remaining_seconds_live)}
    </div>
    <div class="countdown-sub">
      ${
        exhausted
          ? `<span class="over">${LM.fmtMoney(-s.over_budget_cents_live)} over budget</span>`
          : paused
            ? 'paused — no one clocked in'
            : freeCrew
              ? 'crew clocked in at $0/hr — budget not burning'
              : `remaining at ${LM.fmtMoney(s.burn_rate_cents_per_hour)}/hr crew burn rate`
      }
    </div>
    <div class="bar"><div class="bar-fill ${exhausted ? 'red' : ''}" style="width:${Math.min(100, s.pct_consumed_live).toFixed(1)}%"></div></div>
    <div class="stats">
      <div><span class="muted">Budget</span><strong>${LM.fmtMoney(s.budget_cents)}</strong></div>
      <div><span class="muted">Used</span><strong>${LM.fmtMoney(Math.round(s.consumed_cents_live))}</strong></div>
      <div><span class="muted">Remaining</span><strong class="${s.remaining_cents_live < 0 ? 'neg' : ''}">${LM.fmtMoney(Math.round(s.remaining_cents_live))}</strong></div>
      <div><span class="muted">Used %</span><strong>${s.pct_consumed_live.toFixed(1)}%</strong></div>
      <div><span class="muted">Crew now</span><strong>${crew.length}</strong></div>
      <div><span class="muted">Crew cost</span><strong>${LM.fmtMoney(s.burn_rate_cents_per_hour)}/hr</strong></div>
      <div><span class="muted">Hours worked</span><strong>${LM.fmtHours(s.total_worked_ms)}</strong></div>
      <div><span class="muted">Budget hours @ crew</span><strong>${s.budgeted_seconds_at_current_burn != null ? LM.fmtClock(s.budgeted_seconds_at_current_burn) : '—'}</strong></div>
    </div>
    ${renderEmployeeTable(s)}
    <div class="clock-actions"></div>
    ${me.is_admin ? renderAdminControls(s) : ''}`;

  renderClockButtons(card.querySelector('.clock-actions'), s);
  if (me.is_admin) {
    wireAdminControls(card, s);
    const details = card.querySelector('.admin-controls');
    if (details && detailsWasOpen) details.open = true;
  }
}

// lightweight per-tick update used while the user is typing inside the card
function tickCountdownOnly(card, s) {
  if (s.redacted) return;
  const clock = card.querySelector('.countdown');
  if (clock) clock.textContent = s.exhausted_live ? '0:00:00' : LM.fmtClock(s.remaining_seconds_live);
  const fill = card.querySelector('.bar-fill');
  if (fill) fill.style.width = `${Math.min(100, s.pct_consumed_live).toFixed(1)}%`;
  // keep the exhausted state honest even in the light path
  card.classList.toggle('exhausted', !!s.exhausted_live);
  const sub = card.querySelector('.countdown-sub');
  if (sub && s.exhausted_live) {
    sub.innerHTML = `<span class="over">${LM.fmtMoney(-s.over_budget_cents_live)} over budget</span>`;
  }
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
  btn.className = `btn big ${mine ? 'danger' : 'primary'}`;
  btn.textContent = mine ? 'Clock OUT' : 'Clock IN';
  btn.onclick = async () => {
    try {
      await api(`/api/tasks/${s.task_id}/clock-${mine ? 'out' : 'in'}`, { method: 'POST' });
    } catch (err) {
      toast(err.message, true);
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
            ? `<button class="btn small ${active ? 'danger' : ''}" data-clock="${e.id}" data-dir="${active ? 'out' : 'in'}">${active ? 'Clock out' : 'Clock in'}</button>`
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
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
  card.querySelectorAll('[data-clock]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/tasks/${s.task_id}/clock-${btn.dataset.dir}`, {
          method: 'POST',
          body: { employee_id: Number(btn.dataset.clock) },
        });
      } catch (err) {
        toast(err.data?.open_task_id ? 'Already clocked into another task' : err.message, true);
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
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
}

function renderEmployeeList() {
  const el = $('#employee-list');
  el.innerHTML = employees
    .map(
      (e) => `<div class="emp-row">
        <span>${esc(e.name)}${e.is_admin ? ' <span class="badge">admin</span>' : ''}</span>
        <span class="emp-rate">
          <input type="number" min="0" step="0.01" value="${(e.hourly_rate_cents / 100).toFixed(2)}" data-rate="${e.id}" />
          <span class="muted">/hr</span>
        </span>
      </div>`
    )
    .join('');
  el.querySelectorAll('[data-rate]').forEach((input) => {
    input.onchange = async () => {
      try {
        await api(`/api/employees/${input.dataset.rate}`, {
          method: 'PATCH',
          body: { hourly_rate_cents: Math.round(Number(input.value) * 100) },
        });
        toast('Rate updated (applies to next clock-in)');
        refreshEmployees();
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
    refreshEmployees();
  } catch (err) {
    toast(err.message, true);
  }
});

document.querySelectorAll('[data-warp]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const res = await api('/api/timewarp', { method: 'POST', body: { advance_ms: Number(btn.dataset.warp) } });
      toast(`Clock advanced — ${(res.offset_ms / 3_600_000).toFixed(2)} h warped in total`);
    } catch (err) {
      toast(err.message, true);
    }
  });
});

// 1 Hz render loop — recompute-from-snapshot, never decrement
setInterval(() => {
  if (me) render();
}, 1000);

boot();
