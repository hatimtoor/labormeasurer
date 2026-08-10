'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTaskSnapshot, MS_PER_HOUR } = require('../src/calc');

const task = (budgetCents) => ({ id: 1, budget_cents: budgetCents });
const session = (rate, inMs, outMs = null) => ({
  task_id: 1,
  employee_id: 1,
  rate_cents_snapshot: rate,
  clock_in_ms: inMs,
  clock_out_ms: outMs,
});

test('no sessions: paused, full budget', () => {
  const s = computeTaskSnapshot(task(100_000), [], 0);
  assert.equal(s.remaining_seconds, null);
  assert.equal(s.burn_rate_cents_per_hour, 0);
  assert.equal(s.consumed_cents, 0);
  assert.equal(s.remaining_cents, 100_000);
  assert.equal(s.exhausted, false);
});

test('$1000 budget, $20/hr single worker => 50h = 180000s', () => {
  const s = computeTaskSnapshot(task(100_000), [session(2000, 0)], 0);
  assert.equal(s.remaining_seconds, 180_000);
  assert.equal(s.budgeted_seconds_at_current_burn, 180_000);
});

test('challenge example: $800 remaining at $45/hr => exactly 64000s (17h46m40s)', () => {
  // consumed $200 at $20/hr = 10h; then B ($25/hr) joins
  const tenHours = 10 * MS_PER_HOUR;
  const sessions = [session(2000, 0), { ...session(2500, tenHours), employee_id: 2 }];
  const s = computeTaskSnapshot(task(100_000), sessions, tenHours);
  assert.equal(s.consumed_cents, 20_000);
  assert.equal(s.remaining_cents, 80_000);
  assert.equal(s.burn_rate_cents_per_hour, 4500);
  assert.equal(s.remaining_seconds, 64_000);
});

test('exhaustion is an exact integer comparison at the boundary', () => {
  // $1 budget, $1/hr => exhausted at exactly 1 hour
  const justBefore = computeTaskSnapshot(task(100), [session(100, 0)], MS_PER_HOUR - 1);
  assert.equal(justBefore.exhausted, false);
  assert.equal(justBefore.remaining_seconds, 0); // floor(<1000ms worth) = 0s but not exhausted yet
  const atBoundary = computeTaskSnapshot(task(100), [session(100, 0)], MS_PER_HOUR);
  assert.equal(atBoundary.exhausted, true);
  assert.equal(atBoundary.remaining_seconds, 0);
});

test('over budget: remaining goes negative, over_budget_cents positive, hours keep accruing', () => {
  const s = computeTaskSnapshot(task(100), [session(100, 0)], 2 * MS_PER_HOUR);
  assert.equal(s.exhausted, true);
  assert.equal(s.remaining_cents, -100);
  assert.equal(s.over_budget_cents, 100);
  assert.equal(s.remaining_seconds, 0);
  assert.equal(s.total_worked_ms, 2 * MS_PER_HOUR);
});

test('no per-session rounding drift: 3 workers at odd rates for odd durations', () => {
  // rates that don't divide evenly: 1234c/hr for 1h1m7s etc.
  const sessions = [
    session(1234, 0, 3_667_000),
    { ...session(2077, 500, 5_000_321), employee_id: 2 },
    { ...session(999, 12_345, 9_876_543), employee_id: 3 },
  ];
  const s = computeTaskSnapshot(task(1_000_000), sessions, 10_000_000);
  const exact =
    1234 * 3_667_000 + 2077 * (5_000_321 - 500) + 999 * (9_876_543 - 12_345);
  assert.equal(s.consumed_cents, Math.round(exact / MS_PER_HOUR));
});

test('open session elapsed is clamped at zero (defense against clock anomalies)', () => {
  const s = computeTaskSnapshot(task(100_000), [session(2000, 5000)], 0);
  assert.equal(s.consumed_cents, 0);
});

test('budget lowered below consumed => instantly exhausted', () => {
  const s = computeTaskSnapshot(task(1000), [session(2000, 0, MS_PER_HOUR)], MS_PER_HOUR);
  assert.equal(s.consumed_cents, 2000);
  assert.equal(s.exhausted, true);
  assert.equal(s.remaining_cents, -1000);
});
