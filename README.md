# ⏳ LaborMeasurer — Countdown Labor Budget Tracker

**24-Hour Development Challenge deliverable.** A working system that tracks tasks by a
**countdown labor budget** instead of a count-up timer:

```
Remaining Time = Remaining Labor Budget ÷ Current Crew Burn Rate
```

The countdown recalculates live whenever anyone clocks in or out, a rate or budget
changes, or the demo clock advances. At `0:00:00` the dashboard shows
**LABOR BUDGET EXHAUSTED** and starts accumulating over-budget dollars — while actual
worked hours continue to be recorded, never lost.

---

## Quick start

```bash
npm install
npm run seed     # demo data (see logins below)
npm start        # http://localhost:3000
npm test         # includes the full 11-step success scenario
```

## Database backends: Supabase Postgres or local SQLite

With no configuration the app runs on a local SQLite file — zero setup, perfect
for demos. To run on **Supabase**, create `.env` in the project root with the
direct Postgres connection string:

```
SUPABASE_DB_URL=postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Find it in the Supabase dashboard: **Connect** (top of the project page) →
**Transaction pooler** URI. Note this is the *database* connection string with
your DB password — the `https://` project URL and `anon`/`service_role` API
keys are a different mechanism and are not used by this server.

The server picks the backend automatically at boot (it logs which one), the
schema is created on first run, and `npm run seed` seeds whichever backend is
configured. Tests always run on in-memory SQLite and never touch Supabase.
`.env` is git-ignored — never commit credentials.

Demo logins (from `npm run seed`):

| Login | Password | Role |
|---|---|---|
| `admin` | `admin` | Manager (dashboard, time-warp, all controls) |
| `workera` | `worker` | Worker A — **$20/hr** |
| `workerb` | `worker` | Worker B — **$25/hr** |

Seeded task: **Frame Unit 101** with a **$1,000** labor budget, both workers assigned.

## Proving the 11-step success scenario (≈2 minutes)

Open two browser windows: one as `admin`, one as `workera`.

1. Task with $1,000 budget already exists (or create one in the sidebar).
2. Worker A ($20/hr) is seeded.
3. As Worker A, press **Clock IN**.
4. Both windows show **50:00:00** counting down ($1,000 ÷ $20/hr).
5. As admin, press **+10 h** in the Demo Time-Warp panel → Used $200, Remaining $800.
6. Log in as `workerb` (third window or reuse) and **Clock IN** ($25/hr).
7. Countdown instantly recalculates: $800 ÷ $45/hr = **17:46:40**.
8. Worker B presses **Clock OUT**.
9. Countdown recalculates at Worker A's $20/hr.
10. Admin presses **+10 h** repeatedly → countdown reaches **0:00:00** → red **LABOR BUDGET EXHAUSTED** banner.
11. Advance further → over-budget dollars tick up, Worker A's actual hours keep accruing in the table.

The same scenario runs headlessly with exact integer assertions: `npm test`
(`test/scenario.test.js`).

> The challenge text says step 7 shows "17 hours 47 minutes"; the exact value of
> $800 ÷ $45/hr is 17.7̅ hours = **17:46:40**, which is what the system displays and
> what the tests assert.

---

## Research: does this already exist? (Option A report)

Per the challenge, existing SaaS and open-source solutions were surveyed first.
**Verdict: no product — commercial or open-source — implements a live countdown
driven by the combined burn rate of the currently clocked-in crew.** The market
offers three weaker patterns: budget dashboards/burn-down *reports*, threshold
*alerts* (75/90/100%), and *auto-stop* timers at a budget limit.

