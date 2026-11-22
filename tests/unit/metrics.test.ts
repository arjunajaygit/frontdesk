import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { CommitHooks } from '../../apps/api/src/observability/commit-hooks';
import { MetricsService } from '../../apps/api/src/observability/metrics.service';
import { UnitOfWork } from '../../apps/api/src/tickets/unit-of-work';
import { parseEnv } from '../../apps/api/src/config/env';

const metric = async (m: MetricsService, line: string) => {
  const text = (await m.render()).body;
  const hit = text.split('\n').find((l) => l.startsWith(line + ' '));
  return hit ? Number(hit.slice(line.length + 1)) : 0;
};
const newMetrics = () => new MetricsService({ $queryRaw: async () => [{ ok: 1 }] } as never);

describe('metrics: commit-only counting and bounded, private labels', () => {
  it('CommitHooks fire only on commit; discarded/rolled-back work never counts; observer errors are contained', () => {
    const hooks = new CommitHooks();
    const fired: string[] = [];
    const a = {};
    const b = {};
    hooks.onCommit(a, () => fired.push('a'));
    hooks.onCommit(b, () => fired.push('b'));
    hooks.onCommit(b, () => {
      throw new Error('observer bug');
    });
    hooks.discarded(a);
    hooks.committed(a); // nothing left
    expect(() => hooks.committed(b)).not.toThrow();
    hooks.committed(b); // never twice
    expect(fired).toEqual(['b']);
  });

  it('UnitOfWork: a serialization-failure retry discards the first attempt; only the committed attempt counts', async () => {
    const hooks = new CommitHooks();
    let attempt = 0;
    let counted = 0;
    const db = {
      $transaction: async (fn: (tx: object) => Promise<unknown>) => {
        attempt++;
        const tx = { $queryRaw: async () => [] };
        const out = await fn(tx);
        if (attempt === 1)
          throw new Prisma.PrismaClientKnownRequestError('serialization', {
            code: 'P2034',
            clientVersion: 'test',
          });
        return out;
      },
    };
    const uow = new UnitOfWork(db as never, { DB_LOCK_TIMEOUT_MS: 3000 } as never, hooks);
    await uow.run(async (tx) => {
      hooks.onCommit(tx, () => counted++);
      return 'ok';
    });
    expect(attempt).toBe(2);
    expect(counted).toBe(1);

    const failing = new UnitOfWork(
      {
        $transaction: async (fn: (tx: object) => Promise<unknown>) => {
          await fn({ $queryRaw: async () => [] });
          throw new Error('commit failed');
        },
      } as never,
      { DB_LOCK_TIMEOUT_MS: 3000 } as never,
      hooks,
    );
    await expect(failing.run(async (tx) => hooks.onCommit(tx, () => counted++))).rejects.toThrow(
      'commit failed',
    );
    expect(counted).toBe(1); // rolled back -> not counted
  });

  it('labels are closed vocabularies: raw URLs, ids, unknown commands/clocks/priorities fold to fixed buckets', async () => {
    const m = newMetrics();
    m.observeHttp('GET', '/api/tickets/{id}', 200, 0.01);
    m.observeHttp('GET', '/api/tickets/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 404, 0.01);
    m.observeHttp('GET', '/api/tickets/12345', 404, 0.01);
    m.observeHttp('GET', '/api/x?email=a@b.example', 404, 0.01);
    m.observeHttp('BREW', undefined, 418, 0.01);
    m.command('POST /tickets/{id}/claim', 'success');
    m.command('POST /tickets/{id}/claim', 'conflict');
    m.command('POST /evil/aarav.menon@customer.example', 'success');
    m.breachRecorded('RESPONSE', 'URGENT');
    m.breachRecorded('<script>', 'PRIVATE-NOTE');
    const text = (await m.render()).body;
    expect(
      await metric(
        m,
        'frontdesk_http_requests_total{method="GET",route="/api/tickets/{id}",status_class="2xx"}',
      ),
    ).toBe(1);
    expect(
      await metric(
        m,
        'frontdesk_http_requests_total{method="GET",route="unmatched",status_class="4xx"}',
      ),
    ).toBe(3);
    expect(
      await metric(
        m,
        'frontdesk_http_requests_total{method="OTHER",route="unmatched",status_class="4xx"}',
      ),
    ).toBe(1);
    expect(await metric(m, 'frontdesk_ticket_claims_total{outcome="won"}')).toBe(1);
    expect(await metric(m, 'frontdesk_ticket_claims_total{outcome="conflict"}')).toBe(1);
    expect(
      await metric(m, 'frontdesk_ticket_commands_total{command="other",outcome="success"}'),
    ).toBe(1);
    expect(
      await metric(m, 'frontdesk_sla_breaches_recorded_total{clock="other",priority="other"}'),
    ).toBe(1);
    // Privacy is about LABELS: metric values are numbers and may contain any digit sequence (e.g. memory bytes).
    const labels = [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    expect(labels).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(labels).not.toMatch(/@|PRIVATE|script|12345/);
    expect(await metric(m, 'frontdesk_db_up')).toBe(1);
  });

  it('sweep metrics: outcome, recoveries, backlog flag and last success', async () => {
    const m = newMetrics();
    m.sweepFinished('SYSTEM', 'completed', 0.2, true);
    m.sweepFinished('LEAD', 'conflict', 0.01);
    m.leaseRecoveries(2);
    m.leaseRecoveries(0);
    expect(
      await metric(
        m,
        'frontdesk_sweep_invocations_total{initiator="system",trigger="timer",outcome="completed"}',
      ),
    ).toBe(1);
    expect(
      await metric(
        m,
        'frontdesk_sweep_invocations_total{initiator="lead",trigger="manual",outcome="conflict"}',
      ),
    ).toBe(1);
    expect(await metric(m, 'frontdesk_sweep_lease_recoveries_total')).toBe(2);
    expect(await metric(m, 'frontdesk_sweep_more_due')).toBe(1);
    expect(
      await metric(m, 'frontdesk_sweep_last_scheduled_success_timestamp_seconds'),
    ).toBeGreaterThan(1.7e9);
  });

  it('config: metrics are off by default, must not share the public port, and need a strong token in production', () => {
    const base = {
      DATABASE_URL: 'postgresql://frontdesk_app:x@localhost:5432/frontdesk',
      PUBLIC_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: randomBytes(48).toString('base64url'),
      CSRF_SIGNING_KEY: randomBytes(48).toString('base64url'),
    };
    expect(parseEnv(base).METRICS_PORT).toBe(0);
    expect(() => parseEnv({ ...base, METRICS_PORT: '3000' })).toThrow(/METRICS_PORT/);
    const prod = {
      ...base,
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://frontdesk.example',
      METRICS_PORT: '9464',
    };
    expect(() => parseEnv(prod)).toThrow(/METRICS_TOKEN/);
    expect(() => parseEnv({ ...prod, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
    expect(parseEnv({ ...prod, METRICS_TOKEN: 'T'.repeat(16) + 'u'.repeat(16) }).METRICS_PORT).toBe(
      9464,
    );
  });

  it('a manual sweep never updates the scheduled-success gauge (cannot hide a dead scheduler); external SYSTEM triggers do', async () => {
    const m = newMetrics();
    m.sweepFinished('LEAD', 'completed', 0.1, false);
    expect(await metric(m, 'frontdesk_sweep_last_scheduled_success_timestamp_seconds')).toBe(0);
    expect(
      await metric(m, 'frontdesk_sweep_last_manual_success_timestamp_seconds'),
    ).toBeGreaterThan(1.7e9);
    m.sweepFinished('SYSTEM', 'completed', 0.1, false, 'external');
    expect(
      await metric(m, 'frontdesk_sweep_last_scheduled_success_timestamp_seconds'),
    ).toBeGreaterThan(1.7e9);
    expect(
      await metric(
        m,
        'frontdesk_sweep_invocations_total{initiator="system",trigger="external",outcome="completed"}',
      ),
    ).toBe(1);
  });
});
