# Frontdesk V3.2 | Follow-up audit-corrected engineering baseline
Original PDF is authoritative; DOMAIN_CONTRACT and AUTH_CONTRACT define all normative interpretation. V2 PDF and BASELINE_V1 are historical. Full V2/V3 scope retained. Standalone calendar tests only; application implementation unverified.

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

---

# V3.1 authoritative domain contract
Original assessment is authoritative; this document fixes ambiguous implementation decisions. It supersedes conflicting examples in the V2 historical PDF, BASELINE_V1 and V3 design prose. Retain every existing engineering pillar and all P0/P1/P2 scope. All timestamps UTC timestamptz(3); calculations fixed Asia/Kolkata. All durations integer milliseconds; MIN=60000, business day=32400000 ms. Calendar holidays frozen for demo. Inject clock only in test service; no public time override.

## SLA policy and exact semantics
| Priority | Initial response | Resolution per cycle |
|---|---:|---|
| URGENT | 120 min | remaining working time from cycle start to close of its effective business day |
| MEDIUM | 270 min | 1620 min |
| LOW | 540 min | 2700 min |
Effective start: intake/cycle start if inside [09:30,18:30), otherwise next eligible opening. An urgent resolution created Friday 18:00 has 30 business minutes and deadline Friday 18:30; urgent response due Monday 11:00 (no holiday). The unspecified Friday example in the PDF is interpreted as a medium/low ticket or response SLA, not an exception to explicit same-day urgent resolution. Medium Friday 18:00 response due Monday 13:30, resolution Wednesday 18:00. Sunday has no extra working time; missed Friday urgent resolution stays missed. Explicitly document this interpretation in README. Urgent escalation uses ORIGINAL effective resolution cycle start to determine same-day budget, not day of escalation; pause credit shifts remaining deadline. Reopen gets a new resolution cycle starting at reopen time. Initial response is never restarted.

### Persistence and evaluation
Each clock: cycle (initial response always 0), kind RESPONSE/RESOLUTION, cycleStartedAt, budgetMs, consumedMs, state RUNNING/PAUSED/COMPLETED/CANCELLED, runningSince, deadlineAt, completedAt/cancelledAt, firstBreachedAt, currentLate, breachSequence, policyRevision. Store nonnegative integer bigint milliseconds; at API boundary check safe integer range and serialize numbers, never raw BigInt. All evaluation timestamps are integer ms. Effective running consumption = stored consumedMs + working overlap since runningSince. Accrue and reconcile before any change. At create both RUNNING with deadline=addBusinessMs(now,budget). When running, late iff now > deadline OR consumed > budget; equality at deadline on time. After a Friday deadline, Saturday remains late even if consumed equals budget; clock-time crossing the already due instant matters, not additional weekend accrual. Historical breach onset is first overdue millisecond (deadline+1) when discovered retrospectively, recordedAt is actual audit insertion time; if priority change newly makes consumed exceed budget, onset is change time. Audit stores both. Completion records current late result and historical facts; no automatic rewrite on priority changes. Cancellation records prior evaluation and stops clock (does not mark success). Queue active-late filters RUNNING/PAUSED with currentLate; terminal history is separately displayed. Staff read projection evaluates running clocks as-of server time even if sweep delayed; GET never mutates DB. Persist transitions on mutation/sweep; read projection may show detected but not yet recorded breach, clearly label.

Pause: only explicit public request from assignee; that message completes pending RESPONSE before pausing remaining RESOLUTION. Ordinary replies/notes never pause. Before pause, evaluate at now, store consumed, preserve currentLate, clear runningSince and deadline. While paused, consumed remains constant and no new deadline-based lateness accrues, except explicit priority recalculation. Resume: if not already late and remaining>0, deadline=addBusinessMs(now,remaining); if remaining=0, deadline=now (on time at equality, late at +1 ms); if already late or consumed>budget, retain currentLate immediately and deadline=now for display of newly resumed exhausted clock; retain original missed deadline in audit. Do not erase late status merely because pause or resume occurs. Already late running clock cannot become on track without policy change. Completion before first public reply is forbidden unless resolve command supplies a public resolution message in SAME transaction; that message completes response then resolution. No private note can fulfill SLA. Auto-close waiting cancels any unfinished clocks and preserves all prior breach evidence and close reason (not a resolution).

Priority change: no-op if same priority; no new deadline or breach identity. For each incomplete clock, first reconcile old deadline, apply new budget against elapsed consumed (never reset). Increment policyRevision. New currentLate iff consumed>new budget; equality on time. Running new deadline=addBusinessMs(now,max(0,new budget-consumed)); paused deadline=null, consumed frozen; if consumed>new budget mark late immediately even while paused. If revised policy clears lateness, preserve firstBreachedAt and all prior breach events. A new false->true episode increments breachSequence; one immutable event per clock ID + sequence. Completed/cancelled clocks never revised. Use deterministic event timestamps and old/new values. On ordinary running reconciliation preserve stored deadline (do not derive it again from zero remaining and shift it forward). At WAITING inactivity cutoff the close condition is strictly greater: customer at cutoff resumes; sweep only when now > waitingCloseDueAt. One business week=2700 minutes. Resolve reopen deadline=resolvedAt+7*86400000 ms inclusive (calendar week assumption, NOT working week). No calendar-time freeze of reopen window. Expire only now>reopenUntil.

### Worked boundary cases (IST, no holidays unless marked)
| Example | Expected |
|---|---|
| Fri Nov 20 18:00 2026 medium; Sun noon | response due Mon Nov 23 13:30, resolve Wed Nov 25 18:00, neither late |
| Same urgent | reply Mon 11:00, resolution Fri 18:30; at 18:30 on time, +1 ms late, remains late Sunday |
| Fri 18:30 intake urgent | effective Monday 09:30, reply Mon 11:30, resolve Mon 18:30 |
| Mon 09:30 low; escalate at 11:30 before response | consumed=120min, urgent response due now, no breach until +1 ms; resolution due Mon 18:30 |
| Mon 09:30 low; escalate at 12:00 before response | consumed=150min, urgent response breached now; resolution due Mon 18:30 |
| Mon 09:30 low; public request 11:00, Wed 15:00 customer reply | response completed at Mon 11:00; resolution consumed 90min, 2610min remaining; pause consumes zero; resume deadline calculated from Wed 15:00 |
| Mon 17:30 urgent; public request 18:00; Tue 10:00 reply | original resolution budget 60min, consumed 30min, new deadline Tue 10:30 |
| Paused exhausted clock equality after priority change | paused, not newly late, null deadline; resume deadline=now; +1ms late |
| At cutoff / +1ms customer reply | same ticket resume / close old and create linked child |
| At reopenUntil / +1ms | same ID new resolution cycle / expire old and create linked child |

## Actor and command matrix
Roles CUSTOMER, AGENT, LEAD, ADMIN (admin optional account; no implicit ownership bypass). AGENT/LEAD/ADMIN are staff; all nine agents include Meera as LEAD. Staff queue metadata for all tickets, safe assignee display name; individual staff details/internal notes/audit may be viewed by staff in this single support team; only assigned staff mutate owned ticket. LEAD/ADMIN may sweep; no reassignment route required by source, optional lead feature must lock and audit if added. All customers restricted by customerId; inaccessible IDs return 404, prohibited role 403. Actor derived from verified session, never request body. Customer cannot set authoritative priority: optional requestedPriority stored for triage, defaults authoritative MEDIUM until assigned staff adjusts. Staff-created ticket requires existing customerId and priority: initial public message attributed to staff but message kind INTAKE does NOT satisfy RESPONSE (record customer problem on behalf of customer, not response). Customer initial message similarly kind INTAKE. All intake atomic ticket + initial public message + response/resolution clocks + audit. Both return 201, OPEN, unassigned, resolutionCycle=0.
| Command / actor | State | Atomic outcome |
|---|---|---|
| Staff claim | OPEN | IN_PROGRESS, assign, increment version, audit; 200 vs 409 |
| Assignee public reply | IN_PROGRESS | publish REPLY, first response completes, state stays |
| Assignee note | IN_PROGRESS/WAITING | private NOTE, no SLA effects |
| Assignee wait with nonempty public request | IN_PROGRESS | WAITING, publish REQUEST, finish response, pause resolution, set waitingCloseDueAt |
| Assignee resolve with optional public message | IN_PROGRESS | require body if response pending; publish REPLY if supplied, complete clocks, RESOLVED, set resolvedAt/reopenUntil |
| Assignee priority change | IN_PROGRESS/WAITING | same state, recompute clocks, audit |
| Customer reply | OPEN/IN_PROGRESS | append public REPLY, no response completion, no state change |
| Customer reply | WAITING and now<=cutoff | append, resume, IN_PROGRESS, clear wait fields |
| Customer reply or reopen | RESOLVED and now<=reopenUntil | append public REPLY, retain assignee if present: IN_PROGRESS; otherwise OPEN; increment resolutionCycle; clear terminal fields; new resolution clock only |
| Customer reply | WAITING and now>cutoff | reconcile and auto-close old then create linked OPEN child with new intake + clocks |
| Customer reply or reopen | RESOLVED past window or CLOSED | reconcile expiry if needed, create linked OPEN child using original subject/customer/priority (requestedPriority null), new intake + clocks; old history unchanged except due reconciliation |
| Customer reopen | OPEN/IN_PROGRESS/WAITING | 409 (use reply) |
| Lead/admin sweep / SYSTEM scheduler | due WAITING/RESOLVED/running clocks | reconcile and audit, close strictly after cutoffs; no duplicate transition |
Staff reopen route retained only as role-forbidden compatibility stub (403); owning customer uses /customer/tickets/{id}/reopen with nonempty message. No staff impersonation. Resolved/closed staff public replies forbidden. Ineligible state 409. Every successful ticket mutation increments version once per logical transition (child intake version 0); sweep no-op does not increment. For reply/reopen return 200 SAME_TICKET or 201 NEW_LINKED_TICKET with {outcome,ticket,previousTicketId}; same-key retry returns original status/body. Late contact works identically before/after sweep. Reset waiting and terminal fields when entering active state; keep historical values in immutable audit/clock rows. CloseReason null until CLOSED; RESOLUTION_WINDOW_EXPIRED retains resolvedAt and reopenUntil. No destructive edit/delete endpoints. No arbitrary status PATCH.

