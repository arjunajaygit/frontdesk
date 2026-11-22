import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { Prisma } from '@prisma/client';
import { AppError, Errors } from '../common/app-error';
import { DomainError } from '../domain/shared/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import { CommitHooks } from '../observability/commit-hooks';

export type Tx = Prisma.TransactionClient;

function pgCode(e: unknown): string | undefined {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2034') return '40001';
    const meta = e.meta as { code?: string } | undefined;
    return meta?.code;
  }
  return undefined;
}

/**
 * One bounded READ COMMITTED transaction per business command. Deadlock / serialization failures retry the
 * WHOLE transaction (bounded); lock timeouts surface as a safe 503. No external I/O happens inside.
 */
@Injectable()
export class UnitOfWork {
  constructor(
    private readonly db: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hooks: CommitHooks,
  ) {}

  async run<T>(work: (tx: Tx) => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let attemptTx: Tx | undefined;
      try {
        const result = await this.db.$transaction(
          async (tx) => {
            attemptTx = tx;
            const lockMs = String(this.config.DB_LOCK_TIMEOUT_MS);
            const stmtMs = String(Math.max(10_000, this.config.DB_LOCK_TIMEOUT_MS + 5_000));
            await tx.$queryRaw`SELECT set_config('lock_timeout', ${lockMs}, true), set_config('statement_timeout', ${stmtMs}, true)`;
            return work(tx);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: Math.max(15_000, this.config.DB_LOCK_TIMEOUT_MS + 10_000) },
        );
        this.hooks.committed(attemptTx); // observers fire only for the attempt that actually committed
        return result;
      } catch (e) {
        this.hooks.discarded(attemptTx);
        if (e instanceof AppError || e instanceof DomainError) throw e;
        const code = pgCode(e);
        if ((code === '40001' || code === '40P01') && attempt < attempts) continue;
        if (code === '55P03' || code === '57014') throw Errors.unavailable('BUSY', 'The ticket is busy. Please retry.');
        throw e;
      }
    }
  }
}
