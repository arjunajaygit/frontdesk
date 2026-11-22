import { Controller, Get } from '@nestjs/common';
import { Errors } from '../common/app-error';
import { Public } from '../auth/guards';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: process is up, and which source revision it was built from (OCI label value; not a secret). */
  @Get('healthz')
  healthz() {
    const commit = process.env.APP_COMMIT ?? '';
    return { ok: true, commit: /^[0-9a-f]{40}$/.test(commit) ? commit : 'unknown' };
  }

  /** Readiness: the RESTRICTED runtime connection can reach PostgreSQL (and the schema is visible). */
  @Get('readyz')
  async readyz() {
    try {
      await this.prisma.$queryRaw`SELECT 1 FROM "Holiday" LIMIT 1`;
    } catch {
      throw Errors.unavailable('NOT_READY', 'Database unavailable.');
    }
    if (!this.prisma.runtimeSafe()) throw Errors.unavailable('NOT_READY', 'Database unavailable.');
    return { ok: true };
  }
}
