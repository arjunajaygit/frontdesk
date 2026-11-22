# M7 evidence — observability, performance, security, supply chain, recovery (2026-11-22)

All results below were executed locally on an Apple Silicon Mac (8 CPUs, Docker 4 GiB) against the
**isolated** `frontdesk-prod` compose stack with synthetic seeded data. Nothing was deployed, pushed or
published. GitHub Actions changes are **configured, not executed remotely**.

## 1. Release candidate identity (exact committed revision)

| Item | Value |
|---|---|
| Tested application revision | `a917ce1df8e8d25275b1e5c66a7a7cd7759a3b2c` (built by `scripts/build-release.mjs` from `git archive`, so the locally modified CLAUDE.md, `.env*` and `.local/` cannot enter the context) |
| Runtime image | `frontdesk-app:rc-a917ce1df8e8`, image id / OCI index digest `sha256:198817f4e9422bebec1de0f0de6c3b9d4afc613df4760f292204fbabafa62d01` (same digest after push to the throwaway local registry) |
| OCI label `org.opencontainers.image.revision` | `a917ce1df8e8d25275b1e5c66a7a7cd7759a3b2c` |
| Startup log `frontdesk started … commit` | `a917ce1df8e8d25275b1e5c66a7a7cd7759a3b2c` |
| Lockfile | `package-lock.json` sha256 `92cb8c9c2de6eba68b405db40f969ef921ae1f51fd45e2ebcca48e3b7cbf22aa` (unchanged since 403c433) |
| Image checks | non-root uid 1000, code read-only, calendar kernel present and correct in-container (Fri 18:00 + 120 min over the 23 Nov holiday → Tue 11:00 IST), no `.env`/`.local`/`.git`/CLAUDE.md, 0 secret-like history lines, env names only `PATH NODE_VERSION YARN_VERSION APP_COMMIT NODE_ENV PORT WEB_DIST_DIR NODE_OPTIONS` |
| Runtime dependencies | all 22 declared API dependencies resolve; `@prisma/client` + `argon2` native module load; only `prisma` CLI and `typescript` (lockfile `devOptional`, build-time) are absent — the M6 pruning removed no runtime dependency |
| Production smoke | `scripts/smoke-prod.mjs` 23/23 PASS on rc-403c433 and again on rc-a917ce1 |
| Scheduler without browser traffic | 3 `SYSTEM` sweeps logged within ~70 s of start with no user requests |

Later commits after `a917ce1` are documentation only (this file, notes, RTM, risks) and do not change the image.

## 2. Prometheus metrics (implemented, tested)

Internal listener (`METRICS_PORT`, default **off**; compose: 9464 on the monitoring network, never published),
bearer token required in production (≥ 32 chars, config refuses otherwise), `Cache-Control: no-store`, only
`GET /metrics`. The public port answers 404 for `/metrics` and `/api/metrics`.

| Metric | Labels (closed vocabularies) | Semantics |
|---|---|---|
| `frontdesk_http_requests_total`, `frontdesk_http_request_duration_seconds` | method, route **template**, status_class | `/api` only; raw URLs / id-like segments fold to `unmatched` |
| `frontdesk_ticket_commands_total` | command (10 known), outcome success/replayed/conflict/rejected/busy/error | recorded after the transaction settles; replays separate |
| `frontdesk_ticket_claims_total` | outcome won/conflict | |
| `frontdesk_sla_breaches_recorded_total` | clock, priority | via `CommitHooks`: only committed `SLA_BREACHED` events |
| `frontdesk_sweep_invocations_total`, `frontdesk_sweep_duration_seconds` | initiator system/lead/admin, outcome | |
| `frontdesk_sweep_tickets_processed_total`, `frontdesk_sweep_lease_recoveries_total` | — | committed work only |
| `frontdesk_sweep_more_due`, `frontdesk_sweep_last_scheduled_success_timestamp_seconds` | — | backlog flag / scheduler liveness |
| `frontdesk_db_up` | — | readiness query at scrape time (2 s bound) |
| `frontdesk_process_*`, `frontdesk_nodejs_*` | — | prom-client defaults |

All counters are **process-local** (per instance, reset on restart). Durable business totals are the audit log
and sweep invocation rows in PostgreSQL.

Tests: `tests/unit/metrics.test.ts` (5: commit-only hooks, serialization-retry discard, rollback discard, label
folding, config rules) and `tests/integration/metrics.test.ts` (4, real PostgreSQL): 9-agent race → claims
won +1 / conflict +8, replay does not re-count, `TICKET_CLAIMED` audit rows = 1; sweep breach and processed
counters equal the audit/invocation rows written; exposition contains no UUIDs, emails, subjects, bodies,
private-note marker, token or CSRF values; listener 401 without/with wrong token.

## 3. Grafana / Prometheus (optional `monitoring` profile)

