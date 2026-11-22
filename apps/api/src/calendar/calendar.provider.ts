import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { KernelBusinessCalendar } from '../domain/calendar/business-calendar';
import { ArvoSlaPolicy } from '../domain/sla/sla-policy';
import { TicketLifecycle } from '../domain/ticket/ticket-lifecycle';
import { PrismaService } from '../prisma/prisma.service';

/** Holiday-configured calendar from the Holiday table (single domain calendar for every request). */
@Injectable()
export class CalendarProvider implements OnModuleInit {
  private cal = new KernelBusinessCalendar([]);
  private lc = this.build(this.cal);

  constructor(private readonly db: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Reloaded on boot and on every scheduler tick (holidays are configuration, rarely changed). */
  async refresh(): Promise<void> {
    const rows = await this.db.holiday.findMany({ select: { day: true } });
    this.cal = new KernelBusinessCalendar(rows.map((r) => r.day.toISOString().slice(0, 10)));
    this.lc = this.build(this.cal);
  }

  calendar(): KernelBusinessCalendar {
    return this.cal;
  }
  lifecycle(): TicketLifecycle {
    return this.lc;
  }

  private build(cal: KernelBusinessCalendar): TicketLifecycle {
    return new TicketLifecycle({ calendar: cal, policy: new ArvoSlaPolicy(cal), ids: { next: () => randomUUID() } });
  }
}
