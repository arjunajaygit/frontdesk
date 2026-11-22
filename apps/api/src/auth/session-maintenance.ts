import { Injectable } from '@nestjs/common';
import { RETENTION_GRACE_MS } from '@frontdesk/contracts';
import { PrismaService } from '../prisma/prisma.service';

/** Retention: refresh digests and sessions are kept until absolute expiry + 24h, then purged. */
@Injectable()
export class SessionMaintenance {
  constructor(private readonly db: PrismaService) {}

  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_GRACE_MS);
    return this.db.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({ where: { session: { expiresAt: { lt: cutoff } } } });
      return (await tx.session.deleteMany({ where: { expiresAt: { lt: cutoff } } })).count;
    });
  }
}
