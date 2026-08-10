'use strict';

// Phase 1+2 product features: overtime, burden, hours budgets, corrections,
// revocable auth, org settings, projects, audit.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp, createEmployee, login, HOUR_MS } = require('./helpers');

async function setup() {
  const ctx = await createTestApp();
  await createEmployee(ctx.data, { name: 'Admin', username: 'admin', isAdmin: true });
  ctx.aId = await createEmployee(ctx.data, { name: 'A', username: 'a', rateCents: 2000 });
  ctx.admin = await login(request, ctx.app, 'admin');
  ctx.workerA = await login(request, ctx.app, 'a');
  const res = await request(ctx.app)
    .post('/api/tasks')
    .set('Cookie', ctx.admin)
    .send({ name: 'T1', budget_cents: 100_000 });
  ctx.taskId = res.body.id;
  await request(ctx.app)
    .put(`/api/tasks/${ctx.taskId}/assignments`)
    .set('Cookie', ctx.admin)
    .send({ employee_ids: [ctx.aId] })
    .expect(200);
  return ctx;
}

const adminTasks = async (ctx) =>
  (await request(ctx.app).get('/api/tasks').set('Cookie', ctx.admin).expect(200)).body;

test('overtime: hours past the daily threshold cost the multiplier', async () => {
  const ctx = await setup();
  await request(ctx.app)
    .patch('/api/settings')
    .set('Cookie', ctx.admin)
    .send({ ot_threshold_hours: 8, ot_multiplier_percent: 150 })
    .expect(200);

  await request(ctx.app).post(`/api/tasks/${ctx.taskId}/clock-in`).set('Cookie', ctx.workerA).expect(201);
  ctx.clock.advance(10 * HOUR_MS);

  const t = (await adminTasks(ctx)).tasks[0];
  // 8h at $20 + 2h at $30 = $220
  assert.equal(t.consumed_cents, 22_000);
  // currently in OT → live burn is the OT rate
  assert.equal(t.burn_rate_cents_per_hour, 3000);
});

test('overtime accrues across tasks within the same day', async () => {
  const ctx = await setup();
  await request(ctx.app)
    .patch('/api/settings')
    .set('Cookie', ctx.admin)
    .send({ ot_threshold_hours: 8, ot_multiplier_percent: 150 })
    .expect(200);
  const t2 = (
    await request(ctx.app).post('/api/tasks').set('Cookie', ctx.admin).send({ name: 'T2', budget_cents: 100_000 })
  ).body.id;
  await request(ctx.app)
    .put(`/api/tasks/${t2}/assignments`)
    .set('Cookie', ctx.admin)
    .send({ employee_ids: [ctx.aId] })
    .expect(200);

  // 6h on T1, then 4h on T2 — the last 2h of the day are OT, landing on T2
  await request(ctx.app).post(`/api/tasks/${ctx.taskId}/clock-in`).set('Cookie', ctx.workerA).expect(201);
  ctx.clock.advance(6 * HOUR_MS);
  await request(ctx.app).post(`/api/tasks/${ctx.taskId}/clock-out`).set('Cookie', ctx.workerA).expect(200);
  await request(ctx.app).post(`/api/tasks/${t2}/clock-in`).set('Cookie', ctx.workerA).expect(201);
  ctx.clock.advance(4 * HOUR_MS);

  const { tasks } = await adminTasks(ctx);
  const task1 = tasks.find((t) => t.task_id === ctx.taskId);
  const task2 = tasks.find((t) => t.task_id === t2);
  assert.equal(task1.consumed_cents, 12_000); // 6h × $20
  assert.equal(task2.consumed_cents, 10_000); // 2h × $20 + 2h × $30
});

