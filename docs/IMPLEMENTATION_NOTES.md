# V3.1 evidence and limitations
Existing calendar kernel unchanged; six original and six new boundary tests run, see calendar-test-results.txt. V3.1 resolves audit findings in design contracts, schema, SQL templates and typed API draft. No Prisma CLI validation, PostgreSQL migration, real HTTP integration, frontend build, security scans, deployment or five-proof execution here. No live URL. No claim of production readiness or independent re-audit. All P0–P2 engineering scope retained. See AUDIT_RECONCILIATION.md for remaining gates.

V3.2: follow-up audit corrected at contract level. Draft schema, SQL, API and env updated; 12 calendar tests rerun successfully. Targeted Python response fixtures passed (OpenAPI nullable translated to JSON Schema for these shapes only); all local refs resolve. Full OpenAPI-aware validation, real PostgreSQL lease/crash/migration/privilege checks, HTTP/browser/auth tests, CI scans and deploy remain pending. No independent V3.2 audit claimed. See FOLLOWUP_AUDIT_RECONCILIATION and package-check-results.txt.


## Progress log
### M1 (2026-11-21) — see commit history
- Done: npm workspaces (apps/api, apps/web, packages/contracts), strict TS, ESLint/Prettier, typed zod env validation, health/readiness, Pino redaction, isolated Compose PG16 (owner + restricted runtime roles), 3 versioned migrations (baseline, domain constraints incl. V3.2 sweep constraints/index, audit immutability + least-privilege grants), idempotent seed (9 agents/Meera LEAD, 3 customers, 3 illustrative holidays, FD-001..015), OpenAPI 3.0 validation, 34 unit + 47 integration tests.
- Contract defect fixed: `ResolveInput.required: []` is invalid OpenAPI 3.0 (found by swagger-parser; the old Python smoke check missed it). Removed the empty array; body stays optional.
- Decisions: Prisma 6.19.3 / Nest 11.2.11 / TS 5.9.3 / Vite 7.3.8 / React 19.1.10 (newest majors Prisma 7+/TS 7 not adopted for compatibility). Seed runs as owner; demo passwords random per account in git-ignored `.local/demo-credentials.json`.
- Known limits: calendar kernel is ESM `.mjs`; Jest (CJS) cannot import it, so M2 must wrap it (dynamic import / adapter) — kernel untouched. Owner role can disable the audit trigger by design (trusted-owner boundary; no tamper-proof claim). Prisma `package.json#prisma` seed config is deprecated for Prisma 7 (irrelevant on 6).
- Next: M2 SLA clocks/lifecycle engine on the calendar kernel.

### M2 (2026-11-21) — domain engine, SLA, lifecycle, sweep policy
- Domain layer `apps/api/src/domain` (pure TS, no Nest/Prisma): `calendar/` (kernel loader + `KernelBusinessCalendar`), `sla/` (policy strategy, clock transitions, read projection), `ticket/` (actor model, typed audit-event union, `TicketLifecycle` state machine), `sweep/` (candidate/lease/reservation policy, strict sweep audit schemas, `SweepRunner` over ports). Infrastructure: `infrastructure/persistence/ticket-mapper.ts`, `infrastructure/sweep/pg-sweep-store.ts`.
- ESM interop: kernel loaded via Node's native `require(esm)` obtained from `process.getBuiltinModule('node:module')` (Jest cannot intercept it); runtime shape guard; identical path in prod/tests; kernel untouched. M6 image must ship repo-root `src/calendar.mjs`.
- Real defect found and fixed in the adapter: minute-based kernel + float ms conversion pushed ~2% of exact-close deadlines into the next working day; adapter rounds, corrects the overshoot and verifies every result by exact round trip.
- Every command runs `reconcile` first (same rule as the sweep) => delayed-sweep equivalence by construction. One version bump per logical mutation; all its events share before/after versions. Breach events: SYSTEM for deadline breaches, acting staff for PRIORITY_ESCALATION; eventKey `breach:<clockId>:<sequence>`.
- Seed rebuilt on the engine (no second rule implementation); M1 seed tests now validate engine output. FD-006/FD-007 gained an early staff reply so their response clock is on time (scenario focus unchanged).
- Fencing fix during implementation: `clock_timestamp()` in a `FOR UPDATE` target list is evaluated before lock waits; lease checks now sample fresh DB time after the lock.
- Evidence: 12 calendar + 117 unit + 59 integration tests (real PG scratch DB) pass; typecheck/lint/format/build/secret scan pass; schema unchanged (no migration). A mutation check (`<` -> `<=` in SQL cutoff) is caught by the strict-cutoff test.
- One integration run failed once early in verification; the failing test name was not captured and 13 subsequent full runs were green. Treated as unexplained, watch in M4.
- Dev DB (`frontdesk`) still holds the M1-generated seed (audit rows are immutable; refreshing requires dropping that DB — needs approval, planned for demo prep). Scratch DBs used for all tests.
- Pending: M3 per-ticket sweep processor (lock invocation -> ticket SKIP LOCKED -> clocks, persist + audit + counters atomically), scheduler wiring, HTTP/auth, typed audit write validation for ticket events; M4 overlapping-worker/crash/claim/privacy proofs.

