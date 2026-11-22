import { InternalSweepController, MachineTokenGuard } from './sweep/internal-sweep.controller';
import { SessionContextService } from './auth/session-context';
import { ObservabilityModule } from './observability/observability.module';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage } from 'node:http';
import { AccessTokenService } from './auth/access-token.service';
import { AuthController } from './auth/auth.controller';
import { CsrfService } from './auth/csrf.service';
import { AuthGuard, CsrfGuard, RolesGuard } from './auth/guards';
import { SessionMaintenance } from './auth/session-maintenance';
import { SessionService } from './auth/session.service';
import { CalendarProvider } from './calendar/calendar.provider';
import { RateLimiter } from './common/rate-limiter';
import { ConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';
import { PgSweepStore } from './infrastructure/sweep/pg-sweep-store';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { AdminController } from './sweep/admin.controller';
import { PgSweepTicketProcessor } from './sweep/sweep-ticket.processor';
import { SweepScheduler } from './sweep/sweep.scheduler';
import { SweepService } from './sweep/sweep.service';
import { AuditValidator, AuditWriter } from './tickets/audit.writer';
import { CursorCodec } from './tickets/cursor';
import { IdempotencyService } from './tickets/idempotency.service';
import { TicketCommandService } from './tickets/ticket-command.service';
import { TicketQueryService } from './tickets/ticket-query.service';
import { TicketRepository } from './tickets/ticket.repository';
import { TicketViews } from './tickets/ticket.views';
import { CustomerTicketsController, CustomersController, StaffTicketsController } from './tickets/tickets.controller';
import { UnitOfWork } from './tickets/unit-of-work';

@Module({
  imports: [
    ObservabilityModule,
    ConfigModule,
    PrismaModule,
    ScheduleModule.forRoot(),
    LoggerModule.forRootAsync({
      useFactory: () => ({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req: IncomingMessage) => (req as IncomingMessage & { id?: string }).id ?? randomUUID(),
        // Never log credentials, cookies, CSRF tokens or bodies (bodies are not serialised by pino-http).
        redact: {
          // x-session-context: opaque per-session binding tag (H02). Not a credential, but session-correlated, so never
          // logged (found by tests/e2e/log-safety.spec.ts).
          paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'req.headers["x-session-context"]', 'req.headers["idempotency-key"]', 'res.headers["set-cookie"]'],
          censor: '[REDACTED]',
        },
        autoLogging: { ignore: (req: IncomingMessage) => req.url === '/api/healthz' },
      },
      }),
    }),
  ],
  controllers: [HealthController, AuthController, StaffTicketsController, CustomersController, CustomerTicketsController, AdminController, InternalSweepController],
  providers: [
    // Global guards, in order: authenticate (deny by default) -> role -> Origin/CSRF for mutations.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    RateLimiter,
    AccessTokenService,
    CsrfService,
    SessionContextService,
    SessionService,
    SessionMaintenance,
    CalendarProvider,
    UnitOfWork,
    AuditValidator,
    AuditWriter,
    TicketRepository,
    IdempotencyService,
    TicketViews,
    CursorCodec,
    TicketCommandService,
    TicketQueryService,
    { provide: PgSweepStore, useFactory: (db: PrismaService) => new PgSweepStore(db), inject: [PrismaService] },
    PgSweepTicketProcessor,
    SweepService,
    SweepScheduler,
    MachineTokenGuard,
  ],
})
export class AppModule {}
