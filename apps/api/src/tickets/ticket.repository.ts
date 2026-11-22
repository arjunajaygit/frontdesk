import { Injectable } from '@nestjs/common';
import type { Prisma, SlaClock as ClockRow, Ticket as TicketRow } from '@prisma/client';
import type { MutationResult } from '../domain/ticket/ticket-lifecycle';
import type { TicketAggregate } from '../domain/ticket/ticket.types';
import { fromDate, type Instant } from '../domain/shared/instant';
import { clockToRow, messageToRow, ticketToRow } from '../infrastructure/persistence/ticket-mapper';
import { AuditWriter } from './audit.writer';
import type { Tx } from './unit-of-work';

export class ConcurrentModificationError extends Error {}

/**
 * Lock order for ordinary commands (DOMAIN_CONTRACT): [idempotency] -> ticket FOR UPDATE -> sample DB time ->
 * clocks FOR UPDATE ordered (cycle, kind, id) -> append-only writes. Clocks are never locked before the ticket.
 */
@Injectable()
export class TicketRepository {
  constructor(private readonly audit: AuditWriter) {}

  /**
   * Lock a ticket row. With `customerId`, ownership is part of the lock predicate (H02): a foreign ticket fails
   * the qualifier and is never locked or waited on, so busy-foreign and nonexistent are indistinguishable.
   */
  async lockTicket(tx: Tx, id: string, scope: { customerId?: string } = {}): Promise<TicketRow | null> {
    const owner = scope.customerId ?? null;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Ticket" WHERE id = ${id} AND (${owner}::text IS NULL OR "customerId" = ${owner}::text) FOR UPDATE`;
    return rows.length ? tx.ticket.findUnique({ where: { id } }) : null;
  }

  /** Sweep variant: never waits on a busy ticket. */
  async lockTicketSkipLocked(tx: Tx, id: string): Promise<TicketRow | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Ticket" WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    return rows.length ? tx.ticket.findUnique({ where: { id } }) : null;
  }

  async lockClocks(tx: Tx, ticketId: string): Promise<ClockRow[]> {
    await tx.$queryRaw`SELECT id FROM "SlaClock" WHERE "ticketId" = ${ticketId} ORDER BY cycle, kind, id FOR UPDATE`;
    return tx.slaClock.findMany({ where: { ticketId }, orderBy: [{ cycle: 'asc' }, { kind: 'asc' }, { id: 'asc' }] });
  }

  /** Fresh, advancing authoritative time (floor to ms), sampled after the ticket lock is held. */
  async dbNow(tx: Tx): Promise<Instant> {
    const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    return fromDate(row!.now);
  }

  /** Persist one aggregate's mutation; the ticket update is version-guarded (belt and braces under the lock). */
  async persist(tx: Tx, before: TicketAggregate, r: MutationResult, correlationId: string, guard: Prisma.TicketWhereInput = {}): Promise<void> {
    if (r.changed) {
      const { id: _id, customerId: _c, subject: _s, createdAt: _ca, ...data } = ticketToRow(r.aggregate.ticket);
      const updated = await tx.ticket.updateMany({ where: { ...guard, id: before.ticket.id, version: before.ticket.version }, data });
      if (updated.count !== 1) throw new ConcurrentModificationError('ticket changed concurrently');
      const prior = new Map(before.clocks.map((c) => [c.id, c]));
      for (const c of r.aggregate.clocks) {
        const old = prior.get(c.id);
        if (!old) await tx.slaClock.create({ data: clockToRow(c) });
        else if (JSON.stringify(old) !== JSON.stringify(c)) {
          const { id, ticketId: _t, ...fields } = clockToRow(c);
          await tx.slaClock.update({ where: { id: id! }, data: fields });
        }
      }
    }
    if (r.messages.length) await tx.message.createMany({ data: r.messages.map(messageToRow) });
    await this.audit.appendTicketEvents(tx, r.events, correlationId, r.aggregate.ticket.priority);
  }

  /** Atomic intake / linked child: ticket + initial public message + both clocks + audit. */
  async insertNew(tx: Tx, r: MutationResult, correlationId: string): Promise<void> {
    await tx.ticket.create({ data: ticketToRow(r.aggregate.ticket) });
    await tx.slaClock.createMany({ data: r.aggregate.clocks.map(clockToRow) });
    await tx.message.createMany({ data: r.messages.map(messageToRow) });
    await this.audit.appendTicketEvents(tx, r.events, correlationId, r.aggregate.ticket.priority);
  }
}