## Transaction, time and idempotency contract
READ COMMITTED; all ticket paths lock parent ticket row first (SELECT FOR UPDATE), then sample floor-to-ms clock_timestamp() once, then lock/read its clocks ordered (cycle,kind,id), then write messages, clocks, ticket and audit. Clamp sampled DB time to ticket.updatedAt to avoid a backwards wall-clock step corrupting durations, log time anomaly. At create (no row) sample server time once. Claim can prelock then conditional UPDATE ... WHERE id=$id AND assigneeId IS NULL AND status='OPEN' plus version=version+1; use the same sampled time. Commit before responding. Loser authorized staff may receive assignee display name only. Jobs select candidate ticket IDs without locking clocks, then per-ticket transaction locks ticket via FOR UPDATE SKIP LOCKED, rechecks state and due time; scan in stable order with bounded batches and catch-up. Never lock clock before ticket; sweep invocation bookkeeping separate, no global lock while holding ticket locks. Idempotency row reservation FIRST for all externally retried POST/PATCH business commands (including claim, sweep; claim tests use distinct keys); lock order idempotency -> ticket -> ordered clocks -> append-only writes. Unique (actorId, operation incl route, key) with canonical normalized request hash incl resource and body. INSERT ON CONFLICT DO NOTHING; conflicting insert waits; read stored committed result, matching hash returns same HTTP status and JSON, mismatched hash 409; never return a pending result. Store completed response/status in same transaction, rollback reservation on failure, no side effects after retry. Limit keys and retained records (24h minimum demo retry window; never purge pending); server sweep uses unique invocation key and independent idempotent ticket transactions, see sweep below. No arbitrary caller timestamps. Retry entire deadlock/serialization failure bounded; never retry non-idempotent unauthenticated writes. Do not keep external calls in DB tx.

Sweep special case: one invocation record (unique key derived from actor ID/type and caller idempotency key) reserved and committed with START audit; process bounded ticket transactions with SYSTEM actor for auto transitions, correlation to initiating LEAD/ADMIN; finish invocation in separate transaction with FINISH audit and stored result. Same key/hash completed replay; running invocation returns 409 SWEEP_IN_PROGRESS, changed hash 409; abandoned invocation lease recover via new key after timeout, record failure/recovery, ticket transitions idempotent. Sweep endpoint never accepts time or arbitrary customer ID. Scheduled invocation SYSTEM without user; every invocation even zero tickets attributed. Audit ticket events include before/after state, version, priority, deadline, elapsed, breach reason, message ID and publication, no body; invocation events target SWEEP and no ticket FK. Publication time is server logical mutation time and message becomes visible on commit; does not prove external delivery/receipt or exact physical commit instant. UI reconstructs why late from immutable events; customer has no audit access.

---

# V3.1 authentication and authorization contract
All routes use same-origin HTTPS in production (Vercel rewrite /api or single-origin Nest static hosting). PUBLIC_ORIGIN is one exact origin including scheme/port; dev http://localhost:5173 via Vite proxy. Origin header required on browser POST/PATCH/DELETE including login/refresh/logout, must exactly equal configured origin, reject missing/null; no wildcard CORS or credentials for arbitrary origins. No alternate cross-origin browser flow unless explicitly designed and tested. Reverse proxy trusted hop configured narrowly, do not trust arbitrary forwarded headers. HSTS after HTTPS verified. GET never mutates business state. Auth/session and all staff/customer ticket responses Cache-Control: no-store; prevent CDN caching. Sensitive response variation by Cookie; no staff payload in customer client storage.

## Token and session lifecycle
- Argon2id individual credential login, generic 401, rate limit by source and normalized principal. Demo accounts synthetic and isolated; provide passwords privately; no identity bypass. Browser session independent contexts, not two tabs sharing cookies.
- Access JWT (15 min): HttpOnly Secure SameSite=Lax cookie `frontdesk_access`, Path=/api, host-only. Verify approved algorithm, issuer/audience, exp, sub, sid, then active session + user role from DB every protected call (immediate revocation takes effect on next authorization check, in-flight transaction may finish). No client actor or role. Development-only Secure exception on loopback HTTP. No localStorage tokens.
- Refresh opaque high-entropy token (7-day absolute session expiry), HttpOnly Secure SameSite=Lax `frontdesk_refresh`, Path=/api/auth, host-only. Store digest only; each token has session FK, unique hash, issuedAt, usedAt; old digests retained until session expiry plus 24h. Session is family. Refresh only uses refresh cookie, not access JWT. Lock Session row first then token, verify hash, expiry, not revoked. Mark used and insert new token atomically, issue new access and refresh after commit. Reused previously used digest revokes entire family atomically; return 401 after committing revocation (not throw/rollback). Concurrent requests serialize; second reuse intentionally revokes family, fail closed; client uses single-flight refresh, coordinate tabs via Web Locks or require fresh login after duplicate/replay; no automatic retry of refresh. Logout accepts valid access OR refresh identity, revokes current family, clears both cookies with matching paths, clears client cache; repeated logout 200 no-op after CSRF. No session lifetime extension beyond absolute expiry.
- Anti-CSRF: GET /auth/csrf issues random signed token cookie `frontdesk_csrf` (HttpOnly, Secure, SameSite=Lax, Path=/api), returns matching token in JSON (no-store); signature separate from JWT key, expiry 1h, bound to session ID for authenticated session or prelogin nonce otherwise. Request `X-CSRF-Token` must match signed cookie constant-time, verify signature/expiry and current family binding plus exact Origin. Login accepts only prelogin token and rotates CSRF on successful login; refresh and logout accept session-bound token even if access expired via refresh identity. GET /auth/csrf may identify session via valid access or valid refresh cookie (refresh cookie path /api/auth); read-only session check; no refresh rotation. Return new csrfToken in login/refresh success; clear on logout. CSRF token in memory, never log. Reject cross-origin and missing/wrong token with 403. Test expired access refresh, cookie paths, replay, origin, logout, revoked access and deployed proxy behavior. CLI/integration uses explicit Origin, cookie jar and CSRF token.

## Route matrix
| Routes | Authorized actor and resource |
|---|---|
| GET /healthz, /readyz, /auth/csrf | public; only safe status/token, rate-limited as appropriate |
| POST /auth/login | prelogin CSRF + origin, credentials |
| POST /auth/refresh | valid refresh family + CSRF + origin; rotation |
| POST /auth/logout | access or refresh; CSRF + origin; anonymous idempotent no-op with valid prelogin CSRF |
| GET /auth/me | active session |
| GET /tickets, /tickets/{id}, /tickets/{id}/audit | AGENT/LEAD/ADMIN; one support team; no customer access |
| POST /tickets | staff, valid existing customer ID |
| POST /tickets/{id}/claim | staff, OPEN and unassigned; conflict name safe staff only |
| POST replies/notes/wait/resolve; PATCH priority on /tickets/{id} | assigned staff only, DOMAIN_CONTRACT state guard |
| POST /tickets/{id}/reopen | compatibility stub, deny 403; no staff impersonation |
| GET/POST /customer/tickets; GET /customer/tickets/{id}; GET export; POST replies/reopen | CUSTOMER only, own customerId for every nested path |
| POST /admin/run-sla-sweep | LEAD or ADMIN; CSRF; idempotency key; bounded rate |
Every business mutation (POST/PATCH after auth) uses idempotency key and role/ownership check before replay result. Staff/customer API query scope before select; unknown or inaccessible resource 404, wrong role 403, authorized invalid state 409. No client-selected identity. Sweep SYSTEM job internal only. Retain all previous CIA, STRIDE, OWASP, NIST, CIS, SLSA, Pino, rate limiting, validation and deployment controls in SECURITY_ARCHITECTURE.

