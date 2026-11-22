# Deployment feasibility and procedure (prepared in M6; nothing provisioned, nothing deployed)

Requirement: a public HTTPS reviewer URL for **at least one week**, one same-origin container (API + SPA),
PostgreSQL with the **owner / restricted-runtime role model and audit triggers**, secrets in the host's
environment, and an **unattended scheduler** (SLA sweep + retention) that does not depend on browser traffic.

## Verified facts (sources checked 2026-11-22; provider terms change — re-check in M8)

| Fact                                                                                                                                                                                                                                                 | Source                                                                                                                                                | Consequence                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render free web services spin down after 15 min of no inbound traffic; free Postgres expires after 30 days                                                                                                                                           | [Render free-tier docs](https://render.com/docs/free)                                                                                                 | A sleeping instance cannot run the in-process scheduler. Free tier is **not** adequate for a one-week unattended demo.                                                                                                                                                                                                                                                           |
| **Verified M7 (render.com/pricing.md, 2026-11-22):** web `0.5c-512mb` (legacy Starter) US$7/month; Postgres `0.1c-256mb` (legacy basic-256mb, 100 connections) US$6/month + storage US$0.30/GB; Hobby workspace US$0; compute prorated to the second | [Render pricing (markdown)](https://render.com/pricing.md), [compute plans](https://render.com/docs/compute-plans)                                    | One week ≈ (7 + 6 + 0.30) × 7/30 ≈ **US$3.10**; a full month ≈ US$13.30. Paid instances are not described as sleeping (only Free spins down after 15 min). Needs user approval.                                                                                                                                                                                                  |
| Render Postgres is managed with **no superuser**; the default user is highly privileged. Whether it can `CREATE ROLE` is **not confirmed from official docs**                                                                                        | [Render community answer](https://community.render.com/t/permissions-setting-in-postgresql-database/6892)                                             | `preflight.sql` must be run and pass **before** any deploy; fallback topology below.                                                                                                                                                                                                                                                                                             |
| Supabase: custom roles supported; app should use the transaction pooler (6543, `?pgbouncer=true`) and a **direct/session** URL for migrations; direct connection is IPv6-only on Free; prepared statements are unsupported on the shared pooler      | [Supabase + Prisma](https://supabase.com/docs/guides/database/prisma), [connecting](https://supabase.com/docs/guides/database/connecting-to-postgres) | Workable but riskier: (1) Supabase's public-schema default privileges can expose tables to its API roles (`anon`/`authenticated`/`service_role`) — **must be revoked or the Data API disabled**; (2) free projects pause after inactivity ([docs](https://supabase.com/docs/guides/platform/free-plan-pausing)); (3) Node host is still needed (Supabase does not run this app). |
| Vercel serverless cannot run an in-process scheduler; Hobby cron is daily                                                                                                                                                                            | [Vercel cron docs](https://vercel.com/docs/cron-jobs/usage-and-pricing)                                                                               | Not suitable for the API/scheduler.                                                                                                                                                                                                                                                                                                                                              |

## Recommended topology (preferred: keep the security contract, change the host)

**A. Render web service (Docker, Starter, always-on) + Render Postgres (paid), same region, private networking.**
Meets always-on scheduler, HTTPS termination, env secrets, health-gated deploys. Unknown: role creation → verified by `preflight.sql` on the new DB _before_ migrating. If it fails, use B.

**B (fallback, full control, potentially free/cheap): one small always-on VM** running `infrastructure/docker/compose.prod.yaml` unchanged behind a TLS reverse proxy (e.g. Caddy with automatic certificates). Identical to what was verified locally; set `TRUST_PROXY_HOPS=1` and `PUBLIC_ORIGIN=https://<domain>`; remove the loopback-HTTP flag. Needs a domain/DNS and a VM the user controls.

Do **not** use a sleeping free tier for the review week; if it is the only option, disclose that sweeps only run while awake (catch-up on wake is proven by the restart tests but is not "unattended").

## Release procedure (any host)

1. Build from the reviewed commit: `docker build --build-arg GIT_SHA=$(git rev-parse HEAD) --target runtime …` and `--target migrate …`; the SHA is recorded in the OCI label and logged at startup (`frontdesk started … commit`).
2. Provision DB, run `preflight.sql` as the admin user; every result row must read `OK` (or `OK (none)`).
3. **Migrate** with the _migrate_ image and the **owner** URL (direct, TLS): `docker run --rm -e DATABASE_URL=… frontdesk-migrate`. Never run migrations from the app container; never give the app the owner URL.
4. Deploy the app with the **restricted** URL, `NODE_ENV=production`, exact `PUBLIC_ORIGIN`, `TRUST_PROXY_HOPS=1`, independent random `JWT_SECRET`/`CSRF_SIGNING_KEY`. The app **refuses to start** if its database role is over-privileged; readiness stays red otherwise.
5. Seed synthetic demo data **once and explicitly** (never on startup): `SEED_CREDENTIALS=write` with `ALLOW_DEMO_SEED=true`, owner URL, recorded in a git-ignored `.local/credentials.<label>.json`.
6. Run `node scripts/smoke-prod.mjs --base https://<origin> --creds .local/credentials.<label>.json` (23 checks) and the M8 proxy/cookie/CSRF/scheduler verification.
7. Roll back by redeploying the previous image; schema changes are forward-only (restore from backup if ever required; backup/restore timing is **not measured**).

## Open items for M8 (need user decisions/approval)

Hosting choice and budget · domain (for B) · region · run `preflight.sql` on the real DB · confirm Render Starter price · verify real proxy cookie/Origin/CSRF behaviour at the public URL · keep the URL up and check it daily for a week.

## M7 preflight update (2026-11-22)

- **Still unverified (blocking for option A):** Render's docs do not state whether the database's original user can `CREATE ROLE`, nor superuser status; PL/pgSQL is enabled by default ([extensions](https://render.com/docs/postgresql-extensions)); users created with `CREATE USER` are "not managed by Render" ([credentials](https://render.com/docs/postgresql-credentials)). Run `preflight.sql` before migrating; if role creation or trigger creation fails, use option B.
- **Resource fit (from local measurements):** app RSS 78–90 MiB under the mixed and stress runs → fits 512 MB; Postgres 256 MB RAM with 100 connections is enough for 9 agents (Prisma pool default is small). Argon2id logins briefly peak CPU; 0.5 CPU will slow concurrent logins but not correctness.
- **Metrics on a host:** keep `METRICS_PORT` unset unless a private scraper exists (Render private network / VM-local Prometheus). Never expose it publicly; a token is required in production.
- **Monitoring stack is optional** and not part of the reviewer deployment.
- **Backups:** paid Render Postgres has provider backups (verify retention in the dashboard); the local logical procedure is `infrastructure/ops/backup-restore-verify.sh`.
- **Recommendation for M8 approval:** option A (Render Docker web service 0.5c-512mb + Postgres 0.1c-256mb, same region), ≈ US$3.10 for the review week, **conditional on preflight.sql passing**; otherwise option B (small VM + this compose stack + Caddy TLS).

## M8 zero-cost deployment (executed 2026-11-22 under the owner's authorization; evidence: docs/M8_DEPLOYMENT_EVIDENCE.md)

**Topology (Option A): Render Free web service (Docker image, same-origin SPA + API) + Supabase Free PostgreSQL.**
Vercel is not used: it would add a cross-boundary proxy for cookies/CSRF with no benefit for a same-origin container.

Verified facts (official docs, 2026-11-22): Render Free spins down after 15 idle minutes, ~1 min spin-up, 750 free
instance hours/month per workspace, images must be `linux/amd64`, prebuilt private GHCR images and digests are
supported, deploy hooks accept `imgURL` (render.com/docs/free, /deploying-an-image, /deploy-hooks). Supabase Free: 2 active
projects, 500 MB database, projects pause after 1 week of inactivity; direct connections are IPv6-only on Free, the shared
pooler is IPv4 in session and transaction mode, session mode supports prepared statements, custom roles connect as
`<role>.<project-ref>`; the Data API can be disabled; pg_net's default timeout is 2 s and is settable per call
(supabase.com/docs: connecting-to-postgres, roles, hardening-data-api, pg_net, pricing). Not stated in the docs and
therefore verified at preflight: pg_cron, pg_net and Vault availability on the Free plan.

Procedure (as executed; each step had the approval checkpoint):

1. Supabase: new isolated project (region near Render's), disable the Data API, note the session-pooler host.
2. `01-provision.sql` as `postgres` (psql variables for passwords) → `prisma migrate deploy` as `frontdesk_owner` via the
   session pooler (`frontdesk_owner.<ref>`, verified TLS: `sslmode=verify-full` + `sslrootcert=infrastructure/deploy/supabase/supabase-prod-ca-2021.crt`
   for psql; the 2026-11-22 run used `sslmode=require`, encrypted but unverified) → `02-post-migrate.sql` → `03-verify.sql` (all OK).
3. Seed once, explicitly: `SEED_CREDENTIALS=write SEED_TARGET_LABEL=hosted ALLOW_DEMO_SEED=true` → `.local/credentials.hosted.json`
   (fresh random passwords; never the development ones).
4. GitHub: create the approved repository from the sanitized candidate; run CI and Security; run `release.yml`
   (publish=true) for the exact SHA → signed amd64 digest in GHCR.
5. Render: Free web service from that image digest (registry credential for a private package); env: `NODE_ENV=production`,
   `PUBLIC_ORIGIN=https://<service>.onrender.com`, `TRUST_PROXY_HOPS=1`, independent `JWT_SECRET`/`CSRF_SIGNING_KEY`/
   `SWEEP_TRIGGER_TOKEN`, `DATABASE_URL=postgresql://frontdesk_app.<ref>:…@<pooler-host>:5432/postgres?sslmode=require&sslcert=/app/certs/supabase-prod-ca-2021.crt&sslaccept=strict&connection_limit=5`
   (the image ships Supabase's public root CA; `sslaccept=strict` verifies the pooler certificate chain and hostname),
   metrics disabled (`METRICS_PORT` unset), health check path `/api/healthz`.
6. `04-cron.sql`: pg_cron job calling `POST /api/internal/sweep` (token in Vault, per-slot Idempotency-Key, 120 s timeout).
   Schedule every 30 minutes (active, jobid 1; verified per slot in M8_DEPLOYMENT_EVIDENCE.md): the service sleeps between runs (no keep-alive pinging), each run wakes it, processes
   due work as SYSTEM, and the in-process scheduler continues while awake. Granularity: breaches keep their exact
   deadline timestamps, but auto-close/expiry can be recorded up to one interval late.
7. Verify externally (HTTPS): smoke suite, cookies Secure/HttpOnly, CSRF/Origin, revision via `/api/healthz`, scheduled
   SYSTEM invocations with no browser traffic, privacy in DOM/network. Keep the URL up ≥ 7 days; no auto-teardown.

Expected cost: US$0 (free tiers). Limits: cold starts (~1 min), no uptime guarantee, Supabase inactivity pausing (cron
traffic is expected to count as activity — to be observed), 500 MB storage, Render may restart free services at any time.
Rehearsal: `infrastructure/deploy/supabase/rehearse-local.sh` reproduces steps 2–3 and the app start against a container
that mimics Supabase's role layout; it passed end to end (verify 9/9, API roles denied, startup privilege check, smoke).