test('labor burden: clock-ins snapshot wage × burden; countdown uses true cost', async () => {
  const ctx = await setup();
  await request(ctx.app).patch('/api/settings').set('Cookie', ctx.admin).send({ burden_percent: 25 }).expect(200);
  await request(ctx.app).post(`/api/tasks/${ctx.taskId}/clock-in`).set('Cookie', ctx.workerA).expect(201);
  ctx.clock.advance(HOUR_MS);
  const t = (await adminTasks(ctx)).tasks[0];
  assert.equal(t.consumed_cents, 2500); // $20 wage × 1.25 burden
  assert.equal(t.burn_rate_cents_per_hour, 2500);
  // $1000 budget at $25/hr true cost → 40h minus the hour already worked
  assert.equal(t.remaining_seconds, 39 * 3600);
});

test('hours-mode budget: countdown divides remaining person-hours across crew', async () => {
  const ctx = await setup();
  const bId = await createEmployee(ctx.data, { name: 'B', username: 'b', rateCents: 2500 });
  const workerB = await login(request, ctx.app, 'b');
  const hoursTask = (
    await request(ctx.app)
      .post('/api/tasks')
      .set('Cookie', ctx.admin)
      .send({ name: 'HoursTask', budget_mode: 'hours', budget_hours_ms: 10 * HOUR_MS })
  ).body.id;
  await request(ctx.app)
    .put(`/api/tasks/${hoursTask}/assignments`)
    .set('Cookie', ctx.admin)
    .send({ employee_ids: [ctx.aId, bId] })
    .expect(200);

  await request(ctx.app).post(`/api/tasks/${hoursTask}/clock-in`).set('Cookie', ctx.workerA).expect(201);
  await request(ctx.app).post(`/api/tasks/${hoursTask}/clock-in`).set('Cookie', workerB).expect(201);
  ctx.clock.advance(2 * HOUR_MS);

  const t = (await adminTasks(ctx)).tasks.find((x) => x.task_id === hoursTask);
  assert.equal(t.budget_mode, 'hours');
  assert.equal(t.consumed_person_ms, 4 * HOUR_MS); // 2 workers × 2h
  assert.equal(t.remaining_person_ms, 6 * HOUR_MS);
  assert.equal(t.remaining_seconds, (6 * 3600) / 2); // 6 person-hours ÷ 2 crew
  assert.equal(t.exhausted, false);

  ctx.clock.advance(3 * HOUR_MS); // total 10 person-hours
  const done = (await adminTasks(ctx)).tasks.find((x) => x.task_id === hoursTask);
  assert.equal(done.exhausted, true);
  assert.equal(done.remaining_seconds, 0);
});

test('corrections: adjust voids the original, replaces it, and shows in audit', async () => {
  const ctx = await setup();
  await request(ctx.app).post(`/api/tasks/${ctx.taskId}/clock-in`).set('Cookie', ctx.workerA).expect(201);
  ctx.clock.advance(3 * HOUR_MS);
  await request(ctx.app).post(`/api/tasks/${ctx.taskId}/clock-out`).set('Cookie', ctx.workerA).expect(200);
  assert.equal((await adminTasks(ctx)).tasks[0].consumed_cents, 6000);

  const sessions = (
    await request(ctx.app).get(`/api/tasks/${ctx.taskId}/sessions`).set('Cookie', ctx.admin).expect(200)
  ).body;
  const original = sessions[0];

  // shrink to 2h ("forgot to clock out")
  await request(ctx.app)
    .post(`/api/tasks/sessions/${original.id}/adjust`)
    .set('Cookie', ctx.admin)
    .send({
      clock_in_ms: original.clock_in_ms,
      clock_out_ms: original.clock_in_ms + 2 * HOUR_MS,
      reason: 'forgot to clock out',
    })
    .expect(200);

  assert.equal((await adminTasks(ctx)).tasks[0].consumed_cents, 4000);
  const after = (
    await request(ctx.app).get(`/api/tasks/${ctx.taskId}/sessions`).set('Cookie', ctx.admin).expect(200)
  ).body;
  assert.equal(after.length, 2);
  assert.ok(after.some((s) => s.voided === 1 || s.voided === true));
  assert.ok(after.some((s) => s.corrected_from === original.id));

  const audit = (
    await request(ctx.app).get('/api/settings/audit').set('Cookie', ctx.admin).expect(200)
  ).body;
  assert.ok(audit.some((r) => r.action === 'session.adjust'));

  // adjusting an already-voided session is refused
  await request(ctx.app)
    .post(`/api/tasks/sessions/${original.id}/adjust`)
    .set('Cookie', ctx.admin)
    .send({ clock_in_ms: original.clock_in_ms, clock_out_ms: original.clock_in_ms + HOUR_MS })
    .expect(409);
});