---

# High-level design
## Context and deployment
Browser (agent/customer) -> TLS edge -> React/Vite static app -> same-origin /api proxy -> NestJS modular API -> PostgreSQL. Vercel frontend, Render backend, Supabase managed PostgreSQL are target providers, not provisioned resources. Alternative single-origin deployment serves built React from Nest to simplify CSRF/cookies. Verify hosting supports persistent scheduled work; sleeping free instances cannot guarantee timely automation or availability. Use request-time reconciliation for displayed state and choose an awake host or document limitation; no fake uptime. Local Compose runs web, API and PostgreSQL with persistent volume and health dependency. Optional monitoring profile runs Prometheus and Grafana privately.
## Components and responsibilities
| Boundary | Responsibility | Dependencies |
|---|---|---|
| Identity | Login, sessions, actor context, roles | User/session repository, password hasher |
| Tickets | Claim, state transitions, priority changes | SLA, audit, persistence transaction |
| Calendar/SLA | Pure working-time arithmetic and clocks | Clock, configured holiday calendar |
| Conversations | Public messages and private notes, projections | Ticket authorization, transaction |
| Audit | Append event on every business mutation | Insert-only persistence port |
| Jobs | Due work and idempotent reconciliation | Ticket use cases and DB locks |
| Health | Liveness and bounded database readiness | DB check |
| Web | Inbox, detail, customer view | Typed REST client |
Domain functions do not import NestJS/Prisma/React. Controllers handle transport, DTOs and guards; use cases orchestrate transactional operations; infrastructure implements narrow ports. No direct cross-module writes outside coordinating use case. One database owns authoritative state; no distributed transaction or cache invalidation burden. API instances are stateless with durable sessions in DB; scheduler may run in more than one replica only after lock/retry tests. Workers are extractable, not separate microservices initially.
## Data flow and trust boundaries
Browser input untrusted; TLS terminates at edge, forwarded headers trusted only from configured proxy. API authenticates then checks role and ticket ownership in transaction. Customer read path queries explicit public columns, never generic ORM serialization. Runtime DB identity is not table owner. Migration credentials are separate. CI is distinct trust boundary with least token permissions and no secrets on untrusted PRs. Logs/metrics are operational and never contain message content or credentials. Audit is transactional business evidence, not application logging.
## Capacity and reliability
40/day x 365 = 14,600 tickets/year illustrative upper estimate, not measured throughput; nine agents. Start with indexed queries, bounded 50-row pages, connection pool sized to host limits, bounded job batches of 50, 60-second polling target. Scale API horizontally only with verified connection limits and job locks. Avoid caching sensitive data. Optional worker extraction retains same schema and use-case contracts; transactional outbox only when durable external events are needed. No Redis, Kafka, RabbitMQ, Kubernetes, Istio, Vault or SIEM in baseline. Failure: DB unavailable -> readiness 503, mutations fail safely; rollback all changes; clients retry explicitly, jobs retry with bounded backoff. No unverified HA/SLA promises.


## V3 proof surfaces
Customer list/detail/export and lead-only sweep are explicit API boundaries. Inject Clock into use cases for deterministic tests only; DB time in production. Scheduler and manual sweep invoke same locked, idempotent service. Audit and business writes share transaction. Real PostgreSQL integration proofs and authenticated browser privacy tests gate release.

---

# Low-level design and transaction contracts — V3.1
DOMAIN_CONTRACT.md is the normative transition, SLA, time and locking matrix; AUTH_CONTRACT.md is the route and session matrix. No competing lifecycle definitions here.
## Interfaces and dependency rules
Clock.now(): Instant; BusinessCalendar.addMs(start,ms), elapsedMs(start,end), urgentBudgetMs(start); SlaPolicy.budgetMs(priority,kind,cycleStartedAt); TicketRepository.lock(id,tx), claim(id,actor,now,tx), save(ticket,tx); AuditWriter.append(event,tx); UnitOfWork.run(fn); PublicTicketReader.list(customerId,cursor), detail(customerId,id), export(customerId,id,format). Wrap preserved calendar engine with integer-ms boundary conversions and round result to nearest millisecond. Use focused ports, Nest DI, pure domain transition functions returning state and event intents. Pass transaction client through all writes; never commit independently. Sample DB time after ticket lock; deterministic Clock injection only in tests.
## Claim and jobs
Reserve idempotency key, lock ticket, sample advancing DB time, then conditional UPDATE where id, OPEN, assigneeId IS NULL; set assignee, status IN_PROGRESS, updatedAt, increment version; append audit and persist successful response in same transaction. Loser 409, one audit event; no read-then-write outside lock. Jobs select candidate ticket IDs by indexed deadlines, lock ticket first with SKIP LOCKED, recheck, lock ordered clocks, mutate and append; no clock-first locks. Use clock ID + breachSequence for unique breach event keys. Sweep invocation audit separate from ticket mutations, per DOMAIN_CONTRACT. No in-memory timer source of truth.
## Customer projection and errors
Mandatory dedicated list/detail/JSON+CSV export; query ownership and PUBLIC visibility at DB, allowlist public DTOs, no private counts or audit. Staff role and ownership as in AUTH_CONTRACT. 400 validation, 401 invalid session, 403 forbidden/CSRF, 404 invisible, 409 state/idempotency conflict, 429 throttle, 503 unavailable; safe error envelope code/message/requestId plus optional assignedAgentDisplayName for staff claim conflict. Stable pagination by createdAt/id, signed or validated opaque cursor scoped to current filters and actor; no offset drift. Details include complete message timeline bounded by assessment-scale limits; if larger, paginate without leaking counts. Public list selects public summary only. Transaction retry only bounded full transaction for transient deadlock/serialization; see DOMAIN_CONTRACT.

---

# Database engineering
Existing prisma/schema.prisma is a preserved draft, not validated migration. Normalize users, tickets, messages, SLA clocks, immutable audit and holiday dates; retain sessions, linked parentTicketId, waitingCloseDueAt, reopenUntil, cycle/version, idempotency record as needed. Use UUID PKs, foreign keys RESTRICT (no destructive cascade into audit), unique email normalized on input, unique clock(ticket,cycle,kind), unique eventKey, check budget/consumption >=0, kind enum, valid state/assignee coherence. Application must enforce assigned user role; FK alone cannot. UTC timestamptz, date-only holiday. Store typed TICKET or SWEEP audit target, actor role and user ID or explicit SYSTEM actor, action, timestamp, before/after safe metadata and correlation ID; no passwords or private body. Audit events indexed ticket/time/id. Ticket indexes assignee/status, customer/createdAt/id, status/waitingCloseDueAt, status/reopenUntil; clock deadline index for active clocks; message ticket/visibility/createdAt/id. Keyset pagination stable createdAt/id. Use EXPLAIN on seeded workload before adding redundant indexes. Prisma parameterization; raw SQL uses tagged parameter binding, never interpolate user text. Migrations versioned and run with owner role; runtime connects as non-owner with explicit grants. Audit runtime SELECT/INSERT only, revoke UPDATE/DELETE/TRUNCATE; prevent privilege inheritance and public grants. Database owner remains trusted; optional hash chain plus externally protected checkpoint for stronger tamper evidence. Migration rollback via compatible forward fix or tested restore; never reset production. Supabase pool connection mode must support transactions; direct connection for migrations, TLS, verify role privileges. Backup retention provider-dependent; test restore in isolated DB, no claim until verified. Seed synthetic nine agents, customers, each priority/state and holiday example; credentials via environment, no committed shared admin secret.


## V3 migration contract
AuditEvent maps to audit_logs; reviewed SQL template in prisma/sql/audit_immutability.sql must be included after table creation in a versioned migration. Test with owner and runtime separately; ensure runtime does not inherit ownership or elevated roles. Add explicit actorType and close reason; parent link restrict deletion, same customer enforced by use case. Add durable session and idempotency tables. SQL template is not executed here.

