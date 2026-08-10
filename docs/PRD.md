# LaborMeasurer — Product Requirements Document

**Version:** 1.1 · **Status:** v1 shipped; Phases 1–2 implemented (see §4 notes) · **Owner:** Hatim Toor
**Origin:** 24-hour development challenge (Singam Singh) — countdown labor budget tracking

---

## 1. Vision

Every hour a crew works, money drains from a task's labor budget. Traditional time tracking
tells managers what was *spent* — after the week is over, when it's too late. LaborMeasurer
inverts the model: **a live countdown showing how much longer the current crew can work
before the task's labor budget is gone.**

> "At the current crew cost, how much longer can this crew work before this task's labor
> budget is exhausted?" — answered live, on one screen, while the work is happening.

**Core mechanic:** `Remaining Time = Remaining Labor Budget ÷ Current Crew Burn Rate`,
recalculated automatically on every clock-in, clock-out, rate change, budget change, and
crew change.

This is not an attendance app. It is **task-level labor cost control and real-time
profitability visibility**.

### Market position

Researched during the challenge: no commercial product (Hubstaff, Everhour, busybusy,
WorkMax, Procore, ClickTime) and no open-source project (Kimai, Solidtime, OpenProject,
Odoo, ERPNext) implements a live countdown driven by the summed rates of the currently
clocked-in crew. The market offers budget *reports*, threshold *alerts*, and auto-stop
timers — never the live "time until the money runs out" clock. This mechanic is the
product's differentiation and must stay central to every design decision.

---

## 2. Users

| Persona | Needs |
|---|---|
| **Site / project manager** (primary) | See every task's burn at a glance; know *before* a task goes over budget; control who's assigned; adjust budgets; prove labor cost to the office |
| **Worker / crew member** | One-tap clock in/out; see their assigned tasks; optionally see the countdown so the crew self-manages pace |
| **Owner / office admin** | Cross-project profitability, payroll-grade records, rate confidentiality, exports |
| **(Future) Payroll / accounting** | Clean, immutable time records that reconcile with payroll and job costing |

**Rate confidentiality is a hard requirement:** a worker must never be able to see a
co-worker's hourly rate or individual cost, in any payload, ever. (Shipped: server-side
redaction; aggregates like crew burn rate are shown only when management enables the
countdown for the crew.)

---

## 3. Current state — what is built and working (v1.0)

Deployed as a Node.js/Express app backed by Supabase (or SQLite standalone), pushed to
`github.com/hatimtoor/labormeasurer`. All 11 success criteria of the original challenge
pass in an automated test and were verified live against Supabase.

### 3.1 Core engine (the product's heart)
- Immutable session records (clock-in/out with an hourly-rate snapshot per session);
  every figure — consumed, remaining, burn rate, countdown — is **derived, never stored**,
  so history is never lost and recalculation is automatic by construction.
- Exact integer arithmetic (cents × milliseconds; single division at the API boundary;
  exhaustion decided by integer comparison — no rounding drift, verified to the cent).
- Over-budget behavior: countdown pins at 0:00:00, "LABOR BUDGET EXHAUSTED" banner,
  over-budget dollars accumulate, actual hours keep recording.
- Edge cases handled: mid-session rate edits (snapshot preserved), budget lowered below
  consumed, $0/hr crew, unassignment auto-closes sessions, one-open-session-per-worker
  invariant enforced at the database level, clock-skew clamps.

### 3.2 Management features
- Tabbed admin dashboard (Tasks / Employees / Settings): create/edit/archive/delete tasks,
  budgets in dollars, per-task countdown visibility toggle, assign crews, clock anyone
  in/out, live per-task cards (budget / used / remaining / %, crew now, crew cost/hr,
  hours worked, cost by employee), employee roster with inline rate edits and safe delete
  (blocked once hours exist).
- Demo **time-warp** (advance-only simulated clock) for demos and training.

### 3.3 Worker features
- Login → assigned tasks → one-tap clock in/out (stateful green/red toggle), countdown
  visible when management permits.

### 3.4 Platform
- **Real-time:** SSE full-state snapshots pushed on every change; drift-free client
  countdown (re-derives from snapshot + monotonic clock each second; never decrements).
- **Backends:** pluggable data layer — Supabase REST (service key), direct Postgres,
  or local SQLite — selected by environment at boot.
- **Security:** scrypt password hashing, HMAC cookie sessions, login rate limiting,
  timing-attack mitigations, security headers, server-side rate redaction, role checks
  on every route, parameterized queries, XSS-escaped rendering.
- **Quality:** 19 unit/scenario tests (including the challenge's 11-step scenario with
  exact assertions) + 31-check live E2E suite covering every endpoint and permission path.
