# Submission note

**Live:** https://frontdesk-arvo-support.onrender.com (Render Free + Supabase Free, synthetic data only). It runs revision
`136ee89` (including the redesigned UI) from the signed image `ghcr.io/arjunajaygit/frontdesk@sha256:ebf7a980…`. **Repository:** the private
https://github.com/arjunajaygit/frontdesk. Reviewer access and demo accounts are granted through a private channel.
Start with `docs/REVIEWER_WALKTHROUGH.md`. All deployment evidence is in `docs/M8_DEPLOYMENT_EVIDENCE.md`.

**What was actually executed.**
- *The five mandatory proofs* run on real PostgreSQL in CI on every push:
  - PROOF-01: SLA clocks, calendar and escalation.
  - PROOF-02: 9-agent HTTP claim race.
  - PROOF-03: private-note isolation, including Playwright DOM and network checks.
  - PROOF-04: DB-enforced append-only audit with role restrictions.
  - PROOF-05: historical seed plus sweep, lifecycle and recovery.
- *On the live site:*
  - production smoke: 29/29;
  - deployed workflows: 29/29 (claim race, privacy, lifecycle, linked tickets, scheduler auto-close);
  - real-browser checks: 8/8;
  - Supabase role verification: 9/9, with live denials of audit tampering and Data-API reads.
- *Release chain:* gated build of one amd64 image, then Trivy, SBOM, keyless signature and attestation (verified independently). Before each deploy the exact manifest is re-scanned against the owner's conditional risk acceptance.
- *Final audit:* all ten findings are reconciled in `docs/FINAL_AUDIT_RECONCILIATION.md`.

**Deliberately not done / limits.**
- *Free hosting sleeps when idle.* One measured cold start: about 39 s from request to response (a single sample). While asleep, Supabase Cron calls the authenticated sweep every 30 minutes (each slot verified at the HTTP and database level; one slot verifiably auto-closed an overdue ticket). Persisted SLA effects can therefore land up to about 30 minutes late; lateness itself is always computed from stored timestamps.
- *Database TLS:* the runtime verifies the pooler certificate strictly. The one-time provisioning, migrations and seed ran encrypted but unverified.
- *Residual image findings:* 38 Debian OS-package findings (11 advisories) have no upstream fix. They are accepted conditionally by the owner for this temporary deployment.
- *Security tooling gaps:* CodeQL is skipped on the private repository (paid feature for private repos), so Semgrep is the SAST gate. ZAP runs as a passive baseline only, with no authenticated or active scan of the hosted demo.
- *Not performed or not built:* a manual screen-reader pass (no WCAG conformance claim); text search and aggregate counts; distributed rate limiting (in-memory, single instance); an alert notification channel; a distroless runtime (evaluated, not adopted).
- *Unexplained:* one integration failure in M2 was never reproduced or explained.
- *Not observable through an API:* Render free-hour usage and Supabase's inactivity pause. The owner checks the dashboards during the review week.

**Time.** The suggested eight-hour budget was substantially exceeded (a multi-milestone build with audits, proofs, DevSecOps and a
hosted release). Actual times are recorded per milestone in `docs/IMPLEMENTATION_NOTES.md`.