Prometheus v3.5.0 and Grafana 12.1.1 pinned by multi-arch index digest (arm64 verified), loopback-only ports,
own network and volumes, Grafana admin password generated, anonymous access off (API → 401).
Dashboard `Frontdesk — operations` (16 panels): availability, DB, minutes since last sweep, backlog,
throughput by route, 4xx/5xx share, P50/P95/P99, RSS/heap, CPU, event-loop lag, claim contention, command
outcomes, breaches by clock/priority, sweep outcomes, sweep P95/processed, lease recoveries.

Verified: target `app:9464` **up** through bearer auth; all **21 dashboard queries** executed against
Prometheus — 20 returned series, 1 (5xx share) correctly empty because no 5xx occurred; Grafana datasource
health OK and a Grafana→Prometheus query returned data; 7 alert rules loaded and healthy.
**Alert firing proven**: app stopped at 07:54:07 → `FrontdeskDown` pending at 07:54:15 → **firing** after its
2-minute `for` window (checked 07:58:35). No Alertmanager: **notifications are not delivered anywhere**.
Thresholds are initial settings, not SLOs.

## 4. k6 (v1.8.2 standalone, checksum-verified) — `infrastructure/perf/frontdesk.k6.js`

Real CSRF + HttpOnly-cookie sessions, Origin + Idempotency-Key on mutations. Production controls unchanged:
the per-IP API limit (600/min) applies and **all k6 VUs share one source IP**.

| Scenario | VUs / duration | Requests | Throughput | Latency | Unexpected | Notes |
|---|---|---|---|---|---|---|
| smoke (healthz/readyz) | 1 / 20 s | 80 | 3.9 req/s | p95 8.5 ms, p99 10.9 ms | 0 | thresholds pass |
| contention | 9 agents × 10 tickets | 120 | 12.2 req/s | p95 218 ms, p99 345 ms (claims wait on the row lock) | 0 | **10 won, 80 × 409**; DB: no ticket has >1 `TICKET_CLAIMED` |
| mixed (9 agents + 3 customers, think time) | 12 / 3 min | 1,906 | 10.3 req/s | overall p95 20.5 ms, p99 161 ms; reads p95 18.5 ms; writes p95 24.5 ms | 0 | 31 claims won, tickets created/replied; **21 × 429** (1.1%) — checks threshold failed because of them |
| stress (no think time) | ramp to 20 / 70 s | 603,052 | 8,615 req/s | p95 2.95 ms, p99 4.7 ms (mostly limiter fast path) | 581 × 401 | 601,816 × 429; 18/20 VUs logged in after the IP was already limited → unauthenticated 401s; **0 × 5xx** in app logs |

Resources (docker stats): mixed — app CPU avg 28% (peak 358% during 12 concurrent Argon2id logins), RSS
78→83 MiB; Postgres CPU avg 1.4%, 69→73 MiB. Stress — app CPU ~100–128%, RSS stable ~84–90 MiB.