- Three security/correctness review passes performed; all critical findings fixed
  (notably: compensation-data leak, stranded sessions on unassignment, PostgREST row-limit
  truncation that would have silently under-reported consumed budget).

### 3.5 Known limitations (v1 accepted trade-offs)
- Sessions are stateless HMAC cookies → **no server-side revocation** on logout/password change.
- Supabase REST write latency ≈ network round-trip (~1s at distance); direct-Postgres mode is faster and already supported.
- Assignment replacement over REST is not one atomic transaction (it is under direct Postgres/SQLite).
- Single-process server; SSE state is in-memory (no horizontal scaling yet).
- No breaks/overtime/rounding rules; a session is raw wall-clock time.
- Demo seed credentials; no password reset flow; English-only; browser-only.

---

## 4. Roadmap — from working v1 to full-fledged product

Priorities: **P0** = required for real production use · **P1** = strong differentiation /
major workflow value · **P2** = scale and polish.

### Phase 1 — Production hardening (P0) — **SHIPPED** (1.1–1.4, 1.5 partial: Docker+CI done, hosting/Sentry pending; 1.6 partial; 1.7 done)

| # | Requirement | Notes |
|---|---|---|
| 1.1 | **Real auth lifecycle** — migrate to Supabase Auth (or add a sessions table): revocation on logout/password change, password reset via email, invite flow for new employees | Replaces the v1 HMAC cookie; removes seed credentials |
| 1.2 | **Atomic operations everywhere** — move multi-step REST sequences (assignment swap) into Postgres RPC functions; prefer direct-Postgres connection in production | Kills the last consistency gap + cuts write latency ~3× |
| 1.3 | **Audit trail** — append-only log of every budget change, rate change, assignment change, and manual clock action (who, what, when, old→new) | Labor cost data is money data; disputes need receipts |
| 1.4 | **Timesheet corrections with approval** — admins can edit/void a session via a correction record (never mutate the original row), with reason + audit entry | Real crews forget to clock out; today that data is stuck |
| 1.5 | **Deployment story** — Dockerfile, hosted deployment (Fly/Railway/Render), TLS, environment-based config, CI (GitHub Actions: tests on PR), error monitoring (Sentry), automated DB backups | Currently runs on a laptop |
| 1.6 | **Time zone correctness** — store UTC (done), render in site-local zone, handle DST in daily summaries | |
| 1.7 | **Remove demo affordances from production builds** — time-warp behind an env flag; seeded credentials never in prod | |

### Phase 2 — The manager's power tools (P1) — **SHIPPED** (2.1 as flat projects+rollups; 2.2–2.8 done; alerts are in-app+webhook, email/SMS pending; reports are CSV, payroll formats pending)

