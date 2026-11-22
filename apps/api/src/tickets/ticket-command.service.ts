import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Priority } from '@frontdesk/contracts';
import { AppError, Errors } from '../common/app-error';
import { CalendarProvider } from '../calendar/calendar.provider';
import { DomainError } from '../domain/shared/domain-error';
import type { Instant } from '../domain/shared/instant';
import type { CustomerContactResult, MutationResult, TicketLifecycle } from '../domain/ticket/ticket-lifecycle';
import type { TicketAggregate } from '../domain/ticket/ticket.types';
import { aggregateFromRows } from '../infrastructure/persistence/ticket-mapper';
import { type Principal, toActor } from '../auth/principal';
import { IdempotencyService, requestHash } from './idempotency.service';
import { TicketRepository } from './ticket.repository';
import { TicketViews } from './ticket.views';
import { type Tx, UnitOfWork } from './unit-of-work';
import { type CommandOutcome as MetricOutcome, MetricsService } from '../observability/metrics.service';

export interface CommandContext {
  principal: Principal;
  /** Route template, e.g. "POST /tickets/{id}/replies" (part of the idempotency scope). */
  operation: string;
  idempotencyKey: string;
  requestId: string;
}

export interface CommandOutcome {
  status: number;
  body: unknown;
}

type Locked = { agg: TicketAggregate; now: Instant };

/**
 * Re-authorises a stored outcome against CURRENT state before it is released (M01). It never re-runs the
 * historical transition; it only proves the caller may still see every resource the stored body exposes.
 */
type ReplayGuard = (tx: Tx, storedBody: unknown) => Promise<void>;

const idOf = (v: unknown, path: 'id' | 'ticket.id'): string | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const x = path === 'id' ? o.id : (o.ticket as Record<string, unknown> | undefined)?.id;
  return typeof x === 'string' ? x : null;
};

/**
 * Application service: authorisation context, transaction boundary, idempotency, locking, domain call,
 * persistence, audit and stored outcome — in that order, in ONE transaction. Business rules live only in the
 * domain TicketLifecycle; this class never re-implements them.
 */