Interpretation: the synthetic agents (~0.85 req/s each, far above a human's pace) exceed the per-IP budget when a
whole team shares one IP. For an office behind a single NAT, key the authenticated API limit by principal and keep
per-IP limits for unauthenticated routes (risk register). Not a capacity claim beyond this laptop.
Harness bug found and fixed: k6 resets cookies per iteration by default (`noCookiesReset: true`).

## 5. OWASP ZAP 2.16.1 baseline (passive), inside the isolated compose network

Run 1 (rc-403c433): 0 FAIL, 4 WARN, 62 PASS — CSP `style-src 'unsafe-inline'` [10055], Permissions-Policy
missing [10063], COEP missing / Spectre isolation [90004], ZAP out of date [10116].
Fixed in a917ce1: `Permissions-Policy` on every response; `Cross-Origin-Embedder-Policy: require-corp` on pages
and API; API CSP without helmet defaults (no `https:`/`'unsafe-inline'`). Regression: `http-static.test.ts`.
Run 2 (rc-a917ce1, committed `infrastructure/security/zap/baseline.conf`, 20 FAIL rules incl. cookie flags,
SameSite, anti-clickjacking, nosniff, CSP missing, server/X-Powered-By leaks, error disclosure, CORS,
Permissions-Policy, Spectre): **0 FAIL**, 62 PASS; WARN only: 10055 (accepted — a bundled UI library creates
`<style>` elements at runtime; scripts stay `'self'`, React escapes text), 10049/10109 informational cache/SPA
notes, 10116 (image pinned; bump deliberately).
Not performed: authenticated active scan. Business authorization, claim races and private-note isolation remain
proven by the PostgreSQL integration suites and Playwright, which ZAP does not replace. No OWASP compliance claim.

## 6. SBOM and signing

| Artifact | Tool | Result |
|---|---|---|
| npm runtime SBOM | `@cyclonedx/cyclonedx-npm` 7.0.1, CycloneDX 1.6, `--omit dev --omit peer --output-reproducible` | 234 components, **schema-valid** (ajv + official 1.6 schemas); sha256 `75140b9b…dacb`. Lists `prisma`/`typescript` (lockfile devOptional) which the image does not ship — the image SBOM is authoritative for the artifact |
| Container SBOM (rc-a917ce1) | Trivy 0.76.2, CycloneDX 1.7 | 306 components (305 libraries + Debian 12). Raw output fails strict schema on 2 non-SPDX license ids (`SMAIL-GPL`, `Artistic-dist`) emitted as `license.id`; moved to `license.name` as the spec requires → **schema-valid**; sha256 `47c70f0a…811a` |
| Local signing | Cosign v3.1.4 (checksum-verified), disposable password-protected key pair (deleted), throwaway loopback registry (removed) | **signed + verified** `sha256:198817f4…`; CycloneDX attestation verified (predicateType `https://cyclonedx.org/bom`, 306 components); unrelated key → verification fails; `--tlog-upload=false`: nothing sent to Rekor |
| Published-image signing | `.github/workflows/release.yml` (manual dispatch, GHCR, keyless OIDC, verify by certificate identity) | **CONFIGURED, NOT EXECUTED** (needs an authorised remote run) |

No SLSA level or supply-chain compliance is claimed.

## 7. Trivy (final, exact image rc-a917ce1, DB updated 2026-11-21 18:38 UTC)

HIGH/CRITICAL: OS packages 38 (37 HIGH, 1 CRITICAL), **fixable 0**; Node.js packages 0; secrets 0;
misconfigurations 0. CI gate (`--ignore-unfixed --exit-code 1`) exit 0. The CRITICAL is CVE-2023-45853
(`zlib1g`, Debian status *will_not_fix*: MiniZip, which is not shipped in that package; Node bundles its own zlib).

## 8. Backup and restore (`infrastructure/ops/backup-restore-verify.sh`)

pg_dump 16.14 custom format as the owner role → `.local/backups/*.dump` (dir 0700, file 0600, git-ignored),
116,587 bytes, backup **0.66 s**, restore into `frontdesk_restore_verify` **0.20 s** (`--single-transaction`).
Identical counts (User 12, Ticket 54, Message 136, SlaClock 108, audit_logs 330, SLA_BREACHED 5, Holiday 3,
migrations 4) and identical content digest (tickets, clocks, audit, messages, users + roles + hashes).
Both audit triggers restored; DB and every relation owned by `frontdesk_owner`; `frontdesk_app` reads but is
denied UPDATE/DELETE/TRUNCATE on `audit_logs`, CREATE TABLE and ALTER TABLE; the trigger blocks UPDATE even
for the owner. Release migrate image: "No pending migrations"; release app image on the restored DB with the
restricted role: startup privilege check passed, readiness 200, staff login with the original recorded
password 200, 54 tickets listed.
Roles are cluster objects (not in pg_dump) and must be pre-provisioned; `CONNECT` is re-granted by the script.
No HA, PITR, RPO/RTO or DR guarantee is claimed from one small local restore.

## 9. Distroless evaluation — DEFERRED (documented, not adopted)

Not built in M7 (time budget). Candidate: `gcr.io/distroless/nodejs24-debian12` (glibc, libstdc++ and libssl
present in the `cc`-based image family, which Prisma's engine and the argon2 native addon need). Adoption
requires the full checklist in the directive (Node 24 parity, arm64, Prisma engine + OpenSSL, argon2, CA certs,
TZ/calendar, non-root, read-only fs, probes without a shell — the HEALTHCHECK already uses `node`, SIGTERM,
static assets, kernel, scheduler) plus the 23-check smoke and Trivy comparison. The verified Debian-slim image
is retained; its 38 unfixed OS findings remain open in the risk register.

## 10. Regression on the release revision a917ce1 (executed)

| Gate | Command | Result |
|---|---|---|
| Original calendar tests | `npm run test:calendar` | 12/12 |
| Backend unit | `npm run test:unit` | 159/159 (13 suites) |
| PostgreSQL integration incl. PROOF-01..05, remediation, metrics, seed credentials | `npm run test:integration` | 195/195 (21 suites) |
| Frontend unit | `npm run test:web` | 20/20 |
| Playwright (privacy, workflows, a11y) | `npm run test:e2e` ×2 | 26/26 and 26/26 |
| Types / lint / format | `npm run typecheck`, `npx eslint .`, `npx prettier --check .` | pass |
| OpenAPI / audit schema / Prisma | swagger-parser (3.0.3, 26 paths), `gen-audit-schema --check`, `prisma validate` | pass |
| Secrets | `scripts/secret-scan.mjs`; Gitleaks (history, redacted) | pass; no leaks |
| SAST | Semgrep 1.170.0 (host install; the local Docker image is missing `semgrep-core`, likely M6 layer-store damage) with project rules + typescript/nodejs/owasp-top-ten/jwt/react packs | 91 rules, 127 files, 0 findings |
| Dependency audit | `scripts/audit-gate.mjs` | no unwaived high/critical (zod waiver expires 2027-02-28) |
| Workflow policy | `tests/unit/workflows.test.ts` (in unit total) | 17/17 |

The M2 flaky integration failure did not recur in any M7 run (baseline 187/187, final 195/195, targeted suites).
