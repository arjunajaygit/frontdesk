import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { SweepAuditAction, SweepAuditDetails, validateSweepDetails } from '../../domain/sweep/sweep-events';
import {
  ERROR_MESSAGES,
  SweepCandidate,
  SweepCounters,
  SweepCursor,
  SweepState,
  decideReservation,
  isLeaseLive,
  isRecoverable,
} from '../../domain/sweep/sweep-policy';
import type {
  InvocationLease,
  SweepCandidateSource,
  SweepInvocationStore,
  TerminalOutcome,
} from '../../domain/sweep/sweep-runner';
import { Instant, fromDate, toIso } from '../../domain/shared/instant';

type Tx = Prisma.TransactionClient;

export type LeaseWriteOp = 'refresh' | 'failure' | 'finish' | 'fail' | 'progress';
export interface SweepStoreHooks {
  /** Runs after the invocation row lock is held and before the guarded lease write. */
  beforeLeaseWrite?: (op: LeaseWriteOp, tx: Prisma.TransactionClient) => Promise<void>;
}

/** Time budget for candidate scans (M04); never longer than this even when more invocation time remains. */
const MAX_SCAN_MS = 5_000;

export type SweepInitiator = { type: 'SYSTEM' } | { type: 'LEAD' | 'ADMIN'; id: string };

export type ReservationResult =
  | { kind: 'RESERVED'; lease: InvocationLease; correlationId: string }
  | { kind: 'REPLAY'; status: number; body: unknown }
  | { kind: 'CONFLICT'; status: 409; code: 'IDEMPOTENCY_CONFLICT' | 'SWEEP_IN_PROGRESS' };

interface InvocationRow {
  id: string;
  actorType: 'SYSTEM' | 'LEAD' | 'ADMIN';
  actorId: string | null;
  state: SweepState;
  requestHash: string;
  leaseToken: string;
  leaseUntil: Date;
  startedAt: Date;
  responseStatus: number | null;
  result: unknown;
  processed: number;
  autoClosed: number;
  expired: number;
  breachesRecorded: number;
  failed: number;
}

/** Bounded per-transaction timeouts: no unbounded waits while holding locks. */
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

async function bound(tx: Tx): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
}

const counters = (r: InvocationRow): SweepCounters => ({
  processed: r.processed,
  autoClosed: r.autoClosed,
  expired: r.expired,
  breachesRecorded: r.breachesRecorded,
  failed: r.failed,
});

/**
 * PostgreSQL invocation bookkeeping + candidate selection (SWEEP_CONTRACT). Times come from
 * clock_timestamp() truncated to ms; no caller-supplied time is ever trusted. Locks only the invocation
 * row (never global); the per-ticket processor (M3) calls `verifyLease` inside its own transaction.
 */
export class PgSweepStore implements SweepInvocationStore, SweepCandidateSource {
  constructor(
    private readonly db: PrismaClient,
    /** Test-only interleaving seam (never wired from configuration or HTTP). */
    private readonly hooks: SweepStoreHooks = {},
  ) {}

  async now(): Promise<Instant> {
    return dbNow(this.db);
  }

  // ------------------------------------------------------------------ candidates

  /** Distinct tickets with an unprocessed due transition, ordered (min due, id), keyset after cursor. */
  async selectCandidates(snapshot: Instant, after: SweepCursor | null, limit: number, budgetMs = MAX_SCAN_MS): Promise<SweepCandidate[]> {
    const snap = new Date(snapshot);
    const cursorFilter = after
      ? Prisma.sql`HAVING (min(d.due), d.id) > (${new Date(after.dueAt)}::timestamptz, ${after.ticketId}::text)`
      : Prisma.empty;
    const rows = await this.bounded(budgetMs, (tx) =>
      tx.$queryRaw<{ id: string; due: Date }[]>`
        SELECT d.id, min(d.due) AS due FROM (${this.dueUnion(snap)}) d
        GROUP BY d.id ${cursorFilter}
        ORDER BY min(d.due), d.id
        LIMIT ${limit}`,
    );
    return rows.map((r) => ({ ticketId: r.id, dueAt: fromDate(r.due) }));
  }

