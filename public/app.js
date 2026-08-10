'use strict';

/* SPA: login → tabbed admin view or employee view. State arrives via SSE
   full-state snapshots {tasks, projects} (LM.ingest). Cards fully rebuild
   ONLY when their snapshot/selection/roster changes; the 1 Hz tick rewrites
   numbers in place — rebuilding DOM every second eats clicks and wipes UI
   state. */

let me = null;
let employees = []; // admin only
let employeesVersion = ''; // roster fingerprint
let rosterRev = 0; // bumped when the roster changes; part of the card signature
let eventSource = null;
let selectedTaskId = null; // clicked card highlight
let projectFilter = null; // clicked project chip
let lastEmployeesFetch = 0;
let features = { timewarp: true };

const $ = (sel) => document.querySelector(sel);
const MS_PER_HOUR = 3_600_000;

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

function toast(message, isError = false, ms = 3500) {
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
  setTimeout(() => el.remove(), ms);
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
  $('#admin-tabs').hidden = !me.is_admin;
  $('#display-btn').hidden = !me.is_admin;
  show(me.is_admin ? 'admin-view' : 'employee-view');
  connectSse();
  refreshTasks();
  if (me.is_admin) {
    refreshEmployees(true);
    loadFeatures();
    loadOrgSettings();
    loadAudit();
  }
}