### M3 (2026-11-21) — authenticated transactional backend
- Modules: `auth/` (Argon2id login with timing-equalised dummy hash, HS256 access JWT with iss/aud/typ/sid checks + live DB session/role on every call, refresh rotation locking Session first with committed family revocation on reuse, logout via access OR refresh identity, signed session/prelogin-bound CSRF with HKDF subkey of CSRF_SIGNING_KEY, exact Origin), global deny-by-default guards (Auth -> Roles -> Origin/CSRF), `common/` (safe error envelope, request ids, Zod strict DTOs, in-process rate limiter, monotonic UUIDv7 audit ids), `tickets/` (UnitOfWork, TicketRepository, IdempotencyService, AuditWriter/AuditValidator, TicketViews, TicketCommandService, TicketQueryService, CursorCodec, controllers), `sweep/` (PgSweepTicketProcessor, SweepService, SweepScheduler, AdminController), `calendar/` (holidays from DB).
- Transactions: idempotency INSERT .. ON CONFLICT first -> ticket FOR UPDATE -> clock_timestamp() -> clocks FOR UPDATE (cycle, kind, id) -> domain -> version-guarded writes + validated audit -> stored outcome, one READ COMMITTED tx; bounded retry on 40001/40P01; lock timeouts -> 503 BUSY. Sweep per-ticket tx: invocation lock + lease -> ticket SKIP LOCKED -> DB time -> clocks -> reconcile -> persist + counters -> lease re-verified before commit.
- Audit contract: runtime JSON Schema generated from docs/openapi.draft.yaml (`npm run gen:audit-schema`, drift-tested); Ajv validation at write AND read (read fails closed with 503 AUDIT_UNAVAILABLE).
- Additive migration 20261121000300_retention_grants: DELETE on IdempotencyRecord/RefreshToken/Session only (24h idempotency retention; session expiry + 24h) + createdAt/expiresAt indexes. Privilege-matrix test updated explicitly; zero drift asserted on migrated scratch DB. Applied to dev DB (additive only).
- No CORS (same-origin); helmet CSP default-src 'none', frame-ancestors 'none'; HSTS only when PUBLIC_ORIGIN is https; no-store + Vary: Cookie on all API responses; 64 KB body limit; login/sweep/API rate limits.
- Evidence (3 consecutive full runs 15:52-15:53Z): calendar 12/12, unit 129/129, integration 104/104 (real PG scratch DBs; real Nest pipeline via Supertest). Compiled dist starts; /api/readyz via restricted role; scheduler verified in compiled mode on a throwaway DB (2 SYSTEM invocations, audited, clean SIGTERM). No secrets in logs.
- Not claimed: claim race only 2-agent Promise.all (forced-overlap 2/9-agent proofs, crash-after-commit, overlapping workers -> M4); browser/cache privacy -> M5; Docker/CI/scans -> M6; deployed proxy/cookies -> M8.