  async anyDue(snapshot: Instant, budgetMs = MAX_SCAN_MS): Promise<boolean> {
    const rows = await this.bounded(budgetMs, (tx) => tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM (${this.dueUnion(new Date(snapshot))}) d LIMIT 1`);
    return rows.length > 0;
  }

  /**
   * Read-only scan under transaction-local statement/lock timeouts derived from the remaining invocation
   * budget (M04): a blocked scan fails fast (57014/55P03) instead of pinning the scheduler.
   */
  private bounded<T>(budgetMs: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ms = String(Math.max(50, Math.min(MAX_SCAN_MS, Math.floor(budgetMs))));
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${ms}, true), set_config('lock_timeout', ${ms}, true)`;
        return fn(tx);
      },
      { ...TX_OPTIONS, timeout: MAX_SCAN_MS + 2_000 },
    );
  }

  /** Index-friendly union; each branch matches one of the M1 indexes (incl. partial sla_unprocessed_due_idx). */
  private dueUnion(snap: Date): Prisma.Sql {
    return Prisma.sql`
      SELECT t.id::text AS id, t."waitingCloseDueAt" AS due FROM "Ticket" t
        WHERE t.status = 'WAITING' AND t."waitingCloseDueAt" < ${snap}
      UNION ALL
      SELECT t.id::text, t."reopenUntil" FROM "Ticket" t
        WHERE t.status = 'RESOLVED' AND t."reopenUntil" < ${snap}
      UNION ALL
      SELECT c."ticketId"::text, c."deadlineAt" FROM "SlaClock" c
        WHERE c.state = 'RUNNING' AND c."currentLate" = false AND c."deadlineAt" < ${snap}`;
  }

  // ------------------------------------------------------------------ reservation

  async reserve(args: {
    initiator: SweepInitiator;
    key: string;
    requestHash: string;
    correlationId: string;
    leaseMs: number;
  }): Promise<ReservationResult> {
    const { initiator, key, requestHash, correlationId, leaseMs } = args;
    return this.db.$transaction(async (tx) => {
      await bound(tx);
      const id = newId();
      const token = randomBytes(32).toString('base64url');
      const actorId = initiator.type === 'SYSTEM' ? null : initiator.id;
      const inserted = await tx.$queryRaw<{ id: string; leaseUntil: Date }[]>`
        INSERT INTO "SweepInvocation" (id, "actorId", "actorType", key, "requestHash", state, "startedAt", "leaseUntil", "leaseToken")
        SELECT ${id}, ${actorId}, ${initiator.type}::"ActorType", ${key}, ${requestHash}, 'RUNNING',
               n.now, n.now + make_interval(secs => ${leaseMs}::double precision / 1000), ${token}
        FROM (SELECT date_trunc('milliseconds', clock_timestamp()) AS now) n
        ON CONFLICT (key) DO NOTHING
        RETURNING id, "leaseUntil"`;
      const row = inserted[0];
      if (row) {
        await this.appendAudit(tx, row.id, initiator, correlationId, 'SWEEP_STARTED', { leaseUntil: toIso(fromDate(row.leaseUntil)) }, 'start');
        return { kind: 'RESERVED', lease: { id: row.id, token }, correlationId };
      }
      // Same key: wait for the holder's row lock, then decide deterministically.
      const existing = await this.lockByKey(tx, key);
      const now = await dbNow(tx); // sampled AFTER the lock wait
      const decision = decideReservation(
        existing && {
          state: existing.state,
          requestHash: existing.requestHash,
          leaseUntil: fromDate(existing.leaseUntil),
          responseStatus: existing.responseStatus,
          result: existing.result,
        },
        requestHash,
        now,
      );
      switch (decision.kind) {
        case 'CONFLICT':
        case 'IN_PROGRESS':
          return { kind: 'CONFLICT', status: 409, code: decision.code };
        case 'REPLAY':
          return { kind: 'REPLAY', status: decision.status, body: decision.body };
        case 'RECOVER_THEN_REPLAY': {
          if (!existing) throw new Error('invariant: recovery decision without invocation');
          const recovered = await this.recoverLocked(tx, existing);
          if (!recovered) return { kind: 'CONFLICT', status: 409, code: 'SWEEP_IN_PROGRESS' };
          return { kind: 'REPLAY', status: recovered.status, body: recovered.body };
        }
        case 'RESERVE':
          throw new Error('invariant: conflicting insert but no existing invocation');
      }
    }, TX_OPTIONS);
  }

  // ------------------------------------------------------------------ fencing

  /**
   * Lease predicate evaluated INSIDE the write statement (H01): identity, RUNNING, token equality and the
   * statement's own advancing clock_timestamp() strictly before leaseUntil (equality = expired).
   */
  private leaseGuard(lease: InvocationLease): Prisma.Sql {
    return Prisma.sql`id = ${lease.id} AND state = 'RUNNING' AND "leaseToken" = ${lease.token} AND clock_timestamp() < "leaseUntil"`;
  }

  /**
   * Early check at the start of a ticket transaction: lock this invocation row (invocation -> ticket order)
   * and verify the lease with fresh DB time sampled after the lock is held. Advisory only: every durable
   * write is additionally fenced by `leaseGuard` in the writing statement itself.
   */
  async verifyLease(tx: Tx, lease: InvocationLease): Promise<InvocationRow | null> {
    const row = await this.lockById(tx, lease.id);
    if (!row) return null;
    const now = await dbNow(tx);
    return isLeaseLive({ state: row.state, leaseToken: row.leaseToken, leaseUntil: fromDate(row.leaseUntil) }, lease.token, now)
      ? row
      : null;
  }

  /** Lock row, then one guarded UPDATE; affected-row count decides. Never writes for a stale/expired worker. */
  private async guarded(tx: Tx, op: LeaseWriteOp, lease: InvocationLease, set: Prisma.Sql): Promise<InvocationRow | null> {
    if (!(await this.lockById(tx, lease.id))) return null;
    await this.hooks.beforeLeaseWrite?.(op, tx);
    const rows = await tx.$queryRaw<InvocationRow[]>`
      UPDATE "SweepInvocation" SET ${set} WHERE ${this.leaseGuard(lease)} RETURNING ${this.columns()}`;
    return rows[0] ?? null;
  }

  /** Renew only while the current lease is still live; an expired/recovered worker cannot renew. */
  async refreshLease(lease: InvocationLease, leaseMs: number): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await bound(tx);
      const row = await this.guarded(
        tx,
        'refresh',
        lease,
        Prisma.sql`"leaseUntil" = date_trunc('milliseconds', clock_timestamp()) + make_interval(secs => ${leaseMs}::double precision / 1000)`,
      );
      return row !== null;
    }, TX_OPTIONS);
  }

  /** Failed ticket transaction (already rolled back): count it under the invocation lock while leased. */
  async recordFailure(lease: InvocationLease): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await bound(tx);
      return (await this.guarded(tx, 'failure', lease, Prisma.sql`failed = failed + 1`)) !== null;
    }, TX_OPTIONS);
  }

  /**
   * Final fence of a ticket transaction: persist per-ticket counters only if the lease is still live at this
   * statement. Returns false => the caller MUST roll back its ticket transaction.
   */
  async commitTicketProgress(tx: Tx, lease: InvocationLease, c: { autoClosed: number; expired: number; breachesRecorded: number }): Promise<boolean> {
    await this.hooks.beforeLeaseWrite?.('progress', tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "SweepInvocation"
      SET processed = processed + 1, "autoClosed" = "autoClosed" + ${c.autoClosed}, expired = expired + ${c.expired},
          "breachesRecorded" = "breachesRecorded" + ${c.breachesRecorded}
      WHERE ${this.leaseGuard(lease)} RETURNING id`;
    return rows.length === 1;
  }

  // ------------------------------------------------------------------ terminal transitions

  /** Terminal state + FINISH audit in one transaction; the state change is lease-guarded, the audit follows it. */
  async finish(lease: InvocationLease, moreDue: boolean): Promise<TerminalOutcome> {
    return this.db.$transaction(async (tx) => {
      await bound(tx);
      const correlationId = await this.correlationOf(tx, lease.id).catch(() => null);
      if (correlationId === null) return { kind: 'FENCED' } as const;
      const row = await this.guarded(
        tx,
        'finish',
        lease,
        Prisma.sql`state = 'COMPLETED', "finishedAt" = date_trunc('milliseconds', clock_timestamp()), "responseStatus" = 200,
          result = jsonb_build_object('invocationId', id, 'correlationId', ${correlationId}::text, 'processed', processed,
            'autoClosed', "autoClosed", 'expired', expired, 'breachesRecorded', "breachesRecorded", 'failed', failed,
            'moreDue', ${moreDue}::boolean)`,
      );
      if (!row) return { kind: 'FENCED' } as const;
      const c = counters(row);
      await this.appendAudit(tx, row.id, initiatorOf(row), correlationId, 'SWEEP_FINISHED', { ...c, moreDue }, 'terminal');
      return { kind: 'COMPLETED', status: 200, body: row.result } as const;
    }, TX_OPTIONS);
  }

  /** Controlled operational failure while the lease is still valid: safe stored 503. */
  async fail(lease: InvocationLease, code: 'SWEEP_FAILED'): Promise<TerminalOutcome> {
    return this.db.$transaction(async (tx) => {
      await bound(tx);
      const correlationId = await this.correlationOf(tx, lease.id).catch(() => null);
      if (correlationId === null) return { kind: 'FENCED' } as const;
      const body = { code, message: ERROR_MESSAGES[code], requestId: correlationId };
      const row = await this.guarded(
        tx,
        'fail',
        lease,
        Prisma.sql`state = 'FAILED', "finishedAt" = date_trunc('milliseconds', clock_timestamp()), "responseStatus" = 503,
          result = ${JSON.stringify(body)}::jsonb`,
      );
      if (!row) return { kind: 'FENCED' } as const;
      await this.appendAudit(tx, row.id, initiatorOf(row), correlationId, 'SWEEP_FAILED', { ...counters(row), errorCode: code }, 'terminal');
      return { kind: 'FAILED', status: 503, body, code } as const;
    }, TX_OPTIONS);
  }

  /**
   * Terminalise expired RUNNING invocations (bounded, stable order, SKIP LOCKED). Recheck expiry with fresh
   * DB time under the row lock; prior committed counters are preserved; one SWEEP_RECOVERED per invocation.
   */
  async recoverExpired(limit: number): Promise<number> {
    return this.db.$transaction(async (tx) => {
      await bound(tx);
      const rows = await tx.$queryRaw<InvocationRow[]>`
        SELECT ${this.columns()} FROM "SweepInvocation"
        WHERE state = 'RUNNING' AND "leaseUntil" <= clock_timestamp()
        ORDER BY "leaseUntil", id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`;
      let recovered = 0;
      for (const row of rows) {
        const now = await dbNow(tx); // recheck expiry with fresh DB time under the lock
        if (!isRecoverable({ state: row.state, leaseUntil: fromDate(row.leaseUntil) }, now)) continue;
        if (await this.recoverLocked(tx, row)) recovered++;
      }
      return recovered;
    }, TX_OPTIONS);
  }

  // ------------------------------------------------------------------ internals

  /** Guarded terminalisation (expiry re-evaluated in the statement); returns null if not (or no longer) expired. */
  private async recoverLocked(tx: Tx, row: InvocationRow): Promise<{ status: 503; body: unknown } | null> {
    const correlationId = await this.correlationOf(tx, row.id);
    const body = { code: 'SWEEP_LEASE_EXPIRED', message: ERROR_MESSAGES.SWEEP_LEASE_EXPIRED, requestId: correlationId };
    const updated = await tx.$executeRaw`
      UPDATE "SweepInvocation"
      SET state = 'FAILED', "finishedAt" = greatest(date_trunc('milliseconds', clock_timestamp()), "startedAt"),
          "responseStatus" = 503, result = ${JSON.stringify(body)}::jsonb
      WHERE id = ${row.id} AND state = 'RUNNING' AND "leaseUntil" <= clock_timestamp()`;
    if (updated !== 1) return null;
    await this.appendAudit(
      tx,
      row.id,
      { type: 'SYSTEM' },
      correlationId,
      'SWEEP_RECOVERED',
      { ...counters(row), errorCode: 'SWEEP_LEASE_EXPIRED', expiredLeaseAt: toIso(fromDate(row.leaseUntil)) },
      'terminal',
    );
    return { status: 503, body };
  }

  private columns(): Prisma.Sql {
    return Prisma.sql`id::text AS id, "actorType"::text AS "actorType", "actorId"::text AS "actorId", state::text AS state,
      "requestHash", "leaseToken", "leaseUntil", "startedAt", "responseStatus", result,
      processed, "autoClosed", expired, "breachesRecorded", failed`;
  }

  private async lockById(tx: Tx, id: string): Promise<InvocationRow | null> {
    const rows = await tx.$queryRaw<InvocationRow[]>`SELECT ${this.columns()} FROM "SweepInvocation" WHERE id = ${id} FOR UPDATE`;
    return rows[0] ?? null;
  }

  private async lockByKey(tx: Tx, key: string): Promise<InvocationRow | null> {
    const rows = await tx.$queryRaw<InvocationRow[]>`SELECT ${this.columns()} FROM "SweepInvocation" WHERE key = ${key} FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** Initiating correlation is immutable in the START audit row (no separate column needed). */
  async correlationOf(tx: Tx, invocationId: string): Promise<string> {
    const rows = await tx.$queryRaw<{ correlationId: string }[]>`
      SELECT "correlationId" FROM audit_logs WHERE "sweepId" = ${invocationId} AND action = 'SWEEP_STARTED' LIMIT 1`;
    const c = rows[0]?.correlationId;
    if (!c) throw new Error('invariant: invocation without START audit');
    return c;
  }

  private async appendAudit<A extends SweepAuditAction>(
    tx: Tx,
    invocationId: string,
    actor: SweepInitiator,
    correlationId: string,
    action: A,
    details: SweepAuditDetails<A>,
    slot: 'start' | 'terminal',
  ): Promise<void> {
    const safe = validateSweepDetails(action, details); // fails closed on unknown fields
    const actorId = actor.type === 'SYSTEM' ? null : actor.id;
    // Unique eventKey guarantees exactly one START and one terminal event per invocation.
    await tx.$executeRaw`
      INSERT INTO audit_logs (id, target, "sweepId", "correlationId", "reasonCode", "actorType", "actorId", action, details, "eventKey", "createdAt")
      VALUES (${newId()}, 'SWEEP', ${invocationId}, ${correlationId}, NULL, ${actor.type}::"ActorType", ${actorId},
              ${action}, ${JSON.stringify(safe)}::jsonb, ${`sweep:${invocationId}:${slot}`}, date_trunc('milliseconds', clock_timestamp()))`;
  }
}

function initiatorOf(row: InvocationRow): SweepInitiator {
  if (row.actorType === 'SYSTEM' || row.actorId === null) return { type: 'SYSTEM' };
  return { type: row.actorType, id: row.actorId };
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

export async function dbNow(db: Tx | PrismaClient): Promise<Instant> {
  const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  if (!row) throw new Error('clock query returned no row');
  return fromDate(row.now);
}
