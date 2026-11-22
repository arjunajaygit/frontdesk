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
