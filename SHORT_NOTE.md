# Submission note (DRAFT — pre-deployment; finalised after the live release)

**Status.** Built and verified locally; the hosted release is awaiting the owner's approval of the free hosting
topology. The live URL, repository link and reviewer access will be added here only after they exist and are verified.

**What was actually executed.** The five mandatory proofs run on real PostgreSQL in the integration suite
(PROOF-01 SLA clocks/calendar/escalation, PROOF-02 9-agent HTTP claim race, PROOF-03 private-note isolation incl.
Playwright DOM/network checks, PROOF-04 DB-enforced append-only audit with role restrictions, PROOF-05 historical
seed + sweep/lifecycle/recovery). The final Codex audit's ten findings are reconciled with tests in
`docs/FINAL_AUDIT_RECONCILIATION.md`; evidence for observability, performance, supply chain and recovery is in
`docs/M7_EVIDENCE.md` and `docs/CVE_APPLICABILITY.md`.

**Deliberately not done / limits.**
- Manual screen-reader (VoiceOver) pass: not performed; checklist prepared. No WCAG conformance claim.
- Text search and aggregate counts: not implemented (not required); no partial-page search or fabricated totals.
- Rate limiting is in-memory, single instance (per verified user for signed-in traffic); distributed limiting is roadmap.
- ZAP: passive baseline only; no authenticated/active scan of the hosted demo.
- Alerts are configured but no notification channel (Alertmanager) is wired.
- Distroless runtime: evaluated on paper, not adopted.
- One integration failure in M2 was never reproduced or explained.
- 38 Debian OS-package findings (37 HIGH, 1 CRITICAL) have no upstream fix; per-advisory analysis proposes accepting them,
  pending the owner's decision.
- Free hosting sleeps when idle; SLA processing then relies on an external scheduled trigger (granularity = schedule).

**Time.** The suggested eight-hour budget was substantially exceeded (multi-milestone build with audits, proofs and
DevSecOps); actual times are recorded per milestone in `docs/IMPLEMENTATION_NOTES.md`.