@Injectable()
export class TicketCommandService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: TicketRepository,
    private readonly idem: IdempotencyService,
    private readonly views: TicketViews,
    private readonly calendars: CalendarProvider,
    private readonly metrics: MetricsService,
  ) {}

  // ------------------------------------------------------------------ intake

  staffIntake(ctx: CommandContext, input: { customerId: string; subject: string; body: string; priority: Priority }) {
    return this.mutate(ctx, null, input, this.staffCanRead(), async (tx, lc) => {
      const customer = await tx.user.findUnique({ where: { id: input.customerId }, select: { role: true } });
      if (!customer || customer.role !== 'CUSTOMER') throw Errors.badRequest('UNKNOWN_CUSTOMER', 'customerId does not identify a customer.');
      const now = await this.repo.dbNow(tx);
      const r = this.domain(() => lc.staffIntake({ actor: toActor(ctx.principal), ...input, now }));
      await this.repo.insertNew(tx, r, ctx.requestId);
      return { status: 201, body: await this.views.staffTicket(tx, r.aggregate.ticket.id, now, ctx.principal.userId) };
    });
  }

  customerIntake(ctx: CommandContext, input: { subject: string; body: string; requestedPriority?: Priority | null }) {
    return this.mutate(ctx, null, input, this.customerOwns(ctx, (b) => [idOf(b, 'id')]), async (tx, lc) => {
      const now = await this.repo.dbNow(tx);
      const r = this.domain(() => lc.customerIntake({ actor: toActor(ctx.principal), ...input, now }));
      await this.repo.insertNew(tx, r, ctx.requestId);
      return { status: 201, body: await this.views.publicTicket(tx, ctx.principal.userId, r.aggregate.ticket.id) };
    });
  }

  // ------------------------------------------------------------------ staff commands

  /** INC-0291: the ticket row lock + version/assignee-guarded UPDATE make the claim exclusive; one audit event. */
  claim(ctx: CommandContext, ticketId: string) {
    return this.staffCommand(ctx, ticketId, {}, 'read', (lc, l) => {
      try {
        return lc.claim(l.agg, toActor(ctx.principal), l.now);
      } catch (e) {
        if (e instanceof DomainError && e.code === 'ALREADY_CLAIMED') throw new ClaimLost(l.agg.ticket.assigneeId);
        throw e;
      }
    }, { assigneeId: null, status: 'OPEN' });
  }

  reply(ctx: CommandContext, ticketId: string, body: string) {
    return this.staffCommand(ctx, ticketId, { body }, 'assignee', (lc, l) => lc.publicReply(l.agg, toActor(ctx.principal), body, l.now));
  }

  note(ctx: CommandContext, ticketId: string, body: string) {
    return this.staffCommand(ctx, ticketId, { body }, 'assignee', (lc, l) => lc.addNote(l.agg, toActor(ctx.principal), body, l.now));
  }

  requestInformation(ctx: CommandContext, ticketId: string, body: string) {
    return this.staffCommand(ctx, ticketId, { body }, 'assignee', (lc, l) => lc.requestInformation(l.agg, toActor(ctx.principal), body, l.now));
  }

  resolve(ctx: CommandContext, ticketId: string, body: string | undefined) {
    return this.staffCommand(ctx, ticketId, body === undefined ? {} : { body }, 'assignee', (lc, l) => lc.resolve(l.agg, toActor(ctx.principal), body, l.now));
  }

  changePriority(ctx: CommandContext, ticketId: string, priority: Priority) {
    return this.staffCommand(ctx, ticketId, { priority }, 'assignee', (lc, l) => lc.changePriority(l.agg, toActor(ctx.principal), priority, l.now));
  }

  // ------------------------------------------------------------------ customer commands

  customerReply(ctx: CommandContext, ticketId: string, body: string) {
    return this.customerContact(ctx, ticketId, body, (lc, l) => lc.customerReply(l.agg, toActor(ctx.principal), body, l.now));
  }

  customerReopen(ctx: CommandContext, ticketId: string, body: string) {
    return this.customerContact(ctx, ticketId, body, (lc, l) => lc.customerReopen(l.agg, toActor(ctx.principal), body, l.now));
  }

  // ------------------------------------------------------------------ internals

  private staffCommand(
    ctx: CommandContext,
    ticketId: string,
    body: object,
    replayAccess: 'read' | 'assignee',
    run: (lc: TicketLifecycle, l: Locked) => MutationResult,
    guard: Prisma.TicketWhereInput = {},
  ): Promise<CommandOutcome> {
    const replayGuard = replayAccess === 'assignee' ? this.stillAssignee(ctx, ticketId) : this.staffCanRead(ticketId);
    return this.mutate(ctx, ticketId, body, replayGuard, async (tx, lc) => {
      const l = await this.lock(tx, ticketId);
      let r: MutationResult;
      try {
        r = this.domain(() => run(lc, l));
      } catch (e) {
        if (e instanceof ClaimLost) {
          const assignee = e.assigneeId ? await tx.user.findUnique({ where: { id: e.assigneeId }, select: { displayName: true } }) : null;
          throw new AppError(409, 'CLAIM_CONFLICT', 'This ticket has already been claimed.', assignee?.displayName);
        }
        throw e;
      }
      await this.repo.persist(tx, l.agg, r, ctx.requestId, guard);
      return { status: 200, body: await this.views.staffTicket(tx, ticketId, Math.max(l.now, r.aggregate.ticket.updatedAt), ctx.principal.userId) };
    });
  }

  private customerContact(
    ctx: CommandContext,
    ticketId: string,
    body: string,
    run: (lc: TicketLifecycle, l: Locked) => CustomerContactResult,
  ): Promise<CommandOutcome> {
    const replayGuard = this.customerOwns(ctx, (b) => [ticketId, idOf(b, 'ticket.id')]);
    return this.mutate(ctx, ticketId, { body }, replayGuard, async (tx, lc) => {
      // Ownership is part of the lock predicate: foreign tickets are never locked (H02).
      const l = await this.lock(tx, ticketId, ctx.principal.userId);
      const r = this.domain(() => run(lc, l));
      if (r.outcome === 'SAME_TICKET') {
        await this.repo.persist(tx, l.agg, r.result, ctx.requestId);
        const ticket = await this.views.publicTicket(tx, ctx.principal.userId, ticketId);
        return { status: 200, body: { outcome: 'SAME_TICKET', ticket, previousTicketId: null } };
      }
      // Parent reconciliation (if any) + link event, then the child, all in this transaction.
      await this.repo.persist(tx, l.agg, r.previous, ctx.requestId);
      await this.repo.insertNew(tx, r.child, ctx.requestId);
      const ticket = await this.views.publicTicket(tx, ctx.principal.userId, r.child.aggregate.ticket.id);
      return { status: 201, body: { outcome: 'NEW_LINKED_TICKET', ticket, previousTicketId: ticketId } };
    });
  }

  /** ticket FOR UPDATE -> fresh DB time -> ordered clock locks (DOMAIN_CONTRACT). Unknown ticket => 404. */
  private async lock(tx: Tx, ticketId: string, customerId?: string): Promise<Locked> {
    const row = await this.repo.lockTicket(tx, ticketId, { customerId });
    if (!row) throw Errors.notFound();
    const now = await this.repo.dbNow(tx);
    const clocks = await this.repo.lockClocks(tx, ticketId);
    return { agg: aggregateFromRows(row, clocks), now };
  }

  /** Idempotency reservation FIRST, then the work, then the stored outcome — all in one transaction. */
  private mutate(
    ctx: CommandContext,
    resource: string | null,
    body: unknown,
    replayGuard: ReplayGuard,
    work: (tx: Tx, lc: TicketLifecycle) => Promise<CommandOutcome>,
  ): Promise<CommandOutcome> {
    const hash = requestHash(ctx.operation, resource, body);
    let replayed = false;
    // Outcome metric is recorded AFTER the transaction settles: success means committed; replays never re-count.
    return this.uow
      .run(async (tx) => {
        replayed = false;
        const res = await this.idem.reserve(tx, { actorId: ctx.principal.userId, operation: ctx.operation, key: ctx.idempotencyKey, requestHash: hash });
        if (res.kind === 'REPLAY') {
          await replayGuard(tx, res.body); // current authorisation BEFORE releasing the stored outcome
          replayed = true;
          return { status: res.status, body: res.body };
        }
        const out = await work(tx, this.calendars.lifecycle());
        await this.idem.complete(tx, res.id, out.status, out.body);
        return out;
      })
      .then(
        (out) => {
          this.metrics.command(ctx.operation, replayed ? 'replayed' : 'success');
          return out;
        },
        (e: unknown) => {
          this.metrics.command(ctx.operation, outcomeOf(e));
          throw e;
        },
      );
  }

  // ------------------------------------------------------------------ replay guards (M01)

  /** Staff share one support team: replay needs the ticket to still exist (staff read access). */
  private staffCanRead(ticketId?: string): ReplayGuard {
    return async (tx, stored) => {
      const id = ticketId ?? idOf(stored, 'id');
      if (!id || !(await tx.ticket.findUnique({ where: { id }, select: { id: true } }))) throw Errors.notFound();
    };
  }

  /** Assignee-restricted operations replay only to the CURRENT assignee. */
  private stillAssignee(ctx: CommandContext, ticketId: string): ReplayGuard {
    return async (tx) => {
      const t = await tx.ticket.findUnique({ where: { id: ticketId }, select: { assigneeId: true } });
      if (!t) throw Errors.notFound();
      if (t.assigneeId !== ctx.principal.userId) throw new DomainError('NOT_ASSIGNEE', 'not the assignee');
    };
  }

  /** Customer replays expose only tickets (incl. a linked child) the caller owns NOW; otherwise 404. */
  private customerOwns(ctx: CommandContext, ids: (stored: unknown) => (string | null)[]): ReplayGuard {
    return async (tx, stored) => {
      const wanted = [...new Set(ids(stored).filter((x): x is string => x !== null))];
      if (!wanted.length) throw Errors.notFound();
      const owned = await tx.ticket.count({ where: { id: { in: wanted }, customerId: ctx.principal.userId } });
      if (owned !== wanted.length) throw Errors.notFound();
    };
  }

  private domain<T>(fn: () => T): T {
    return fn(); // DomainErrors propagate; the exception filter maps their kind to 400/403/404/409.
  }
}

function outcomeOf(e: unknown): MetricOutcome {
  const status = e instanceof AppError ? e.status : e instanceof DomainError ? (e.kind === 'CONFLICT' ? 409 : 400) : 500;
  if (status === 409) return 'conflict';
  if (status === 503) return 'busy';
  return status < 500 ? 'rejected' : 'error';
}

class ClaimLost extends Error {
  constructor(readonly assigneeId: string | null) {
    super('claim lost');
  }
}