### M4 (2026-11-21) — Codex audit remediation + five engineering proofs
- All 10 Codex findings (H01–H04, M01–M05, L01) reproduced, fixed and regression-tested on real PostgreSQL; see docs/M4_REMEDIATION.md (root cause, fix, regression per finding). Contract changes: StaffTicket/PublicTicket gain `olderMessagesCursor`; new `/tickets/{id}/messages` and `/customer/tickets/{id}/messages`; audit `createdAt` = recording time (AUDIT_PAYLOAD_CONTRACT addendum). New config: DATABASE_RUNTIME_ROLE (default frontdesk_app), DB_LOCK_TIMEOUT_MS (default 3000).
- Proofs: `npm run test:proofs` (calendar 12 + unit 101 + integration 161 incl. proof-01..05). Concurrency evidence uses barrier transactions + pg_stat_activity lock-wait observation (test-only superuser observer) and DB-time barriers, never bare sleeps.
- Evidence: 3 consecutive full `npm test` runs at 17:08–17:11Z: 12/12, 129/129, 178/178 (17 suites); typecheck, lint, format, OpenAPI (25 paths), audit-schema drift, build, secret scan pass; compiled dist ready as frontdesk_app and refuses owner credentials with violation codes; no secrets in logs; no leaked scratch DBs/roles.
- Not claimed: browser DOM/network/cache privacy (M5), Docker/CI/scans (M6), deployed proxy/cookies/scheduler (M8).

### M5 (2026-11-22) — frontend, browser security, accessibility
- Web app (`apps/web`): typed API client (`lib/api.ts`: same-origin cookies, in-memory CSRF, single-flight refresh incl. Web Locks across tabs, one retry only, session-lost signal, no browser storage), `AuthProvider` (cache wiped on logout / identity change / session loss), staff workspace (server-filtered views, cursor-paged list, detail with independent SLA cards, three isolated composers with per-mode drafts and amber team-only note, claim with real conflict handling, priority, resolve, audit tab with 'why was this late?' built only from immutable events, lead-only sweep dialog, new-ticket dialog), customer portal (own cache namespace and public DTOs only; reply / reopen / linked-ticket outcome / JSON+CSV download). Timelines use the real `/messages` endpoints (scroll position kept, dedupe by id, stable (createdAt,id) order).
- Backend addition: staff-only `GET /customers` (id + displayName) for the intake form; OpenAPI + integration test. No migration.
- Honest limits: the API has no text search or counts, so the UI offers neither (filters: views + priority; no fabricated KPIs). Ticket reference is derived from the id (`FD-` + 8 hex). Detail pagination gap edge-case (>50 messages arriving while a detail is open) is not specially handled.
- Evidence (2026-11-22): calendar 12/12; unit 129/129; integration 179/179 (18 suites, includes M4 proofs); frontend unit 14/14 (Vitest); Playwright 26/26 on three consecutive full runs (`npm run test:e2e`); typecheck, eslint, prettier, builds, audit-schema drift, secret scan pass. Isolated e2e DB `frontdesk_e2e` (recreated per run); reviewer DB `frontdesk_demo`; old dev DB `frontdesk` not dropped or modified (15 tickets / 88 audit rows unchanged).
- Browser PROOF-03 (privacy.spec.ts, 10 tests): staff see the marked note; customer DOM and every captured /api response body omit the marker, private ids and private field names; browser-downloaded JSON/CSV public-only; cross-customer 404; 520-message customer timeline fully reachable with no duplicates and no `PAGEDNOTE` or private ids anywhere; staff reach all 532; staff→logout→customer clears content, makes no staff API calls, back/forward shows nothing sensitive; revoked session returns to login with explanation; storage holds no tokens/caches/IndexedDB; cookies HttpOnly, SameSite=Lax, paths /api and /api/auth.
- Defects found and fixed in M5 by actually running the UI: dialog focus was not restored on close (controlled Radix dialogs have no Trigger); two controls shared the accessible name 'Priority' and form/textarea shared a name; at 1024 px the SLA cards were clipped (layout rebalanced + regression test); mobile nav stayed open after selecting a view; composer textarea oversized.
- Incident (disclosed): running `npm run demo:db` once wrote the demo DB's random passwords into `.local/demo-credentials.json`, overwriting the plaintext passwords of the same 12 emails for the dev DB (path override had not applied). Fixed in seed.ts; the file was renamed `.local/demo-credentials.OVERWRITTEN-do-not-use.json` and the demo passwords saved as `.local/demo-credentials-demo.json`. Dev DB data and hashes are untouched but its plaintext logins are no longer recorded (dev DB is slated for refresh anyway).
- Screenshots (local, git-ignored): `.local/screenshots/` — login, staff list/detail/note/history, portal list/ticket at 1440/1024/390, dialogs.
- Pending: M6 (Docker incl. src/calendar.mjs, CI, scans), M7 optional, M8 deployed proxy/cookies/scheduler, real-device screen-reader testing (only axe + keyboard automation done; no WCAG conformance claim).

