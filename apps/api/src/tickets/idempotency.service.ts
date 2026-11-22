import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IDEMPOTENCY_RETENTION_MS } from '@frontdesk/contracts';
import { Errors } from '../common/app-error';
import { sha256 } from '../auth/crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from './unit-of-work';

/** Canonical request fingerprint: operation + resource + body with recursively sorted keys. */
export function requestHash(operation: string, resource: string | null, body: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return `sha256:${sha256(JSON.stringify({ operation, resource, body: canon(body ?? null) }))}`;
}

export type Reservation = { kind: 'NEW'; id: string } | { kind: 'REPLAY'; status: number; body: unknown };

/**
 * DOMAIN_CONTRACT idempotency: reservation is the FIRST write of the business transaction
 * (INSERT .. ON CONFLICT DO NOTHING). A concurrent duplicate blocks on the unique index until the first commits
 * (then replays its stored result) or rolls back (then executes itself). The response is stored in the same
 * transaction, so a pending reservation is never visible and never orphaned. Keys are actor-scoped, so a retry
 * can only ever replay the caller's own response.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: PrismaService) {}

  async reserve(tx: Tx, a: { actorId: string; operation: string; key: string; requestHash: string }): Promise<Reservation> {
    const id = randomUUID();
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "IdempotencyRecord" (id, "actorId", operation, key, "requestHash", "createdAt")
      VALUES (${id}, ${a.actorId}, ${a.operation}, ${a.key}, ${a.requestHash}, clock_timestamp())
      ON CONFLICT ("actorId", operation, key) DO NOTHING
      RETURNING id`;
    if (inserted.length) return { kind: 'NEW', id };
    const row = await tx.idempotencyRecord.findUnique({ where: { actorId_operation_key: { actorId: a.actorId, operation: a.operation, key: a.key } } });
    if (!row) throw Errors.unavailable('IDEMPOTENCY_RETRY', 'Please retry the request.');
    if (row.requestHash !== a.requestHash) throw Errors.conflict('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request.');
    if (row.responseStatus === null) throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'The original request is still in progress.');
    return { kind: 'REPLAY', status: row.responseStatus, body: row.response };
  }

  async complete(tx: Tx, id: string, status: number, body: unknown): Promise<void> {
    await tx.idempotencyRecord.update({ where: { id }, data: { responseStatus: status, response: body as Prisma.InputJsonValue } });
  }

  /** Retention: completed records older than 24h (pending records cannot exist outside a live transaction). */
  async purgeExpired(): Promise<number> {
    const r = await this.db.idempotencyRecord.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - IDEMPOTENCY_RETENTION_MS) }, responseStatus: { not: null } },
    });
    return r.count;
  }
}
