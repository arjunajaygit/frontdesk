# Final assessment compliance (2026-11-22)

This document maps every requirement in the original hiring assessment (dated 21-11-2026; the PDF is withheld from the
publication repository) to its implementation and to evidence that was **executed**. The assessment gives a story, not
a requirements list, so the rules below are extracted from its sections. The project's own interpretations of the
ambiguous points are listed separately (§I). Run totals and commands are in `docs/FINAL_FUNCTIONAL_TEST_REPORT.md`.

**Status key.**
- **PASS:** implemented and verified by executed tests or live checks.
- **FAIL:** tested and not met.
- **PARTIAL:** implemented incompletely.
- **NOT VERIFIED:** insufficient evidence so far.
- **OUT OF SCOPE:** justified by the source.

**Evidence abbreviations:**
- `U:` unit test (Jest, deterministic clocks);
- `I:` PostgreSQL integration test (real database, real HTTP sessions);
- `E:` Playwright browser test (local stack);
- `L:` live check against https://frontdesk-arvo-support.onrender.com.

## §1 Quick summary

| ID | Original assessment requirement | Implementation | Test evidence | Status |
|---|---|---|---|---|
| Q1 | A working web application: a backend service and a simple screen for support agents | NestJS API + PostgreSQL; React staff workspace and customer portal, served same-origin | I: 26 integration suites; E: 8 browser spec files incl. the full UI lifecycle; L: smoke 29/29, workflows 29/29, browser 8/8 | PASS |
| Q2 | Host it online; it will be opened in a browser | Render Free (Docker image from private GHCR) + Supabase PostgreSQL | L: `/api/healthz` reports the deployed commit; HTTPS with HSTS; `hosted-runtime-health` 9/9 screens clean | PASS |
| Q3 | Send a live URL, a repository link, a README and a short note | URL above; private repo `arjunajaygit/frontdesk`; `README.md`; `SHORT_NOTE.md` | Files exist and were reviewed against the running app (this audit) | PASS (sending them is the owner's action) |

## §2 The situation

| ID | Original assessment requirement | Implementation | Test evidence | Status |
|---|---|---|---|---|
| S1 | Replace the shared spreadsheet / WhatsApp group with a real support system for 9 agents and about 40 tickets a day | Multi-user ticketing with roles (agent, lead, admin, customer), queues and per-ticket ownership | E: two and nine independent agent sessions; M7 k6 mixed profile, local (`docs/M7_EVIDENCE.md`): 9 agents + 3 customers, 1,906 requests in 3 min, p95 20.5 ms, 0 unexpected errors; 9-agent contention 10 won / 80 × 409. Far above 40 tickets a day | PASS |
| S2 | Managers must be able to tell which tickets were late and why; the spreadsheet keeps no history | Append-only `audit_logs`, SLA clock history (breach sequence, first breach) and a "Why was this ticket late?" reconstruction in the UI | I: `proof-04` "reconstructs WHY a ticket was late and WHEN the public reply became visible"; I: `audit-completeness` (new); E: "breached ticket is explained"; Breached view (server `late=true` filter) | PASS |

## §3 Notes from the first meeting (Meera)

| ID | Original assessment requirement | Implementation | Test evidence | Status |
|---|---|---|---|---|
| M1 | Customer cannot work (urgent): reply within 2 hours, fix the same working day | URGENT: response 120 working minutes; resolution = rest of the effective working day | U: "urgent resolution is the rest of the effective day"; "Fri 18:00 urgent → reply Mon 11:00, resolution Fri 18:30; equality on time, +1 ms late" | PASS |
| M2 | Medium: reply within half a day, fix in about three days | MEDIUM: 270 / 1,620 working minutes | U: "Fri 18:00 medium → response Mon 13:30, resolution Wed 18:00"; calendar "medium Friday deadline examples" | PASS |
| M3 | Small problems: reply within one day, finish in about one week | LOW: 540 / 2,700 working minutes | U: priority and lifecycle worked cases with LOW; calendar tests | PASS |
| M4 | Working hours, not clock hours: 09:30–18:30, Monday–Friday | Preserved calendar kernel (`src/calendar.mjs`), Asia/Kolkata, half-open [09:30, 18:30) | Calendar 12/12; U: `calendar-adapter` 14 tests incl. ms precision and the exact closing boundary | PASS |
| M5 | No work on weekends or festival holidays | Weekends skipped; holidays from the `Holiday` table (3 seeded) | Calendar "holiday skipped", "consecutive holidays skip Monday and Tuesday"; U: "resume across a weekend and a holiday consumes nothing" | PASS |
| M6 | A ticket arriving at 6 PM Friday must not be late on Sunday morning | Business-time deadlines; intake outside hours starts at the next opening | U: "Fri 18:00 medium … neither late on Sunday"; "Fri 18:30 urgent intake → effective Monday 09:30" | PASS |
| M7 | Waiting for a customer's answer must not count against the team | Explicit public "Request information" pauses the resolution clock; the customer's reply resumes it | U: "Mon 09:30 low, request 11:00, Wed 15:00 reply → 90 consumed, 2610 remaining"; I: `proof-01` "waiting freezes consumption"; E: full UI lifecycle (Waiting → Paused → customer reply → On track) | PASS |
| M8 | No customer reply for about one working week → close the ticket | Auto-close strictly after 2,700 working minutes of waiting (sweep + contact path) | U: "cutoff is exactly 2700 working minutes", "sweep at cutoff is a no-op; at cutoff + 1 ms it closes"; I: `proof-05`, `audit-completeness` (SYSTEM, `AUTO_CLOSED_NO_REPLY`, idempotent replay); L: Supabase Cron 13:00 call auto-closed an overdue verification ticket | PASS |
| M9 | They can always contact us again later | Contact after auto-close creates a new linked ticket; the old ticket is unchanged | U: "customer reply 1 ms after the cutoff closes the old ticket and creates a linked OPEN child"; I: `proof-05` "same outcome whether or not a sweep ran first"; L: `hosted-verify` linked ticket | PASS |
| M10 | Customer unhappy after "done" can reopen, but only for about one week | `reopenUntil` = resolution + 7 calendar days, inclusive; the same ticket gets a new resolution cycle | U: "reply exactly at reopenUntil reopens the same ticket"; E: UI reopen; L: `hosted-verify` reopen inside 7 days | PASS |
| M11 | After that it is a new ticket, not the old one | Reopen after the window expires the old ticket (`RESOLUTION_WINDOW_EXPIRED`) and creates a linked child | U: "reopen 1 ms after the window …"; E: "customer follow-up after the reopen window creates a linked ticket"; I: `audit-completeness` | PASS |
| M12 | Agents see their tickets on one screen | Staff workspace: views + list + detail side by side (drill-down on phones) | E: queue views; `a11y-responsive` at 1440/1024/390; new `runtime-health` (all 7 views) | PASS |
| M13 | They know which tickets are already late | "Breached" view (server filter) + red edge and "Breached" SLA badges (text and icon, not colour alone) | E: "queue views and filters use the server"; "breached ticket is explained" | PASS |
| M14 | …and which are waiting on the customer | "Waiting on customer" view; status badge; paused clock card | E: "queue views and filters …"; full UI lifecycle | PASS |
| M15 | Open a ticket and reply to the customer | Composer "Public reply" (completes the first-response clock) | E: full UI lifecycle; U/I: "first public reply completes RESPONSE only" | PASS |
| M16 | Write a note for the team only | Composer "Internal note", amber "Internal note · team only", separate drafts | E/I: PROOF-03 suites (below); web unit "note never leaks into the public draft" | PASS |
| M17 | What happens to the timer if a ticket becomes urgent midway? (left open) | Documented policy: the new budget is applied to working time already consumed; never reset; a breach caused by escalation is recorded at change time; history is preserved | U: `priority.test` 11 tests (LOW→MEDIUM, MEDIUM→URGENT, URGENT→LOW after a breach, while paused, completed response, near deadline ±1 ms); I: `proof-01` escalation tests; E: UI "Priority Medium → Urgent" in the audit story | PASS |

## §4 Problem reports

| ID | Original assessment requirement | Implementation | Test evidence | Status |
|---|---|---|---|---|
| I1 | INC-0291: two agents must not be able to take the same ticket | Atomic conditional claim in one transaction (row-level), HTTP 409 for losers, one `TICKET_CLAIMED` | I: `proof-02` describe.each([2, 9]) independently authenticated agents with forced overlap (exactly one 200, the rest 409, one audit row) + rollback on audit failure; E: two browsers click Claim together; L: 9-agent race on the live site; I: `audit-completeness` (a losing claim writes no audit row) | PASS |
| I2 | INC-0304: a private note must never reach the customer — not on a screen, in an API response, in an export, or in a list | Customer routes query `visibility = PUBLIC` with column allowlists and public DTOs; separate customer cache namespace | I: `proof-03` 12 tests (list, detail, >500-message paging, JSON/CSV export, cross-customer 404, replay, error fields); E: `privacy.spec` (DOM + every network response + downloaded exports); L: `hosted-verify` and `hosted-browser` (DOM and network) | PASS |
| I3 | INC-0318: record exactly what happened, when and who did it; nobody can change it later | `audit_logs` append-only: runtime role lacks UPDATE/DELETE/TRUNCATE; triggers reject mutation even for the owner; business change and audit in one transaction; event time and recording time are separate fields | I: `proof-04` (privilege + trigger denials, rollback, reconstruction, no bodies in payloads); I: `audit-completeness` (all 15 event types, actors, before/after); L: runtime role UPDATE/DELETE/TRUNCATE denied on Supabase; `03-verify.sql` 9/9 | PASS |

## §5 Rules

| ID | Original assessment requirement | Implementation | Test evidence | Status |
|---|---|---|---|---|
| R1 | About 8 hours; "we prefer 8 honest hours over a full weekend of extra polish" | — | Actual effort far exceeded 8 hours (multi-milestone build, audits, DevSecOps, hosting); disclosed in SHORT_NOTE and per milestone in `docs/IMPLEMENTATION_NOTES.md` | FAIL (disclosed) |
| R2 | Any frontend; Node or Python backend; PostgreSQL or MySQL | React + Vite; NestJS on Node 22; PostgreSQL 17 (Supabase) / 16 (local) | `package.json`, Docker image, live `/api/readyz` (DB reachable) | PASS |
| R3 | Full stack: a backend service and a simple screen for agents | API + staff workspace (+ customer portal) | Q1 evidence | PASS |
| R4 | Host it yourself on a free service | Render Free + Supabase Free, US$0 | `docs/M8_DEPLOYMENT_EVIDENCE.md` | PASS |
| R5 | Keep it running for one week | Live since 2026-11-22; free-tier sleep disclosed (one measured cold start, about 39 s) | Not yet observable: one week has not passed | NOT VERIFIED |
| R6 | README that explains how to run it locally | README "Run locally" section | Local setup reproduced by this audit's runs (Compose PostgreSQL, migrations, seed, tests) | PASS |
| R7 | Short note: what did you not finish, and why? | `SHORT_NOTE.md` | Reviewed for accuracy against this audit | PASS |

## §6 How to submit

| ID | Original assessment requirement | Implementation | Test evidence | Status |
|---|---|---|---|---|
| D1 | Send the live URL, repository link, README and short note to the person who gave the document | Ready (checklist in `docs/FINAL_FUNCTIONAL_TEST_REPORT.md`) | The repository is private: reviewers need access granted by the owner | NOT VERIFIED (owner action) |

## §I Documented interpretations of ambiguous points

| ID | Ambiguity in the story | Interpretation (DOMAIN_CONTRACT) | Evidence | Status |
|---|---|---|---|---|
| A1 | "Same working day" for urgent | Rest of the effective business day (Friday 18:00 urgent → resolution Friday 18:30); not a rolling 540 minutes | U: worked case incl. ±1 ms | PASS |
| A2 | "Half a day" / "one day" / "about three days" / "about one week" | 270 / 540 / 1,620 / 2,700 working minutes | U + calendar | PASS |
| A3 | "Should not be late on Sunday" (Friday 18:00 example, priority unstated) | Holds for medium/low and for the urgent response; urgent resolution stays same-day by M1 | U: Friday worked cases | PASS |
| A4 | Exact deadlines | Equality is on time; strictly after (+1 ms) is late | U/I: ±1 ms tests | PASS |
| A5 | Which waiting pauses the clock | Only an explicit public "Request information" by the assignee; ordinary replies and notes never pause | U: "ordinary public replies and notes never pause" | PASS |
| A6 | "About one working week" without reply | Strictly after 2,700 working minutes; contact at the cutoff resumes the same ticket | U: cutoff / +1 ms | PASS |
| A7 | "About one week" to reopen | 7 calendar days inclusive of `reopenUntil` | U: at / +1 ms | PASS |
| A8 | Timer after a change to urgent | New budget against consumed time; history kept (M17) | U/I as M17 | PASS |
| A9 | Historical lateness | Breaches are immutable events; current status can recover without erasing history | U: "downgrade clears current lateness but preserves history" | PASS |
| A10 | Proof of "when the reply was sent" | Records when a reply became visible in Frontdesk; no email delivery or read receipt is claimed | I: `proof-04` reconstruction | PASS |
| A11 | Timezone | Asia/Kolkata (company in Kochi; IST shown everywhere) | U/E | PASS |

## Summary

- **PASS:** 41.
- **FAIL:** 1 (R1, the time budget, disclosed).
- **NOT VERIFIED:** 2. R5 (one-week uptime) is time-based and not yet observable; D1 (submission and reviewer access) is the owner's action.
- **PARTIAL:** 0.

Defects found and fixed during this audit are listed in `docs/FINAL_FUNCTIONAL_TEST_REPORT.md`.