### M6 (2026-11-22) — containerization, CI/CD, DevSecOps
- Built: credential-file safeguards (prisma/credentials.ts, SEED_CREDENTIALS=write|none, per-environment files, atomic 0600, refuse overwrite, reset script not run); same-origin static serving + split CSP; multi-stage Dockerfile (runtime/migrate/tools), allowlist `.dockerignore`; `compose.prod.yaml` (migration job, restricted app, read-only fs, no published DB port, explicit seed profile); `scripts/smoke-prod.mjs` (23 checks); shared `useTimeline` fix for >50 messages arriving while open (18 frontend tests); CI/security/CodeQL workflows + Dependabot; Semgrep rules, Gitleaks config, audit gate; deployment feasibility + preflight + Render blueprint draft (`infrastructure/deploy/`); release-traceability label (`GIT_SHA`).
- EXECUTED before the daemon hung: image build (142 MB, non-root, kernel loads in-container); compose from a clean volume; 23/23 production smoke; role/audit-immutability checks inside the stack (digest unchanged); owner credentials rejected by the app; scheduler without HTTP traffic (all SYSTEM sweeps COMPLETED); SIGTERM hook; restart / SIGKILL / DB-restart persistence; Gitleaks, Semgrep (+negative control), npm audit, SBOM, workflow schema validation, SHA verification; unit 24 env + 4 credentials + 13 workflow tests.
- PENDING (needs Docker): rebuild with `--omit=peer` + label and re-run smoke; Trivy scan; full re-run of integration/e2e suites (they use the PostgreSQL container) after today's changes; destroying/regenerating the local prod-like stack secrets. PENDING (needs GitHub): any remote workflow run.
- Time: M1–M6 elapsed across several sessions; precise wall-clock was not recorded; M6 consumed roughly 3 hours including the disk incident.

**M6 closing evidence (after Docker recovery, final image from commit 5d9d19d):**
- Final image rebuilt and re-verified: 23/23 production smoke, readiness via Prisma, SIGTERM hook (exit 143), kernel + identity checks, Trivy (see docs/DEVSECOPS.md): 0 fixable / 0 app-dependency findings; 38 unfixed OS CVEs accepted with justification.
- Full regression after all M6 changes: calendar 12/12; backend unit 147/147; integration 184/184 across 19 suites (real PostgreSQL, incl. PROOF-01..05 and remediation regressions, no leaked scratch DBs/roles); frontend 18/18; Playwright 26/26 on four consecutive full runs; typecheck, eslint, prettier, builds, OpenAPI (26 paths), audit-schema drift, Prisma validate, secret scan, Semgrep, Gitleaks, audit gate pass.
- Three e2e test races found and fixed while re-running (none a product defect): response-body capture recorded asynchronously; React mirrors a textarea's value into its text content so `getByText` matched before the request committed; restart/FINISH ordering earlier. The M2 flaky failure is still unexplained.
- Local verification stack destroyed (`down -v`, own volume only) and secrets regenerated because two values had been echoed into the session log; `.env.production.local` regenerated (git-ignored, 0600).
- Still PENDING: any remote GitHub Actions run; hosting decision and provisioning (M8); ZAP, signing, Prometheus/Grafana, k6, distroless evaluation (M7). Time: not precisely recorded; M6 roughly 4 hours including the disk/Docker incident.

