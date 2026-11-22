# Sequence and class views
```mermaid
sequenceDiagram
 participant A as Agent A
 participant B as Agent B
 participant API
 participant DB
 A->>API: claim ticket
 B->>API: claim same ticket
 API->>DB: BEGIN / conditional UPDATE A
 API->>DB: append audit / COMMIT
 DB-->>API: 1 row
 API-->>A: 200
 API->>DB: conditional UPDATE B
 DB-->>API: 0 rows
 API-->>B: 409
```
```mermaid
sequenceDiagram
 participant J as Scheduler
 participant DB
 participant C as Customer
 J->>DB: lock due ticket / recheck
 C->>DB: reply use case waits for ticket lock
 J->>DB: close + audit / commit if overdue
 C->>DB: recheck state; new ticket if closed
```
```mermaid
classDiagram
 class Clock { +now() Instant }
 class BusinessCalendar { +add(start, minutes) Instant }
 class SlaPolicy { +budget(priority, kind) number }
 class TicketUseCase { +claim(id, actor) Ticket }
 class TicketRepository { +lock(id, tx) Ticket }
 class AuditWriter { +append(event, tx) }
 class UnitOfWork { +run(fn) }
 TicketUseCase --> Clock
 TicketUseCase --> BusinessCalendar
 TicketUseCase --> SlaPolicy
 TicketUseCase --> TicketRepository
 TicketUseCase --> AuditWriter
 TicketUseCase --> UnitOfWork
```