## V3.1 schema and migration alignment
Use ClockKind/ClockState enum, bigint budgetMs/consumedMs, cycleStartedAt, policyRevision, currentLate, breachSequence and firstBreachedAt. MessageKind separates intake from public response. User role LEAD; SweepInvocation supports zero-ticket audit and durable invocation lease; RefreshToken stores spent token hashes; IdempotencyRecord captures HTTP status and body. Apply prisma/sql/domain_constraints.sql and audit_immutability.sql in versioned migration after initial generated schema, using public schema and separate non-owner role. Verify inherited grants/column grants, privileges, triggers, check constraints, ownership and actual role connection in isolated real PostgreSQL. Role provisioning is environment-specific; do not grant runtime migration rights. Neither SQL template has been executed here.

---

# Software engineering standards and reference adoption
SOLID: SRP calendar calculates time, ticket use case orchestrates; OCP policy strategy extends budgets without modifying controllers; LSP repository implementations honor transaction/error contract; ISP narrow read/write/clock ports; DIP domain depends on interfaces, adapters implement. DRY centralize policy/authorization; KISS/YAGNI avoid brokers and over-abstraction; encapsulation protects transitions; composition over inheritance; fail-fast config; design by contract (pre/postconditions and invariants); single source PostgreSQL; convention over configuration, strict TS, ESLint, Prettier, descriptive names, small meaningful commits. High cohesion, loose coupling, separation of concerns. Patterns: Repository, Strategy SLA, State Machine, DI, Adapter, Command use cases, Middleware/guards/interceptors; Observer for noncritical in-process events only; Specification for reusable predicates if needed; transactional outbox conditional for reliable external dispatch, not needed for local audit. Do not conflate append-only audit with event sourcing or claim full CQRS. HLD/LLD, ADR, ERD, sequence/class/state views, traceability and verification. NFRs: indexed reads/pagination, stateless API, reliable transactions and retries, availability health, maintainability boundaries, testability clocks, accessibility, portability Compose, usable responsive screen, recoverability and correlation IDs; measure rather than invent.
## Reference repositories (patterns only)
Toyota R2 https://github.com/ruvais-p/toyota_r2 : adopt shadcn, typed env/Zod decision, Supabase, repository boundaries, constraints, health, seed and detailed README/diagrams. Reject shared admin password and Next.js all-in-one for this design. Platform Service https://github.com/shivaacodes/platform-service : adopt Docker Compose, CI, Pino equivalent of Zerolog, Nest ConfigModule equivalent of Viper, health/readiness, Jest/Supertest and k6 equivalent of pytest/Locust, optional prom-client/Grafana; no Go or Redis baseline. Payroll Automation https://github.com/shivaacodes/Payroll-Automation-System : decoupled UI/API, atomic DB operations, normalized tables, background work without broker, persistent volumes, pg_isready, one-command setup; no Go. Nippon Website https://github.com/shivaacodes/nippon-website : strict TS, responsive design, Tailwind, Lucide, Vercel, ESLint, optimized assets; optional motion/Zustand; no proprietary code, automotive functionality or SSR requirement. These are adoption decisions based on previously reviewed repository descriptions, not a fresh repository audit.

---

# Security architecture
CIA: confidentiality (TLS, public-only projections, resource authorization, encryption at rest where provider confirms); integrity (ACID, state invariants, constraints, restricted append-only audit); availability (limits, health, bounded queries, backups, recovery). Accountability via unique identities and transactional audit; attribution is not cryptographic non-repudiation. Defense in depth, explicit verification (Zero Trust principles, not full enterprise Zero Trust), least privilege, deny by default, secure design/default, separation of duties, fail securely, privacy minimization, shift-left. Do not claim certification.
## Identity and authorization
Argon2id password hashing using maintained library; tune memory/time on host, never log credentials. Short-lived JWT access with algorithm allowlist, iss/aud/exp/sub/session ID validation; refresh token opaque random, hash stored in DB, rotate transactionally, revoke family on reuse; logout revokes session. Check session validity on every protected read/mutation. HttpOnly Secure SameSite cookies; prefer same-origin proxy, anti-CSRF token plus Origin validation; no localStorage tokens. Exact CORS allowlist, no wildcard credentials; login throttling and generic error; no public admin registration. Seed individual demo accounts. MFA optional. Resource checks on every endpoint, including exports and nested messages; no client-supplied actor/role/visibility for public reply. Staff queue and detail scoped to single team; assigned staff only mutates; customer only own public view and reply/reopen; audit staff only; nobody app-side edits audit.
## Hardening
Helmet with CSP (no unsafe-inline unless documented), HSTS after HTTPS confirmed, frame-ancestors none, nosniff, referrer policy; validate DTO whitelist and forbid unknown fields, Zod for shared contracts/environment or Nest class-validator for DTOs (choose one validation authority per boundary). Bound body length, page size, timeouts and rate; output encode, render text not raw HTML; parameterized SQL; avoid arbitrary outbound URLs and uploads (not required). Safe errors and Pino redaction for cookies, auth, passwords and bodies. No private fields in customer API, list counts, export, cache, real-time event, or telemetry. No sensitive data in metric labels. Environment schema fails startup on missing secrets; separate signing and DB credentials; rotate exposed keys immediately and revoke sessions. TLS DB and HTTPS; non-root minimal container, read-only FS where compatible; restricted network; IAM least privilege. Keep synthetic data, define demo retention (delete after evaluation unless required), no destructive audit deletes during evaluation; actual customer retention requires approved policy. Backup encrypted if supported; restore test. Incident response: contain, rotate, preserve evidence, assess, recover and document.
## Standards mapping
OWASP Top 10 and API Top 10: broken access/BOLA, auth, injection, misconfiguration, resource exhaustion, inventory and dependencies; ASVS selected controls mapped to tests, not full verification. NIST CSF 2.0 govern/identify/protect/detect/respond/recover; SSDF prepare/protect/produce/respond; CIS Benchmarks relevant host/container controls subject to runtime; SLSA pin dependencies/actions, provenance and optional signing. References: https://owasp.org/www-project-top-ten/ ; https://owasp.org/www-project-api-security/ ; https://owasp.org/www-project-application-security-verification-standard/ ; https://www.nist.gov/cyberframework ; https://csrc.nist.gov/projects/ssdf ; https://www.cisecurity.org/cis-benchmarks ; https://slsa.dev/ . Guidance only, not researched compliance assessment.


## V3 demo and export boundary
Demo authentication is opt-in isolated synthetic tenant/instance, real identity credentials or limited demo tokens; admin sweep has authorization, CSRF and rate limits. No production impersonation bypass. Customer export strictly public allowlist, no-store, CSV injection mitigation. Clear client cache on session change; separate browser contexts. Audit trigger plus grants, not a privileged DBA tamper-proof claim.

## V3.1 binding decisions
AUTH_CONTRACT.md defines exact routes, authority, access/refresh/CSRF cookies, Origin, reuse revocation, concurrent refresh and proxy behavior. DOMAIN_CONTRACT defines transaction-time checks and idempotency. Explicit typed public schemas in OpenAPI are allowlists, not ORM serialization.

---

# STRIDE threat model
Assets: public and private conversations, account/session secrets, ownership, SLA facts, historical audit, service availability. Actors: anonymous internet user, customer, agent, compromised session, malicious insider, CI contributor, DB owner (trusted boundary).
| STRIDE | Attack path | Required mitigation | Verification |
|---|---|---|---|
| Spoofing | stolen token / brute force | Argon2id, session expiry/revocation, throttling | invalid/revoked token and rate tests |
| Tampering | duplicate claim or forged timestamp | conditional update, server clock, audit privilege | race, rollback, DB update denied |
| Repudiation | deny reply | actor/time/message ID transactional audit | exact same transaction, persisted history |
| Disclosure | guessed ID, note export/list | resource guard, PUBLIC query and DTO | two-customer negative tests, private sentinel absent |
| DoS | giant page/body, expensive query | bounded inputs, limits, indexes, job batch | 429, max size, readiness |
| Elevation | crafted role or mass assignment | DTO whitelist, deny default, non-owner roles | customer calls staff routes, privilege regression |
Residual risks: privileged DB owner, hosting outages/sleep, dependency zero-days, compromised browser, holiday config mistakes; record in risk register. DAST only against owned disposable test service. No real customer data. Optional MFA, external audit checkpoint and image signing reduce specific risks, not mandatory.

---

