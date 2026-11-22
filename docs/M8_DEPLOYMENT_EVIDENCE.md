# M8 deployment evidence (live, 2026-11-22)

Every result below was executed against real external resources (GitHub Actions, GHCR, Render, Supabase). Nothing is
simulated. Anything that could not be measured is marked **UNKNOWN**.

## Identities (current deployment)

| Item | Value |
|---|---|
| Repository | https://github.com/arjunajaygit/frontdesk (made **public** at the owner's request on 2026-11-22 after a full-history check: no secrets, personal data, employer details or infrastructure identifiers; sanitized publication history, see PROVENANCE.md). The GHCR image package remains private. |
| Released source revision | `741fee7c673f3e903b8f4ea6d50bfb708aaf6ed1` (publication repo; merge of PR #14, the final assessment audit, on top of the redesign) |
| CI (that SHA) | https://github.com/arjunajaygit/frontdesk/actions/runs/45044659609: success (static, unit, PostgreSQL integration incl. PROOF-01..05, Playwright, Docker amd64 smoke/k6/ZAP, release gate) |
| Security (that SHA) | https://github.com/arjunajaygit/frontdesk/actions/runs/45044659628: success (Gitleaks full history, Semgrep, npm audit gate + SBOM, Trivy) |
| CodeQL | Skipped while the repository was private (code scanning on private repositories is a paid GitHub feature); runs on every push since it was made public. Semgrep remains the mandatory SAST gate. |
| Release workflow | https://github.com/arjunajaygit/frontdesk/actions/runs/45045027702: success. Steps: gate (main, exact SHA, passing CI + Security) → one linux/amd64 build → smoke → Trivy gate → SBOM → publish → pull back → config-digest match → keyless sign + CycloneDX attestation → both verified against the exact workflow identity |
| Registry manifest digest (deployed) | `ghcr.io/arjunajaygit/frontdesk@sha256:aa4577a035a61ec6849f770e77d34530563e08504b3c7e546a829ee95c89baba` (private GHCR package) |
| Config digest (tested image) | `sha256:dfc85783406015a6322a345104e2e956971474aca0482a3fa98a7e3efea4dde9` (equal to the pulled-back image) |
| Independent signature check | Run locally with cosign: `cosign verify` and `cosign verify-attestation --type cyclonedx`. Identity `https://github.com/arjunajaygit/frontdesk/.github/workflows/release.yml@refs/heads/main`, issuer `https://token.actions.githubusercontent.com`. Both passed (claims validated, transparency-log inclusion verified, certificate chain verified). |
| Live URL | https://frontdesk-arvo-support.onrender.com (Render Free, Singapore) |
| Render deploy | `dep-dc1ho7cs728c73cfl4h0`, image `sha256:aa4577a0…`, live at 16:46 UTC |
| Deployed revision check | `GET /api/healthz` → `{"ok":true,"commit":"741fee7c673f3e903b8f4ea6d50bfb708aaf6ed1"}` |
| Database | Supabase Free project `frontdesk` (ap-southeast-1), PostgreSQL 17.12, IPv4 session pooler |

**Previous deployments (same day).**
- `136ee89`, digest `ebf7a980…`: CI 45022244966, Security 45022245000, release 45022802427, deploy `dep-dc1e4m4s728c73c6lpr0` at 12:40 (the redesign). The final audit's new runtime-health check found an unrecognised Permissions-Policy token on it, which is fixed in `741fee7`.
- `9cadd0b`, digest `b5ef0a7f…`: CI 45017605776, Security 45017605825, release 45017938581, deploy `dep-dc1dkbajnfac738g25hg` at 12:04. It introduced strict database TLS and the scroll fix, passed every live suite below, and was replaced only to ship the merged redesign.
- `a577264`, digest `681c5e31…be247c`: CI 44995365902, release 44995728324. It was replaced to ship the scroll fix and database TLS verification.

**Earlier CI failures.** Failed CI runs on the same repository (first pushes) and their root causes are recorded in `docs/IMPLEMENTATION_NOTES.md`. None was bypassed. One Security run, on `983a631`, failed correctly: Semgrep blocked `rejectUnauthorized: false` in two new hosted-verification scripts. The fix is the next section, not a suppression.

## Database TLS: verified, not just encrypted

| Connection | Before | Now |
|---|---|---|
| Runtime (`frontdesk_app`, Render) | `sslmode=require`: encrypted, certificate **not** verified | `sslmode=require&sslcert=/app/certs/supabase-prod-ca-2021.crt&sslaccept=strict`: chain **and** hostname verified |
| Verification scripts (owner, local) | `rejectUnauthorized: false` (Semgrep-blocked, never released) | `ssl: { ca: <Supabase root> }` |
| Operator `psql` | `sslmode=require` | `sslmode=verify-full sslrootcert=infrastructure/deploy/supabase/supabase-prod-ca-2021.crt` |

**How the root CA was established.** The pooler certificate (`*.pooler.supabase.com`) chains to Supabase's private "Supabase Root 2021 CA", which is not in public trust stores. I downloaded that root over verified HTTPS from Supabase, and its DER SHA-256 `807025ad…e6cafa` equals the root served in the pooler's own chain. The root is committed at `infrastructure/deploy/supabase/supabase-prod-ca-2021.crt`, and `tests/unit/supabase-ca.test.ts` pins its fingerprint. It is copied into the image at `/app/certs/`.

**Negative tests:**
- *In the Linux release image (Prisma):* correct root → connected; wrong root → refused (`certificate verify failed`); no root → refused.
- *From node-postgres:* committed root → verified; system roots only → refused (`SELF_SIGNED_CERT_IN_CHAIN`).
- *Live:* all deployed suites below pass on the new revision, which can only reach the database through the strict connection.

**Historical limitation (stated, not hidden).** The one-time provisioning, migrations and seed (earlier on 2026-11-22) ran from the operator machine over `sslmode=require`. That traffic was encrypted but the certificate was unverified.

## Pre-deployment residual-risk re-scan (exact manifest, refreshed DB)

I ran a Trivy 0.76.2 remote scan before each deploy, for `b5ef0a7f…`, `ebf7a980…` and `aa4577a0…` (DB updated 2026-11-21 18:38 UTC, the latest published at scan time):
- 38 HIGH/CRITICAL package findings, across the same 11 advisories the owner conditionally accepted;
- no new advisory, none removed, no fix available;
- 0 npm, secret or misconfiguration findings.

The acceptance conditions (no new high/critical, no applicability change, no available fix) still hold.

## Hosted database (Supabase): provisioning and verification

- **Provisioning:** `01-provision.sql` ran as `postgres`, which is a non-superuser here (CREATEROLE/CREATEDB/BYPASSRLS; `public` is owned by pg_database_owner).
- **Migrations:** five migrations applied as `frontdesk_owner` through the pooler. The temporary database CREATE grant was then revoked (`02-post-migrate.sql`).
- **`03-verify.sql`: 9/9 OK.** The checks:
  - the runtime role is restricted and has no memberships;
  - ownership is correct;
  - API roles and PUBLIC have no table privileges;
  - PUBLIC has no function EXECUTE;
  - append-only triggers are present;
  - the runtime role has no UPDATE/DELETE/TRUNCATE and no CREATE;
  - the temporary grant is revoked.
- **Live denials:**
  - `frontdesk_app` attempting UPDATE, DELETE or TRUNCATE on `audit_logs`, or CREATE TABLE → permission denied.
  - `anon`, `authenticated` and `service_role` reading `Ticket` → permission denied, so the Data API cannot bypass the app.
- **Seeded once, explicitly:**
  - 12 reviewer users, 15 scenario tickets and 3 holidays;
  - one synthetic verification customer (`verification.bot@customer.example`), so deployment checks never touch reviewer scenarios.

  Credentials exist only in the git-ignored `.local/credentials.hosted.json` (0600) and are delivered through a private channel.

## Deployed application checks (public HTTPS; identical results on `9cadd0b`, `136ee89` and the current `741fee7`, which additionally passes `hosted-runtime-health` 9/9)

| Suite | Result |
|---|---|
| `scripts/smoke-prod.mjs`: production smoke incl. Secure/HttpOnly/SameSite cookies, HSTS, CSRF/Origin, privacy in detail + CSV, logout replay, stale tab | **29/29 PASS** |
| `scripts/hosted-verify.mjs`: workflows on synthetic tickets, with DB truth | **29/29 PASS** |
| `scripts/hosted-browser.mjs`: real Chromium | **8/8 PASS** |
| Empty page scroll (real Chromium, staff workspace) | **0 px** of extra document scroll at 1440, 1024 and 390 px (previously 891–1,051 px) |

**Workflow coverage (`hosted-verify`):**
- *Claiming:* 9-agent claim race (one 200, eight 409, exactly one `TICKET_CLAIMED` row).
- *Clocks and escalation:* independent clocks (response completed, resolution running); waiting pauses the clock and a customer reply resumes it; escalation is recorded.
- *Privacy:* the private note is absent from the customer detail, timeline, JSON and CSV export, DOM and network; another customer's ticket returns 404.
- *Lifecycle:*
  - resolve → reopen inside 7 days → resolve → expired window → `NEW_LINKED_TICKET`, with the parent link in the DB;
  - an overdue waiting reply → linked ticket;
  - an overdue waiting ticket is auto-closed by the deployed SYSTEM scheduler (`AUTO_CLOSED_NO_REPLY`, correlated with a `SWEEP_STARTED` invocation).
- *Sweeps:* lead-only manual sweep (an agent gets 403).
- *Pagination and audit:* 56-message pagination; audit reconstruction (a customer gets 403).

**Browser coverage (`hosted-browser`):** two tabs in one browser (the stale draft is refused and created for neither identity, and the switch notice is shown); the session is restored after access-token expiry; cross-tab sign-out.

**Metrics are not exposed.** `/metrics` on the public port serves the SPA shell (HTML), `/api/metrics` returns 404, and the listener is disabled.

## Scheduler (free-tier sleep) — measured

Render Free spins an idle service down after about 15 minutes. A sleeping instance cannot run its in-process 60-second scheduler.

**External trigger.** Supabase Cron job `frontdesk-sla-sweep` (`*/30 * * * *`, jobid 1) calls `POST /api/internal/sweep` through `pg_net`:
- the bearer token is read from Supabase Vault at run time, and the stored job text contains it **0** times;
- the request carries a per-slot `Idempotency-Key` (`ext-cron-YYYYMMDDHHMM`) and has a 120 s timeout.

The endpoint runs the same fenced, idempotent sweep as the in-process scheduler, as the SYSTEM actor. A successful cron row alone is **not** treated as proof. Each slot below was checked at four layers: the cron run, the real HTTP response in `net._http_response`, the persisted `SweepInvocation`, and (for the business test) the ticket and audit rows.

| Slot (UTC) | Cron run | HTTP (pg_net) | Persisted invocation | Business effect |
|---|---|---|---|---|
| 11:30 | succeeded | **200**, not timed out; body = sweep result | `SYSTEM:-:ext-cron-202611221130`, SYSTEM, COMPLETED | nothing due (processed 0), which is correct |
| 12:00 | succeeded | **200**, not timed out | `SYSTEM:-:ext-cron-202611221200`, SYSTEM, COMPLETED | nothing due (processed 0), which is correct |
| 12:30 | succeeded (12:30:00.14) | **200**, not timed out; **instance was asleep**, request answered after the cold start | `SYSTEM:-:ext-cron-202611221230`, SYSTEM, COMPLETED, started 12:30:38.73, finished 12:30:38.86 | nothing due (processed 0); see cold start below |
| 13:00 | succeeded (13:00:00.16) | **200**, not timed out | `SYSTEM:-:ext-cron-202611221300`, SYSTEM, COMPLETED, started 13:00:00.49, **processed 1, autoClosed 1** | the verification ticket was **closed by this cron call** (see below) |

**Cron-attributed auto-close (persisted business processing): VERIFIED at the 13:00 slot.** The in-process scheduler fires at a fixed phase per instance, so the test was timed around it:
- *12:30 attempt, correctly skipped:* the instance was asleep and the phase could not be confirmed, so the safety check refused to move the deadline. That slot became the cold-start measurement below.
- *13:00 attempt:*
  - At 12:59:00 the instance was awake, with in-process sweeps at `hh:mm:19`.
  - At 12:59:24.7, after the 12:59:19 sweep, the verification ticket's stored waiting deadline was moved into the past (the technique the integration tests use).
  - At 13:00:00.49 the cron invocation started, processed 1 ticket and auto-closed 1.
  - At 13:00:00.62 `TICKET_CLOSED` (`AUTO_CLOSED_NO_REPLY`) was recorded. Its correlation ID resolves to the `SWEEP_STARTED` event of `SYSTEM:-:ext-cron-202611221300`.
  - The next in-process sweep ran at 13:00:19, after the close.
- *Conclusion:* the external trigger's HTTP call performs real, persisted lifecycle work as the SYSTEM actor.

**Cold start: MEASURED (one sample, 2026-11-22 12:30 UTC).**
- *The instance was asleep.* The last in-process sweep ran at 12:21:31 (about 15 minutes after the last inbound request, at about 12:07), and Render logged nothing between 12:21:31 and 12:30:33.
- *The wake:*
  - 12:30:00.14: the cron sends the request.
  - 12:30:33.2: a new instance (`…-hss86`, previously `…-54mm6`) logs "Starting Nest application", after **≈ 33 s** of platform resume.
  - 12:30:38.73: the app starts the sweep (app boot + DB connect ≈ 5.5 s).
  - 12:30:38.86: the sweep finishes and returns **HTTP 200**.
- *Total:* **≈ 38.6 s** from request to response, inside the 120 s pg_net timeout. The invocation persisted as SYSTEM COMPLETED.
- *Caveats:*
  - pg_net's `net._http_response.created` holds the request time, not the response time, so the measurement uses the app's own `startedAt` together with Render's log timestamps.
  - This is one sample, not a distribution.
  - Whether the image was re-pulled on wake is still **UNKNOWN** (Render logs no pull events).
- *Earlier spin-down on the previous instance:* an 11,996 s gap in in-process sweeps (07:42 → 11:01 UTC), woken by an unknown source.

**Lateness bound.** Lateness and breaches are computed from stored timestamps, so they are correct whenever they are read. While the instance sleeps, persisted effects (breach events, auto-close, reopen-window expiry) can be applied up to about 30 minutes late, plus any wake time. They are still applied only strictly after the cutoff.

**GitHub Actions scheduler: evaluated and rejected.** A 30-minute `schedule:` workflow with retries would:
- cost about 1,440 billed minutes a month (each run is billed at least 1 minute, and the private repo has a 2,000-minute allowance);
- suffer GitHub's documented schedule delays and drops under load;
- need the sweep token as an Actions secret.

Supabase Cron runs inside the database project at no extra cost and keeps the token in Vault. The GHCR policy is not a factor either way: GHCR storage and bandwidth are currently free, with one month's notice of any change, and a cold start re-pulls only from Render's side.

## Free-tier resources and limits (measured)

| Resource | Measured | Allowance |
|---|---|---|
| Render instance | memory 72–127 MiB; CPU 0.035 (5-min average) | 512 MiB; 0.15 CPU |
| Render free instance hours | UNKNOWN (no API; check the dashboard) | 750 h/month per workspace |
| GitHub Actions (private repo, Free plan) | about 290 billed minutes earlier today, computed from job runtimes (210 from Dependabot PR runs), plus today's later CI, release and PR runs | 2,000 min/month |
| GHCR | two release images (about 145 MB compressed each) plus signatures and attestations | storage and bandwidth currently free |
| Supabase | 1 active Free project (3 existing projects paused, untouched) | 2 active Free projects |
| Cost | US$0 (all free tiers; no paid plan or overage enabled by this work) | — |

## Repository housekeeping during M8

- **Dependabot:** 8 of the original PRs were closed by Dependabot itself and 1 (#6, not security-relevant) by me under the owner's authorization. PR #11 (grouped GitHub Actions bumps, opened after the authorization) is left open for the owner. Vulnerability alerts are enabled.
- **PR #12** (the owner's README) was merged after all required checks passed on its updated head. Its README is now the source of truth in the private repository.
- **PR #13** (frontend redesign) was merged at the owner's request after all required checks passed (merge commit `2476934`). It was then released through the full gated chain and is live in `136ee89`.

## Verification commands (reproducible)

```bash
# Deployed revision
curl -s https://frontdesk-arvo-support.onrender.com/api/healthz
# Signature + SBOM attestation of the deployed digest
D=ghcr.io/arjunajaygit/frontdesk@sha256:aa4577a035a61ec6849f770e77d34530563e08504b3c7e546a829ee95c89baba
ID=https://github.com/arjunajaygit/frontdesk/.github/workflows/release.yml@refs/heads/main
cosign verify --certificate-identity "$ID" --certificate-oidc-issuer https://token.actions.githubusercontent.com "$D"
cosign verify-attestation --type cyclonedx --certificate-identity "$ID" --certificate-oidc-issuer https://token.actions.githubusercontent.com "$D"
# Residual-risk re-scan of the exact manifest
trivy image --image-src remote --platform linux/amd64 --scanners vuln,secret,misconfig "$D"
# Live suites (credentials from the private file; OWNER_URL without sslmode, TLS verified by the scripts)
node scripts/smoke-prod.mjs   --base https://frontdesk-arvo-support.onrender.com --creds .local/credentials.hosted.json
OWNER_URL=... node scripts/hosted-verify.mjs  --base https://frontdesk-arvo-support.onrender.com --creds .local/credentials.hosted.json
OWNER_URL=... node scripts/hosted-browser.mjs --base https://frontdesk-arvo-support.onrender.com --creds .local/credentials.hosted.json
# Scheduler truth (operator, verified TLS): cron run, real HTTP status, persisted invocation
psql "host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.<ref> sslmode=verify-full sslrootcert=infrastructure/deploy/supabase/supabase-prod-ca-2021.crt" \
  -c "select runid,status,start_time from cron.job_run_details where jobid=1 order by runid desc limit 3" \
  -c "select id,status_code,timed_out,created from net._http_response order by id desc limit 3" \
  -c "select key,status from \"SweepInvocation\" where key like '%ext-cron-%' order by key desc limit 3"
```
