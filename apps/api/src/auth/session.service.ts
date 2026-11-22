import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { SESSION_ABSOLUTE_TTL_MS, type Role } from '@frontdesk/contracts';
import { Errors } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenService } from './access-token.service';
import { sha256 } from './crypto';
import type { Principal } from './principal';

export interface IssuedSession {
  principal: Principal;
  accessToken: string;
  refreshValue: string;
  expiresAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** refresh cookie = "<sessionId>.<opaque 256-bit secret>"; only sha256(secret) is stored. */
export function parseRefresh(value: string | undefined): { sessionId: string; digest: string } | null {
  if (!value || value.length > 200) return null;
  const [sessionId, secret, extra] = value.split('.');
  if (!sessionId || !secret || extra !== undefined || !UUID.test(sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return { sessionId, digest: sha256(secret) };
}

@Injectable()
export class SessionService implements OnModuleInit {
  /** Equalises timing for unknown accounts (no user enumeration). */
  private dummyHash = '';

  constructor(
    private readonly db: PrismaService,
    private readonly tokens: AccessTokenService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash(randomBytes(32).toString('base64url'), { type: argon2.argon2id });
  }

  async login(email: string, password: string): Promise<IssuedSession> {
    const user = await this.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    const ok = await argon2.verify(user?.passwordHash ?? this.dummyHash, password).catch(() => false);
    if (!user || !ok) throw Errors.unauthenticated('Invalid email or password.');
    const sessionId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS);
    await this.db.$transaction([
      this.db.session.create({ data: { id: sessionId, userId: user.id, expiresAt } }),
      this.db.refreshToken.create({ data: { sessionId, tokenHash: sha256(secret), issuedAt: new Date() } }),
    ]);
    const principal: Principal = { userId: user.id, role: user.role, displayName: user.displayName, sessionId };
    return { principal, accessToken: this.tokens.sign(user.id, sessionId), refreshValue: `${sessionId}.${secret}`, expiresAt };
  }

  /**
   * Rotation (AUTH_CONTRACT): lock Session row first, then the token. A previously used digest revokes the
   * whole family; the revocation is COMMITTED before the 401 is returned. Concurrent refreshes serialise on
   * the session lock, so the second presenter of the same token is treated as reuse (fail closed).
   */
  async refresh(cookie: string | undefined): Promise<IssuedSession> {
    const parsed = parseRefresh(cookie);
    if (!parsed) throw Errors.unauthenticated();
    const outcome = await this.db.$transaction(
      async (tx) => {
        // Lock FIRST without validity predicates (they would be evaluated before any lock wait), then sample
        // fresh DB time and re-validate revocation + absolute expiry under the lock (M02).
        const locked = await tx.$queryRaw<{ revokedAt: Date | null; expiresAt: Date }[]>`
          SELECT "revokedAt", "expiresAt" FROM "Session" WHERE id = ${parsed.sessionId} FOR UPDATE`;
        const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
        const dbNow = clock[0]!.now;
        const session = locked[0];
        if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= dbNow.getTime()) return { kind: 'invalid' as const };
        const token = await tx.refreshToken.findUnique({ where: { tokenHash: parsed.digest } });
        if (!token || token.sessionId !== parsed.sessionId) return { kind: 'invalid' as const };
        if (token.usedAt !== null) {
          await tx.session.update({ where: { id: parsed.sessionId }, data: { revokedAt: dbNow } });
          return { kind: 'reused' as const };
        }
        const now = dbNow;
        const marked = await tx.refreshToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
        if (marked.count !== 1) return { kind: 'invalid' as const };
        const secret = randomBytes(32).toString('base64url');
        await tx.refreshToken.create({ data: { sessionId: parsed.sessionId, tokenHash: sha256(secret), issuedAt: now } });
        const current = await tx.session.findUniqueOrThrow({ where: { id: parsed.sessionId }, include: { user: true } });
        return { kind: 'rotated' as const, secret, session: current };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 },
    );
    if (outcome.kind !== 'rotated') throw Errors.unauthenticated(outcome.kind === 'reused' ? 'Session revoked.' : undefined);
    const { session, secret } = outcome;
    const principal: Principal = { userId: session.userId, role: session.user.role, displayName: session.user.displayName, sessionId: session.id };
    return { principal, accessToken: this.tokens.sign(session.userId, session.id), refreshValue: `${session.id}.${secret}`, expiresAt: session.expiresAt };
  }

  /** Access JWT + live DB session + current user role on every protected call (immediate revocation). */
  async authenticate(accessToken: string | undefined): Promise<Principal> {
    if (!accessToken || accessToken.length > 4096) throw Errors.unauthenticated();
    const { userId, sessionId } = this.tokens.verify(accessToken);
    const session = await this.db.session.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: { select: { role: true, displayName: true } } },
    });
    if (!session) throw Errors.unauthenticated();
    return { userId, role: session.user.role as Role, displayName: session.user.displayName, sessionId };
  }

  /** Read-only identity from the *current* refresh token (no rotation). Used by /auth/csrf and logout. */
  async sessionFromRefresh(cookie: string | undefined): Promise<string | null> {
    const parsed = parseRefresh(cookie);
    if (!parsed) return null;
    const token = await this.db.refreshToken.findFirst({
      where: { tokenHash: parsed.digest, sessionId: parsed.sessionId, usedAt: null, session: { revokedAt: null, expiresAt: { gt: new Date() } } },
      select: { sessionId: true },
    });
    return token?.sessionId ?? null;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async viewer(userId: string) {
    return this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, displayName: true, role: true } });
  }
}
