# Final Codex release audit — reconciliation (M8)

The final independent audit returned **BLOCKED** with ten findings. Status uses: FIXED AND VERIFIED (code + executed
tests), PREPARED (locally complete; needs an authorised external action), OPEN (not resolved). Test evidence is from
real PostgreSQL and real browsers unless stated. Application revision for the evidence below: `7b02b7b` (later commits
are documentation only unless noted).

| ID | Severity | Status |
|---|---|---|
| H01 Session restoration and logout | HIGH | FIXED AND VERIFIED |
| H02 Stale tabs and cross-identity retries | HIGH | FIXED AND VERIFIED |
| H03 Unverified artifact publication and signing | HIGH | FIXED (workflow + gate logic tested); remote execution PENDING authorisation |
| H04 Confidential materials in Git history | HIGH (publication) | PREPARED (sanitized candidate built and scanned); publication PENDING approval |
| H05 Hosted submission incomplete | HIGH | OPEN until live deployment is verified |
| M01 Shared-IP rate limiting | MEDIUM | FIXED AND VERIFIED |
| M02 Concurrent seed credential consistency | MEDIUM | FIXED AND VERIFIED |
| M03 Scheduler shutdown ordering | MEDIUM | FIXED AND VERIFIED |
| M04 Residual OS-package CVE applicability | MEDIUM (evidence gap) | FIXED (per-advisory report for the amd64 artifact); risk decisions PENDING owner |
| L01 Scheduler metrics correctness | LOW | FIXED AND VERIFIED |

## H01 — Session restoration and logout
- **Root cause.** Startup `GET /auth/me` was an "auth path" and never triggered refresh, so an expired access token
  stranded a valid refresh session. `GET /auth/csrf` returned a session-bound token whenever a refresh cookie was
  valid, but login requires a pre-login token. Logout cleared local state even when the server call failed.
- **Fix.** `restoreSession()` performs one coordinated refresh (single flight + Web Locks) and never loops;
  `GET /auth/csrf?purpose=login` always yields a pre-login token; login revokes the browser's previous session;
  logout returns `confirmed` only on 200, otherwise hides protected content, wipes caches and tells the user the
  session may still be active with a *Retry sign-out* action. Smoke test now replays the ORIGINAL access and refresh
  cookies after logout (both 401) instead of using an anonymous client.
- **Tests.** `tests/e2e/sessions.spec.ts` (expired access + valid refresh → restored with exactly one rotation; two tabs
  reloading together → one rotation, session not revoked; revoked refresh → sign-in works; forced logout failure →
  unconfirmed + DB session still live, retry → revoked; post-logout replay → 401/401);
  `tests/integration/final-audit-auth.test.ts` (pre-login token with a live session, prior session revoked, replayed
  credentials rejected); `apps/web/src/lib/api.session.test.ts` (one refresh, no loops, single-flight).
- **Residual.** None known.

## H02 — Stale tabs and cross-identity retries
- **Root cause.** Tabs share cookies but hold separate viewers, drafts and caches; after another tab signed in as a
  different user, a stale tab's CSRF retry fetched a token bound to the REPLACEMENT session and resent the old mutation,
  which the server executed as the new identity.
- **Fix (server-enforced).** Opaque per-session context (HMAC of the session id; stable across rotation) returned at
  login/refresh/`/auth/me` and echoed as `X-Session-Context`; required on authenticated mutations, enforced on reads,
  refresh and logout; mismatch → `409 SESSION_CHANGED`, nothing executed. Client: epoch counter cancels pending retries,
  in-flight requests are aborted, caches cleared, the protected tree is remounted per session (drafts discarded), a
  BroadcastChannel hint plus visibility/pageshow revalidation ask the server, and a notice explains the switch. No
  credentials or staff data are persisted in the browser.
- **Tests.** Browser (two pages in ONE context, persisted DB truth): customer→customer, staff→staff, staff→customer,
  pending drafts and new-ticket forms during identity change, CSRF-retry path, suspended tab, back/forward,
  cross-tab logout, same-session refresh. **Mutation-tested:** with the server check disabled, customer A's drafted ticket
  was created for Diya and Imran's staff intake was created as Priya; with the check enabled both are refused.
  Integration: the same scenarios at HTTP level, logout/refresh from a stale tab refused, context stable across rotation.
- **Residual.** None known; enforcement does not depend on browser events.

## H03 — Unverified artifact publication and signing
- **Root cause.** `release.yml` could build/push/sign any dispatched ref without proof that the exact SHA passed checks.
- **Fix.** Gate job (`scripts/release-gate.mjs`): only `refs/heads/main`; typed 40-hex SHA must equal the dispatched
  commit; the latest push runs of CI and Security on main for that SHA must have succeeded, including CI's release-gate
  job. Then ONE linux/amd64 build, smoke-tested through the compose stack, Trivy-gated, SBOM'd; publish only with
  `publish=true`; pull back by digest and reject a config-digest mismatch; keyless sign + attest; verify against the exact
  workflow identity (no regexp); optional deploy of that digest (Render deploy hook `imgURL`). Publishing jobs use the
  protected `release` environment (reviewers/branch restrictions are repository settings to configure on creation).
  `/api/healthz` reports the build commit for external revision checks.
- **Tests.** `tests/release/release-gate.test.mjs` (9): unapproved ref, mismatched/short SHA, missing/failed/cancelled/
  in-progress runs, stale/other-branch/PR runs, latest-rerun wins, missing CI gate job, digest mismatch, exact identity.
  Workflow policy tests (17). Keyless "incorrect identity" rejection cannot be exercised locally (needs OIDC); the verify
  step pins identity + issuer and M7 showed key-based verification rejects a different key.
