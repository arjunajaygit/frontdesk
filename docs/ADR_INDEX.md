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
