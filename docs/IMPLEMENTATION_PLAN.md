# V3 implementation plan — proof driven
Time constraint: PDF ~8 honest hours; confirm AI policy and if stricter 4-hour instruction governs. Record elapsed time and stop at applicable limit. P0 correctness and deployment before optional infrastructure. Retain detailed V2 docs, no silent removal.
| Milestone | Minutes (8h plan) | Scope and gate |
|---|---:|---|
| M1 | 45 | Audit starter, scaffold workspaces, schema/roles/migrations, trigger and idempotent seed; real PostgreSQL migration check |
| M2 | 55 | Calendar/SLA clocks, priority, pause, lifecycle; deterministic tests |
| M3 | 80 | Auth/RBAC, atomic claim, messages, customer API/export, audit, jobs; API build |
| M4 | 70 | Five proof integration suites, separate DB sessions, raw SQL, browser privacy test plan; fix failures |
| M5 | 100 | Accessible agent/customer UI, real demo actions, build and browser smoke |
| M6 | 40 | Docker, CI, Pino, health, security gates where feasible |
| M7 | 20 | Optional monitoring/k6/DAST/SBOM only if core done; otherwise use for blockers |
| M8 | 70 | Deploy, HTTPS smoke, docs, RTM evidence, honest omissions, reserve |
Four-hour contingency: M1 25, M2 35, M3 50, M4 35, M5 40, M6/M7 0, M8 55 minutes; narrow UI polish, never remove security controls, report incomplete items. Estimates not claims.
## Pre-M1
Read DOMAIN_CONTRACT, AUTH_CONTRACT and AUDIT_RECONCILIATION. Node 22 LTS, Prisma 6, PostgreSQL 16 are compatibility baseline candidates, not installed version claims. Pin exact supported patched releases in M1 after checking official compatibility and availability; commit lockfile, runtime version file and image digest; record versions and migrate against real isolated PG. Check hosting scheduler and same-origin feasibility before committing providers.
## Phase prompts
M1: Read original PDF, DOMAIN_CONTRACT, AUTH_CONTRACT, DATABASE_DESIGN, ENGINEERING_PROOFS. Inspect draft schema and SQL template; implement baseline migration first, then trigger; separate owner/runtime roles; run migrations and seed real isolated PostgreSQL. Report commands and failures.
M2: Read DOMAIN_CONTRACT, LLD, ENGINEERING_PROOFS and calendar tests. Preserve kernel; implement independent clocks and safe precision; test all boundary cases.
M3: Read DOMAIN_CONTRACT, AUTH_CONTRACT, HLD, SECURITY_ARCHITECTURE, THREAT_MODEL, OpenAPI draft and proof contracts. Implement authenticated role/ownership checks, transactions, public projections and export, scheduler and lead sweep; no client-controlled time.
M4: Read TESTING_STRATEGY and ENGINEERING_PROOFS. Run real PostgreSQL HTTP contention, leak, trigger and rollback tests; report observed responses, rows and errors. Do not fake green checks.
M5: Read UI_ENGINEERING and DEMO_SCENARIOS. Build real customer session and agent workspace; test private marker absent in DOM/network/export; verify strict TS build and accessible interaction.
M6: Read DEVSECOPS and OBSERVABILITY_RUNBOOK. Compose health and persistent volume, structured redacted logging, CI and security tools; verify configured gates, no untrusted PR secrets.
M7: Keep optional Prometheus/Grafana, k6, ZAP, CycloneDX, independent worker, outbox if justified, MFA, signed images, audit checkpoints, restore drills and alerts. Implement only as time allows.
M8: Read REQUIREMENTS, RTM and runbook. Verify release gates for exact commit even if M6 deferred; verify deployment and scheduled behavior, smoke tests, README, SHORT_NOTE and link availability; update evidence with actual results. For every milestone inspect, plan, implement, test, record elapsed time and limitations.

## V3.2 follow-up audit assignments (mandatory)
- M1: read SWEEP_CONTRACT, AUDIT_PAYLOAD_CONTRACT and FOLLOWUP_AUDIT_RECONCILIATION; validate exact compatible toolchain and full OpenAPI 3.0 with OpenAPI-aware validator, representative response fixtures; Prisma validation, migration/roles/SQL checks including sweep progress constraints/index; startup env validation and scheduler/hosting feasibility.
- M2: implement sweep due candidate exclusion, cursor progress, lease recovery/fencing and exact cutoff semantics per SWEEP_CONTRACT.
- M3: persist durable progress and terminal status/replay, implement typed audit writes/reads and staff-only conflict projection, validate auth startup config and all mutation contracts.
- M4: actual PostgreSQL backlog, overlapping workers, crash/expiry/fencing and replay tests; strict API response fixtures, privacy/error payload and auth cookie/CSRF/revocation/no-store tests. Preserve all existing five proof gates.
- M5: verify safe audit UI reconstructs why late and publication; browser privacy and cache switch proof.
- M6–M7: retain P1 gates and optional P2 roadmap; no scope reductions.
- M8: exact deployed SHA evidence, real proxy cookie/Origin/CSRF/revocation/no-store, scheduler progression/recovery without browser traffic, deployment smoke and honest omissions. No proof by documentation alone.
