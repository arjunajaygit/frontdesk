# M1 deployment feasibility (desk research only — nothing provisioned or deployed)

Sources checked 2026-11-21: Render [free-tier docs](https://render.com/docs/free), Vercel [cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), Supabase [project pausing](https://supabase.com/docs/guides/platform/free-plan-pausing). Provider terms change; re-verify in M8 against the exact account.

| Need | Finding | Verdict |
|---|---|---|
| Same-origin API + HTTPS + cookie flags | One Node service serving the Vite build as static files and the API under `/api` gives one origin with provider-terminated HTTPS. `PUBLIC_ORIGIN` = that origin. Cookie paths (`/api`, `/api/auth`) and `Secure` need verifying on the real host in M8 (trust-proxy hop must be configured narrowly). | Feasible |
| Vercel for the API | Serverless functions have no long-lived process, so the in-process `@nestjs/schedule` sweep cannot run there. Hobby cron is once per day with ±59 min precision. | **Not suitable for the scheduler.** A Vercel static front-end + `/api` rewrite is possible but adds a second host, so the API host must still run the scheduler. |
| Unattended scheduler (SWEEP_CONTRACT) | Render free web services spin down after 15 min without inbound traffic, so an in-process scheduler stops. An external ping would be "browser traffic by proxy" and is discouraged by Render. Render cron jobs appear to need a paid plan (unconfirmed). | **Genuine limitation.** Needs an always-on instance (paid) or a paid cron job running a DB-only sweep entrypoint. Free tier would require disclosing that sweeps only run while the service is awake. |
| Managed PostgreSQL | Render free Postgres expires 30 days after creation, 1 GB, no backups: unsuitable for a one-week-live-plus-review window only if created early; fine if created at deploy. Supabase free pauses after 1 week of inactivity (restore window 90 days per current docs). | Feasible with caveats; keep-alive is real DB activity from the scheduler. |
| Pooling | Supabase transaction-mode pooler needs Prisma `pgbouncer=true`; migrations need a direct/session connection (owner role). Not verified here. | Verify in M8 |
| Role separation on managed DB | Migration 3 fails closed unless `frontdesk_app` exists with no elevated attributes. On Supabase/Render the owner must run the provisioning SQL (see `infrastructure/docker/initdb/01-roles.sh`) before `migrate deploy`. | Feasible, documented |
| Migrations | `prisma migrate deploy` as owner in the deploy/pre-deploy step; runtime never holds owner credentials. | Feasible |
| Health/readiness | `/api/healthz` and `/api/readyz` (DB check via the restricted role) implemented and smoke-tested locally. | Done locally |

## Unresolved dependency needing a user decision before M6/M8
Which hosting tier: (a) paid always-on API instance (scheduler in-process, simplest, meets "unattended"), (b) free tier with disclosed scheduler limits. Recommendation: (a) for the review week, single Render web service + Postgres in the same region; no provisioning without approval.
