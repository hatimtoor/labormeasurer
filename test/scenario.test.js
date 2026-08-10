'use strict';

// The challenge's 11-step success scenario, end-to-end through the real HTTP
// API with a fake clock. Exact integer assertions throughout.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp, createEmployee, login, HOUR_MS } = require('./helpers');

test('11-step success scenario', async () => {
  const { data, clock, app } = await createTestApp();

  await createEmployee(data, { name: 'Admin', username: 'admin', rateCents: 0, isAdmin: true });
  const aId = await createEmployee(data, { name: 'Worker A', username: 'a', rateCents: 2000 });
  const bId = await createEmployee(data, { name: 'Worker B', username: 'b', rateCents: 2500 });

  const admin = await login(request, app, 'admin');
  const workerA = await login(request, app, 'a');
  const workerB = await login(request, app, 'b');

  // Step 1: create task with $1,000 budget
  const created = await request(app)
    .post('/api/tasks')
    .set('Cookie', admin)
    .send({ name: 'Frame Unit 101', budget_cents: 100_000 });
  assert.equal(created.status, 201);
  const taskId = created.body.id;
  await request(app)
    .put(`/api/tasks/${taskId}/assignments`)
    .set('Cookie', admin)
    .send({ employee_ids: [aId, bId] })
    .expect(200);

  const snap = async (cookie = admin) => {
    const res = await request(app).get('/api/tasks').set('Cookie', cookie).expect(200);
    return res.body.find((t) => t.task_id === taskId);
  };

  // Steps 2-3: Worker A ($20/hr) clocks in
  await request(app).post(`/api/tasks/${taskId}/clock-in`).set('Cookie', workerA).expect(201);

  // Step 4: system shows 50 hours remaining (exactly 180,000 s)
  let s = await snap();
  assert.equal(s.burn_rate_cents_per_hour, 2000);
  assert.equal(s.remaining_seconds, 180_000);
  assert.equal(s.budgeted_seconds_at_current_burn, 180_000);

  // Step 5: Worker A consumes $200 of budget (10 hours pass)
  clock.advance(10 * HOUR_MS);
  s = await snap();
  assert.equal(s.consumed_cents, 20_000);
  assert.equal(s.remaining_cents, 80_000);

  // Step 6: Worker B ($25/hr) clocks in
  await request(app).post(`/api/tasks/${taskId}/clock-in`).set('Cookie', workerB).expect(201);

  // Step 7: recalculated from REMAINING budget at $45/hr => $800/45 = 64,000 s exactly
  s = await snap();
  assert.equal(s.burn_rate_cents_per_hour, 4500);
  assert.equal(s.remaining_cents, 80_000);
  assert.equal(s.remaining_seconds, 64_000);
  assert.deepEqual([...s.active_employee_ids].sort(), [aId, bId].sort());

  // burn together for 2 hours: consumes 2 * $45 = $90
  clock.advance(2 * HOUR_MS);

  // Step 8: Worker B clocks out
  await request(app).post(`/api/tasks/${taskId}/clock-out`).set('Cookie', workerB).expect(200);

  // Step 9: recalculated at Worker A's $20/hr
  s = await snap();
  assert.equal(s.burn_rate_cents_per_hour, 2000);
  assert.equal(s.consumed_cents, 29_000); // $200 + $90
  assert.equal(s.remaining_cents, 71_000);
  assert.equal(s.remaining_seconds, Math.floor((71_000 * 3_600_000) / 2000 / 1000)); // 35.5h = 127,800s
  assert.equal(s.remaining_seconds, 127_800);

  // Step 10: countdown reaches zero — advance exactly 35.5 hours
  clock.advance(35 * HOUR_MS + 30 * 60_000);
  s = await snap();
  assert.equal(s.exhausted, true);
  assert.equal(s.remaining_seconds, 0);
  assert.equal(s.remaining_cents, 0);
  assert.equal(s.consumed_cents, 100_000);

  // Step 11: additional work becomes over-budget labor; actual hours keep accruing
  clock.advance(1 * HOUR_MS);
  s = await snap();
  assert.equal(s.exhausted, true);
  assert.equal(s.remaining_cents, -2000);
  assert.equal(s.over_budget_cents, 2000);
  assert.equal(s.remaining_seconds, 0);
  // A has worked 10 + 2 + 35.5 + 1 = 48.5 hours, never lost
  const aLine = s.employees.find((e) => e.employee_id === aId);
  assert.equal(aLine.worked_ms, 48.5 * HOUR_MS);
  assert.equal(aLine.clocked_in, true);
  const bLine = s.employees.find((e) => e.employee_id === bId);
  assert.equal(bLine.worked_ms, 2 * HOUR_MS);
  assert.equal(bLine.cost_cents, 5000);

  // clock A out; history intact
  await request(app).post(`/api/tasks/${taskId}/clock-out`).set('Cookie', workerA).expect(200);
  s = await snap();
  assert.equal(s.burn_rate_cents_per_hour, 0);
  assert.equal(s.remaining_seconds, null); // paused
  assert.equal(s.total_worked_ms, 50.5 * HOUR_MS);
  assert.equal(s.consumed_cents, 102_000);
});