# DevSecOps and supply chain
Plan threat model -> code review/secret scan -> build/lint/typecheck -> unit/integration -> scan dependencies/SAST -> build non-root image -> Trivy -> optional isolated ZAP -> release gate -> deploy -> smoke/monitor/recover. GitHub Actions PR workflow: npm ci from committed lock, ESLint, Prettier check, tsc --noEmit, Jest, Supertest against real PostgreSQL service, frontend/backend build, Gitleaks, Semgrep or CodeQL, npm audit/Dependabot review, Trivy. Pinned verified action commit SHAs, contents:read default, no production secrets on PR, no pull_request_target checkout of untrusted code. Dependabot npm/actions updates. Generate CycloneDX SBOM if time; optional signed images/provenance. ZAP baseline/API scan only owned ephemeral environment, authenticated tests separately; scanner cannot prove business authorization. High/critical actionable findings, secrets, failed required tests block release; documented time-limited waivers with rationale and owner; do not bypass silently. Deployment only reviewed main commit, environment-scoped secrets, migration step then health/smoke; no auto-deploy bypassing gates. If hosting auto-deploy cannot be gated, disable or disclose. Roll back to prior compatible artifact; schema forward fix/restore if needed. Docker multi-stage minimal pinned base, npm ci, non-root, no secrets in image, health checks. CI/configs are planned, not executed; implement only after application works. Tools: Semgrep/CodeQL SAST, Gitleaks secrets, Dependabot/npm audit SCA, Trivy container/IaC, ZAP DAST, CycloneDX SBOM, optional signing. Evidence saved as redacted artifacts with commit SHA.


V3.1: essential P0 proofs/build/security gates are blocking on the exact release commit regardless of M6; run locally if CI not ready, log actual commands and SHA. Never deploy with known privacy/authorization/integrity failure. Remaining P1 scanners should run; record each status and justified omission in short note. Disable unsafe auto-deploy; deploy only reviewed tested SHA and smoke it. P2 remains optional.

---

# Quality engineering and acceptance
Testing pyramid: pure domain Jest/unit tests, real DB Supertest integration and concurrency/security, Playwright browser smoke; k6 optional load. Original six Node tests plus six V3.1 boundary tests executed; no full app exists. Inject deterministic clock, explicit fixture holidays, separate DB per test suite, no sleeps for SLA. Unit coverage: workday open/close boundaries, Friday 18:00, holiday Monday, weekend, after-hours, zero/negative budget, add/elapsed inverse, urgent budget, pause spanning holiday, priority escalation/de-escalation without reset, prior breach preservation, exact cutoff and reopen cycle. Integration: nine simultaneous distinct agents claim one ticket (one 200/eight 409/one event), forced audit insert failure rollback, concurrent reply/close and repeat scheduler, restart catch-up, customer A cannot read B, customer private sentinel absent from list/detail/both JSON/CSV exports, customer cannot post note or change role, invalid JWT/session revocation, CSRF, size/rate, audit UPDATE/DELETE/TRUNCATE fails under runtime user. Verify own-ticket dashboard, late versus waiting, public reply vs note, reopen within window and new ticket after. Test resolved/closed semantics, duplicate message key, missing DB readiness. E2E keyboard navigation and accessible labels, mobile viewport, error/retry. k6 synthetic local workload nine concurrent agents, report actual p50/p95/errors and resource constraints; no invented SLOs. Proposed target p95 <500ms for small paginated read on specified test host, not requirement or proof. CI artifacts include command, commit, environment and result. Regression map in RTM; every required row needs evidence or explicit omission. No claimed coverage percentage before run.


## V3 mandatory gates
P01–P05 in ENGINEERING_PROOFS supersede generic test descriptions. Real PostgreSQL required for integration, privilege and contention tests. Playwright customer privacy smoke is P0; expanded E2E optional. Record test command, environment, actual output and evidence file. No unexecuted test may be marked pass.

## V3.1 verification matrix
Follow ENGINEERING_PROOFS additional required gates. Auth: cookie paths, exact Origin/CSRF, wrong-role and cross-customer mutations, expiry/rotation/concurrent replay/logout, revoked access, cache no-store. API contract test: every staff/public DTO response matches schema; no extra public fields. Test DB constraints and version increment, lock ordering and advancing DB time. Release gate: execute mandatory P0 proofs + build + basic authorization/privacy/security checks on exact deployed commit; required browser privacy smoke is P0. Expanded Playwright, load and P2 scans retained. Never mark pending tests passed.

---

# Observability, deployment and recovery
Pino structured logs: requestId, route template, method, status, duration, safe error code; redact Authorization, cookies, credentials, message content. Audit separate, permanent business evidence. GET /healthz process liveness (no dependency); GET /readyz bounded DB SELECT 1 -> 503 if unavailable. Optional prom-client metrics: http_request_duration_seconds histogram by route/method/status class; http_requests_total; ticket_claim_conflicts_total; sla_breaches_total by priority/kind; jobs_runs_total by job/outcome; jobs_last_success_timestamp_seconds; db_up gauge. No ticket/customer IDs or content labels. Grafana panels request rate/errors/p95, claim conflicts, breaches, job failures and DB readiness; private monitoring profile, no public Grafana or metrics. Alert candidates job stale >2 intervals, DB unavailable, error spike; thresholds unverified. Deployment: provision Supabase DB + owner/runtime roles, apply migrations via direct TLS URL, seed synthetic data once, configure Render secrets, deploy API, verify readiness, deploy Vercel UI and same-origin proxy, check cookies/CSRF/HTTPS and all three incidents. Keep available seven days, verify host sleep and scheduler, document cold starts. Local compose persistent volume, pg_isready, API readiness, one-command run after environment setup. Recovery: stop mutations if compromise, isolate, rotate secrets/revoke sessions, preserve audit, inspect redacted logs, restore backup into isolated DB and verify counts/invariants, redeploy known good compatible commit. RPO/RTO not measured; record actual backup/restore timing, provider limits. Incident log: detected time, impact, mitigation, owner, recovery, follow-up. No live deployment or availability asserted.


## V3 reviewer operation
Expose lead sweep result with correlation ID, counts and safe errors; audit invocation separately from per-ticket state events. No message bodies in logs or metrics. Verify sleeping-host limitation, use awake service where feasible. Preserve monitoring as optional profile. Check URL daily during required week; record actual availability.

V3.1: verify scheduler runs with no browser traffic; test sleep/restart catch-up on actual host. Sweep START/FINISH events even zero tickets; link system events by correlationId. Verify exact tested SHA, no-store and authenticated cookie/CSRF smoke on deployed proxy.

---

# Frontend architecture and UX
React + Vite + strict TypeScript, Tailwind CSS/shadcn/ui, Lucide icons, TanStack Query for server state; optional Zustand for genuinely shared client-only state, Framer Motion for subtle transitions with prefers-reduced-motion. Avoid unnecessary animation and Next.js SSR/SEO. Feature modules auth, inbox, ticket detail, conversation, customer, shared UI; typed API adapter and shared contracts. Query keys separated by role/session; clear cache on logout, invalidate after mutation, no optimistic claim success or fabricated SLA status. Server supplies authoritative deadlines and business state; countdown display only. Screen: queue/my tickets, filters priority/status/late, accessible list and detail split panel, narrow screens stack; waiting indicator independent from historical late badge; explicit public reply vs private note modes with labels and confirmation when ambiguous, note visually distinct but never rely on color alone. Agent audit timeline uses safe actor/time/action, customer view only public DTO. Keyboard focus, semantic buttons, labels, WCAG-oriented contrast, reduced motion, loading/empty/error/conflict states (409 refresh and notify), pagination. Assets optimized (SVG icons, small bundles, lazy load optional charts, no decorative heavy imagery). No marketing landing or unrelated product feature. Validate at desktop and mobile with keyboard and screen-reader semantics; no compliance claim without audit.


## V3 reviewer workspace
Filters All, Late, Waiting, Unassigned, My Tickets, Closed; distinct priority/current SLA/history badges; remaining working time from server. Public reply and amber team-only note composer; customer portal separately authenticated; export preview from actual customer endpoint, no staff payload. Lead-only sweep; show outcome and automatic history. See DEMO_SCENARIOS.

V3.1: use separate typed staff/public API contracts; public list shows public summary subject only. Staff detail reconstructs historical reasons and publication timestamp; server clock as-of and unrecorded breach indicator. Support customer response outcomes SAME_TICKET or NEW_LINKED_TICKET; never reuse staff data in customer preview. Staff resolve requires public message if response pending. Auth flow per AUTH_CONTRACT; clear cache on identity switch.

---

