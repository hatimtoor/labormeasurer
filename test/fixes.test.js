'use strict';

// Regression tests for the bugs found in the post-MVP review pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp, createEmployee, login, HOUR_MS } = require('./helpers');

async function setup() {
  const ctx = await createTestApp();
  await createEmployee(ctx.data, { name: 'Admin', username: 'admin', isAdmin: true });
  ctx.aId = await createEmployee(ctx.data, { name: 'A', username: 'a', rateCents: 2000 });
  ctx.bId = await createEmployee(ctx.data, { name: 'B', username: 'b', rateCents: 2500 });
  ctx.admin = await login(request, ctx.app, 'admin');
  ctx.workerA = await login(request, ctx.app, 'a');
  ctx.workerB = await login(request, ctx.app, 'b');
  const res = await request(ctx.app)
    .post('/api/tasks')
    .set('Cookie', ctx.admin)
    .send({ name: 'T', budget_cents: 100_000 });
  ctx.taskId = res.body.id;
  await request(ctx.app)
    .put(`/api/tasks/${ctx.taskId}/assignments`)
    .set('Cookie', ctx.admin)
    .send({ employee_ids: [ctx.aId, ctx.bId] })
    .expect(200);
  return ctx;
}

test('unassigning a clocked-in worker closes their session (no phantom burn, not stuck)', async () => {
  const ctx = await setup();
  const { app, clock, admin, workerA, aId, bId, taskId } = ctx;

  await request(app).post(`/api/tasks/${taskId}/clock-in`).set('Cookie', workerA).expect(201);
  clock.advance(HOUR_MS);

  // remove A from the task while clocked in
  await request(app)
    .put(`/api/tasks/${taskId}/assignments`)
    .set('Cookie', admin)
    .send({ employee_ids: [bId] })
    .expect(200);

  let snap = (await request(app).get('/api/tasks').set('Cookie', admin).expect(200)).body.tasks[0];
  assert.equal(snap.burn_rate_cents_per_hour, 0); // session was closed
  assert.equal(snap.consumed_cents, 2000); // 1h at $20 kept, then stopped

  clock.advance(HOUR_MS);
  snap = (await request(app).get('/api/tasks').set('Cookie', admin).expect(200)).body.tasks[0];
  assert.equal(snap.consumed_cents, 2000); // no phantom burn after removal

  // A is free to clock into another task
  const t2 = (
    await request(app).post('/api/tasks').set('Cookie', admin).send({ name: 'T2', budget_cents: 50_000 })
  ).body.id;
  await request(app).put(`/api/tasks/${t2}/assignments`).set('Cookie', admin).send({ employee_ids: [aId] }).expect(200);
  await request(app).post(`/api/tasks/${t2}/clock-in`).set('Cookie', workerA).expect(201);
});

