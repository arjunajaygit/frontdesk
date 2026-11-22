import { CommitHooks } from '../../apps/api/src/observability/commit-hooks';
import { MetricsService } from '../../apps/api/src/observability/metrics.service';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parseEnv } from '../../apps/api/src/config/env';
import { CsrfService } from '../../apps/api/src/auth/csrf.service';
import { parseRefresh } from '../../apps/api/src/auth/session.service';
import { AppError } from '../../apps/api/src/common/app-error';
import { SafeExceptionFilter } from '../../apps/api/src/common/exception.filter';
import { DomainError } from '../../apps/api/src/domain/shared/domain-error';
import {
  AuditPayloadError,
  AuditValidator,
  AuditWriter,
} from '../../apps/api/src/tickets/audit.writer';
import { CursorCodec } from '../../apps/api/src/tickets/cursor';
import { requestHash } from '../../apps/api/src/tickets/idempotency.service';
import { csvCell } from '../../apps/api/src/tickets/ticket.views';
import { extractAuditSchema } from '../../scripts/gen-audit-schema';
import { AGENT, CUSTOMER, ist, lifecycle } from '../helpers/domain';

const config = parseEnv({
  DATABASE_URL: 'postgresql://frontdesk_app:x@localhost:5432/f',
  PUBLIC_ORIGIN: 'http://localhost:5173',
  JWT_SECRET: randomBytes(32).toString('hex'),
  CSRF_SIGNING_KEY: randomBytes(32).toString('hex'),
});

describe('audit write boundary', () => {
  it('runtime schema is generated from, and identical to, the authoritative OpenAPI (no drift)', () => {
    const committed = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../packages/contracts/src/audit-event.schema.json'),
        'utf8',
      ),
    );
    expect(committed).toEqual(extractAuditSchema());
  });

  const env = (details: Record<string, unknown>, action = 'MESSAGE_PUBLISHED') => ({
    id: '0190e000-0000-7000-8000-000000000001',
    ticketId: '0190e000-0000-7000-8000-000000000002',
    actorId: '0190e000-0000-7000-8000-000000000003',
    actorType: 'AGENT',
    action,
    createdAt: '2026-11-23T04:00:00.000Z',
    correlationId: 'corr',
    reasonCode: null,
    details,
  });
  const ok = {
    beforeVersion: 1,
    afterVersion: 2,
    messageId: '0190e000-0000-7000-8000-000000000004',
    messageKind: 'REPLY',
    publishedAt: '2026-11-23T04:00:00.000Z',
  };

  it('accepts a contract payload and rejects undeclared/sensitive fields, wrong shapes and unknown actions (fail closed)', () => {
    const v = new AuditValidator();
    expect(v.assert(env(ok))).toBeTruthy();
    for (const extra of ['body', 'email', 'passwordHash', 'leaseToken', 'sessionId', 'cookie']) {
      expect(() => v.assert(env({ ...ok, [extra]: 'secret' }))).toThrow(AuditPayloadError);
    }
    expect(() => v.assert(env(ok, 'PRIORITY_CHANGED'))).toThrow(AuditPayloadError);
    expect(() => v.assert(env(ok, 'ARBITRARY_ACTION'))).toThrow(AuditPayloadError);
    expect(() => v.assert({ ...env(ok), raw: { anything: true } } as never)).toThrow(
      AuditPayloadError,
    );
  });

  it('every event the domain emits for a full lifecycle passes the write-boundary validator', async () => {
    const { lc } = lifecycle();
    const rows: unknown[] = [];
    const writer = new AuditWriter(
      new AuditValidator(),
      new CommitHooks(),
      new MetricsService({} as never),
    );
    const tx = {
      $queryRaw: async () => [{ now: new Date('2026-11-23T05:00:00.000Z') }],
      auditEvent: { createMany: async ({ data }: { data: unknown[] }) => rows.push(...data) },
    } as never;
    let r = lc.customerIntake({
      actor: CUSTOMER,
      subject: 's',
      body: 'b',
      now: ist('2026-11-23T09:30'),
    });
    const all = [r];
    const step = (x: typeof r) => (all.push(x), (r = x));
    step(lc.claim(r.aggregate, AGENT, ist('2026-11-23T09:35')));
    step(lc.addNote(r.aggregate, AGENT, 'secret note', ist('2026-11-23T09:40')));
    step(lc.requestInformation(r.aggregate, AGENT, 'info?', ist('2026-11-23T10:00')));
    step(lc.changePriority(r.aggregate, AGENT, 'URGENT', ist('2026-11-23T11:00')));
    for (const x of all) await writer.appendTicketEvents(tx, x.events, 'corr');
    expect(rows.length).toBe(all.reduce((n, x) => n + x.events.length, 0));
    expect(JSON.stringify(rows)).not.toContain('secret note');
  });
});