async function loadFeatures() {
  try {
    features = await api('/api/features');
  } catch {
    features = { timewarp: false };
  }
  $('#warp-controls').hidden = !features.timewarp;
  $('#warp-help').hidden = !features.timewarp;
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
  eventSource.addEventListener('alert', (e) => {
    try {
      const a = JSON.parse(e.data);
      toast(`⚠ ${a.task_name}: ${a.threshold}% of labor budget consumed`, true, 8000);
      loadAudit();
    } catch { /* ignore malformed alert */ }
  });
  eventSource.onerror = () => {
    setConnectionState(false);
    // A 401 (expired cookie, revoked session) closes the EventSource permanently —
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
  if (me.is_admin) renderProjectStrip();
  const container = me.is_admin ? $('#task-cards') : $('#employee-tasks');
  if (!container) return;
  let ids = [...LM.snapshots.keys()];
  if (me.is_admin && projectFilter != null) {
    ids = ids.filter((id) => {
      const entry = LM.snapshots.get(id);
      return entry && entry.snap.project_id === projectFilter;
    });
  }
  for (const id of ids) {
    let card = container.querySelector(`[data-task="${id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.dataset.task = id;
      // click (outside any control) selects/deselects the card
      card.addEventListener('click', (e) => {
        if (e.target.closest('button, input, select, label, details, summary, table, a')) return;
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

/* ---- project strip ---- */

let projectStripSig = '';
function renderProjectStrip() {
  const strip = $('#project-strip');
  if (!strip) return;
  const projects = LM.getProjects();
  const sig = JSON.stringify([projects.map((p) => [p.id, p.name, p.consumed_cents, p.burn_rate_cents_per_hour]), projectFilter]);
  if (sig === projectStripSig) return;
  projectStripSig = sig;

  strip.innerHTML = '';
  const allChip = document.createElement('button');
  allChip.className = `chip${projectFilter == null ? ' active' : ''}`;
  allChip.textContent = 'All tasks';
  allChip.onclick = () => {
    projectFilter = null;
    render();
  };
  strip.appendChild(allChip);

  for (const p of projects) {
    const chip = document.createElement('button');
    chip.className = `chip c${p.id % 6}${projectFilter === p.id ? ' active' : ''}`;
    const countdown =
      p.remaining_seconds != null ? ` · ${LM.fmtClock(p.remaining_seconds)} left` : '';
    chip.innerHTML = `${esc(p.name)} <span class="chip-sub">${LM.fmtMoney(p.consumed_cents)} / ${LM.fmtMoney(p.budget_cents)}${countdown}</span>`;
    chip.onclick = () => {
      projectFilter = projectFilter === p.id ? null : p.id;
      render();
    };
    strip.appendChild(chip);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'chip ghost';
  addBtn.textContent = '+ Project';
  addBtn.onclick = async () => {
    const name = prompt('Project name:');
    if (!name || !name.trim()) return;
    try {
      await api('/api/projects', { method: 'POST', body: { name: name.trim() } });
      toast('Project created');
      syncTasks();
    } catch (err) {
      toast(err.message, true);
    }
  };
  strip.appendChild(addBtn);
}

/* ---- task cards ---- */

function updateCard(card, taskId) {
  const s = LM.liveState(taskId);
  if (!s) return;

  // Structural signature: rebuild only when the underlying snapshot, the
  // selection, the roster, or the live exhausted state changes.
  const selected = taskId === selectedTaskId;
  const sig = `${s.at_ms}|${selected ? 1 : 0}|${s.redacted ? 1 : 0}|${s.exhausted_live ? 1 : 0}|${rosterRev}`;

  // freeze rebuilds only for controls where losing state mid-interaction hurts
  // (text entry, open selects) — NOT checkboxes, whose state is instantaneous
  // and which must not block the card from refreshing after a toggle
  const active = document.activeElement;
  const typing =
    card.contains(active) &&
    ((active.tagName === 'INPUT' && active.type !== 'checkbox') || active.tagName === 'SELECT');

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
  const freeCrew = !paused && s.budget_mode !== 'hours' && s.burn_rate_cents_per_hour === 0;
  const detailsWasOpen = card.querySelector('.admin-controls')?.open;
  const hoursMode = s.budget_mode === 'hours';
  const project = LM.getProjects().find((p) => p.id === s.project_id);

  card.className =
    `task-card${exhausted ? ' exhausted' : ''}${paused ? ' paused' : ''}` +
    `${s.status === 'archived' ? ' archived' : ''}${selected ? ' selected' : ''}`;

  const crew = s.employees.filter((e) => e.clocked_in);
  card.innerHTML = `
    <div class="card-head">
      <h3>${esc(s.name)}</h3>
      ${project ? `<span class="badge proj c${project.id % 6}">${esc(project.name)}</span>` : ''}
      ${hoursMode ? '<span class="badge">hours budget</span>' : ''}
      ${s.status === 'archived' ? '<span class="badge">archived</span>' : ''}
      ${!s.show_countdown_to_employees ? '<span class="badge">hidden from crew</span>' : ''}
    </div>
    <div class="banner-slot">${exhausted ? '<div class="exhausted-banner">⚠ LABOR BUDGET EXHAUSTED</div>' : ''}</div>
    <div class="countdown"></div>
    <div class="countdown-sub"></div>
    <div class="bar"><div class="bar-fill"></div></div>
    <div class="stats">
      ${
        hoursMode
          ? `<div><span class="muted">Budget</span><strong>${LM.fmtHours(s.budget_hours_ms)}</strong></div>
             <div><span class="muted">Used</span><strong data-live="used-h"></strong></div>
             <div><span class="muted">Remaining</span><strong data-live="remaining-h"></strong></div>
             <div><span class="muted">Labor cost</span><strong data-live="used"></strong></div>`
          : `<div><span class="muted">Budget</span><strong>${LM.fmtMoney(s.budget_cents)}</strong></div>
             <div><span class="muted">Used</span><strong data-live="used"></strong></div>
             <div><span class="muted">Remaining</span><strong data-live="remaining"></strong></div>
             <div><span class="muted">Budget hours @ crew</span><strong>${s.budgeted_seconds_at_current_burn != null ? LM.fmtClock(s.budgeted_seconds_at_current_burn) : '—'}</strong></div>`
      }
      <div><span class="muted">Used %</span><strong data-live="pct"></strong></div>
      <div><span class="muted">Crew now</span><strong>${crew.length}</strong></div>
      <div><span class="muted">Crew cost</span><strong>${LM.fmtMoney(s.burn_rate_cents_per_hour)}/hr</strong></div>
      <div><span class="muted">Hours worked</span><strong data-live="hours"></strong></div>
    </div>
    ${renderEmployeeTable(s)}
    <div class="clock-actions"></div>
    <div class="chart-slot" hidden></div>
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
  const activeCount = (s.active_employee_ids || []).length;
  const paused = activeCount === 0;
  const hoursMode = s.budget_mode === 'hours';
  const freeCrew = !paused && !hoursMode && s.burn_rate_cents_per_hour === 0;

  const clock = card.querySelector('.countdown');
  if (clock) {
    clock.textContent = exhausted ? '0:00:00' : freeCrew ? '∞' : LM.fmtClock(s.remaining_seconds_live);
    clock.className = `countdown ${exhausted ? 'red' : paused ? 'gray' : 'green'}`;
  }
  const sub = card.querySelector('.countdown-sub');
  if (sub) {
    sub.innerHTML = exhausted
      ? hoursMode
        ? `<span class="over">${LM.fmtHours(s.over_budget_ms_live ?? 0)} over the hours budget</span>`
        : `<span class="over">${LM.fmtMoney(-s.over_budget_cents_live)} over budget</span>`
      : paused
        ? 'paused — no one clocked in'
        : freeCrew
          ? 'crew clocked in at $0/hr — budget not burning'
          : hoursMode
            ? `remaining with ${activeCount} on the clock (${LM.fmtHours(s.remaining_person_ms_live)} person-hours left)`
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
  set('used-h', LM.fmtHours(s.consumed_person_ms_live));
  set('remaining-h', LM.fmtHours(Math.max(0, s.remaining_person_ms_live ?? 0)));
  set('pct', `${s.pct_consumed_live.toFixed(1)}%`);
  set('hours', LM.fmtHours(s.consumed_person_ms_live));
  const rem = card.querySelector('[data-live="remaining"]');
  if (rem) rem.classList.toggle('neg', s.remaining_cents_live < 0);
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
  const projectOptions = [`<option value="">No project</option>`]
    .concat(
      LM.getProjects().map(
        (p) => `<option value="${p.id}" ${s.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`
      )
    )
    .join('');
  return `<details class="admin-controls">
    <summary>Manage task</summary>
    <div class="assign-list">${rows || '<p class="muted small">No employees yet.</p>'}</div>
    <div class="inline-form">
      ${
        s.budget_mode === 'hours'
          ? `<input type="number" min="0" step="0.5" data-budget-hours placeholder="New budget (hours)" />`
          : `<input type="number" min="0" step="0.01" data-budget placeholder="New budget ($)" />`
      }
      <button class="btn small" data-set-budget>Set budget</button>
      <select data-project aria-label="Project">${projectOptions}</select>
    </div>
    <label class="check"><input type="checkbox" data-show-countdown ${s.show_countdown_to_employees ? 'checked' : ''}/> Crew can see countdown</label>
    <div class="inline-form">
      <button class="btn small" data-timesheet>Timesheet</button>
      <button class="btn small" data-chart>Burn-down</button>
      <button class="btn small" data-archive>${s.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
      <button class="btn small danger" data-delete>Delete task</button>
    </div>
    <div class="timesheet-slot" hidden></div>
  </details>`;
}

function wireAdminControls(card, s) {
  card.querySelectorAll('[data-assign]').forEach((box) => {
    box.onchange = async () => {
      // delta add/remove per worker — full-replace raced against itself when
      // several checkboxes were toggled before the next snapshot arrived,
      // silently dropping all but the last selection
      const toggled = Number(box.dataset.assign);
      const wasChecked = box.checked;
      box.disabled = true;
      try {
        await api(`/api/tasks/${s.task_id}/assignments/${toggled}`, {
          method: wasChecked ? 'POST' : 'DELETE',
        });
        syncTasks();
      } catch (err) {
        box.checked = !wasChecked; // revert the visual state on failure
        toast(err.message, true);
      } finally {
        box.disabled = false;
        box.blur(); // let the next snapshot rebuild the card (clock-in button appears)
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
      try {
        if (s.budget_mode === 'hours') {
          const hours = Number(card.querySelector('[data-budget-hours]').value);
          if (!Number.isFinite(hours) || hours < 0) return toast('Enter a valid hours budget', true);
          await api(`/api/tasks/${s.task_id}`, { method: 'PATCH', body: { budget_hours_ms: Math.round(hours * MS_PER_HOUR) } });
        } else {
          const dollars = Number(card.querySelector('[data-budget]').value);
          if (!Number.isFinite(dollars) || dollars < 0) return toast('Enter a valid budget', true);
          await api(`/api/tasks/${s.task_id}`, { method: 'PATCH', body: { budget_cents: Math.round(dollars * 100) } });
        }
        toast('Budget updated');
        syncTasks();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  const projectSel = card.querySelector('[data-project]');
  if (projectSel) {
    projectSel.onchange = async () => {
      try {
        await api(`/api/tasks/${s.task_id}`, {
          method: 'PATCH',
          body: { project_id: projectSel.value === '' ? null : Number(projectSel.value) },
        });
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
  const timesheetBtn = card.querySelector('[data-timesheet]');
  if (timesheetBtn) {
    timesheetBtn.onclick = () => toggleTimesheet(card, s);
  }
  const chartBtn = card.querySelector('[data-chart]');
  if (chartBtn) {
    chartBtn.onclick = () => toggleChart(card, s);
  }
}

/* ---- timesheet (corrections) ---- */

function fmtLocal(ms) {
  return new Date(ms).toLocaleString();
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function toggleTimesheet(card, s) {
  const slot = card.querySelector('.timesheet-slot');
  if (!slot) return;
  if (!slot.hidden) {
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  slot.innerHTML = '<p class="muted small">Loading sessions…</p>';
  try {
    const sessions = await api(`/api/tasks/${s.task_id}/sessions`);
    if (!sessions.length) {
      slot.innerHTML = '<p class="muted small">No sessions recorded yet.</p>';
      return;
    }
    slot.innerHTML = `<table class="emp-table ts-table">
      <thead><tr><th>Employee</th><th>In</th><th>Out</th><th>Hours</th><th></th></tr></thead>
      <tbody>${sessions
        .map((row) => {
          const voided = row.voided === 1 || row.voided === true;
          const open = row.clock_out_ms == null;
          const end = open ? Date.now() : row.clock_out_ms;
          const hours = ((end - row.clock_in_ms) / MS_PER_HOUR).toFixed(2);
          return `<tr class="${voided ? 'voided-row' : ''}" data-session="${row.id}">
            <td>${esc(row.employee_name)}${row.corrected_from ? ' <span class="badge">corrected</span>' : ''}${voided ? ' <span class="badge">voided</span>' : ''}</td>
            <td>${fmtLocal(row.clock_in_ms)}</td>
            <td>${open ? '(open)' : fmtLocal(row.clock_out_ms)}</td>
            <td>${hours}</td>
            <td>${!voided && !open ? `<button class="btn small" data-adjust="${row.id}">Adjust</button> <button class="btn small danger" data-void="${row.id}">Void</button>` : ''}</td>
          </tr>`;
        })
        .join('')}</tbody></table>
      <div class="adjust-slot"></div>`;

    slot.querySelectorAll('[data-void]').forEach((btn) => {
      btn.onclick = async () => {
        const reason = prompt('Reason for voiding this session (recorded in the audit log):');
        if (reason == null) return;
        try {
          await api(`/api/tasks/sessions/${btn.dataset.void}/void`, { method: 'POST', body: { reason } });
          toast('Session voided');
          slot.hidden = true;
          syncTasks();
        } catch (err) {
          toast(err.message, true);
        }
      };
    });
    slot.querySelectorAll('[data-adjust]').forEach((btn) => {
      btn.onclick = () => {
        const row = sessions.find((x) => x.id === Number(btn.dataset.adjust));
        const adjustSlot = slot.querySelector('.adjust-slot');
        adjustSlot.innerHTML = `
          <div class="adjust-form">
            <strong>Adjust ${esc(row.employee_name)}'s session</strong>
            <label>In <input type="datetime-local" data-adj-in value="${toLocalInput(row.clock_in_ms)}" /></label>
            <label>Out <input type="datetime-local" data-adj-out value="${toLocalInput(row.clock_out_ms)}" /></label>
            <input type="text" data-adj-reason placeholder="Reason (audited)" />
            <button class="btn small primary" data-adj-save>Save correction</button>
            <button class="btn small" data-adj-cancel>Cancel</button>
          </div>`;
        adjustSlot.querySelector('[data-adj-cancel]').onclick = () => (adjustSlot.innerHTML = '');
        adjustSlot.querySelector('[data-adj-save]').onclick = async () => {
          const inMs = new Date(adjustSlot.querySelector('[data-adj-in]').value).getTime();
          const outMs = new Date(adjustSlot.querySelector('[data-adj-out]').value).getTime();
          if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs < inMs) {
            return toast('Enter a valid in/out range', true);
          }
          try {
            await api(`/api/tasks/sessions/${row.id}/adjust`, {
              method: 'POST',
              body: {
                clock_in_ms: inMs,
                clock_out_ms: outMs,
                reason: adjustSlot.querySelector('[data-adj-reason]').value,
              },
            });
            toast('Session corrected');
            slot.hidden = true;
            syncTasks();
          } catch (err) {
            toast(err.message, true);
          }
        };
      };
    });
  } catch (err) {
    slot.innerHTML = `<p class="error small">${esc(err.message)}</p>`;
  }
}

/* ---- burn-down chart ---- */

async function toggleChart(card, s) {
  const slot = card.querySelector('.chart-slot');
  if (!slot) return;
  if (!slot.hidden) {
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  slot.innerHTML = '<p class="muted small">Loading history…</p>';
  try {
    const hist = await api(`/api/tasks/${s.task_id}/history`);
    const pts = hist.points;
    if (pts.length < 2) {
      slot.innerHTML = '<p class="muted small">Not enough history yet — chart appears once work is recorded.</p>';
      return;
    }
    const hoursMode = hist.budget_mode === 'hours';
    const value = (p) => (hoursMode ? p.consumed_person_ms : p.consumed_cents);
    const budget = hoursMode ? hist.budget_hours_ms : hist.budget_cents;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const maxY = Math.max(budget, ...pts.map(value)) || 1;
    const W = 560;
    const H = 150;
    const PAD = 8;
    const x = (t) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD);
    const y = (v) => H - PAD - (v / maxY) * (H - 2 * PAD);
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(value(p)).toFixed(1)}`).join(' ');
    const budgetY = y(budget).toFixed(1);
    const label = hoursMode
      ? `${LM.fmtHours(value(pts[pts.length - 1]))} of ${LM.fmtHours(budget)} consumed`
      : `${LM.fmtMoney(value(pts[pts.length - 1]))} of ${LM.fmtMoney(budget)} consumed`;
    slot.innerHTML = `
      <div class="chart-box">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Budget consumption over time" preserveAspectRatio="none">
          <line x1="${PAD}" y1="${budgetY}" x2="${W - PAD}" y2="${budgetY}" class="chart-budget" />
          <path d="${line}" class="chart-line" fill="none" />
        </svg>
        <p class="muted small">${label} · dashed line = budget</p>
      </div>`;
  } catch (err) {
    slot.innerHTML = `<p class="error small">${esc(err.message)}</p>`;
  }
}

/* ---------- employees tab ---------- */

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
          <button class="btn small ghost" data-passwd="${e.id}" title="Set a new password">🔑</button>
          ${e.id !== me.id ? `<button class="btn small ghost" data-del-emp="${e.id}" title="Delete (only possible before any hours are recorded)">✕</button>` : ''}
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
        refreshEmployees(true);
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
  el.querySelectorAll('[data-passwd]').forEach((btn) => {
    btn.onclick = async () => {
      const emp = employees.find((x) => x.id === Number(btn.dataset.passwd));
      const pw = prompt(`New password for ${emp?.name} (min 8 chars). All their existing logins will be signed out:`);
      if (pw == null) return;
      try {
        await api(`/api/employees/${btn.dataset.passwd}`, { method: 'PATCH', body: { password: pw } });
        toast('Password changed — their sessions were signed out');
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
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
}

/* ---------- settings tab ---------- */

async function loadOrgSettings() {
  try {
    const s = await api('/api/settings');
    $('#set-burden').value = s.burden_percent;
    $('#set-ot-threshold').value = s.ot_threshold_hours;
    $('#set-ot-mult').value = s.ot_multiplier_percent;
    $('#set-tz').value = s.org_utc_offset_min;
    $('#set-thresholds').value = s.alert_thresholds;
    $('#set-webhook').value = s.alert_webhook_url;
  } catch (err) {
    toast(`Could not load settings: ${err.message}`, true);
  }
}

async function loadAudit() {
  const el = $('#audit-list');
  if (!el || !me?.is_admin) return;
  try {
    const rows = await api('/api/settings/audit?limit=100');
    if (!rows.length) {
      el.innerHTML = '<p class="muted small">No audit entries yet.</p>';
      return;
    }
    el.innerHTML = rows
      .map(
        (r) => `<div class="audit-row">
          <span class="muted small">${new Date(r.at_ms).toLocaleString()}</span>
          <span><strong>${esc(r.actor_name)}</strong> · ${esc(r.action)}${r.entity_id != null ? ` #${r.entity_id}` : ''}</span>
          ${r.details ? `<span class="muted small audit-details">${esc(r.details)}</span>` : ''}
        </div>`
      )
      .join('');
  } catch (err) {
    el.innerHTML = `<p class="error small">${esc(err.message)}</p>`;
  }
}

$('#org-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', {
      method: 'PATCH',
      body: {
        burden_percent: $('#set-burden').value,
        ot_threshold_hours: $('#set-ot-threshold').value,
        ot_multiplier_percent: $('#set-ot-mult').value,
        org_utc_offset_min: $('#set-tz').value,
        alert_thresholds: $('#set-thresholds').value,
        alert_webhook_url: $('#set-webhook').value,
      },
    });
    toast('Settings saved — burden/OT apply to future clock-ins');
    loadAudit();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- wall display mode ---------- */

function setDisplayMode(on) {
  document.body.classList.toggle('wall', on);
  if (on && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  if (!on && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}
$('#display-btn').addEventListener('click', () => setDisplayMode(true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setDisplayMode(false);
});

/* ---------- helpers, forms & global wiring ---------- */

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

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

$('#task-mode').addEventListener('change', () => {
  const hours = $('#task-mode').value === 'hours';
  $('#task-budget').placeholder = hours ? 'Budget (person-hours)' : 'Budget ($)';
});

$('#new-task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const hours = $('#task-mode').value === 'hours';
    const amount = Number($('#task-budget').value);
    await api('/api/tasks', {
      method: 'POST',
      body: {
        name: $('#task-name').value.trim(),
        budget_mode: hours ? 'hours' : 'money',
        budget_cents: hours ? 0 : Math.round(amount * 100),
        budget_hours_ms: hours ? Math.round(amount * MS_PER_HOUR) : 0,
        show_countdown_to_employees: $('#task-show-countdown').checked,
        project_id: $('#task-project').value === '' ? null : Number($('#task-project').value),
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

// keep the create form's project dropdown in sync with the strip
setInterval(() => {
  const sel = $('#task-project');
  if (!sel || document.activeElement === sel) return;
  const current = sel.value;
  const options =
    '<option value="">No project</option>' +
    LM.getProjects()
      .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
      .join('');
  if (sel.innerHTML !== options) {
    sel.innerHTML = options;
    sel.value = current;
  }
}, 2000);

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
    if (btn.dataset.tab === 'settings') loadAudit();
  });
});

// 1 Hz tick — live numbers only; DOM structure changes only on real events
setInterval(() => {
  if (me) render();
}, 1000);

boot();