| # | Requirement | Notes |
|---|---|---|
| 2.1 | **Projects → tasks hierarchy with cost codes** — budgets roll up (task → phase → project); the countdown exists at every level | Matches how construction/manufacturing actually bids work |
| 2.2 | **Labor burden multiplier** — true cost = wage × burden (taxes, insurance, benefits, typically 1.25–1.4×); burn rate and countdown use burdened cost | v1 undercounts real labor cost |
| 2.3 | **Threshold alerts** — configurable notifications at 50/75/90/100% budget consumed, and "crew can only work N more hours" warnings — email, SMS, push, webhook | The countdown is the display; alerts are the safety net when nobody is looking |
| 2.4 | **Budgeted-hours mode** — budgets definable in hours as well as dollars (the original brief's "allowed task hours") | |
| 2.5 | **Overtime / break / rounding rules** — configurable OT multipliers (e.g. 1.5× after 8h/day), unpaid break deduction, minute-rounding policies | Payroll-grade accuracy |
| 2.6 | **Reports & exports** — per task/project/employee/date-range: hours, cost, over/under budget, profitability; CSV + PDF; payroll export (QuickBooks/ADP format) | |
| 2.7 | **Wall display mode** — full-screen rotating countdown board for a site office TV | The countdown is at its best when the whole crew sees it |
| 2.8 | **Historical burn-down chart** — per task: budget line vs actual consumption over time, projected exhaustion date at current pace | |

### Phase 3 — Field reality (P1)

| # | Requirement | Notes |
|---|---|---|
| 3.1 | **Mobile PWA** — installable, offline-capable clock in/out that queues events and syncs when connectivity returns (conflict rule: server-side one-open-session invariant wins) | Job sites have bad signal; this is the #1 field requirement |
| 3.2 | **Kiosk mode** — one shared tablet at the site entrance; workers clock in with PIN or badge QR | Crews don't all have company phones |
| 3.3 | **Geofencing (optional per task)** — GPS check on clock-in, flag (not block) out-of-bounds punches for review | Trust-but-verify; blocking creates field friction |
| 3.4 | **Crew clock-in** — foreman clocks an entire crew in/out in one action | Shipped in single-select form; extend to multi-select one-tap |

### Phase 4 — Platform & scale (P2)

| # | Requirement | Notes |
|---|---|---|
| 4.1 | **Multi-tenancy** — organizations with isolated data (Postgres RLS), per-org admins, worker membership | Prerequisite for offering this as SaaS |
| 4.2 | **Granular roles** — owner / admin / project manager / foreman / worker; per-project permissions | v1 is admin-or-worker |
| 4.3 | **Horizontal scaling** — replace in-process SSE with Supabase Realtime (or Redis pub/sub) so multiple server instances share broadcasts; per-task channel granularity | Also removes the multi-instance clock-offset caveat |
| 4.4 | **Public API + webhooks** — API keys, documented REST API, webhooks on clock events and threshold crossings | This is the GTOS integration path: GTOS consumes the API/webhooks or embeds the wall display |
| 4.5 | **Rate history table** — effective-dated rates instead of a single current rate (v1 preserves history via per-session snapshots; this adds forward scheduling: "raise takes effect next Monday") | |
| 4.6 | **i18n + accessibility audit** — externalized strings; WCAG AA pass (labels shipped; contrast/screen-reader audit pending) | |
| 4.7 | **Data retention & compliance** — configurable retention, export-all, delete-org; labor-record retention rules vary by jurisdiction | |

---

## 5. Non-functional requirements

| Area | Requirement | v1 status |
|---|---|---|
| Correctness | Money math exact to the cent; countdown mathematically consistent with stored records at all times | ✅ shipped, test-enforced |
| Latency | Interactive actions < 300ms perceived (optimistic UI + direct DB); countdown tick drift < 1s over 24h | ~1s on REST backend; direct-Postgres mode + Phase 1.2 close the gap |
| Availability | 99.9% for the SaaS offering; offline clock capture in the field (Phase 3.1) | single instance today |
| Security | No rate/compensation data to non-admins (hard invariant); OWASP top-10 clean; secrets never in repo | ✅ shipped + reviewed; auth lifecycle gap closes in Phase 1.1 |
| Scale target | 200 concurrent workers, 500 tasks, 1M session rows per org without degradation | paginated reads shipped; needs Phase 4.3 for fan-out |
| Auditability | Every dollar-affecting change attributable to a user and timestamp | Phase 1.3 |

---

## 6. Success metrics

- **Activation:** a new org reaches first real clock-in against a budgeted task in < 15 minutes.
- **Core value:** ≥ 80% of over-budget tasks showed a visible warning state (yellow/red) at least 4 working hours before exhaustion.
- **Trust:** zero discrepancies between countdown-displayed consumption and payroll-report totals (same derived source — enforced by architecture).
- **Field adoption:** median clock-in action < 5 seconds from phone unlock (Phase 3).
- **Retention proxy:** % of tasks created with a budget (if managers stop entering budgets, the countdown — the product — is not being used).

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Countdown misread as a deadline ("work faster") rather than a budget instrument → crew resentment | Per-task visibility toggle (shipped); positioning/education in onboarding; show "budget hours," never personal productivity scores |
| Rate confidentiality breach would be catastrophic for customer trust | Hard server-side redaction (shipped + regression-tested); keep as release-blocking test forever |
| REST-backend latency erodes the "live" feel | Direct Postgres in production (supported today); optimistic UI; Phase 1.2 |
| Payroll-grade expectations (OT, breaks, corrections) arrive before Phase 2.5/1.4 ship | Be explicit in marketing: v1 is budget control, not payroll of record |
| Single-developer bus factor | Tests are the spec (19 unit + 31 E2E); this PRD is the roadmap of record |

---

## 8. Out of scope (deliberately)

- General project management (Gantt, dependencies, documents) — integrate, don't compete.
- Invoicing/estimating — export to existing tools instead.
- Employee monitoring (screenshots, activity tracking) — explicitly against product values;
  the product measures *task budgets*, not people.
- Materials/equipment cost tracking — labor only until the labor loop is world-class.

---

## 9. Open questions

1. GTOS integration surface: does GTOS want API/webhooks (4.4), an embedded wall display (2.7), or database-level integration?
2. SaaS vs internal tool: multi-tenancy (4.1) is only P2 if this stays internal; it becomes P0 the moment it's sold.
3. Burden rates (2.2): single org-wide multiplier or per-employee? (Per-employee is more accurate; org-wide ships faster.)
4. Should workers *ever* see dollar figures (crew burn rate) or strictly time remaining? Currently a per-task management toggle governs aggregates; individual rates are never shown.