test('guards: double clock-in idempotent, second task blocked, employee redaction', async () => {
  const { data, app } = await createTestApp();
  await createEmployee(data, { name: 'Admin', username: 'admin', isAdmin: true });
  const aId = await createEmployee(data, { name: 'A', username: 'a', rateCents: 2000 });
  const admin = await login(request, app, 'admin');
  const workerA = await login(request, app, 'a');

  const t1 = (await request(app).post('/api/tasks').set('Cookie', admin).send({ name: 'T1', budget_cents: 10_000 })).body.id;
  const t2 = (await request(app).post('/api/tasks').set('Cookie', admin).send({ name: 'T2', budget_cents: 10_000, show_countdown_to_employees: false })).body.id;
  await request(app).put(`/api/tasks/${t1}/assignments`).set('Cookie', admin).send({ employee_ids: [aId] }).expect(200);
  await request(app).put(`/api/tasks/${t2}/assignments`).set('Cookie', admin).send({ employee_ids: [aId] }).expect(200);

  await request(app).post(`/api/tasks/${t1}/clock-in`).set('Cookie', workerA).expect(201);
  const again = await request(app).post(`/api/tasks/${t1}/clock-in`).set('Cookie', workerA).expect(200);
  assert.equal(again.body.already, true);

  const blocked = await request(app).post(`/api/tasks/${t2}/clock-in`).set('Cookie', workerA).expect(409);
  assert.equal(blocked.body.open_task_id, t1);

  // employee list: t2 has countdown hidden => redacted (no dollar figures)
  const list = (await request(app).get('/api/tasks').set('Cookie', workerA).expect(200)).body;
  const seen1 = list.find((t) => t.task_id === t1);
  const seen2 = list.find((t) => t.task_id === t2);
  assert.equal(seen1.remaining_cents, 10_000 - seen1.consumed_cents);
  assert.equal(seen2.redacted, true);
  assert.equal(seen2.budget_cents, undefined);
  assert.equal(seen2.remaining_seconds, undefined);

  // unauthenticated and non-admin access
  await request(app).get('/api/tasks').expect(401);
  await request(app).get('/api/employees').set('Cookie', workerA).expect(403);
  await request(app).post('/api/timewarp').set('Cookie', workerA).send({ advance_ms: 1000 }).expect(403);
});

test('rate edit does not affect open session; applies to next clock-in', async () => {
  const { data, clock, app } = await createTestApp();
  await createEmployee(data, { name: 'Admin', username: 'admin', isAdmin: true });
  const aId = await createEmployee(data, { name: 'A', username: 'a', rateCents: 2000 });
  const admin = await login(request, app, 'admin');

  const t = (await request(app).post('/api/tasks').set('Cookie', admin).send({ name: 'T', budget_cents: 100_000 })).body.id;
  await request(app).post(`/api/tasks/${t}/clock-in`).set('Cookie', admin).send({ employee_id: aId }).expect(201);

  await request(app).patch(`/api/employees/${aId}`).set('Cookie', admin).send({ hourly_rate_cents: 3000 }).expect(200);
  clock.advance(3_600_000);
  let s = (await request(app).get('/api/tasks').set('Cookie', admin).expect(200)).body[0];
  assert.equal(s.burn_rate_cents_per_hour, 2000); // snapshot rate unchanged
  assert.equal(s.consumed_cents, 2000);

  await request(app).post(`/api/tasks/${t}/clock-out`).set('Cookie', admin).send({ employee_id: aId }).expect(200);
  await request(app).post(`/api/tasks/${t}/clock-in`).set('Cookie', admin).send({ employee_id: aId }).expect(201);
  s = (await request(app).get('/api/tasks').set('Cookie', admin).expect(200)).body[0];
  assert.equal(s.burn_rate_cents_per_hour, 3000); // new rate now applies
});