| Product | Type / cost | What it has | What's missing |
|---|---|---|---|
| [Hubstaff](https://hubstaff.com) | SaaS ~$7–15/user/mo | $ budgets, % alerts, auto-stop timers at budget | No countdown; remaining budget is a static number; no crew-rate math |
| [Everhour](https://everhour.com) | SaaS ~$8.50/user/mo | $/hr budgets, "remaining" figure, auto-stop | Same — no countdown, no dynamic divisor |
| [busybusy](https://busybusy.com) | SaaS, free tier | Construction labor budgets, live budget-vs-actual bars | Progress bars, not a ticking clock |
| [WorkMax INSIGHT](https://workmax.com) | SaaS, quote | "Current pace / pace needed" analytics | Reports, not a live countdown |
| [Procore](https://procore.com) | Enterprise | Real-time labor productivity budget views | Updates on timesheet submission only |
| [Kimai](https://github.com/kimai/kimai) | OSS (AGPL-3.0) | Money budgets, per-user rates, overbooking block | Countdown is an open feature request (#2878); budget math counts stopped timers only. Closest modification target: ~1–2 week plugin |
| [Solidtime](https://github.com/solidtime-io/solidtime) | OSS (AGPL-3.0) | Live spend display, 4-tier rates | Hours-only budgets, no countdown |
| OpenProject / Odoo / ERPNext / Redmine | OSS | Batch labor costing | No live timers/countdown; heavy frameworks |
| Invoice Ninja / Anuko | Source-available | Task timers, hour budgets | Restrictive licenses, no countdown |

Every tracker models "one user runs one timer against a project." This feature is
**task-centric** — "what does the crew on this task cost per hour right now, and when
does the money run out" — which is architecturally alien to all of them. Building
a purpose-built MVP was faster than modifying any host codebase (**Option B**).
If integration into a larger suite is later required, **Kimai** is the recommended
modification target.

---

## What was built (Option B)

### Feature checklist

**Admin** — create employees with hourly rates · create tasks with $ budgets ·
assign crews · clock anyone in/out · edit budgets/rates live · per-task dashboard:
budget / used / remaining, % bars, live countdown, active crew + rates, combined
burn rate, hours worked, cost by employee, over-budget amount · hide/show the
countdown per task from employees · demo time-warp.

**Employee** — log in · see assigned tasks · clock in/out · see the countdown when
management permits.

**System** — every clock-in/out stored as an immutable session row with a rate
snapshot · all figures derived on demand from those rows (nothing overwritten, so
history is never lost) · multiple simultaneous workers · automatic recalculation on
every event · works after budget hits zero.

### Architecture

```
Node.js + Express + better-sqlite3 (WAL) — no build step, no external services
├── src/calc.js        pure calculation engine (the whole feature in one function)
├── src/clock.js       single source of domain time (+ advance-only demo time-warp)
├── src/store.js       prepared statements + snapshot assembly
├── src/sse.js         Server-Sent Events hub, role-redacted broadcasts
├── src/auth.js        scrypt password hashes, stateless HMAC cookie sessions
├── src/routes/        REST API (login, employees, tasks, clock in/out, timewarp)
└── public/            vanilla JS SPA — countdown recomputes from snapshot each
                       second (never decrements → no drift), SSE keeps it in sync
```

**Correctness details**

- All money in integer cents, all time in integer ms. The consumed-labor numerator
  `Σ(rate_cents × duration_ms)` stays exact; division happens once at the API
  boundary. Exhaustion is a pure integer comparison — no rounding in the decision.
- Open sessions snapshot the worker's rate at clock-in; changing a rate never
  rewrites history.
- One open session per employee, enforced by a partial unique index.
- Server restarts are safe: open sessions persist and keep accruing; the time-warp
  offset is persisted so domain time never runs backwards.

### API

`POST /api/login` · `POST /api/logout` · `GET /api/me` ·
`GET|POST|PATCH /api/tasks` · `PUT /api/tasks/:id/assignments` ·
`POST /api/tasks/:id/clock-in|clock-out` · `GET|POST|PATCH /api/employees` ·
`GET /api/events` (SSE) · `GET|POST /api/timewarp`

MIT licensed. Integrates into a larger system (e.g. GTOS) via the REST API, or the
pure engine (`src/calc.js`, zero dependencies) can be lifted directly.
