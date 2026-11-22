# V3.1 audit reconciliation — design correction record
Source: independent V3 design review (raw report not published). Original assessment unchanged. V3.1 contracts resolve documented design ambiguity; no claim independent reviewer has accepted changes. Implementation scope/ten pillars unchanged.
| Finding | V3.1 correction | Verification still required |
|---|---|---|
| Critical SLA boundaries | DOMAIN_CONTRACT worked cases, independent clock state, resolve rule, precise pause/resume/equality | pure SLA unit + real DB transition tests |
| Critical intake/lifecycle | DOMAIN_CONTRACT actor/state/outcome matrix, typed intake and customer outcomes, overdue contact independent of scheduler | integration + UI |
| High API projection | OpenAPI strict staff/public DTOs and pagination, both exports, no-store | OpenAPI validator, contract tests, UI/network leakage tests |
| High audit schema | AuditTarget, LEAD/ADMIN, SweepInvocation, correlationId/reason; qualified trigger/constraints templates | migrate real DB, owner and runtime tests |
| High concurrency | idempotency reservation and lock order, post-lock clock, version, breach sequence, sweep lease | real overlapping transactions, rollback/replay/restart |
| High auth/RBAC | AUTH_CONTRACT cookie/CSRF/Origin matrix, retained refresh token digests | auth integration and proxy smoke |
| Medium precision | BigInt ms, enum clock kind/state, check SQL, stable message/audit indexes | Prisma validate, migrations, constraints |
| Low ERD/fixture | corrected ERD/state diagrams, FD-011/012/015 explicit states | seed verification |
| Coverage | R11 why late and R12 publication evidence, RTM rows | reconstruction and publication tests |
| Contradictions | exact cutoff, mandatory export/browser privacy, unassigned reopen; normative contracts override historical PDF | contract review |
| Risk release | P0 gates exact deployed SHA, P1 recorded, scheduler check pre-M1 | actual CI/host proof |
| Missing tests | ENGINEERING_PROOFS and TESTING_STRATEGY additional gates; six extra executable calendar tests | all application tests pending |
| Sequence | original M1–M8, pre-M1 contracts and version/hosting verification | implementation and measured time |

Verdict: design baseline corrected for implementation, subject to M1 validation; not a completed application or proven release-ready system. The final independent review should focus on executable code and database/security proofs. Preserve original time constraints and honest short note.
