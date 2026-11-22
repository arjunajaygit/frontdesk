# Reviewer walkthrough (real behaviour only — no simulated clock)

## Hosted demo
**URL:** https://frontdesk-arvo-support.onrender.com — synthetic data only (15 scenario tickets FD-001..FD-015; tickets
whose subject starts with `[verification` belong to a separate synthetic customer and were created by the deployment checks).
Reviewer accounts (lead, agents, customers) are sent through the private submission channel — never committed.
Free hosting sleeps after ~15 idle minutes, so the first request after a pause is slow (Render documents a delay of up to
about a minute; not measured for this deployment). Scheduled SLA processing continues while the app sleeps: Supabase Cron
calls the authenticated sweep endpoint every 30 minutes (see docs/M8_DEPLOYMENT_EVIDENCE.md).
Times are IST; the scenario clock is real time (the seed was anchored to the deployment time, 2026-11-22).

## Run locally
```
npm run db:up            # isolated PostgreSQL 16 (127.0.0.1:55432)
npm run demo:db          # separate DB `frontdesk_demo` with FD-001..FD-015; passwords -> .local/credentials.frontdesk_demo.json (git-ignored, 0600)
npm run build -w @frontdesk/contracts && npm run build -w @frontdesk/api
# API (own terminal) — DATABASE_URL must point at frontdesk_demo, same-origin web on :5173
set -a; . ./.env; set +a
DATABASE_URL="${DATABASE_URL%/*}/frontdesk_demo" PUBLIC_ORIGIN=http://localhost:5173 node apps/api/dist/main.js
npm run dev -w @frontdesk/web   # http://localhost:5173 (Vite proxies /api -> :3000)
```
Use **separate browser profiles/contexts** for simultaneous agents: tabs of one profile share cookies. If you sign
in as someone else in one tab, the other tabs of that profile switch to the new account (with a notice) and any
pending draft from the old account is refused by the server (`409 SESSION_CHANGED`) — it is never saved under the
new identity.
The development DB `frontdesk` is untouched; the e2e suite uses its own `frontdesk_e2e` (recreated on each run).

## Scenarios (sign in as the named role; passwords are in the git-ignored credentials file)
| Step | Where | What to observe |
|---|---|---|
| FD-001 urgent overdue | Staff → *Breached* → FD-001 | Response and Resolution cards are independent; both *Breached*; "SLA history & audit" tab explains why (deadline, onset = deadline + 1 ms, recording time) |
| FD-004/005 claim race | Two profiles (Arjun, Priya) open FD-004 → both press *Claim ticket* | Exactly one "You claimed this ticket"; the other is told who won and the screen refreshes |
| FD-006 / FD-007 waiting | *Waiting on customer* | Resolution clock *Paused — no time is counting*; FD-007 is past its five-working-day cutoff → Lead runs *Run SLA sweep* → it auto-closes |
| FD-009 expired reopen | Lead sweep, then customer Sana opens FD-009 and "Reopens" | Window expired → a **new linked ticket** is created and shown |
| FD-010 privacy | Imran sees the amber *Internal note · team only*; customer Aarav's portal never receives it (DevTools → Network) | Export JSON/CSV from the portal: public messages only |
| FD-011 / FD-012 / FD-014 escalation | Assignee changes *Ticket priority* | Deadlines are recomputed from time already used (no reset); history tab shows before/after budgets |
| FD-013 holiday | Open FD-013 | Resolution deadline skips the configured illustrative holiday |
| Timelines | Any ticket with > 50 messages | *Load older messages* pages the real API; position is kept |
| Authorization | Agent: no *Run SLA sweep*; Customer visiting /staff is bounced | Server returns 403 for direct API calls |

Times are shown in IST and labelled; the UI never counts weekends, holidays or paused time — all deadlines and remaining working time come from the server.