# Architecture decision records
- ADR 001: Modular monolith. Choose one NestJS service and shared PostgreSQL; reject distributed services, Kafka/RabbitMQ and Kubernetes: local ACID fits workload. Revisit only measured bottleneck.
- ADR 002: Frontend and backend. React/Vite with strict TS, Tailwind/shadcn, NestJS Node. No Angular learning overhead, Next.js SSR or Go (not permitted).
- ADR 003: Storage and concurrency. PostgreSQL/Prisma/Supabase; no MongoDB/Redis baseline. Conditional claim and lock all competing mutations; audit in same transaction.
- ADR 004: SLA policy. Adopt documented assumptions for priority, urgent same-day, working week and reopen; preserve history. Source PDF wins.
- ADR 005: Privacy and audit. Separate public query and DTO, no unrestricted ORM response; non-owner runtime grant insert/read audit only; owner trusted.
- ADR 006: Jobs and infrastructure. Persist due work, lock and recheck, scheduler in API initially. Worker extraction and transactional outbox conditional; optional monitoring profile.
- ADR 007: Secure deployment. Same-origin cookies preferred; TLS, CSRF, least privilege and quality gates. Verify host scheduler availability; no uptime promises.
- ADR 008: Validation and quality. Nest DTO class-validator or shared Zod per boundary; typed env; Jest/Supertest, required Playwright privacy smoke; expanded Playwright/k6 optional; no double validation ceremony.
## ADR-009 — proof-driven V3
Retain V2 architecture and optional roadmap; add mandatory real DB proofs, customer export, controlled demo and sweep. Keep original same-working-day urgent resolution and V2 seven-calendar-day resolved reopen interpretation. Reject unprotected demo switching, client clock and blanket removal of design documents. See ENGINEERING_PROOFS.

- ADR 010: V3.1 authoritative SLA, lifecycle, auth, transaction and API contracts; see adr/010.md.

---

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

---

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

---

# V3 mandatory proof contracts
Status: design and acceptance criteria, not executed application tests. Original PDF wins. V3 policy decisions override older draft examples. Keep all V2 engineering practices by priority.
## P01 — Priority escalation
Use independent RESPONSE and RESOLUTION clocks; first public agent reply completes response, resolution completes resolution. Accrue elapsed active working milliseconds under old policy before changing priority; preserve prior breach events and completed clocks. Urgent resolution budget is remaining working time to end of effective working day at cycle start, not 540 minutes universally. Outside hours effective start is next eligible opening. Pause extends remaining budget; weekends/holidays never accrue. Reevaluate new budget against consumed active time, set deadline immediately if exhausted; if exceeded record breach at change instant unless earlier breach exists. Equality on time; strictly after is late. Downgrade may clear current lateness, never historical breach. Audit old/new priority, budgets, deadlines, consumed and actor in same transaction. A Friday 18:00 urgent response is due Monday 11:00 (no holiday), resolution Friday 18:30; weekend does not add elapsed time but an already missed Friday resolution remains breached. Demonstrate Friday example with medium ticket or response clock separately. Tests: completed response unchanged, paused escalation, downgrade historical breach, exact equality, after-hours, holiday.
## P02 — Exclusive claiming (INC-0291)
POST /api/tickets/{id}/claim; authenticated agent, visible OPEN ticket, conditional update where assignee null and status OPEN; increment version; append audit in same transaction. 200 after commit; loser 409 with assigned agent display name only if authorized staff. Two independent authenticated sessions and separate DB connections invoke HTTP through Promise.all; assert sorted statuses [200,409], only one assignee and one claim event. Repeat with nine agents [200,409 x8]. Force audit insertion failure and assert assignment rolled back. No mock DB or sequential substitute. Owner-only public reply prevents second agent replying.
## P03 — Privacy (INC-0304)
Separate customer list, detail and GET /api/customer/tickets/{id}/export?format=json|csv. Filter ownership AND message visibility PUBLIC at database query, select only public fields, then serialize allowlist DTO. No private notes/IDs/counts, audit metadata, search snippets or notification leak. CSV escape quotes and formula-leading fields; no cache, no internal metadata. Browser customer session independently authorized; do not reuse staff response or hide with CSS. Secret marker assertion on raw list/detail/export bodies and browser DOM/network, plus cross-customer 404, staff-only routes forbidden. Public content must still appear. Distinct amber internal note composer with explicit team-only label.
## P04 — Audit integrity (INC-0318)
Every meaningful mutation and breach records actor ID/type, action, ticket or sweep target, correlation ID, server timestamp and safe before/after metadata in same transaction. SYSTEM actor explicit. No note bodies, tokens or secrets in audit payload. Database trigger rejects UPDATE/DELETE and statement trigger rejects TRUNCATE; runtime non-owner cannot disable triggers or mutate logs. Test raw SQL under runtime role (permission denied), then isolated migration-owner role (trigger error) against existing seeded event; verify row unchanged. No superuser tamper-proof claim. Test failed audit append rolls back business mutation. Optional hash chain with externally protected checkpoint retained.
## P05 — Time lifecycle and demo
Waiting begins only with explicit public request from assignee; request completes unfinished first reply then pauses resolution and any remaining clocks. Customer reply resumes on same ticket before or at 2700 working-minute inactivity cutoff; scheduler closes strictly after cutoff. Recheck state and time under row lock. Waiting timeout closure reason AUTO_CLOSED_NO_REPLY; later contact creates linked new ticket. Resolved reopen window remains seven calendar days inclusive (V2 interpretation of about one week, distinct from explicitly working-week inactivity); reopen within window starts new resolution cycle, preserves completed initial reply and historical clocks, retains owner if present, otherwise re-enters OPEN queue. After window create new OPEN linked ticket; expired resolved closure does not reset original resolvedAt. Use idempotency key bound to actor/operation/request hash for retries. Manual POST /api/admin/run-sla-sweep requires support-lead/admin, CSRF and throttle; no client supplied clock, auditable invocation and per-ticket audit, bounded batches, locks, retry/restart safe. Test fake clock only through dependency injection in tests, real DB for lifecycle integration. No clock manipulation endpoint in deployed app. Demonstrate genuine historical scenarios; scheduler may process overdue seed before reviewer arrives, history must remain visible. Verify customer reply/sweep race and duplicate sweep.

## V3.1 additional required gates
DOMAIN_CONTRACT and AUTH_CONTRACT govern all exact cases. P01: equality and +1ms, paused escalation, resume with zero budget, completed-response unchanged, resolving before first reply rejected unless public resolution message supplied, downgrade preserves prior breach events; deadline does not drift across weekend. P02: force overlapping PostgreSQL transactions using test-only lock barrier (not just Promise.all); 2 and 9 distinct sessions, loser reply denied, one audit and rollback proof. P03: public subject appears in list; public message appears in detail and both exports; secret marker absent from all including browser network/DOM; cross-customer mutations denied and staff->customer client cache emptied. P04: owner trigger errors and runtime effective grant denials for UPDATE/DELETE/TRUNCATE, unchanged rows, zero-ticket sweep invocation, append failure rollback; reconstruct why late and publication time. P05: cutoff equality/+1ms, reply vs sweep, delayed sweep before/after outcome identical, restart catch-up, same-key same-body replay vs different body conflict, correct linked ticket and resolution cycle. All gates pending actual application execution.

---

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

---

# V3 implementation plan — proof driven
Time constraint: PDF ~8 honest hours; confirm AI policy and if stricter 4-hour instruction governs. Record elapsed time and stop at applicable limit. P0 correctness and deployment before optional infrastructure. Retain detailed V2 docs, no silent removal.
| Milestone | Minutes (8h plan) | Scope and gate |
|---|---:|---|
| M1 | 45 | Audit starter, scaffold workspaces, schema/roles/migrations, trigger and idempotent seed; real PostgreSQL migration check |
| M2 | 55 | Calendar/SLA clocks, priority, pause, lifecycle; deterministic tests |
| M3 | 80 | Auth/RBAC, atomic claim, messages, customer API/export, audit, jobs; API build |
| M4 | 70 | Five proof integration suites, separate DB sessions, raw SQL, browser privacy test plan; fix failures |
| M5 | 100 | Accessible agent/customer UI, real demo actions, build and browser smoke |
| M6 | 40 | Docker, CI, Pino, health, security gates where feasible |
| M7 | 20 | Optional monitoring/k6/DAST/SBOM only if core done; otherwise use for blockers |
| M8 | 70 | Deploy, HTTPS smoke, docs, RTM evidence, honest omissions, reserve |
Four-hour contingency: M1 25, M2 35, M3 50, M4 35, M5 40, M6/M7 0, M8 55 minutes; narrow UI polish, never remove security controls, report incomplete items. Estimates not claims.
## Pre-M1
Read DOMAIN_CONTRACT, AUTH_CONTRACT and AUDIT_RECONCILIATION. Node 22 LTS, Prisma 6, PostgreSQL 16 are compatibility baseline candidates, not installed version claims. Pin exact supported patched releases in M1 after checking official compatibility and availability; commit lockfile, runtime version file and image digest; record versions and migrate against real isolated PG. Check hosting scheduler and same-origin feasibility before committing providers.
## Phase prompts
M1: Read original PDF, DOMAIN_CONTRACT, AUTH_CONTRACT, DATABASE_DESIGN, ENGINEERING_PROOFS. Inspect draft schema and SQL template; implement baseline migration first, then trigger; separate owner/runtime roles; run migrations and seed real isolated PostgreSQL. Report commands and failures.
M2: Read DOMAIN_CONTRACT, LLD, ENGINEERING_PROOFS and calendar tests. Preserve kernel; implement independent clocks and safe precision; test all boundary cases.
M3: Read DOMAIN_CONTRACT, AUTH_CONTRACT, HLD, SECURITY_ARCHITECTURE, THREAT_MODEL, OpenAPI draft and proof contracts. Implement authenticated role/ownership checks, transactions, public projections and export, scheduler and lead sweep; no client-controlled time.
M4: Read TESTING_STRATEGY and ENGINEERING_PROOFS. Run real PostgreSQL HTTP contention, leak, trigger and rollback tests; report observed responses, rows and errors. Do not fake green checks.
M5: Read UI_ENGINEERING and DEMO_SCENARIOS. Build real customer session and agent workspace; test private marker absent in DOM/network/export; verify strict TS build and accessible interaction.
M6: Read DEVSECOPS and OBSERVABILITY_RUNBOOK. Compose health and persistent volume, structured redacted logging, CI and security tools; verify configured gates, no untrusted PR secrets.
M7: Keep optional Prometheus/Grafana, k6, ZAP, CycloneDX, independent worker, outbox if justified, MFA, signed images, audit checkpoints, restore drills and alerts. Implement only as time allows.
M8: Read REQUIREMENTS, RTM and runbook. Verify release gates for exact commit even if M6 deferred; verify deployment and scheduled behavior, smoke tests, README, SHORT_NOTE and link availability; update evidence with actual results. For every milestone inspect, plan, implement, test, record elapsed time and limitations.

