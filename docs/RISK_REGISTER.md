# Risk register
| Risk | Impact | Mitigation | Owner/evidence |
|---|---|---|---|
| Ambiguous urgent/priority/reopen semantics | High | explicit assumptions and boundary tests | developer / RTM |
| Duplicate claims or job races | High | conditional update and row locks | backend / real DB test |
| Internal note leak | Critical | public-only DB projection and authorization | backend / negative tests |
| Audit mutable by runtime | Critical | separate roles, grants and rollback tests | DB / SQL test |
| Hosting sleeps or quota expires | High | verify plan, reconcile deadlines, disclose | deployment / smoke |
| Cookie/CSRF deployment mismatch | High | same origin proxy and browser tests | frontend/API |
| Too much optional tooling | High | P0 first, time log and omissions | developer |
| Unverified dependency vulnerabilities | Medium | locked versions/scans, reviewed exceptions | CI |
| Data loss | High | provider backup verification and isolated restore | ops |
| Time-budget constraint | High | prioritise P0, record honest elapsed time, disclose omissions | developer |

| Unexplained M2 integration failure (once, test name not captured) — M4: full logs kept for every run; two test-harness races found and fixed (restart-test read-before-FINISH, FORCE-drop permission); no product defect observed; still watched | Low | Retained: all later runs green (M2: 13 full runs; M3: 3 full runs of 12+129+104 at 15:52-15:53Z 2026-11-21, plus per-suite runs); full-output logs captured per run; re-check in M4 repeated runs | QA / M4 evidence |
| Calendar kernel packaging (repo-root src/calendar.mjs loaded at runtime) | High | Compiled dist verified to load it (M2/M3); M6 Docker image MUST copy src/calendar.mjs and docs/openapi.draft.yaml is dev-only | DevOps / M6 |
| Dev DB holds M1-generated seed (immutable audit rows) | Low | Not modified except additive migration 20261121000300; refresh = drop/recreate with approval at demo prep; tests use isolated scratch DBs | developer / M5-M8 |
| In-process rate limiter is per instance | Medium | Acceptable for single-instance demo; shared store is P1 roadmap; DB invariants never rely on it | backend / M6-M8 |
| Idempotency records store full command responses (staff responses may include note bodies) | Low | Actor-scoped replay only, runtime-role DB, 24h retention purge by scheduler; never exposed cross-actor | backend |
| Lease/time-of-check races (Codex H01/M02) | High | Closed in M4: in-statement guarded writes / post-lock DB-time revalidation; regressions shown to fail on defective variant | backend / M4 evidence |
| Over-privileged runtime credentials (Codex H04) | High | Closed in M4: startup privilege verification fails closed; readiness reports unsafe | backend / M4 evidence |
| Test-only superuser use (observer, role tests, scratch drops) | Low | Confined to scratch DBs/roles in the dedicated Frontdesk cluster; name-pattern checked; never used by the app | QA |
| Frontend privacy regressions (cached staff data shown to another identity) | High | Mitigated in M5: cache cleared on every session change; separate staff/portal namespaces; 10 Playwright proofs inspect network bodies, DOM, storage, back/forward | frontend / M5 evidence |
| No text search / aggregate counts in API | Low | Not faked in UI; P1 backend extension if wanted | product |
| Accessibility verified by axe + keyboard automation only | Medium | No conformance claim; manual screen-reader pass recommended before release | QA |
| Plaintext dev-DB demo passwords lost (M5 incident) | Low | Dev DB to be refreshed; demo DB has its own credentials file; seed path override fixed | developer |
| Disk exhaustion halted the Docker daemon mid-M6 (host disk full) | Medium | Resolved: daemon restarted, no data lost, no prune used; images are small and the build context is an allowlist; keep >10 GiB free before image builds/scans; Docker content store may be partially damaged (a scanner image was) — re-pull if odd errors appear | developer / user |
| Credential overwrite recurrence (M5 incident) | Medium | Closed in M6: derived env-specific file names, refuse overwrite, atomic 0600, explicit `SEED_CREDENTIALS`, reset script behind double confirmation (not run); dev DB plaintext logins still unrecorded until an authorised reset | developer / user |
| Local verification-stack passwords echoed to the session log (shell mistake) | Low | Local throwaway stack only; stack to be destroyed and secrets regenerated | developer |
| zod advisory GHSA-mrhx-c7xc-m3w5 | Low | Waiver W-1, unreachable, expires 2027-02-28 | backend |
| Prisma CLI tooling advisories (effect, deepmerge-ts, @prisma/config) | Low | Excluded from runtime image (`--omit=peer`); tooling image only; revisit with Prisma 7 | backend |
| Hosting: free tiers sleep / DB expiry; managed-DB role model unverified; Supabase API-role default grants | Medium (reduced in M8: role model verified 9/9, API roles denied live, Supabase Cron sweep verified per slot; residual: persisted effects up to ~30 min late while asleep, one measured cold start ≈ 39 s, Supabase Free pauses inactive projects; the app and cron query the database continuously while live) | Original plan (superseded by the M8 Render + Supabase deployment): prefer always-on app + Postgres where `preflight.sql` passes (or a VM running the verified compose); decision and approval deferred to M8 | deployment |
| M2 flaky integration failure (cause never identified) | Low | Still unexplained; not seen since; all later failures were test-harness races. Documented, not closed | QA |
| Known UI/product limits: no text search / aggregate counts / human ticket numbers; manual screen-reader audit not done | Low | Disclosed in README | product / QA |
| 38 unfixed Debian OS-package HIGH/CRITICAL CVEs in the runtime image | Medium | Accepted: non-root, read-only fs, caps dropped, app never runs those tools; weekly Trivy with `--ignore-unfixed` fails when a fix appears; M7 distroless evaluation | DevOps |
| Final-image Trivy in CI uses a digest-pinned image whose local copy was damaged | Low | Binary release v0.76.2 (same version) verified locally; CI image digest verified to resolve; first remote run will confirm | DevOps |
| Credential/seed ordering could strand logins (found pre-M7) | Closed | Plaintext recorded before hashes; pre-flight refusal; lock; path normalisation; real-PostgreSQL regression | developer |
| Timeline hole when a refetch interrupted a gap walk (found pre-M7) | Closed | Queued, non-cancelled gap walks; regression test | developer |
| In-process rate limiter is per instance (N instances ⇒ N× budget); key map grows with distinct IPs until the 60 s prune | Medium | Single instance is the deployment target; DB invariants never depend on it; scale-out needs a shared store (PostgreSQL table or Redis) — P1 roadmap | developer |
| M7: 38 unfixed Debian OS CVEs (37 HIGH, 1 CRITICAL CVE-2023-45853 zlib1g will_not_fix) in the runtime image | Medium | Recorded by the agent for **user review — not user-approved acceptance**. Non-root, read-only fs, caps dropped; app spawns no shell tools; weekly rebuild + fresh Trivy DB fails when a fix appears; distroless evaluation deferred | DevOps / user |
| M7: per-IP API limit (600/min) shared by a whole office behind one NAT; k6 mixed run hit 429 at ~10 req/s with synthetic agents | Medium | Single-instance in-memory limiter by design. Future: key authenticated API limits by principal (session subject), keep per-IP for login/csrf/unauthenticated; for >1 instance use a shared store (PostgreSQL table with `INSERT … ON CONFLICT` fixed windows, or Redis) | developer |
| M7: CSP `style-src 'unsafe-inline'` (ZAP 10055) | Low | Required by runtime `<style>` creation in a bundled UI library; scripts stay `'self'`, `script-src-attr 'none'`, React escapes text; revisit with nonce-based styles | developer |
| M7: alerts have no delivery channel (no Alertmanager) | Medium | Documented; configure Alertmanager + a tested receiver before relying on alerts | ops |
| M7: release signing and remote CI not executed | Medium | Local Cosign sign/attest/verify proven; release.yml configured; first authorised remote run must be checked | DevOps / user |
| M7: image SBOM from Trivy is not strictly schema-valid (2 non-SPDX license ids) | Low | Normalised copy (id→name) validated; CI uploads the raw Trivy SBOM — normalise before strict consumers | DevOps |
| M7: ZAP authenticated/active scanning not performed | Low | Passive baseline only; authorization/race/privacy proofs remain the PostgreSQL + Playwright suites | QA |
| Manual VoiceOver pass not performed | Medium | Checklist prepared (docs/ACCESSIBILITY_VOICEOVER_CHECKLIST.md); no conformance claim | QA |
| Text search and aggregate counts not implemented | Low | Deferred enhancement (not in the contracts); no partial-page search or fabricated totals | product |
| M8: free hosting sleeps; SLA processing granularity = external cron interval (proposed 30 min) | Medium | External machine-authenticated SYSTEM trigger via Supabase Cron + pg_net (deterministic slot keys, leases); breach timestamps exact; in-process scheduler while awake; no keep-alive pings | ops / user |
| M8: Supabase Free pauses after 1 week of inactivity; Render free may restart any time | Medium | Cron + app queries expected to count as activity (observe daily); daily availability check during the review week | ops |
| M8: GitHub `release` environment protection is a remote setting | Medium | Configure required reviewers + main-only deployment branches when the repository is created; workflow-level gate enforced regardless | DevOps / user |
| M8: amd64 artifact verified under local emulation only until the first CI/release run | Closed | Native amd64 build, smoke, scan, sign and verify executed in release runs 44995728324 and 45017938581 | DevOps |
| M8: publication scope | Medium | Approved scope: PDFs, raw audit report and agent configuration withheld; employer-specific references, recruiter/AI-policy notes and internal process notes removed from docs; generic paraphrased requirements kept | user |
| M8: the 38 unfixed OS findings (11 advisories): per-advisory analysis in docs/CVE_APPLICABILITY.md | Medium | Owner conditionally accepted, limited to these findings, temporary synthetic-data deployment; exact manifest re-scanned before every deploy, stop on new high/critical, applicability change or available fix (last: 2026-11-22, unchanged) | user |
| M8: a transient Docker build failure occurred once (truncated output, not reproduced) | Low | Rebuilt successfully from the same commit; release builds run in CI | DevOps |
| M8: database TLS was encrypted but unverified (`sslmode=require`) | Closed | Runtime now `sslaccept=strict` against Supabase's root CA shipped in the image (fingerprint pinned by a unit test, valid until 2031-04-26); CA rotation would fail closed (no connection) rather than open; one-time provisioning/migrations/seed ran unverified (documented) | deployment |
| M8: Render free instance hours and Supabase inactivity pause not observable via API | Low | Owner checks the dashboards during the review week; no keep-alive traffic is generated (policy) | user |