test('assignment PUT rejects unknown employee ids instead of silently ignoring', async () => {
  const ctx = await setup();
  const res = await request(ctx.app)
    .put(`/api/tasks/${ctx.taskId}/assignments`)
    .set('Cookie', ctx.admin)
    .send({ employee_ids: [ctx.aId, 999] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /999/);
});

test('employees never see co-worker rates or costs, even with countdown visible', async () => {
  const ctx = await setup();
  const { app, clock, workerA, workerB, aId, bId, taskId } = ctx;

  await request(app).post(`/api/tasks/${taskId}/clock-in`).set('Cookie', workerA).expect(201);
  await request(app).post(`/api/tasks/${taskId}/clock-in`).set('Cookie', workerB).expect(201);
  clock.advance(HOUR_MS);

  const seenByA = (await request(app).get('/api/tasks').set('Cookie', workerA).expect(200)).body.tasks[0];
  // countdown + aggregates are visible (show_countdown_to_employees defaults on)
  assert.ok(seenByA.remaining_seconds > 0);
  assert.equal(seenByA.burn_rate_cents_per_hour, 4500);
  // own line is complete
  const own = seenByA.employees.find((e) => e.employee_id === aId);
  assert.equal(own.rate_cents_snapshot, 2000);
  assert.equal(own.cost_cents, 2000);
  // co-worker line carries no compensation data
  const coworker = seenByA.employees.find((e) => e.employee_id === bId);
  assert.equal(coworker.rate_cents_snapshot, undefined);
  assert.equal(coworker.cost_cents, undefined);
  assert.equal(coworker.name, 'B');
  const coAssignee = seenByA.assignees.find((a) => a.id === bId);
  assert.equal(coAssignee.hourly_rate_cents, undefined);
});

test('POST and PATCH agree on show_countdown_to_employees truthiness', async () => {
  const ctx = await setup();
  const created = await request(ctx.app)
    .post('/api/tasks')
    .set('Cookie', ctx.admin)
    .send({ name: 'Hidden', budget_cents: 1000, show_countdown_to_employees: 0 });
  assert.equal(created.status, 201);
  const snaps = (await request(ctx.app).get('/api/tasks').set('Cookie', ctx.admin).expect(200)).body.tasks;
  const hidden = snaps.find((t) => t.task_id === created.body.id);
  assert.equal(hidden.show_countdown_to_employees, false); // 0 now means hidden on POST too
});

test('input bounds: oversized budget, oversized rate, short password all rejected', async () => {
  const ctx = await setup();
  await request(ctx.app)
    .post('/api/tasks')
    .set('Cookie', ctx.admin)
    .send({ name: 'Huge', budget_cents: 1e14 })
    .expect(400);
  await request(ctx.app)
    .post('/api/employees')
    .set('Cookie', ctx.admin)
    .send({ name: 'X', username: 'x', password: 'longenough', hourly_rate_cents: 1e9 })
    .expect(400);
  await request(ctx.app)
    .post('/api/employees')
    .set('Cookie', ctx.admin)
    .send({ name: 'X', username: 'x', password: 'short', hourly_rate_cents: 2000 })
    .expect(400);
  await request(ctx.app)
    .post('/api/timewarp')
    .set('Cookie', ctx.admin)
    .send({ advance_ms: 400 * 24 * 3_600_000 })
    .expect(400);
});

test('zero-rate worker: clocked in, burn 0, countdown paused-null, budget untouched', async () => {
  const ctx = await setup();
  const vId = await createEmployee(ctx.data, { name: 'Volunteer', username: 'v', rateCents: 0 });
  await request(ctx.app)
    .put(`/api/tasks/${ctx.taskId}/assignments`)
    .set('Cookie', ctx.admin)
    .send({ employee_ids: [vId] })
    .expect(200);
  const workerV = await login(request, ctx.app, 'v');
  await request(ctx.app).post(`/api/tasks/${ctx.taskId}/clock-in`).set('Cookie', workerV).expect(201);
  ctx.clock.advance(HOUR_MS);
  const snap = (await request(ctx.app).get('/api/tasks').set('Cookie', ctx.admin).expect(200)).body.tasks[0];
  assert.equal(snap.burn_rate_cents_per_hour, 0);
  assert.equal(snap.remaining_seconds, null);
  assert.equal(snap.consumed_cents, 0);
  assert.deepEqual(snap.active_employee_ids, [vId]);
  assert.equal(snap.total_worked_ms, HOUR_MS); // hours still tracked
});

test('login rate limit: 11th rapid attempt gets 429', async () => {
  const ctx = await setup();
  let last;
  for (let i = 0; i < 11; i++) {
    last = await request(ctx.app).post('/api/login').send({ username: 'a', password: 'wrong!' });
  }
  assert.equal(last.status, 429);
});

test('corrupted stored hash yields 401, not a 500', async () => {
  const ctx = await setup();
  await ctx.data.updateEmployee(ctx.aId, { password_hash: 'garbage:aa' });
  await request(ctx.app).post('/api/login').send({ username: 'a', password: 'pw' }).expect(401);
});
