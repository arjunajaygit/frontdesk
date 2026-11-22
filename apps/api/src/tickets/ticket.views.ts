import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type SlaClock as ClockRow } from '@prisma/client';
import { project } from '../domain/sla/sla-clock';
import { fromDate, toIso, type Instant } from '../domain/shared/instant';
import { clockFromRow } from '../infrastructure/persistence/ticket-mapper';
import { CalendarProvider } from '../calendar/calendar.provider';
import { Errors } from '../common/app-error';
import type { Tx } from './unit-of-work';
import { CursorCodec, type Position } from './cursor';

type Reader = Tx | Prisma.TransactionClient;

/** No silent truncation — conversations are keyset-paginated (newest page first) and exports are complete. */
export const TIMELINE_PAGE = 50;
export const EXPORT_BATCH = 500;

const STAFF_SUMMARY = {
  include: { assignee: { select: { displayName: true } }, clocks: { orderBy: [{ cycle: 'asc' }, { kind: 'asc' }, { id: 'asc' }] } },
} as const satisfies Prisma.TicketDefaultArgs;

type StaffSummaryRow = Prisma.TicketGetPayload<typeof STAFF_SUMMARY>;

const STAFF_MESSAGE = {
  id: true,
  body: true,
  kind: true,
  visibility: true,
  createdAt: true,
  author: { select: { id: true, displayName: true, role: true } },
} as const satisfies Prisma.MessageSelect;
/** Customer projection allowlist: no kind, visibility, author id or role beyond STAFF/CUSTOMER. */
const PUBLIC_MESSAGE = {
  id: true,
  body: true,
  createdAt: true,
  author: { select: { displayName: true, role: true } },
} as const satisfies Prisma.MessageSelect;
const PUBLIC_TICKET = { id: true, subject: true, status: true, createdAt: true, parentTicketId: true } as const satisfies Prisma.TicketSelect;

type StaffMsgRow = Prisma.MessageGetPayload<{ select: typeof STAFF_MESSAGE }>;
type PublicMsgRow = Prisma.MessageGetPayload<{ select: typeof PUBLIC_MESSAGE }>;

const staffMessage = (m: StaffMsgRow) => ({
  id: m.id,
  body: m.body,
  author: { id: m.author.id, displayName: m.author.displayName, role: m.author.role },
  kind: m.kind,
  visibility: m.visibility,
  createdAt: m.createdAt.toISOString(),
});
const publicMessage = (m: PublicMsgRow) => ({
  id: m.id,
  body: m.body,
  authorDisplayName: m.author.displayName,
  authorType: m.author.role === 'CUSTOMER' ? ('CUSTOMER' as const) : ('STAFF' as const),
  createdAt: m.createdAt.toISOString(),
});

/** Strictly-older keyset predicate on (createdAt, id) — stable even with identical timestamps. */
const olderThan = (pos: Position | null): Prisma.MessageWhereInput =>
  pos ? { OR: [{ createdAt: { lt: new Date(pos.t) } }, { createdAt: new Date(pos.t), id: { lt: pos.i } }] } : {};

/**
 * Explicit allowlist DTO builders. Staff views may contain notes; customer views are built from queries that
 * filter ownership AND visibility=PUBLIC in SQL on EVERY page and select only allowlisted columns.
 */
@Injectable()
export class TicketViews {
  constructor(
    private readonly calendars: CalendarProvider,
    private readonly cursors: CursorCodec,
  ) {}

  static readonly staffSummaryArgs = STAFF_SUMMARY;

  clocks(rows: ClockRow[], asOf: Instant, updatedAt: Instant) {
    const at = Math.max(asOf, updatedAt); // read projection never evaluates before the last mutation
    const cal = this.calendars.calendar();
    return rows.map((r) => project(clockFromRow(r), at, cal));
  }

