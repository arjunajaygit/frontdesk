# Requirements and policy decisions
Source of truth: the original assessment brief, sections 2–6 (not redistributed). Nine agents, about 40 tickets/day. Replace spreadsheet and WhatsApp with a hosted backend and simple agent screen. No added banking, native mobile, AI, payment or KYC features. Suggested time budget: eight hours.
## SLA contract
| Priority | First public reply | Resolution |
|---|---|---|
| Urgent | 120 business minutes | End of effective working day |
| Medium | 270 business minutes | 1620 business minutes |
| Low | 540 business minutes | 2700 business minutes |
Working interval 09:30–18:30 Monday–Friday, excluding explicitly configured festival dates. Asia/Kolkata assumption; UTC persistence; current calendar kernel only supports IST. A ticket Friday 18:00 has urgent reply due Monday 11:00 unless holiday. Same-day urgent resolution Friday 18:30 is earlier than reply deadline; do not silently extend it. Outside hours start next eligible day. Equality at deadline is on time; late strictly after. Holidays and timezone are configuration, not guessed. Freeze calendar configuration for assessment; future changes need policy version and recomputation audit.
## Ambiguity register
A1: half day = 270 business minutes; one working week = 2700 minutes. A2: waiting pause only after explicit agent request; first qualifying public agent response completes response clock (INTAKE does not); private notes never do. A3: auto-close after 2700 business minutes of waiting, including no weekends/holidays; reopen resolved within seven calendar days inclusive (assumption, not source wording); after window new linked ticket. A4: priority change applies new budget to consumed active time, never resets elapsed or erases historical breach; urgent uses effective cycle-day budget. A5: reopening retains ownership and starts a new resolution cycle, not a new initial response SLA; if no agent assigned, route to queue. A6: resolved tickets become closed after window; customer auto-closed tickets require new contact/new ticket. A7: no email delivery integration required; public message timestamp proves recorded reply, not customer delivery/read receipt. A8: staff can see queue metadata and details within the single support team; only assignee may send replies, notes or change owned ticket. Admin role optional; do not grant silent bypass. A9: customer view is minimal verification interface, not full customer portal.
## Scope discipline
Source requirements are mandatory; architectural controls necessary to enforce them are P0. P1 quality additions and P2 optional infrastructure are not extra product requirements. All limitations must be disclosed. Submission: live URL accessible one week, repository, README local setup and honest omissions note.


## V3 precision decisions
Retain seven calendar days inclusive for resolved reopening (explicit assumption, not PDF exact wording); inactivity closure is 2700 business minutes, not calendar days. Customer export and protected sweep are P0 verification surfaces, not unrelated product features. Staff lead permission required for sweep; never weaken basic RBAC. See DOMAIN_CONTRACT and AUTH_CONTRACT for authoritative edge cases, ENGINEERING_PROOFS for gates and DEMO_SCENARIOS for fixtures. All five proofs mandatory release acceptance criteria. Original PDF overrides interpretations.

## V3.1 source-derived coverage
R11: Explain which tickets were late and why: reconstruct priority, original/revised deadlines, pauses, breach onset and actor from immutable audit; distinguish current vs historical late. R12: Prove when public reply became available in Frontdesk (server event timestamp, visible only after commit; not external delivery or read receipt). Resolve intake, exact cutoffs, reopened queue and overdue customer contact via DOMAIN_CONTRACT.
