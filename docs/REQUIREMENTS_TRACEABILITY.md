# Requirements traceability — V3.1
RTM.csv is canonical. Status reflects actual executed evidence only. Includes R01–R12, P01–P05 and A04/A10/A11. Standalone calendar tests: 12 pass; all application proofs pending.

| ID | Requirement | Module | Acceptance evidence | Status |
| --- | --- | --- | --- | --- |
| R01 | Priority response / resolution SLA | SLA | T01 budgets and urgent day | Partial: calendar only |
| R02 | Working hours/weekends/holidays | Calendar | T02 Friday + holiday boundaries | 12 standalone calendar tests pass; full SLA pending |
| R03 | Pause while waiting | SLA / conversation | T03 pause/resume across holiday | Pending |
| R04 | Auto-close after working week | Jobs | T04 restart / duplicate job / cutoff | Pending |
| R05 | Reopen within window or new ticket | Tickets | T05 exact boundary and linked new | Pending |
| R06 | Agent screen and public/private composer | Web | T06 inbox/detail browser smoke | Pending |
| R07 | INC-0291 single claim | Tickets | T07 nine concurrent claims / rollback | Pending |
| R08 | INC-0304 no private disclosure | Auth / conversations | T08 public list/detail/export negative | Pending |
| R09 | INC-0318 immutable who/what/when | Audit | T09 same transaction / DB grants | Pending |
| R10 | Live week / repo / README / omissions | Ops | T10 production smoke and delivery | Pending |
| A04 | Priority change interpretation | SLA | T11 consumed time and breach preservation | Pending |
| P01 | Escalation and prior breaches | SLA | Active elapsed, paused and completed clock tests | Pending |
| P02 | Exclusive claim | Tickets | 2 and 9 concurrent HTTP claims real PG; audit rollback | Pending |
| P03 | Private notes | Customer | List/detail/export/UI secret marker and ownership | Pending |
| P04 | Immutable audit | Audit | Raw UPDATE DELETE TRUNCATE owner/runtime tests | Pending |
| P05 | Lifecycle demo | Jobs/Web | Seed, sweep lock, reopen, idempotency | Pending |
| R11 | Explain which tickets were late and why | SLA/Audit/UI | Reconstruct deadlines, pauses, priority revisions, onset and recorded time | Pending |
| R12 | Prove public reply publication in Frontdesk | Conversations/Audit | Message visible after commit; event timestamp and actor; no external receipt claim | Pending |
| A10 | Intake and actor/lifecycle matrix | Tickets/Auth | Atomic intake, exact cutoff, linked child, role/ownership | Pending |
| A11 | Session rotation, CSRF, Origin and privacy | Auth/API | Rotation replay, revocation, role, cookie and proxy tests | Pending |

V3.2 adds A12–A15 to RTM.csv (sweep progress, strict API errors/nullable fields, typed audit payload, startup/proxy). All implementation proofs pending; targeted schema fixture evidence separately recorded.
