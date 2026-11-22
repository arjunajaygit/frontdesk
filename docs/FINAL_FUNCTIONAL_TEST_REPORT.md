# Final functional test report (2026-11-22)

This is an independent end-to-end audit of Frontdesk against the original assessment. Every result below was executed during this audit; nothing is carried over from earlier documents without re-running it. The requirement mapping is in `docs/FINAL_ASSESSMENT_COMPLIANCE.md`.

**Environment.**
- *Local:* macOS (Apple Silicon), Node 24, dedicated Docker PostgreSQL 16.14 (`frontdesk-postgres`). Integration tests use throw-away cloned databases; e2e uses its own `frontdesk_e2e` database, its own API port (3100) and its own web port (5273). Production was never used for tests.
- *Hosted:* https://frontdesk-arvo-support.onrender.com (Render Free + Supabase PostgreSQL 17). Only synthetic verification data was mutated; reviewer accounts were only signed in.

## 1. Complete quality suite

All commands were run sequentially on the final code of branch `verify/final-assessment`.

| Command | Result | Tests |
|---|---|---|
| `npm run build` | PASS | contracts, API, web (Vite production bundle) |
| `npm run typecheck` | PASS | API, web, tests |
| `npm run lint` | PASS | ESLint, whole repository |
| `npm run format:check` | PASS | Prettier, whole repository |
| `npm run test:calendar` | PASS | 12/12 (preserved calendar kernel) |
| `npm run test:unit` | PASS | 164/164 in 15 suites (domain with deterministic clocks, config, OpenAPI, SQL templates) |
| `npm run test:web` | PASS | 28/28 in 5 files |
| `npm run test:integration` | PASS | **219/219 in 26 suites** (real PostgreSQL, real HTTP sessions) |
| `npm run test:e2e` | PASS | **49/49** (real Chromium; two consecutive full runs green) |
| `npm run verify:openapi` | PASS | 8/8 (OpenAPI-aware validation of the contract and fixtures) |
| `npm run verify:secrets` | PASS | 326 files scanned; `.env` and `.local/` ignored and untracked |
| `npm run test:release-gate` | PASS | 9/9 |

**Failed runs during the audit, in order (none bypassed).**

| Run | Failure | Root cause | Fix | Retest |
|---|---|---|---|---|
| Baseline `npm run build` | Vite could not resolve `@fontsource-variable/inter` | Environment: this checkout's `node_modules` predated the merged redesign (CI's clean `npm ci` was unaffected) | `npm ci` from the committed lockfile | build PASS |
| Baseline e2e (new spec) | `log-safety`: session-context values found in server logs | **Defect:** the `X-Session-Context` header was not in pino's redaction list | Added to the redaction paths | PASS |
| Baseline e2e (new spec) | `runtime-health`: `networkidle` never reached on /login and the portal | Test harness: under the Vite dev server, React StrictMode's aborted duplicate session probe stays pending in Chromium's request tracking (the server answers in < 1.3 s; verified on production) | Deterministic observation window instead of `networkidle` | PASS |
| `runtime-health` rerun | Console error: 403 from `POST /api/auth/refresh` on the signed-out login page | Not a defect: refresh is a session mutation, so the CSRF guard rejects a visitor with no session (403), and `restoreSession` handles 401/403 as "signed out". Loosening the guard was rejected. | The allow-list names exactly this documented probe | PASS |
| `audit-completeness` (new) | `ticket_state_fields` check constraint rejected the test's fixture update | Test setup moved `reopenUntil` without `resolvedAt`; the database correctly enforces their consistency | The fixture moves both fields together | PASS |
| `lint` | `document`/`window` undefined in `scripts/hosted-runtime-health.mjs` | Browser-context globals inside `page.evaluate` callbacks | Declared as globals for that file | PASS |
| Full e2e | `a11y` login: intermittent axe colour-contrast failure on the sign-in button | **Defect (determinism):** axe sampled the card during its 220 ms entrance fade | Removed the sign-in card's entrance animation | PASS (2 runs) |
| Full e2e | `smoke` and `workflows` queue test failed | My new `assessment-flows` spec created newer and unassigned-urgent tickets, exposing a hidden run-order dependency in `smoke` ("first row is seeded") | `smoke` opens a seeded ticket explicitly; the urgent ticket from the new spec is claimed by an agent, as in real use | PASS (2 runs) |
| CI on PR #14 (integration) | `shutdown-drain` (M03): the `shutdown:` log record was not found, although the process drained and exited by SIGTERM | **Test-harness defect (latent race):** stdout chunks were split on newlines independently, so a JSON line straddling a chunk boundary was lost; also `exit` can fire before stdio is fully read | Line assembly across chunks; wait for `close` instead of `exit` | 3 consecutive local passes; CI rerun on the PR |

## 2. Requirement-focused verification

