# Short note: what I did not finish, and why

**Live:** https://frontdesk-arvo-support.onrender.com (Render Free + Supabase Free, synthetic data only).
**Repository:** https://github.com/arjunajaygit/frontdesk (public). Demo account passwords are shared through a private channel, never in the repository.
Start with `docs/REVIEWER_WALKTHROUGH.md`. The requirement-by-requirement evidence is in `docs/FINAL_ASSESSMENT_COMPLIANCE.md`, the executed tests in `docs/FINAL_FUNCTIONAL_TEST_REPORT.md`, and the hosting evidence in `docs/M8_DEPLOYMENT_EVIDENCE.md`.

## Not finished: assessment requirements

- **"Keep it running for one week."** It has been live since 22 November 2026, but a week has not passed, so I do not claim it. It runs on free tiers: the app sleeps when idle (one measured cold start took about 39 s). While it sleeps, SLA processing is triggered every 30 minutes by Supabase Cron, so a breach record or an automatic closure can be written up to about 30 minutes late. Lateness itself is always computed from stored timestamps, so it is never wrong when read.
- **"About 8 hours. We prefer 8 honest hours."** I did not keep to this. I spent far more than 8 hours: several milestones with independent audits, database-level proofs, a signed and scanned release pipeline, a hosted deployment, a UI redesign and a final verification pass. Per-milestone times are recorded in `docs/IMPLEMENTATION_NOTES.md`. This was a choice, not an accident, but it goes against the stated preference.

Every functional rule I extracted from the story was implemented and verified: the SLA table on working hours and holidays, pausing while waiting, auto-close, the reopen window, linked follow-ups, one screen for agents, replies and team-only notes, the three incidents, and the open question about changing to urgent. The rules are verified by unit, PostgreSQL-integration and real-browser tests and on the live site. Where the story was ambiguous, I chose an interpretation and documented it (`docs/DOMAIN_CONTRACT.md`, summarised in the compliance matrix §I). The main ones:
- "same working day" for urgent means until 18:30 that day;
- exact deadline equality is on time;
- only an explicit "request information" pauses the clock;
- the reopen window is 7 calendar days inclusive;
- a priority change applies the new budget to the time already used, with no reset.

## Not done: optional improvements, not required by the assessment

- No manual screen-reader audit (automated axe and keyboard checks only), so no WCAG conformance claim.
- No text search or aggregate ticket counts.
- No email notifications. Frontdesk records when a reply became visible in the app; it does not claim delivery or read receipts.
- Rate limiting is in-memory for a single instance; distributed limiting is not built.
- Alerts are defined but no notification channel is wired. ZAP is a passive baseline only. CodeQL now runs on every push (enabled when the repository was made public), alongside Semgrep. A distroless runtime was evaluated and not adopted.

## Constraints and things I could not verify

- **Residual image findings:** 38 OS-package findings across 11 advisories have no upstream fix. The owner accepted them conditionally for this temporary deployment, and they are re-scanned before every deploy.
- **Database TLS:** the running app verifies the database certificate strictly. The one-time provisioning, migrations and seed ran encrypted but unverified.
- **Free-tier limits:** Render free-hour usage and Supabase's inactivity pause cannot be read through an API; they are checked on the dashboards.
- **Unexplained:** one integration-test failure early in the build (M2) was never reproduced or explained.

## Found and fixed in the final audit

- The opaque session-context header was written to verbose logs. It is now redacted.
- Every production page logged a browser warning caused by an unrecognised security-header token. The token is removed.
- An entrance animation made an automated contrast check intermittent. The animation is removed.

All three have regression tests, and the full suite passes (integration 219/219, browser 49/49).
