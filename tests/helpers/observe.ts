import { Client } from 'pg';
import { connect } from './db';

/**
 * Deterministic concurrency evidence: a test-only SUPERUSER observer (pg_stat_activity shows other roles'
 * wait state only to privileged roles) and condition barriers that poll real DB state — never bare sleeps.
 */
export class Observer {
  private constructor(
    private readonly c: Client,
    private readonly db: string,
  ) {}

  static async open(db: string): Promise<Observer> {
    return new Observer(await connect('bootstrap', db), db);
  }

  /** Number of backends in this DB currently blocked on a heavyweight lock while running a matching query. */
  async lockWaiters(queryLike: string): Promise<number> {
    const r = await this.c.query(
      `SELECT count(*)::int n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND query ILIKE $2 AND pid <> pg_backend_pid()`,
      [this.db, queryLike],
    );
    return r.rows[0].n;
  }

  /** Resolve once exactly `n` (or more) matching backends are waiting; fail loudly on timeout. */
  async waitForLockWaiters(queryLike: string, n: number, timeoutMs = 8_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const seen = await this.lockWaiters(queryLike);
      if (seen >= n) return seen;
      if (Date.now() > deadline)
        throw new Error(`expected ${n} lock waiters matching ${queryLike}, saw ${seen}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /** Resolve once PostgreSQL's own clock has passed `instant` (barrier on DB time, not wall time). */
  async untilDbTimeAfter(instant: Date, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.c.query(`SELECT clock_timestamp() > $1::timestamptz AS passed`, [
        instant,
      ]);
      if (r.rows[0].passed) return;
      if (Date.now() > deadline) throw new Error('DB time barrier timed out');
      await new Promise((res) => setTimeout(res, 10));
    }
  }

  async close(): Promise<void> {
    await this.c.end();
  }
}

/** A separate connection that holds a row lock until released (the "barrier" transaction). */
export class LockHolder {
  private constructor(private readonly c: Client) {}

  static async hold(db: string, sql: string, params: unknown[]): Promise<LockHolder> {
    const c = await connect('owner', db);
    await c.query('BEGIN');
    const r = await c.query(sql, params);
    if (r.rowCount !== 1) {
      await c.query('ROLLBACK');
      await c.end();
      throw new Error('lock holder did not lock exactly one row');
    }
    return new LockHolder(c);
  }

  query(sql: string, params: unknown[] = []) {
    return this.c.query(sql, params);
  }

  async release(commit = false): Promise<void> {
    await this.c.query(commit ? 'COMMIT' : 'ROLLBACK');
    await this.c.end();
  }
}