---

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

---

# V3.1 evidence and limitations
Existing calendar kernel unchanged; six original and six new boundary tests run, see calendar-test-results.txt. V3.1 resolves audit findings in design contracts, schema, SQL templates and typed API draft. No Prisma CLI validation, PostgreSQL migration, real HTTP integration, frontend build, security scans, deployment or five-proof execution here. No live URL. No claim of production readiness or independent re-audit. All P0–P2 engineering scope retained. See AUDIT_RECONCILIATION.md for remaining gates.

---

# V3.2 normative follow-up refinements
The following contracts override the older sweep, API payload, auth configuration and milestone examples only. All prior scope remains.

# V3.2 normative sweep progress and recovery
Retains V3.1 SLA, actor, idempotency and lifecycle rules. This contract supersedes only the sweep implementation details in DOMAIN_CONTRACT and older docs; no new product scope. All times from PostgreSQL clock_timestamp(), floor to milliseconds. No public time override.

## Candidate selection and progress
At each batch snapshot, take distinct ticket IDs with at least one **unprocessed** due transition: WAITING with waitingCloseDueAt < snapshot; RESOLVED with reopenUntil < snapshot; or EXISTS clock with state RUNNING, currentLate=false, deadlineAt < snapshot. A recorded late clock must not qualify solely because its deadline is old. Paused breaches are reconciled synchronously during escalation; not sweep candidates. CurrentLate is persisted atomically with its breach event. Later policy revision may clear currentLate, making a new episode eligible at its revised deadline. Candidate query does not lock clock rows. Order by minimum qualifying due timestamp then ticket ID. Use bounded keyset batches (default 50 candidates; configurable), maximum 10 batches per invocation by default, and bounded elapsed time below host request limits. Advance cursor past every considered candidate including skipped locks/failed tickets; don't repeatedly select the head of the same batch. Recheck actual due eligibility after locking ticket; reconcile all due clocks and lifecycle for that ticket in one transaction. Only increment ticket version if actual state/clock changes; write audit and progress counters with those changes. Recheck existence of any qualifying due transition at finish without cursor; moreDue=true if backlog remains, including skipped/failed items still eligible. Next scheduled invocation begins from head; normal polling continues even if no work. Never treat moreDue as a failure or promise precise snapshot totals.

## Lease and fencing
Keep one SweepInvocation per actor-scoped key; unique key and request hash, immutable initiating actor/correlation; fresh random leaseToken per invocation, leaseUntil, state RUNNING/COMPLETED/FAILED, persisted counters, terminal result and HTTP status. Use a short configurable lease (default 30s) with bounded per-ticket statement/lock/transaction timeouts; refresh lease before each batch/transaction only when current lease still live. Each ticket transaction first locks **its own invocation row**, verifies RUNNING, token equality and fresh clock_timestamp() < leaseUntil, then locks ticket using FOR UPDATE SKIP LOCKED, then ordered clocks; this is a local per-invocation lock, never a global lock. No path acquires invocation row after ticket. Ordinary business transactions do not touch invocation row. Distinct invocations can overlap safely. A recovery transaction waits for that invocation row or skips it; committed business changes, audits and invocation counts survive crashes together. Before commit of a ticket transaction, check token/state and unexpired lease again using advancing DB time; on failure roll back that ticket transaction. Keep transactions bounded; no external I/O within them. Lease is not a guarantee against an arbitrarily delayed commit; row lock prevents recovery until that transaction ends, then subsequent work is fenced.

Reservation transaction writes START audit with actor, correlation, lease identity (do not expose token). Same-key same-hash RUNNING returns 409 SWEEP_IN_PROGRESS; changed hash always 409 IDEMPOTENCY_CONFLICT. Finish transaction locks invocation row, verifies RUNNING/token/live lease; conditionally transitions to COMPLETED, sets finishedAt/result/status=200 and writes FINISH audit atomically. On controlled operational failure while lease valid, transition FAILED, store safe 503 SWEEP_FAILED response and audit; replay returns identical terminal HTTP status/body. Expiry at now >= leaseUntil: before starting work, or on periodic recovery pass, lock expired RUNNING invocations with SKIP LOCKED in bounded stable order, recheck expiry using fresh DB time, transition FAILED, finishedAt=now, status=503 and error code SWEEP_LEASE_EXPIRED, audit SWEEP_RECOVERED once; preserve prior committed progress. Never resurrect an expired invocation or reuse its key; same-key same-hash retries replay stored failure, new key may start catch-up. An expired/terminal worker cannot renew, mutate further tickets or finalize. Scheduled runs use fresh keys per new invocation; recovery runs independently of browser requests. No global all-or-nothing sweep transaction.

Counters: processed counts tickets with committed transitions, autoClosed/expired/breachesRecorded count committed changes, failed counts processing failures recorded while lease valid (increment under invocation lock in separate transaction after rollback); skipped/no-op not counted as processed. Atomically persist per-ticket counters with domain updates. Terminal successful response uses existing SweepResult; terminal failure uses Error with stable requestId and safe error code; log correlation and audit counts, no lease token or private content. Report moreDue after final candidate check; scheduler rechecks on next tick regardless of flag. Recover stale invocations even if no due tickets remain.

## Acceptance tests (M4; host recovery M8)
- Backlog > one batch, several old already-recorded breaches earlier than fresh due tickets: all fresh work eventually processed, no duplicate breach audits, no starvation; bounded cap moreDue then next invocation drains.
- Two overlapping workers with separate connections: one transition per clock episode/closure, no duplicate audit, skip locked rows eventually revisited; counters reflect committed changes only.
- Crash after ticket commit before FINISH: recover expired invocation to FAILED once, same-key replay stable 503, new key catches up without duplicate events. Test zero-ticket expired invocation also recovers.
- Stale token, lease equality, and worker attempting renew/process/finish after recovery all fail without state overwrite. Controlled failure and changed-hash replay tested. Strict cutoff equality/+1ms and customer reply vs sweep remain mandatory.


# V3.2 normative safe audit payloads
The OpenAPI AuditEvent oneOf union binds action to an exact details shape; each branch denies undeclared properties. Use the corresponding safe DTO at write time and read time; validate internal event payloads before appending. Database details JSON is not a safe serialization source by itself. Customer routes never access audit. Unknown action or invalid historical payload fails closed (safe error; no raw JSON fallback). Every event records actor, correlation, reasonCode (controlled code or null), createdAt and target. Never store or expose message bodies, email, password hashes, session IDs, cookies, lease tokens or arbitrary user input in details. Timestamps use UTC ISO 8601; breach event recordedAt is actual insertion time, logical breachedAt is domain onset. All events of one logical mutation use same before/after version; initial creation version zero. Multiple events may share version and correlation; stable order createdAt/id; reconstruct by versions and semantic relationships, not UUID tie ordering as causal evidence.