### Pre-M7 release-readiness check of the seven open M5 issues (2026-11-22)
- (1) Credentials — two NEW defects found and fixed: the seed created users (hashes committed) BEFORE writing the credentials file, so a refused/failed write stranded logins (proven: old seed left 12 users with no recorded password); and the base-directory check was a raw string prefix (`.local/../x` passed). Now: pre-flight `assertCredentialsWritable` → plaintext recorded first → hashes stored; path normalised and confined; exclusive `.lock`; temp file removed on failure. Reset script pre-checks before hashing. Evidence: tests/unit/credentials.test.ts (7 tests), tests/integration/seed-credentials.test.ts (3, real PostgreSQL; fails on the old seed, passes now).
- (2) Timeline — NEW defect found and fixed: a refetch arriving while a gap walk was in flight cancelled the walk and the next (overlapping) page detected no gap, leaving a permanent hole. Gap walks are now queued per ticket and only stop on ticket change/unmount; fetch failures still surface `gapUnresolved`. Evidence: useTimeline.test.ts 6/6 (new test failed before the fix).
- (3) Kernel in container: M6 evidence reused (no rebuild). (4) Screen reader: deferred, needs a human VoiceOver/NVDA pass. (5) Search/counts: deferred, not in the contracts. (6) Rate limiter: single-instance, mitigated. (7) M2 flake: open, unexplained.

### M7 (2026-11-22, 07:24–08:30 IST) — observability, performance, security, supply chain, recovery
- Seven post-M5 issues: (1) credentials FIXED+VERIFIED (1abe28f) and **recovery after a post-write DB failure** now tested (seed-credentials 6/6: created users keep working logins; unauthorised rerun refuses; authorised rerun completes); (2) timeline FIXED+VERIFIED (1abe28f); (3) kernel in container re-verified on rc-a917ce1; (4) VoiceOver checklist prepared, NOT performed; (5) search/counts deferred; (6) rate limiter single-instance — k6 showed a shared-NAT team can hit the per-IP limit, strategy documented; (7) M2 flake still unexplained (no recurrence in M7 runs).
- Implemented: prom-client metrics behind an internal authenticated listener with commit-only business counters (2ec9b80); monitoring profile + dashboard + alerts + release build from git archive (403c433); ZAP header hardening, k6 workloads, backup/restore script, CI/SBOM/ZAP/k6 integration, manual keyless release workflow (a917ce1).
- Verified: see docs/M7_EVIDENCE.md (exact image `sha256:198817f4…` from a917ce1; smoke 23/23; scheduler without traffic; alert firing; 21 dashboard queries; k6; ZAP 0 FAIL; SBOM validity; Cosign local verify; Trivy; backup/restore integrity + privileges).
- Harness bugs fixed (not product defects): k6 cookie reset per iteration; zsh word-splitting in ad-hoc commands (no secrets printed this time); a lint error slipped into a commit and was amended before anything else built on it.
- Deferred: distroless evaluation; authenticated ZAP; Alertmanager delivery; remote CI/release runs; principal-keyed rate limiting; VoiceOver pass.
- Time: M7 ≈ 66 min wall clock (07:24–08:30 IST, from the Phase A disk check to the docs commit), no incident recovery this milestone; plus the pre-M7 reconciliation (~25 min). The assessment's 8-hour budget is long exceeded overall — recorded honestly.

### M8-A (2026-11-22) — final audit remediation and local release verification
- Fixed and verified: H01, H02 (mutation-tested), M01 (k6 mixed: 0 × 429 vs 21 in M7), M02 (real concurrent processes),
  M03 (real SIGTERM mid-transaction), L01; H03 gate logic + workflow; M04 per-advisory report for the amd64 artifact.
  Prepared: H04 sanitized candidate; hosting adaptations (machine sweep trigger, Supabase scripts rehearsed locally).
  Open: H05 (needs approval + live verification). Details: docs/FINAL_AUDIT_RECONCILIATION.md.
