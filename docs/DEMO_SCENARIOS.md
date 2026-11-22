# Reviewer walkthrough and seed plan
Synthetic data only; nine agents including Meera as lead, at least two independently authenticated customers. Separate browser profiles or isolated sessions for concurrency; shared cookie tabs are not independent. Demo mode explicit, isolated disposable data, rate limited; never allow arbitrary identity switch or admin bypass. Provide evaluator credentials privately, no committed passwords. Generate dates relative to seed anchor with working calendar; freeze calendar and use configured illustrative holiday dates labelled as such, not unverified official holidays. Seed idempotently in demo/test DB only, never reset production. Store coherent clock and audit history, no fake test evidence.
| Ticket | Scenario | Reviewer action / expected evidence |
|---|---|---|
| FD-001 | Urgent response overdue | Inspect separate SLA clocks |
| FD-002 | Medium resolution overdue | Inspect breach history |
| FD-003 | Friday 18:00 medium ticket | Show weekend exclusion; historical as-of calculation with explicit date |
| FD-004 | Unassigned | Two agent sessions claim, one wins |
| FD-005 | Unassigned | Nine-agent integration contention fixture |
| FD-006 | Waiting 2 working days | Customer reply resumes remaining budget |
| FD-007 | Waiting 6 working days | Sweep closes or inspect already auto-closed audit |
| FD-008 | Resolved 2 calendar days ago | Reopen original, resolution cycle increments |
| FD-009 | Resolved 10 calendar days ago | New linked ticket, old unchanged |
| FD-010 | Public and private messages | Agent vs customer list/detail/export and UI |
| FD-011 | LOW, response still RUNNING, no public staff reply, 150 active min | Escalate urgent, breach recorded |
| FD-012 | Paused LOW resolution, original cycle start 17:30, 90 active min accrued across working days before wait; response completed | Change to URGENT: 60 min budget, immediate resolution late while paused; waiting adds zero |
| FD-013 | Calendar holiday crossing | Deadline skips configured date |
| FD-014 | Historical audit reconstruction | Actor/action/time survives mutation |
| FD-015 | First public reply COMPLETED with known completion time and prior budget | Priority change leaves response row unchanged |
Use relative weekdays carefully: a historical Friday ticket may now be overdue; never label it currently on track when it is not. Show a read-only historical as-of calculation, not altered server time. Reviewer steps: login agent, filter My/Unassigned/Late/Waiting/Closed; open ticket, claim, send public reply and team note, change priority, view audit; login customer separately, inspect export, reply/reopen; lead triggers sweep. UI must display current vs historical breach and explicit paused status. Provide one-week hosting check and disclose scheduler limits. No marketing landing page.

FD-011 setup: choose an eligible day, start 09:30, test as-of 12:00 with 150 active minutes, no first reply; urgent response immediately breached, resolution still due at 18:30. For historical live seed choose relative working days and recalculate at actual server time; use test fixture clock for exact worked example, never pretend a currently overdue ticket is on time. FD-014 show deadline changes, pauses and publication event time with audit correlation.