  staffSummary(t: StaffSummaryRow, asOf: Instant) {
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      requestedPriority: t.requestedPriority,
      customerId: t.customerId,
      assigneeId: t.assigneeId,
      assigneeDisplayName: t.assignee?.displayName ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      parentTicketId: t.parentTicketId,
      version: t.version,
      resolutionCycle: t.resolutionCycle,
      waitingCloseDueAt: t.waitingCloseDueAt?.toISOString() ?? null,
      reopenUntil: t.reopenUntil?.toISOString() ?? null,
      closeReason: t.closeReason,
      clocks: this.clocks(t.clocks, asOf, fromDate(t.updatedAt)),
    };
  }

  /** Newest-first pages; items within a page are chronological. `nextCursor` walks to OLDER messages. */
  async staffMessages(db: Reader, ticketId: string, actorId: string, cursor?: string, limit = TIMELINE_PAGE) {
    const scope = { a: actorId, timeline: ticketId, v: 'staff' };
    const pos = this.cursors.decode(scope, cursor);
    const rows = await db.message.findMany({
      where: { ticketId, ...olderThan(pos) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: STAFF_MESSAGE,
    });
    return this.page(rows, limit, scope, staffMessage);
  }

  /** Customer timeline page: ownership + PUBLIC enforced in SQL on every page; cursors reveal only public positions. */
  async publicMessages(db: Reader, customerId: string, ticketId: string, cursor?: string, limit = TIMELINE_PAGE) {
    const scope = { a: customerId, timeline: ticketId, v: 'public' };
    const pos = this.cursors.decode(scope, cursor);
    const rows = await db.message.findMany({
      where: { ticketId, visibility: 'PUBLIC', ticket: { customerId }, ...olderThan(pos) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: PUBLIC_MESSAGE,
    });
    return this.page(rows, limit, scope, publicMessage);
  }

  async staffTicket(db: Reader, id: string, asOf: Instant, actorId: string) {
    const t = await db.ticket.findUnique({ where: { id }, include: STAFF_SUMMARY.include });
    if (!t) throw Errors.notFound();
    const timeline = await this.staffMessages(db, id, actorId);
    return { ...this.staffSummary(t, asOf), messages: timeline.items, olderMessagesCursor: timeline.nextCursor };
  }

  async publicTicket(db: Reader, customerId: string, id: string) {
    const t = await db.ticket.findFirst({ where: { id, customerId }, select: PUBLIC_TICKET });
    if (!t) throw Errors.notFound();
    const timeline = await this.publicMessages(db, customerId, id);
    return { ...this.publicHeader(t), messages: timeline.items, olderMessagesCursor: timeline.nextCursor };
  }

  /**
   * Complete export (no truncation): bounded keyset batches inside ONE read-only REPEATABLE READ transaction,
   * so every batch sees the same snapshot (messages committed after the export began are excluded).
   */
  async publicExport(db: PrismaClient, customerId: string, id: string) {
    return db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const t = await tx.ticket.findFirst({ where: { id, customerId }, select: PUBLIC_TICKET });
        if (!t) throw Errors.notFound();
        const messages: ReturnType<typeof publicMessage>[] = [];
        let pos: Position | null = null;
        for (;;) {
          const after: Prisma.MessageWhereInput = pos
            ? { OR: [{ createdAt: { gt: new Date(pos.t) } }, { createdAt: new Date(pos.t), id: { gt: pos.i } }] }
            : {};
          const batch = await tx.message.findMany({
            where: { ticketId: id, visibility: 'PUBLIC', ticket: { customerId }, ...after },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: EXPORT_BATCH,
            select: PUBLIC_MESSAGE,
          });
          messages.push(...batch.map(publicMessage));
          if (batch.length < EXPORT_BATCH) break;
          const last = batch[batch.length - 1]!;
          pos = { t: last.createdAt.getTime(), i: last.id };
        }
        return { ...this.publicHeader(t), messages, olderMessagesCursor: null };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 30_000 },
    );
  }

  private publicHeader(t: Prisma.TicketGetPayload<{ select: typeof PUBLIC_TICKET }>) {
    return { id: t.id, subject: t.subject, status: t.status, createdAt: toIso(fromDate(t.createdAt)), parentTicketId: t.parentTicketId };
  }

  private page<R extends { id: string; createdAt: Date }, O>(rows: R[], limit: number, scope: object, map: (r: R) => O) {
    const page = rows.slice(0, limit);
    const oldest = page[page.length - 1];
    return {
      items: [...page].reverse().map(map),
      nextCursor: rows.length > limit && oldest ? this.cursors.encode(scope, { t: oldest.createdAt.getTime(), i: oldest.id }) : null,
    };
  }
}

export type PublicTicketView = Awaited<ReturnType<TicketViews['publicExport']>>;

const FORMULA = /^[=+\-@\t\r]/;
/** RFC 4180 quoting + spreadsheet formula-injection neutralisation (leading ' on =,+,-,@,TAB,CR). */
export function csvCell(value: string | null): string {
  const v = value ?? '';
  const safe = FORMULA.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(t: PublicTicketView): string {
  const header = ['ticket_id', 'subject', 'status', 'ticket_created_at', 'parent_ticket_id', 'message_id', 'message_created_at', 'author_type', 'author_display_name', 'body'];
  const rows = t.messages.map((m) => [t.id, t.subject, t.status, t.createdAt, t.parentTicketId, m.id, m.createdAt, m.authorType, m.authorDisplayName, m.body]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