### A. SLA policy
- **Covered by unit tests with deterministic clocks** (`sla-clock`, `calendar-adapter`, calendar kernel):
  - independent response and resolution clocks;
  - weekends and consecutive holidays skipped;
  - after-hours intake starts at the next opening;
  - Friday-evening crossings;
  - Friday 18:00 urgent: reply Monday 11:00, resolution Friday 18:30 (equality on time, +1 ms late, still late Sunday);
  - public reply completes the response clock, while a note or staff intake never does;
  - historical breaches survive a later priority change.
- **Real PostgreSQL:** `proof-01` (5 tests).
- **UI:** clock cards read only server fields (`remainingMs`, `deadlineAt`, `currentLate`). The e2e lifecycle asserts On track → Paused → Completed transitions in the cards.

### B. Priority changes
Unit (`priority.test`, 11 tests) and integration (`proof-01`) cover:
- LOW → MEDIUM and MEDIUM → URGENT (using the original effective cycle start);
- URGENT → LOW after a recorded breach (lateness cleared, history kept);
- a change while paused, and a change after the first response completed;
- a change near the deadline (equality on time, +1 ms breach at change time).

The e2e audit story shows "Priority Medium → Urgent". The audit records previous/new priority and per-clock before/after (`audit-completeness`).

### C. INC-0291 exclusive claim
- `proof-02`: 2 and 9 independently authenticated agents with forced overlap give exactly one 200, the rest 409, and one `TICKET_CLAIMED`. An audit-insert failure rolls the claim back.
- e2e: two agent browsers click Claim together; the loser is told who won and the page refreshes.
- `audit-completeness`: a losing claim writes no audit row.
- Lifecycle: only the assignee may mutate.
- Live: 9-agent race, one 200 and eight 409.

### D. INC-0304 private notes
- **Integration:** `proof-03` (12 tests) covers the customer list, detail, more than 500-message paging, the JSON and CSV export, cross-customer 404, replay and staff-only error fields.
- **Browser:** e2e `privacy.spec` (10 tests) checks the customer DOM, every network response and the exports downloaded in the browser.
- **Composer:** the web unit test proves a note draft never becomes the public draft.
- **Live:** `hosted-verify` and `hosted-browser` repeat the privacy checks on the deployed site.

### E. INC-0318 immutable audit
- `proof-04`: the runtime role is denied UPDATE, DELETE and TRUNCATE by privilege, and triggers reject mutation even by the owner. An audit failure rolls back the business change. It also reconstructs why a ticket was late and when the reply became visible.
- New `audit-completeness`: all 15 event types are recorded with the correct actor, before/after details, event time separate from recording time, ordered recording times and no message bodies.
- Live: the Supabase runtime role is denied as well, and `03-verify.sql` passes 9/9.

### F. Waiting, auto-close, reopening
- **Unit:** cutoff at exactly 2,700 working minutes, with the cutoff instant and +1 ms tested on both the reply path and the sweep path. Also covered: reopen at `reopenUntil` and at +1 ms, contact on an already closed ticket, and a sweep racing a customer reply.
- **Integration:**
  - `proof-05`: overlapping invocations, crash recovery, backlog and SKIP LOCKED;
  - `audit-completeness`: SYSTEM auto-close with `AUTO_CLOSED_NO_REPLY` and an idempotent replay.
- **Live:** an auto-close by the deployed scheduler; a Supabase Cron call that auto-closed an overdue verification ticket (audit-correlated to `ext-cron-202611221300`); and reopen, expiry and linked tickets via `hosted-verify`.

## 3. Frontend workflows (redesigned UI, real browser)