- **Residual.** No remote run yet; environment protection must be configured in GitHub.

## H04 — Confidential assessment materials in Git history
- **Root cause.** The assessment PDF and baseline PDF have been tracked since the first commit; a clean Gitleaks scan says
  nothing about redistribution rights.
- **Fix.** `scripts/build-publication.sh` builds a SEPARATE repository with a fresh one-commit history from
  `git archive <rev>` minus `infrastructure/publish/EXCLUDE.txt` (both PDFs, the raw audit report — which also contained a
  local absolute path with the developer's username — and private AI-agent configuration), adds `PROVENANCE.md` with the
  source SHA, and fails closed on surviving PDFs, env files, dumps, keys, credential files or personal markers (derived at
  runtime). The original repository and history are untouched (it also carries an audit-tool ref that is never published).
- **Tests.** Candidate built, leak checks passed, redacted Gitleaks history scan of the candidate: no leaks (see notes).
- **Residual.** Scope approved by the owner; employer-specific references and internal process notes were removed from
  the published docs (generic paraphrased requirements kept).

## H05 — Hosted submission incomplete
- **Status.** OPEN. Prepared: free-hosting adaptations (machine sweep trigger, Supabase provisioning/verification/cron
  scripts rehearsed end-to-end locally), walkthrough credential filename corrected, SHORT_NOTE drafted. Resolution
  requires approved provisioning and live verification.

## M01 — Shared-IP rate limiting
- **Root cause.** One per-IP budget for all API traffic: a team behind one NAT shared 600 requests/min (21 × 429 in k6).
- **Fix.** Per verified user for signed-in traffic (all sessions of a user share it); strict per-IP budget for failed
  authentication, CSRF bootstrap and refresh; coarse per-IP pre-auth ceiling; login limits unchanged; trusted proxy hops
  only; bounded limiter memory (100k keys, oldest evicted).
- **Tests.** Nine agents behind one IP (135 requests, all 200 with a 20/min per-user limit); one user with three sessions
  shares one budget; forged/expired credentials and spoofed `X-Forwarded-For` limited per IP; CSRF bootstrap limited;
  health probes exempt; one trusted hop honours only the proxy-appended address; limiter memory bound unit test.
  **k6 mixed rerun** (release image, same 12 VUs from one IP): 1,893 requests, 10.2 req/s, **0 × 429**, 0 unexpected,
  checks 100 %, p95 20.3 ms, all thresholds pass.
- **Residual.** Single-instance, in-memory (documented); distributed store is roadmap.

## M02 — Concurrent seed credential consistency
- **Root cause.** The credential-file lock ended before the database insert.
- **Fix.** Discovery → generation → file record → hash insert/update run in ONE transaction holding a per-database
  advisory lock shared by seed and password reset; whole seed runs are also serialised (session advisory lock on a single
  connection); user creation is all-or-nothing.
- **Tests.** Real concurrent processes: overlap forced after A wrote the file and before its insert → B waits on the
  advisory lock (observed in `pg_stat_activity`), creates nothing, every recorded password verifies; SIGKILL after the
  write → no hashes, no lock, authorised rerun consistent; overlapping resets → one refuses. Without the locks the runs
  collided (A failed after B overwrote A's recorded passwords).
- **Residual.** None known. Development passwords were not reset.

## M03 — Scheduler shutdown ordering
- **Root cause.** Prisma disconnected in `onModuleDestroy`, before the scheduler drained in `onApplicationShutdown`.
- **Fix.** Scheduler stops and drains in `beforeApplicationShutdown` (bounded by `SWEEP_SHUTDOWN_DRAIN_MS`); Prisma
  disconnects in `onApplicationShutdown`, after the HTTP server closes.
- **Tests.** Real process, real SIGTERM while a ticket transaction is blocked in PostgreSQL: it commits (FD-007 closed,
  audit rows attributed to the invocation, durable counters), invocation COMPLETED, exit by re-raised SIGTERM, clean
  restart. With the old ordering the test fails.
- **Residual.** Beyond the drain budget the invocation stays leased and is recovered (fenced) on the next start.

## M04 — Residual OS-package CVE applicability
- **Fix.** `docs/CVE_APPLICABILITY.md` (generated by `scripts/cve-report.mjs`) analyses all 11 HIGH/CRITICAL advisories
  (38 package findings) of the final amd64 artifact with reachability, mitigations, residual uncertainty, review date and
  a PROPOSED decision; linkage probe from the same image shows no application or Node object links the affected libraries;
  full Trivy JSON retained (`docs/evidence/`). A derived image with a fixable CRITICAL (minimist 1.2.5) makes the gate
  exit 1.
- **Residual.** 38 unfixed findings remain; acceptance is the owner's decision. Distroless optional.

## L01 — Scheduler metrics correctness
- **Fix.** `frontdesk_sweep_last_scheduled_success_timestamp_seconds` (SYSTEM: timer or external trigger) and
  `..._last_manual_success_...` are separate; invocations carry `trigger=timer|external|manual`; alerts/dashboard use the
  scheduled gauge only. Metrics stay on the private bearer-protected listener.
- **Tests.** Unit (manual never updates the scheduled gauge; external SYSTEM does) and integration (manual sweep leaves the
  scheduled gauge at 0; external trigger counted with `trigger="external"`).
