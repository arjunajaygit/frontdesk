# V3.2 follow-up Codex audit corrections
Source: V3.1 follow-up design audit (READY WITH CORRECTIONS; report not published). Both earlier design blockers closed per reviewer. Original assessment unchanged; all V3.1 engineering scope retained. This revision deliberately restricts changes to the four remaining findings and their gates.
| Severity | Correction | Owner / actual verification pending |
|---|---|---|
| High | SWEEP_CONTRACT: unprocessed candidates, cursor/backlog progress, fenced lease recovery, terminal replay and durable counters; matching Prisma/SQL drafts | M1 migration; M2–M3 implementation; M4 crash/concurrency proofs; M8 host |
| High | Both staff ticket schemas: nullable enum includes null for requestedPriority and closeReason | M1 OpenAPI-aware validator; M4 actual HTTP contracts |
| Medium | Generic Error excludes assignee; staff-only claim conflict; action-bound strict audit DTO union and typed sweep audit writes | M3 implement; M4 negative and reconstruction tests; M5 UI |
| Medium | .env.example PUBLIC_ORIGIN and independently generated CSRF_SIGNING_KEY; startup validation and proxy gate | M1 config; M4 auth integration; M8 deployed proxy |

The scope remains M1–M8 and P0/P1/P2; do not restart a broad design audit. No new unrelated features, no removal of existing technologies. Local checks do not substitute for actual migrations, full OpenAPI conformance, runtime tests or deployment. See package-check-results.txt for actual evidence. Codex follow-up verdict applies to V3.1, not independently re-audited V3.2.
