import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { fromDate, type Instant } from '../domain/shared/instant';
import { Errors } from '../common/app-error';
import type { Principal } from '../auth/principal';
import { PrismaService } from '../prisma/prisma.service';
import { AuditPayloadError, AuditValidator } from './audit.writer';
import { CursorCodec } from './cursor';
import { TicketViews, toCsv } from './ticket.views';

export interface StaffListQuery {
  limit: number;
  cursor?: string;
  scope: 'ALL' | 'MINE' | 'UNASSIGNED';
  status?: 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'RESOLVED' | 'CLOSED';
  priority?: 'URGENT' | 'MEDIUM' | 'LOW';
  late?: boolean;
}

/** Read side. GETs never write: no transactions, no audit, no reconciliation — projections only. */
@Injectable()
export class TicketQueryService {
  constructor(
    private readonly db: PrismaService,
    private readonly views: TicketViews,
    private readonly cursors: CursorCodec,
    private readonly validator: AuditValidator,
  ) {}

  private async now(): Promise<Instant> {
    const [row] = await this.db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    return fromDate(row!.now);
  }

  /** Newest first, keyset (createdAt, id) with a signed cursor scoped to actor + filters. */
  async staffList(p: Principal, q: StaffListQuery) {
    const asOf = await this.now();
    const scope = { a: p.userId, scope: q.scope, status: q.status ?? null, priority: q.priority ?? null, late: q.late ?? null };
    const pos = this.cursors.decode(scope, q.cursor);
    const lateClock: Prisma.SlaClockWhereInput = {
      OR: [{ state: { in: ['RUNNING', 'PAUSED'] }, currentLate: true }, { state: 'RUNNING', deadlineAt: { lt: new Date(asOf) } }],
    };
    const where: Prisma.TicketWhereInput = {
      ...(q.scope === 'MINE' ? { assigneeId: p.userId } : q.scope === 'UNASSIGNED' ? { assigneeId: null } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.priority ? { priority: q.priority } : {}),
      ...(q.late === true ? { clocks: { some: lateClock } } : q.late === false ? { clocks: { none: lateClock } } : {}),
      ...(pos ? { OR: [{ createdAt: { lt: new Date(pos.t) } }, { createdAt: new Date(pos.t), id: { lt: pos.i } }] } : {}),
    };
    const rows = await this.db.ticket.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...TicketViews.staffSummaryArgs,
    });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((t) => this.views.staffSummary(t, asOf)),
      nextCursor: rows.length > q.limit && last ? this.cursors.encode(scope, { t: last.createdAt.getTime(), i: last.id }) : null,
    };
  }

  /** Bounded directory for the staff intake form (allowlist: id + displayName). */
  async customers() {
    const rows = await this.db.user.findMany({
      where: { role: 'CUSTOMER' },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 200,
      select: { id: true, displayName: true },
    });
    return { items: rows };
  }

  async staffDetail(p: Principal, id: string) {
    return this.views.staffTicket(this.db, id, await this.now(), p.userId);
  }

  async staffMessages(p: Principal, id: string, page: { limit: number; cursor?: string }) {
    if (!(await this.db.ticket.findUnique({ where: { id }, select: { id: true } }))) throw Errors.notFound();
    return this.views.staffMessages(this.db, id, p.userId, page.cursor, page.limit);
  }

  /** Staff-only audit: every stored payload is re-validated against the strict union; invalid => fail closed. */
  async audit(p: Principal, ticketId: string, page: { limit: number; cursor?: string }) {
    if (!(await this.db.ticket.findUnique({ where: { id: ticketId }, select: { id: true } }))) throw Errors.notFound();
    const scope = { a: p.userId, audit: ticketId };
    const pos = this.cursors.decode(scope, page.cursor);
    const rows = await this.db.auditEvent.findMany({
      where: {
        ticketId,
        target: 'TICKET',
        ...(pos ? { OR: [{ createdAt: { gt: new Date(pos.t) } }, { createdAt: new Date(pos.t), id: { gt: pos.i } }] } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map((r) => {
      try {
        return this.validator.assert({
          id: r.id,
          ticketId: r.ticketId!,
          actorId: r.actorId,
          actorType: r.actorType,
          action: r.action,
          createdAt: r.createdAt.toISOString(),
          correlationId: r.correlationId,
          reasonCode: r.reasonCode,
          details: r.details,
        });
      } catch (e) {
        if (e instanceof AuditPayloadError) throw Errors.unavailable('AUDIT_UNAVAILABLE', 'Audit history could not be safely rendered.');
        throw e;
      }
    });
    const last = rows[page.limit - 1];
    return { items, nextCursor: rows.length > page.limit && last ? this.cursors.encode(scope, { t: last.createdAt.getTime(), i: last.id }) : null };
  }

  // ------------------------------------------------------------------ customer (public projections only)

  async customerList(p: Principal, page: { limit: number; cursor?: string }) {
    const scope = { a: p.userId, customer: true };
    const pos = this.cursors.decode(scope, page.cursor);
    const rows = await this.db.ticket.findMany({
      where: {
        customerId: p.userId,
        ...(pos ? { OR: [{ createdAt: { lt: new Date(pos.t) } }, { createdAt: new Date(pos.t), id: { lt: pos.i } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      select: { id: true, subject: true, status: true, createdAt: true, parentTicketId: true },
    });
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((t) => ({ id: t.id, subject: t.subject, status: t.status, createdAt: t.createdAt.toISOString(), parentTicketId: t.parentTicketId })),
      nextCursor: rows.length > page.limit && last ? this.cursors.encode(scope, { t: last.createdAt.getTime(), i: last.id }) : null,
    };
  }

  customerDetail(p: Principal, id: string) {
    return this.views.publicTicket(this.db, p.userId, id);
  }

  async customerMessages(p: Principal, id: string, page: { limit: number; cursor?: string }) {
    if (!(await this.db.ticket.findFirst({ where: { id, customerId: p.userId }, select: { id: true } }))) throw Errors.notFound();
    return this.views.publicMessages(this.db, p.userId, id, page.cursor, page.limit);
  }

  async customerExport(p: Principal, id: string, format: 'json' | 'csv') {
    const t = await this.views.publicExport(this.db, p.userId, id);
    return format === 'csv'
      ? { contentType: 'text/csv; charset=utf-8', filename: `ticket-${t.id}.csv`, payload: toCsv(t) }
      : { contentType: 'application/json; charset=utf-8', filename: `ticket-${t.id}.json`, payload: JSON.stringify(t) };
  }
}
