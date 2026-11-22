import { Client } from 'pg';
import { connect, roleUrl } from '../helpers/db';
import { Browser, conforms, newKey, signedIn, start, startApp, TestApp } from '../helpers/http';
import { LockHolder, Observer } from '../helpers/observe';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/**
 * PROOF-02 / INC-0291 — exclusive claiming under REAL PostgreSQL contention.
 * Overlap is forced and observed: a barrier transaction holds the ticket row; every contender's request is
 * confirmed (pg_stat_activity, wait_event_type=Lock) to be blocked inside PostgreSQL on that row before the
 * barrier is released. Contenders are independently authenticated sessions; the app pool gives each its own
 * connection. Bounded repetition: REPS per contention level.
 */
const REPS = 5;
const STAFF = [
  'meera.iyer@arvo.example',
  'arjun.nair@arvo.example',
  'priya.sharma@arvo.example',
  'rohan.mehta@arvo.example',
  'kavya.reddy@arvo.example',
  'vikram.singh@arvo.example',
  'ananya.das@arvo.example',
  'imran.khan@arvo.example',
  'sneha.patil@arvo.example',
];
const TICKET_LOCK = '%FROM "Ticket"%FOR UPDATE%';

let t: TestApp;
let db: string;
let owner: Client;
let observer: Observer;
let agents: Browser[];
let customer: Browser;

beforeAll(async () => {
  db = await cloneTemplate('proof02');
  // Explicit pool: Prisma's default (2 x CPUs + 1) is only 5 on a 2-vCPU CI runner, which would queue contenders in
  // the app instead of letting all nine reach the PostgreSQL row lock this proof observes.
  t = await startApp(db, {
    DB_LOCK_TIMEOUT_MS: '20000',
    DATABASE_URL: `${roleUrl('app', db)}?connection_limit=20`,
  }); // barrier may be held while 9 waiters are observed
  owner = await connect('owner', db);
  observer = await Observer.open(db);
  agents = await Promise.all(STAFF.map((e) => signedIn(t, e)));
  customer = await signedIn(t, 'aarav.menon@customer.example');
  expect(new Set(agents.map((a) => a.viewer!.id)).size).toBe(9); // nine distinct identities
});
afterAll(async () => {
  await owner?.end();
  await observer?.close();
  await t?.close();
  await dropDatabase(db);
});

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await owner.query(sql, p)).rows as T[];
async function openTicket(): Promise<string> {
  const r = await customer.post('/api/customer/tickets', {
    subject: 'Claim race',
    body: 'Who takes it?',
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function race(n: number) {
  const id = await openTicket();
  const holder = await LockHolder.hold(db, `SELECT id FROM "Ticket" WHERE id=$1 FOR UPDATE`, [id]);
  const contenders = agents.slice(0, n);
  const pending = contenders.map((a) => start(a.post(`/api/tickets/${id}/claim`)));
  const observed = await observer.waitForLockWaiters(TICKET_LOCK, n); // all n blocked inside PostgreSQL
  await holder.release();
  const responses = await Promise.all(pending);
  return { id, observed, responses, contenders };
}

describe.each([2, 9])('PROOF-02: %i independently authenticated agents, forced overlap', (n) => {
  it.each(Array.from({ length: REPS }, (_, i) => i + 1))(
    `repetition %i/${REPS}: one 200, ${n - 1} x 409, one assignee, one claim event`,
    async () => {
      const { id, observed, responses, contenders } = await race(n);
      expect(observed).toBeGreaterThanOrEqual(n);
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, ...Array(n - 1).fill(409)]);
      const winnerIdx = responses.findIndex((r) => r.status === 200);
      const winner = responses[winnerIdx]!;
      conforms('StaffTicket', winner.body);
      for (const loser of responses.filter((r) => r.status === 409)) {
        conforms('StaffClaimConflict', loser.body);
        expect(loser.body).toMatchObject({
          code: 'CLAIM_CONFLICT',
          assignedAgentDisplayName: contenders[winnerIdx]!.viewer!.displayName,
        });
      }
      const [tk] = await q(`SELECT status, "assigneeId", version FROM "Ticket" WHERE id=$1`, [id]);
      expect(tk).toEqual({
        status: 'IN_PROGRESS',
        assigneeId: contenders[winnerIdx]!.viewer!.id,
        version: 1,
      });
      expect(
        await q(
          `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='TICKET_CLAIMED'`,
          [id],
        ),
      ).toEqual([{ n: 1 }]);
      // Losers cannot perform assignee-only operations.
      const loser = contenders.find((_, i) => i !== winnerIdx)!;
      for (const r of [
        await loser.post(`/api/tickets/${id}/replies`, { body: 'me too' }),
        await loser.post(`/api/tickets/${id}/notes`, { body: 'me too' }),
        await loser.post(`/api/tickets/${id}/wait`, { body: 'me too' }),
        await loser.patch(`/api/tickets/${id}/priority`, { priority: 'URGENT' }),
      ]) {
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('NOT_ASSIGNEE');
      }
    },
  );
});

describe('PROOF-02: database-level audit rejection rolls the claim back atomically', () => {
  it('a real PostgreSQL trigger rejects the TICKET_CLAIMED insert -> nothing persists; after removal a retry succeeds', async () => {
    const id = await openTicket();
    // Isolated failure injection (scratch DB only), scoped to this ticket's claim event.
    await owner.query(`
      CREATE FUNCTION public.proof02_reject_claim_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.action = 'TICKET_CLAIMED' AND NEW."ticketId" = '${id}' THEN
          RAISE EXCEPTION 'proof02: injected audit rejection';
        END IF;
        RETURN NEW;
      END $f$`);
    await owner.query(
      `CREATE TRIGGER proof02_reject_claim BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.proof02_reject_claim_audit()`,
    );
    const key = newKey();
    try {
      const r = await agents[1]!.post(`/api/tickets/${id}/claim`, undefined, key);
      expect(r.status).toBe(500);
      expect(r.text).not.toContain('proof02');
      expect(
        (await q(`SELECT status, "assigneeId", version FROM "Ticket" WHERE id=$1`, [id]))[0],
      ).toEqual({ status: 'OPEN', assigneeId: null, version: 0 });
      expect(
        await q(
          `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='TICKET_CLAIMED'`,
          [id],
        ),
      ).toEqual([{ n: 0 }]);
      expect(
        await q(`SELECT count(*)::int n FROM "IdempotencyRecord" WHERE key=$1`, [key]),
      ).toEqual([{ n: 0 }]);
    } finally {
      await owner.query('DROP TRIGGER IF EXISTS proof02_reject_claim ON public.audit_logs');
      await owner.query('DROP FUNCTION IF EXISTS public.proof02_reject_claim_audit()');
    }
    expect(
      (await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname='proof02_reject_claim'`))[0],
    ).toEqual({ n: 0 });
    const retry = await agents[1]!.post(`/api/tickets/${id}/claim`, undefined, key); // same key: reservation was rolled back
    expect(retry.status).toBe(200);
    expect(
      await q(
        `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='TICKET_CLAIMED'`,
        [id],
      ),
    ).toEqual([{ n: 1 }]);
  });
});