## Ticket action vocabulary
- `TICKET_CREATED`: version, priority, initialMessageId, parentTicketId, clocks.
- `TICKET_CLAIMED`: beforeVersion, afterVersion, beforeStatus, afterStatus, assigneeId.
- `TICKET_REASSIGNED`: beforeVersion, afterVersion, previousAssigneeId, assigneeId.
- `MESSAGE_PUBLISHED`: beforeVersion, afterVersion, messageId, messageKind, publishedAt.
- `INTERNAL_NOTE_ADDED`: beforeVersion, afterVersion, messageId.
- `PRIORITY_CHANGED`: beforeVersion, afterVersion, previousPriority, newPriority, clocks.
- `SLA_PAUSED`: beforeVersion, afterVersion, clock, pausedAt, requestMessageId, waitingCloseDueAt.
- `SLA_RESUMED`: beforeVersion, afterVersion, clock, resumedAt, customerMessageId.
- `SLA_BREACHED`: beforeVersion, afterVersion, clock, breachedAt, recordedAt, missedDeadlineAt, cause.
- `SLA_COMPLETED`: beforeVersion, afterVersion, clock, completedAt, qualifyingMessageId.
- `SLA_CANCELLED`: beforeVersion, afterVersion, clock, cancelledAt, reason.
- `TICKET_WAITING`: beforeVersion, afterVersion, beforeStatus, afterStatus, waitingSince, waitingCloseDueAt.
- `TICKET_RESUMED`: beforeVersion, afterVersion, beforeStatus, afterStatus, customerMessageId.
- `TICKET_RESOLVED`: beforeVersion, afterVersion, beforeStatus, afterStatus, resolvedAt, reopenUntil.
- `TICKET_CLOSED`: beforeVersion, afterVersion, beforeStatus, afterStatus, closedAt, cutoffAt, closeReason.
- `TICKET_REOPENED`: beforeVersion, afterVersion, beforeStatus, afterStatus, resolutionCycle, newClock, customerMessageId.
- `LINKED_TICKET_CREATED`: beforeVersion, afterVersion, childTicketId, reason.

Clock snapshots include kind, cycle, state, budget, consumption, deadline, currentLate, episode and policy revision. Escalation and pause/resume use before/after snapshots. MESSAGE_PUBLISHED covers initial intake and public reply/request; logical publication timestamp is sampled mutation time, visibility after commit, not proof of external delivery. INTERNAL_NOTE_ADDED contains ID only. TICKET_WAITING and TICKET_RESUMED explicitly record ticket transitions in addition to clock changes. Reassignment remains optional. Linked-child event on parent refers to child and reason; before/after version match actual parent mutation (may be equal if no parent state change). Child receives TICKET_CREATED and MESSAGE_PUBLISHED. R11 and R12 require ordering and reconstruction tests.

## Sweep-target internal events (not returned from ticket audit endpoint)
Use separate strict write schemas with no unknown keys: SWEEP_STARTED {leaseUntil}; SWEEP_FINISHED {processed,autoClosed,expired,breachesRecorded,failed,moreDue}; SWEEP_FAILED {processed,autoClosed,expired,breachesRecorded,failed,errorCode}; SWEEP_RECOVERED {processed,autoClosed,expired,breachesRecorded,failed,errorCode,expiredLeaseAt}. Counts nonnegative integers; timestamps UTC; errorCode controlled enum SWEEP_FAILED or SWEEP_LEASE_EXPIRED as applicable. Actor SYSTEM for recovery; initiating identity remains in SweepInvocation and original START attribution. Do not expose lease token. Ticket transitions caused by scheduler have SYSTEM actor and invocation correlation. One START and one terminal event per invocation; use unique eventKey.

## Error boundary
Generic Error has only code, message, requestId. StaffClaimConflict is permitted only on authorized staff claim HTTP 409 and may contain assignedAgentDisplayName when a ticket actually has an assignee. Other errors including customer errors must not carry this field, via DTO and exception filter allowlists. Test unknown properties rejected; do not put restricted info in message text.


# V3.2 follow-up Codex audit corrections
Source: V3.1 follow-up design audit (READY WITH CORRECTIONS; report not published). Both earlier design blockers closed per reviewer. Original assessment unchanged; all V3.1 engineering scope retained. This revision deliberately restricts changes to the four remaining findings and their gates.
| Severity | Correction | Owner / actual verification pending |
|---|---|---|
| High | SWEEP_CONTRACT: unprocessed candidates, cursor/backlog progress, fenced lease recovery, terminal replay and durable counters; matching Prisma/SQL drafts | M1 migration; M2–M3 implementation; M4 crash/concurrency proofs; M8 host |
| High | Both staff ticket schemas: nullable enum includes null for requestedPriority and closeReason | M1 OpenAPI-aware validator; M4 actual HTTP contracts |
| Medium | Generic Error excludes assignee; staff-only claim conflict; action-bound strict audit DTO union and typed sweep audit writes | M3 implement; M4 negative and reconstruction tests; M5 UI |
| Medium | .env.example PUBLIC_ORIGIN and independently generated CSRF_SIGNING_KEY; startup validation and proxy gate | M1 config; M4 auth integration; M8 deployed proxy |

The scope remains M1–M8 and P0/P1/P2; do not restart a broad design audit. No new unrelated features, no removal of existing technologies. Local checks do not substitute for actual migrations, full OpenAPI conformance, runtime tests or deployment. See package-check-results.txt for actual evidence. Codex follow-up verdict applies to V3.1, not independently re-audited V3.2.


## V3.2 M1 startup and M8 proxy gate
Require PUBLIC_ORIGIN and CSRF_SIGNING_KEY in validated startup config; exact canonical origin including scheme and port (no path/query/fragment, no trailing slash), HTTPS in production, loopback HTTP only in development. JWT_SECRET and CSRF_SIGNING_KEY independently generated high-entropy secrets (at least 32 random bytes each, encoded); reject missing, placeholder, equal or malformed values. Never log them. .env.example contains placeholders only; document generation and provider configuration. Check actual proxy cookie paths and flags, Origin rejection including malicious/missing/null, valid CSRF, expired access refresh, token rotation/reuse, revocation and no-store on both success and errors in M4 integration and M8 deployed commit. Verify real host no caching and no accidental cross-origin behavior.


## V3.2 milestone assignments
## V3.2 follow-up audit assignments (mandatory)
- M1: read SWEEP_CONTRACT, AUDIT_PAYLOAD_CONTRACT and FOLLOWUP_AUDIT_RECONCILIATION; validate exact compatible toolchain and full OpenAPI 3.0 with OpenAPI-aware validator, representative response fixtures; Prisma validation, migration/roles/SQL checks including sweep progress constraints/index; startup env validation and scheduler/hosting feasibility.
- M2: implement sweep due candidate exclusion, cursor progress, lease recovery/fencing and exact cutoff semantics per SWEEP_CONTRACT.
- M3: persist durable progress and terminal status/replay, implement typed audit writes/reads and staff-only conflict projection, validate auth startup config and all mutation contracts.
- M4: actual PostgreSQL backlog, overlapping workers, crash/expiry/fencing and replay tests; strict API response fixtures, privacy/error payload and auth cookie/CSRF/revocation/no-store tests. Preserve all existing five proof gates.
- M5: verify safe audit UI reconstructs why late and publication; browser privacy and cache switch proof.
- M6–M7: retain P1 gates and optional P2 roadmap; no scope reductions.
- M8: exact deployed SHA evidence, real proxy cookie/Origin/CSRF/revocation/no-store, scheduler progression/recovery without browser traffic, deployment smoke and honest omissions. No proof by documentation alone.

## V3.2 evidence
Targeted fixtures passed (nullable ticket fields, invalid enum rejection, restricted claim error, typed audit action and secret rejection); 248 local references resolved; 23 paths; 44 schemas.
Not full OpenAPI-aware validation; Prisma/SQL/HTTP/browser/deployment remain unverified.
RTM: 24 entries, 5 columns.
Preserved byte-for-byte: docs/original-assessment.pdf; SHA256 05ec8583cd49b8a5a3d2f3d337e91bcc9ffd09dc28899575c52a5ef7b40e1739
Preserved byte-for-byte: src/calendar.mjs; SHA256 10ae8efd45f6604e8eacd44c8a3c3d0a5293e3c0316dcdc5c762b5d1bafb7c89
Preserved byte-for-byte: tests/calendar.test.mjs; SHA256 802ef9c403e45f40e930726a669b243ea28af51ae6bbeed47fddb92487693f11
Preserved byte-for-byte: tests/calendar-boundaries.test.mjs; SHA256 9c174a455a7f78b2c17b8ca1165aa87e4edb3bfc9ea83ed64464a3c9eb511aa9
Calendar suite: 12 pass, 0 fail (see calendar-test-results.txt).
