# Glossary of internal tags

The engineering documents use short tags for milestones, audit findings and proofs. The code comments and test names
were rewritten in plain English, but the documents still use the tags, so this page explains them.

> **Watch out: two audits reused the same IDs.** `H01`–`H04`, `M01`–`M04` and `L01` mean different things in the
> **M4 audit** (`docs/M4_REMEDIATION.md`) and in the **final audit** (`docs/FINAL_AUDIT_RECONCILIATION.md`). Check
> which document you are reading.

## Milestones (M1–M8)

| Tag | Meaning |
|---|---|
| M1 | Project foundation: workspaces, strict TypeScript, configuration validation, PostgreSQL roles and migrations, a validated API contract |
| M2 | Pure domain engine: calendar, SLA clocks, ticket lifecycle, sweep policy |
| M3 | Authenticated, transactional backend (HTTP API, sessions, persistence) |
| M4 | First independent audit fixed, plus the five engineering proofs on real PostgreSQL |
| M5 | Frontend, browser security and accessibility |
| M6 | Containers, CI/CD and DevSecOps gates |
| M7 | Observability, performance, security scanning, supply chain and recovery |
| M8 | Final audit fixes, zero-cost deployment, live verification and submission |

Progress, decisions and timing for each milestone are in `docs/IMPLEMENTATION_NOTES.md`.

## Engineering proofs (PROOF-01–05)

Mandatory, executable evidence on real PostgreSQL (`docs/ENGINEERING_PROOFS.md`). The test files keep their
`proof-0x` names.

| Tag | Plain English | Test file |
|---|---|---|
| PROOF-01 | SLA correctness: working hours, holidays, independent clocks, pause and resume, escalation, exact boundaries, preserved breach history | `tests/integration/proof-01-sla.test.ts` |
| PROOF-02 | Exclusive claiming: 2 and 9 agents race over real HTTP; exactly one wins, the rest get 409, one audit row; rollback on audit failure | `tests/integration/proof-02-claim.test.ts` |
| PROOF-03 | Private-note isolation: never in customer lists, details, exports, network responses or the rendered page | `tests/integration/proof-03-privacy.test.ts`, `tests/e2e/privacy.spec.ts` |
| PROOF-04 | Audit immutability: append-only enforced by database privileges and triggers; attribution; transactional rollback | `tests/integration/proof-04-audit.test.ts` |
| PROOF-05 | Lifecycle and scheduler: auto-close, reopen, linked tickets, overlapping workers, crash recovery, backlog | `tests/integration/proof-05-lifecycle.test.ts` |

## Findings from the M4 audit (`docs/M4_REMEDIATION.md`)

| Tag | Problem found | What the code now guarantees | Main test |
|---|---|---|---|
| H01 | The sweep lease was checked in one statement and written in another | The lease is checked **inside** the write statement, so an expired lease can never write | `remediation-h01-lease.test.ts` |
| H02 | Customer reply/reopen locked a ticket by id before checking ownership | Ownership is part of the lock query: a customer can never lock (or learn about) someone else's ticket | `remediation-tickets.test.ts` |
| H03 | Conversations were silently truncated at 500 messages | Keyset pagination (newest page first) and complete exports | `proof-03-privacy.test.ts` |
| H04 | Nothing checked which database identity the app really ran as | Startup refuses to run unless connected as the restricted runtime role | `remediation-h04-runtime-role.test.ts` |
| M01 | A stored idempotent response could be replayed after access was revoked | Replays re-check current authorisation before releasing a stored response | `remediation-tickets.test.ts` |
| M02 | Session validity was evaluated before waiting for the lock; JWT `exp` was optional | Lock first, then re-validate with fresh DB time; every mandatory JWT claim is required | `remediation-auth.test.ts` |
| M03 | Audit `createdAt` held the logical event time | `createdAt` is the actual recording time; logical times stay in the event details | `remediation-tickets.test.ts` |
| M04 | Backlog scans had no timeouts | Scans run with transaction-local timeouts bounded by the remaining budget | `remediation-m04-scan.test.ts` |
| M05 | Raw error messages were logged; maintenance depended on the sweep | Logs carry only allowlisted error metadata; scheduler steps are isolated | `remediation-tickets.test.ts` |
| L01 | A same-priority request skipped the lifecycle guards | State guards run first, then the no-op | `remediation-tickets.test.ts` |

## Findings from the final audit (`docs/FINAL_AUDIT_RECONCILIATION.md`)

| Tag | Plain English | Main test |
|---|---|---|
| H01 | Session restoration (one refresh when the access token expired), login CSRF, confirmed logout | `final-audit-auth.test.ts`, `tests/e2e/sessions.spec.ts` |
| H02 | Stale tabs: a tab rendered for one session can never act through a different session (`409 SESSION_CHANGED`) | `final-audit-auth.test.ts`, `tests/e2e/sessions.spec.ts` |
| H03 | Gated, signed releases: approved ref, exact SHA, passing checks, one signed artifact | `tests/release/release-gate.test.mjs` |
| H04 | Confidential materials kept out of the public git history (sanitized snapshots) | `scripts/build-publication.sh` |
| H05 | The hosted submission had to be deployed and verified live | `docs/M8_DEPLOYMENT_EVIDENCE.md` |
| M01 | Rate limits: per signed-in user (colleagues behind one office IP never throttle each other), strict per IP for anonymous traffic | `final-audit-auth.test.ts` |
| M02 | Concurrent seed runs cannot leave a password hash without its recorded password | `seed-concurrency.test.ts` |
| M03 | Shutdown ordering: the scheduler drains before the HTTP server and the database close | `shutdown-drain.test.ts` |
| M04 | Applicability analysis of unfixed OS-package CVEs in the image | `docs/CVE_APPLICABILITY.md` |
| L01 | Metrics: a manual sweep can never hide a dead scheduler | `tests/unit/metrics.test.ts` |

## Other identifiers

| Identifier | Meaning |
|---|---|
| INC-0291, INC-0304, INC-0318 | The three incidents in the assessment: double claim, leaked private note, unprovable reply time |
| FD-001 … FD-015 | Seeded scenario tickets used by the reviewer walkthrough (`docs/REVIEWER_WALKTHROUGH.md`) |
| R01…, A01…, M6-01…, M8-H01… | Requirement IDs in `docs/RTM.csv` (assessment rules, architecture items, milestone items) |
| V2, V3.1, V3.2 | Versions of the design package; V3.2 is the final contract set (domain, auth, sweep, audit payload) |
| M5 overwrite incident | During M5, running the demo seed overwrote the development credentials file; M6 added credential-file safeguards (`prisma/credentials.ts`) |
