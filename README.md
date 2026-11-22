# Frontdesk — Arvo Systems support ticketing

A support-ticket system built for the Arvo assessment: independent response/resolution SLA clocks that count only
working time (Mon–Fri 09:30–18:30 IST, configurable holidays), exclusive ticket claiming under real PostgreSQL
contention, strict private-note isolation, an append-only audit trail enforced by the database, and an
auto-close / reopen lifecycle driven by an unattended scheduler.

> Status: verified locally (see *Evidence* and `docs/FINAL_AUDIT_RECONCILIATION.md`). **Not deployed yet** — no live URL exists. Free hosting (Render + Supabase) is prepared and awaiting approval
> (`infrastructure/deploy/DEPLOYMENT.md`).

## Stack
React + Vite + strict TypeScript + Tailwind + TanStack Query · NestJS 11 · PostgreSQL 16 + Prisma 6 · JWT (HttpOnly
cookies) + Argon2id · Pino · Jest, Vitest, Playwright · Docker, GitHub Actions, Gitleaks, Semgrep, CodeQL, Trivy, CycloneDX.

## Quick start (development)
```bash
npm ci
npm run env:gen            # random secrets -> .env (git-ignored, mode 600; never overwritten)
npm run db:up              # isolated PostgreSQL 16 on 127.0.0.1:55432 (owner + restricted runtime role)
npm run db:migrate         # versioned migrations as the OWNER role
npm run demo:db            # separate reviewer DB `frontdesk_demo` (15 historical scenarios); passwords -> .local/credentials.frontdesk_demo.json
npm run build -w @frontdesk/contracts && npm run build -w @frontdesk/api
set -a; . ./.env; set +a
DATABASE_URL="${DATABASE_URL%/*}/frontdesk_demo" PUBLIC_ORIGIN=http://localhost:5173 node apps/api/dist/main.js   # API :3000
npm run dev -w @frontdesk/web                                                                                       # UI  :5173 (proxies /api)
```
Credential files live in `.local/` (git-ignored, mode 600) and are **per environment**; the seed refuses to overwrite
existing entries and never prints passwords. Use separate browser *profiles* for simultaneous agents (tabs share cookies).
See `docs/REVIEWER_WALKTHROUGH.md` for the scenario tour.

## Production-like run (one same-origin container + PostgreSQL)
```bash
node scripts/gen-env-prod.mjs                       # .env.production.local (random secrets, git-ignored)
npm run prod:up                                      # postgres -> migrate job (owner) -> app (restricted role)
docker compose -p frontdesk-prod --env-file .env.production.local -f infrastructure/docker/compose.prod.yaml --profile ops run --rm seed   # explicit, optional
node scripts/smoke-prod.mjs --base http://localhost:8080 --creds .local/credentials.prod-compose.json
npm run prod:down
```
The image is multi-stage, non-root, read-only at runtime, has no Prisma CLI, and contains `src/calendar.mjs`.
Migrations use a separate `migrate` image and the owner credentials; the app only ever receives the restricted role and
**refuses to start** if that role is over-privileged. Nothing seeds or resets data on startup.

## Tests
| Command | What |
|---|---|
| `npm run test:calendar` | the 12 original calendar-kernel tests (kernel unchanged) |
| `npm run test:unit` / `npm run test:web` | backend domain/config/contract tests / frontend tests (Vitest) |
| `npm run test:integration` | real-PostgreSQL integration suites incl. PROOF-01…05 and audit-remediation regressions |
| `npm run test:e2e` | Playwright against the real stack (browser privacy proof, workflows, axe, responsive) |
| `npm test` | calendar + unit + integration |

## Key design decisions
- **SLA** (`docs/DOMAIN_CONTRACT.md`): urgent resolution = rest of the effective working day (never a rolling 540 min);
  priority changes apply the new budget to *time already used*; exact deadline equality is on time, +1 ms is late;
  response clock completes only on a public staff reply; waiting needs an explicit public request.
- **Auto-close** after 2700 working minutes of silence (strictly after the cutoff); resolved tickets reopen for 7 calendar
  days inclusive, then a linked ticket is created. Customer contact gives the same result whether or not a sweep ran.
- **Security**: same-origin only (no CORS), HttpOnly cookies, signed CSRF + exact Origin, deny-by-default guards,
  database-enforced append-only audit (trigger + restricted role; the schema owner is the documented trusted boundary).
- Interpretation notes live in `docs/DOMAIN_CONTRACT.md`; demo holidays are *illustrative*, not official calendars.

## Evidence and limits
See `docs/IMPLEMENTATION_NOTES.md`, `docs/M4_REMEDIATION.md`, `docs/RTM.csv`, `docs/DEVSECOPS.md` and `docs/RISK_REGISTER.md`.
Known limitations: single-instance in-process rate limiter; no text search or aggregate counts in the API; ticket reference
is derived from the id; accessibility verified with axe + keyboard automation only (no screen-reader pass, no conformance
claim); CI workflows are validated but have **not** run on GitHub; backup/restore, HA and DR are not demonstrated.