| Area | Evidence | Result |
|---|---|---|
| Authentication | `sessions.spec` 13 tests (login, invalid credentials, session restore after access expiry, confirmed and unconfirmed logout, two tabs/one browser, cross-tab sign-out); `privacy.spec` (HttpOnly/path-scoped cookies, no tokens in storage) | PASS |
| Staff views | All seven views opened in `runtime-health`; server filters in `workflows` "queue views and filters"; priority filter | PASS |
| Pagination and refresh | New `assessment-flows`: Load more pages through the server cursor; every ticket exactly once; count equals the database | PASS |
| Ticket detail and actions | `workflows` full lifecycle via clicks only: portal create → claim → note (draft isolation) → public reply → request information → customer reply → priority change → resolve → reopen → audit explanation | PASS |
| Linked follow-up after expiry | `workflows` "customer follow-up after the reopen window creates a linked ticket" | PASS |
| Staff intake for a customer, requested priority | New `assessment-flows` (dialog → Urgent ticket in that customer's portal; "Customer asked for urgent" with authoritative Medium) | PASS |
| Customer portal | Own-ticket isolation (404 for others), new ticket, list/detail, reply, reopen, follow-up, JSON/CSV download (`privacy`, `workflows`) | PASS |
| Administration | Lead sweep with real results (`workflows`); agents have no sweep in the UI and get 403 from the API | PASS |
| Responsive and accessibility | `a11y-responsive` (axe, no serious/critical issues at 1440/1024/390, no page scroll or horizontal overflow, touch targets, dialog focus trap and return, reduced motion) | PASS |
| Runtime health | New `runtime-health`: every screen as lead and as customer at desktop and phone widths with zero console errors or warnings, page errors, failed assets or API 5xx | PASS |
| Log safety | New `log-safety`: the compiled server at trace level never logs passwords, cookie/token values, CSRF tokens or session contexts | PASS (after fix) |

## 4. Backend, database and security

**Covered by integration suites:**
- *Access control:* ownership and role restrictions (`proof-03`, `http-tickets`, `remediation-*`).
- *Database roles:* runtime-role restrictions (`db-security`, `remediation-h04-runtime-role`, `proof-04`).
- *Idempotency:* replay with the same key, key-and-body mismatch, and unauthorised replay (`http-tickets`, `proof-03`).
- *Transactions and locking:* rollback (`proof-02`, `proof-04`); row locking and SKIP LOCKED (`proof-05`, `remediation-tickets`).
- *Input and errors:* validation and error envelopes (`http-tickets`, `http-auth`).
- *Rate limits:* per verified user and per IP (`final-audit-auth`, `rate-limiter`).
- *Health:* liveness and readiness (`http-static`, `seed`).
- *Schema:* migration and constraint consistency (`db-constraints`, `seed`).
- *Contract:* OpenAPI (`verify:openapi`).
- *Logs:* safe logging (`log-safety`).

Live:
- *Health and contract surface:* `/api/healthz` 200 with the deployed commit; `/api/readyz` 200, so Supabase is reachable. Swagger/OpenAPI and `/api/metrics` return 404.
- *Access control:* protected APIs return 401 without a session; the machine sweep endpoint returns 401 without its token.
- *Static paths:* `/.env`, `/swagger` and `/metrics` return only the SPA shell HTML.
- *Transport and headers:* HTTP 301 → HTTPS, HSTS, strict CSP with `frame-ancestors 'none'`, CORP/COOP/COEP, nosniff, no-referrer.

## 5. Hosted deployment

**Current deployment before this audit's fixes** (`136ee89`, digest `ebf7a980…`):
- smoke 29/29, `hosted-verify` 29/29, `hosted-browser` 8/8, 0 px page scroll;
- cron slots 11:30 / 12:00 / 12:30 / 13:00 all returned HTTP 200 with persisted SYSTEM invocations;
- the 12:30 slot hit a **sleeping instance** (cold start about 38.6 s, one sample);
- the 13:00 slot auto-closed an overdue verification ticket. Evidence and method are in `docs/M8_DEPLOYMENT_EVIDENCE.md`. No duplicate scheduler tests were started by this audit.

**New `hosted-runtime-health` on that deployment: FAIL.** Every page, at every width, logged one console warning: an unrecognised Permissions-Policy feature (`browsing-topics`). There were no other warnings, errors, failed assets or overflow. This is fixed in this branch, and the hosted re-verification of the fix release is recorded below.

### Hosted re-verification after the fix release
**The release chain for the fixes:**
- PR #14 merged as `741fee7`; CI `45044659609` and Security `45044659628` both passed.
- Release `45045027702` produced digest `sha256:aa4577a0…c89baba`; signature and CycloneDX attestation were verified independently with cosign.
- The re-scan was unchanged: 38 findings across the same 11 advisories, nothing new, no fix available.
- Deploy `dep-dc1ho7cs728c73cfl4h0` went live at 16:46 UTC. `/api/healthz` reports `741fee7`, and the `Permissions-Policy` header no longer contains `browsing-topics`.

**Live results on `741fee7`:**

| Suite | Result |
|---|---|
| `smoke-prod` | 29/29 |
| `hosted-verify` | 29/29 |
| `hosted-browser` | 8/8 |
| `hosted-runtime-health` (login, staff views + detail + audit, customer list/ticket/new; 1440/1024/390) | **9/9** (was 0/9 before the fix) |

## 6. Known limitations (final)
- **One-week uptime:** time-based, so it cannot be verified yet. Free hosting sleeps when idle (one measured cold start, about 39 s); while asleep, persisted SLA effects can land up to about 30 minutes late (Supabase Cron every 30 minutes).
- **Accessibility:** no manual screen-reader audit (automated axe and keyboard checks only), so there is no WCAG conformance claim.
- **CodeQL:** skipped while the repository was private; it runs on every push since the repository was made public (2026-11-22). ZAP is a passive baseline only.
- **Image findings:** 38 OS-package findings (11 advisories, no fix available) are accepted conditionally by the owner and re-scanned before each deploy.
- **Rate limiting:** in-memory, single instance.
- **Notifications:** no email delivery or read receipts; Frontdesk records when a reply became visible in the app.
- **Effort:** the suggested 8-hour budget was substantially exceeded (disclosed in SHORT_NOTE).