test('auth: logout revokes the session; password change revokes all sessions', async () => {
  const ctx = await setup();
  // logout kills the cookie server-side
  const cookie1 = await login(request, ctx.app, 'a');
  await request(ctx.app).post('/api/logout').set('Cookie', cookie1).expect(200);
  await request(ctx.app).get('/api/me').set('Cookie', cookie1).expect(401);

  // two live sessions; admin resets the password; both die
  const c2 = await login(request, ctx.app, 'a');
  const c3 = await login(request, ctx.app, 'a');
  await request(ctx.app)
    .patch(`/api/employees/${ctx.aId}`)
    .set('Cookie', ctx.admin)
    .send({ password: 'newpassword1' })
    .expect(200);
  await request(ctx.app).get('/api/me').set('Cookie', c2).expect(401);
  await request(ctx.app).get('/api/me').set('Cookie', c3).expect(401);
  // and the new password works
  await request(ctx.app).post('/api/login').send({ username: 'a', password: 'newpassword1' }).expect(200);
});

test('projects: rollup aggregates member tasks; settings validate', async () => {
  const ctx = await setup();
  const pid = (
    await request(ctx.app).post('/api/projects').set('Cookie', ctx.admin).send({ name: 'Building 7' })
  ).body.id;
  await request(ctx.app)
    .patch(`/api/tasks/${ctx.taskId}`)
    .set('Cookie', ctx.admin)
    .send({ project_id: pid })
    .expect(200);
  await request(ctx.app).post(`/api/tasks/${ctx.taskId}/clock-in`).set('Cookie', ctx.workerA).expect(201);
  ctx.clock.advance(HOUR_MS);

  const state = await adminTasks(ctx);
  const proj = state.projects.find((p) => p.id === pid);
  assert.equal(proj.task_count, 1);
  assert.equal(proj.budget_cents, 100_000);
  assert.equal(proj.consumed_cents, 2000);
  assert.equal(proj.burn_rate_cents_per_hour, 2000);

  // invalid settings rejected
  await request(ctx.app).patch('/api/settings').set('Cookie', ctx.admin).send({ burden_percent: 9999 }).expect(400);
  await request(ctx.app)
    .patch('/api/settings')
    .set('Cookie', ctx.admin)
    .send({ alert_webhook_url: 'notaurl' })
    .expect(400);
  // employees cannot read settings or audit
  await request(ctx.app).get('/api/settings').set('Cookie', ctx.workerA).expect(403);
  await request(ctx.app).get('/api/settings/audit').set('Cookie', ctx.workerA).expect(403);
});

test('history endpoint returns a monotonic consumption curve', async () => {
  const ctx = await setup();
  await request(ctx.app).post(`/api/tasks/${ctx.taskId}/clock-in`).set('Cookie', ctx.workerA).expect(201);
  ctx.clock.advance(5 * HOUR_MS);
  const hist = (
    await request(ctx.app).get(`/api/tasks/${ctx.taskId}/history`).set('Cookie', ctx.admin).expect(200)
  ).body;
  assert.ok(hist.points.length >= 2);
  const last = hist.points[hist.points.length - 1];
  assert.equal(last.consumed_cents, 10_000); // 5h × $20
  for (let i = 1; i < hist.points.length; i++) {
    assert.ok(hist.points[i].consumed_cents >= hist.points[i - 1].consumed_cents);
  }
});