- Found along the way: Supabase incompatibilities caught by a local rehearsal BEFORE provisioning (generic preflight would
  change ownership of Supabase's database; the baseline's CREATE SCHEMA needs database CREATE — granted only during
  migration, then revoked and verified); PUBLIC EXECUTE on the trigger function revoked by a new portable migration;
  a pre-existing useTimeline test race; I mistakenly overwrote an existing web test file (restored from git and merged);
  I briefly committed my own email local-part inside a leak-check pattern (amended before any further commit; patterns
  are now derived at runtime).
- Release candidate: app revision 7b02b7b; arm64 image (k6/smoke) and linux/amd64 image `sha256:fd86f045…` (emulated:
  smoke, kernel, argon2/Prisma on x64, non-root, read-only, scheduler without traffic, SIGTERM drain 143, Trivy, SBOM).
- Not done without approval: any external resource, repository, publication, signing or deployment.
- Time: M8-A ≈ 2 h 55 min wall clock (about 08:35–11:28 IST on 2026-11-22, including a usage-limit pause); no incident recovery. Publication candidate: ../frontdesk-v3.2-publication commit e701ec7 (from 6b086f1), Gitleaks history + dir clean, fast gates pass in isolation. Local disk after amd64 emulated builds: 6.2 GiB free (Docker build cache; no global prune performed).

### M8-B/C (2026-11-22): zero-cost deployment, live verification, submission
**Executed, under the owner's written authorization.**
- Private repository with the sanitized history.
- CI and Security on the publication SHAs.
- Release workflow: gate → amd64 build → smoke → Trivy → SBOM → publish → digest match → keyless sign + attest → verify.
- An isolated Supabase Free project: provisioned, migrated, verified 9/9, seeded once.
- A Render Free service deployed by digest from private GHCR.
- A 30-minute Supabase Cron sweep with the token held in Vault.
- Dependabot cleanup within the authorized scope.

**Live results (revision `9cadd0b`, digest `b5ef0a7f…`, and again on the redesign `136ee89`, digest `ebf7a980…`).** Smoke 29/29, workflows 29/29, browser 8/8, and 0 px of empty page scroll. The external cron slots at 11:30 and 12:00 each returned HTTP 200 and persisted a COMPLETED invocation. The 12:30 slot did the same against a sleeping instance, and at 13:00 the cron call itself auto-closed an overdue verification ticket (audit correlated to `ext-cron-202611221300`). One cold start was measured on a sleeping instance by the 12:30 cron call: about 38.6 s to HTTP 200. Full detail is in M8_DEPLOYMENT_EVIDENCE.md.

**Failures found and fixed (none bypassed).**
- *First CI runs:* contracts build missing in the integration job; k6 origin; a flaky metrics regex; one suite writing to the shared template DB; PROOF-02 pool size on 2-vCPU runners.
- *Hosted-verify assumptions:* the script assumed 201 for replies and notes (the contract says 200), and that ticket events carry the sweep ID (they correlate via `SWEEP_STARTED` instead).
- *User-reported empty page scroll:* `sr-only` labels escaped the pane scrollers because no positioned ancestor existed. Fixed, and guarded by an e2e assertion that fails at 891–1,051 px when the fix is reverted.
- *TLS:* Semgrep blocked `rejectUnauthorized: false` in my new verification scripts. Review then showed the runtime database connection was also unverified, so both now verify against Supabase's pinned root CA (negative tests pass).

**Mistakes and process notes.**
- A `sleep`-based cold-start test never completed because the Mac slept. Those processes were stopped and the results were taken from logs instead.
- My own browsing of the live site once woke the instance and would have invalidated an asleep test. Those waiters were stopped and the test rescheduled.
- The persisted cron-processing test was redesigned around the scheduler's fixed phase rather than sleep, because the instance stayed awake.

**Coordination.** The owner's README PR (#12) was merged after all its checks passed on the updated head, and its README is now the source of truth here. The frontend redesign went to a separate branch and worktree and was opened as PR #13 and merged at the owner's request after all checks passed (`2476934`), then released through the gated chain and deployed (`136ee89`); all live suites passed again.

**Open (owner).**
- Grant reviewer repository access.
- Check Render free hours and Supabase inactivity during the live week.
- Dependabot PR #11.