describe('CSRF tokens', () => {
  const csrf = new CsrfService(config);
  it('verifies header==cookie, signature, expiry and binding', () => {
    const s = csrf.issue({ kind: 'session', sessionId: 'sid-1' });
    expect(() => csrf.verify(s, s, { kind: 'session', sessionId: 'sid-1' })).not.toThrow();
    expect(() => csrf.verify(s, s, { kind: 'session', sessionId: 'sid-2' })).toThrow(AppError);
    expect(() => csrf.verify(s, s, { kind: 'prelogin' })).toThrow(AppError);
    expect(() => csrf.verify(s, `${s}x`, { kind: 'session', sessionId: 'sid-1' })).toThrow(
      AppError,
    );
    const forged = `${s.split('.')[0]}.AAAA`;
    expect(() => csrf.verify(forged, forged, { kind: 'session', sessionId: 'sid-1' })).toThrow(
      AppError,
    );
    const old = csrf.issue({ kind: 'prelogin' }, Date.now() - 2 * 3_600_000);
    expect(() => csrf.verify(old, old, { kind: 'prelogin' })).toThrow(AppError);
    const other = new CsrfService({ ...config, CSRF_SIGNING_KEY: randomBytes(32).toString('hex') });
    expect(() => other.verify(s, s, { kind: 'session', sessionId: 'sid-1' })).toThrow(AppError);
  });
  it('Origin must equal the configured origin exactly', () => {
    expect(() => csrf.verifyOrigin('http://localhost:5173')).not.toThrow();
    for (const o of [
      undefined,
      'null',
      'http://localhost:5173/',
      'http://localhost:5174',
      'https://localhost:5173',
    ]) {
      expect(() => csrf.verifyOrigin(o)).toThrow(AppError);
    }
  });
});

describe('cursor, fingerprint, refresh-cookie parsing, CSV', () => {
  it('cursors are bound to scope and tamper-evident', () => {
    const c = new CursorCodec(config);
    const cur = c.encode({ a: 1 }, { t: 5, i: 'x' });
    expect(c.decode({ a: 1 }, cur)).toEqual({ t: 5, i: 'x' });
    expect(() => c.decode({ a: 2 }, cur)).toThrow(AppError);
    expect(() =>
      c.decode(
        { a: 1 },
        cur.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')),
      ),
    ).toThrow(AppError);
    expect(c.decode({ a: 1 }, undefined)).toBeNull();
  });
  it('request fingerprint is canonical (key order irrelevant) and binds operation and resource', () => {
    expect(requestHash('op', 'r', { a: 1, b: { c: 2, d: 3 } })).toBe(
      requestHash('op', 'r', { b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(requestHash('op', 'r', { a: 1 })).not.toBe(requestHash('op', 'r2', { a: 1 }));
    expect(requestHash('op', 'r', { a: 1 })).not.toBe(requestHash('op2', 'r', { a: 1 }));
  });
  it('refresh cookie format is strictly parsed', () => {
    const good = `0190e000-0000-7000-8000-000000000001.${randomBytes(32).toString('base64url')}`;
    expect(parseRefresh(good)).toMatchObject({ sessionId: '0190e000-0000-7000-8000-000000000001' });
    for (const bad of [
      undefined,
      '',
      'nodot',
      `${good}.extra`,
      `not-a-uuid.${randomBytes(32).toString('base64url')}`,
      good.slice(0, -1),
    ]) {
      expect(parseRefresh(bad)).toBeNull();
    }
  });
  it('CSV cells are quoted and formula-leading values neutralised', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    for (const lead of ['+', '-', '@', '\t', '\r']) expect(csvCell(`${lead}x`)).toBe(`"'${lead}x"`);
    expect(csvCell(null)).toBe('""');
  });
});

describe('safe error envelope', () => {
  const f = new SafeExceptionFilter({ error: () => undefined });
  it('maps domain kinds, hides internals, and only claim conflicts may name an assignee', () => {
    expect(f.toEnvelope(new DomainError('NOT_OWNER', 'detail'), 'r')).toEqual({
      status: 404,
      body: { code: 'NOT_OWNER', message: 'Not found.', requestId: 'r' },
    });
    expect(f.toEnvelope(new DomainError('INVALID_STATE', 'x'), 'r').status).toBe(409);
    expect(f.toEnvelope(new DomainError('MESSAGE_REQUIRED', 'x'), 'r').status).toBe(400);
    expect(f.toEnvelope(new Error('SELECT * FROM secret_table failed at line 3'), 'r')).toEqual({
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId: 'r' },
    });
    expect(
      f.toEnvelope(new AppError(409, 'CLAIM_CONFLICT', 'm', 'Agent A'), 'r').body
        .assignedAgentDisplayName,
    ).toBe('Agent A');
    expect(
      f.toEnvelope(new AppError(404, 'NOT_FOUND', 'm', 'Agent A'), 'r').body,
    ).not.toHaveProperty('assignedAgentDisplayName');
  });
});
