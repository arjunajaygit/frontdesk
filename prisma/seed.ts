/**
 * Reproducible, idempotent historical seed (DEMO_SCENARIOS FD-001..FD-015).
 *
 * History is produced by the REAL domain engine (TicketLifecycle) replaying commands at scenario-relative
 * times, so seeded clocks, versions, messages and audit events obey exactly the rules the API enforces.
 * Runs as the schema OWNER (MIGRATION_DATABASE_URL). Per-ticket idempotency via deterministic ids.
 * SEED_ANCHOR (ISO) pins timestamps for tests; default = now.
 * Demo passwords are random per account, written to .local/demo-credentials.json (git-ignored).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import type { Priority } from '@frontdesk/contracts';
import { KernelBusinessCalendar } from '../apps/api/src/domain/calendar/business-calendar';
import { ArvoSlaPolicy } from '../apps/api/src/domain/sla/sla-policy';
import type { CustomerActor, StaffActor } from '../apps/api/src/domain/ticket/actor';
import {
  IdGenerator,
  MutationResult,
  TicketLifecycle,
} from '../apps/api/src/domain/ticket/ticket-lifecycle';
import type { TicketAggregate } from '../apps/api/src/domain/ticket/ticket.types';
import {
  auditToRow,
  clockToRow,
  messageToRow,
  ticketToRow,
} from '../apps/api/src/infrastructure/persistence/ticket-mapper';
import {
  CREDENTIAL_LOCK_NAME,
  assertCredentialsWritable,
  credentialsFileFor,
  targetDatabase,
  writeCredentials,
} from './credentials';
import { AGENTS, CUSTOMERS, HOLIDAYS, PRIVATE_NOTE_MARKER } from './seed-data';

const MIN = 60_000;
const DAY = 86_400_000;
const IST_OFFSET = 330 * MIN;

export function uuidFor(name: string): string {
  const h = createHash('sha1').update(`frontdesk-seed:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * Scenario timestamp helpers. They only *choose* realistic instants; every working-time question is
 * answered by the shared BusinessCalendar (no second calendar implementation).
 */
class ScenarioTime {
  constructor(private readonly cal: KernelBusinessCalendar) {}
  dayStart = (t: number) => Math.floor((t + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
  weekday = (d: number) => new Date(d + IST_OFFSET).getUTCDay();
  isWorkingDay = (d: number) => this.cal.workingMsBetween(d, d + DAY) > 0;
  at = (d: number, hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return d + h! * 60 * MIN + m! * MIN;
  };
  /** Largest s <= t with workingMsBetween(s, t) >= ms (binary search on a monotone function). */
  sub(t: number, ms: number): number {
    let lo = t - 60 * DAY;
    let hi = t;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.cal.workingMsBetween(mid, t) >= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  /** Latest instant <= t that ends a working millisecond (t itself during working hours). */
  workNow = (t: number) => this.sub(t, 1) + 1;
  /** n-th working day start before-or-at the day of workNow(anchor). */
  wd(anchor: number, n: number): number {
    let d = this.dayStart(this.workNow(anchor));
    for (let i = 0; i < n;) {
      d -= DAY;
      if (this.isWorkingDay(d)) i++;
    }
    return d;
  }
  nextWorkingDay(d: number): number {
    do d += DAY;
    while (!this.isWorkingDay(d));
    return d;
  }
}

/** Deterministic ids per scenario; the ticket id is stable across seed versions (idempotency key). */
function scenarioIds(no: string): IdGenerator {
  const n: Record<string, number> = {};
  return {
    next(kind) {
      const i = (n[kind] = (n[kind] ?? -1) + 1);
      return kind === 'ticket' && i === 0 ? uuidFor(`ticket:${no}`) : uuidFor(`${kind}:${no}:${i}`);
    },
  };
}

/** Replays one scenario through the lifecycle and keeps every result for persistence. */
class Scenario {
  readonly results: MutationResult[] = [];
  agg!: TicketAggregate;
  readonly lc: TicketLifecycle;

  constructor(
    readonly no: string,
    cal: KernelBusinessCalendar,
  ) {
    this.lc = new TicketLifecycle({
      calendar: cal,
      policy: new ArvoSlaPolicy(cal),
      ids: scenarioIds(no),
    });
  }
  private push(r: MutationResult) {
    this.results.push(r);
    this.agg = r.aggregate;
    return this;
  }
  customerIntake(c: CustomerActor, subject: string, body: string, at: number) {
    return this.push(
      this.lc.customerIntake({ actor: c, subject: `[${this.no}] ${subject}`, body, now: at }),
    );
  }
  /** Phone/email intake recorded by staff with an explicit priority (INTAKE never satisfies RESPONSE). */
  staffIntake(
    s: StaffActor,
    c: CustomerActor,
    priority: Priority,
    subject: string,
    body: string,
    at: number,
  ) {
    return this.push(
      this.lc.staffIntake({
        actor: s,
        customerId: c.id,
        subject: `[${this.no}] ${subject}`,
        body,
        priority,
        now: at,
      }),
    );
  }
  claim = (s: StaffActor, at: number) => this.push(this.lc.claim(this.agg, s, at));
  reply = (s: StaffActor, body: string, at: number) =>
    this.push(this.lc.publicReply(this.agg, s, body, at));
  note = (s: StaffActor, body: string, at: number) =>
    this.push(this.lc.addNote(this.agg, s, body, at));
  request = (s: StaffActor, body: string, at: number) =>
    this.push(this.lc.requestInformation(this.agg, s, body, at));
  priority = (s: StaffActor, p: Priority, at: number) =>
    this.push(this.lc.changePriority(this.agg, s, p, at));
  resolve = (s: StaffActor, body: string, at: number) =>
    this.push(this.lc.resolve(this.agg, s, body, at));
  customerReply(c: CustomerActor, body: string, at: number) {
    const r = this.lc.customerReply(this.agg, c, body, at);
    if (r.outcome !== 'SAME_TICKET')
      throw new Error(`${this.no}: scenario expects the same ticket`);
    return this.push(r.result);
  }
  /** Record due breaches as the sweep would (only used where the scenario says "breach recorded"). */
  sweep(at: number) {
    const r = this.lc.reconcileDue(this.agg, at);
    return r.changed ? this.push(r) : this;
  }
}

export interface SeedOptions {
  anchor: number;
  /** Environment-specific file (derive with credentialsFileFor); null = do not record credentials (tests). */
  credentialsFile?: string | null;
  allowCredentialOverwrite?: boolean;
}
export interface SeedReport {
  usersCreated: number;
  ticketsCreated: number;
  ticketsSkipped: number;
  holidays: number;
}

export async function runSeed(prisma: PrismaClient, opts: SeedOptions): Promise<SeedReport> {
  const cal = new KernelBusinessCalendar(HOLIDAYS.map((h) => h.day));
  const time = new ScenarioTime(cal);
  const anchor = opts.anchor;
  const report: SeedReport = {
    usersCreated: 0,
    ticketsCreated: 0,
    ticketsSkipped: 0,
    holidays: HOLIDAYS.length,
  };

  for (const h of HOLIDAYS) {
    const day = new Date(`${h.day}T00:00:00Z`);
    await prisma.holiday.upsert({
      where: { day },
      update: { name: h.name },
      create: { day, name: h.name },
    });
  }

  const creds: Record<string, string> = {};
  const staff = new Map<string, StaffActor>();
  const customers = new Map<string, CustomerActor>();
  // The whole credential-producing operation runs in ONE transaction holding a per-database advisory lock
  // (final audit M02): an overlapping authorised seed/reset waits here and then sees the committed users.
  const created = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CREDENTIAL_LOCK_NAME}, 0))`;
      // Phase 1: find missing users and generate their passwords (no database change yet).
      const toCreate: Array<{
        u: (typeof AGENTS)[number] | (typeof CUSTOMERS)[number];
        id: string;
      }> = [];
      for (const u of [...AGENTS, ...CUSTOMERS]) {
        const existing = await tx.user.findUnique({ where: { email: u.email } });
        const id = existing?.id ?? uuidFor(`user:${u.key}`);
        if (!existing) {
          toCreate.push({ u, id });
          creds[u.email] = randomBytes(15).toString('base64url');
        }
        if (u.role === 'CUSTOMER') customers.set(u.key, { type: 'CUSTOMER', id });
        else staff.set(u.key, { type: u.role, id });
      }
      // Phase 2: record the plaintext FIRST (pre-checked, atomic, file-locked, 0600, refuses to clobber, never
      // printed). A stale entry for a user whose creation later fails is recoverable; a hash without its plaintext is not.
      if (opts.credentialsFile && toCreate.length) {
        assertCredentialsWritable(
          opts.credentialsFile,
          Object.keys(creds),
          opts.allowCredentialOverwrite,
        );
        writeCredentials(opts.credentialsFile, creds, opts.allowCredentialOverwrite);
      }
      // Phase 3: only now store the hashes (same transaction, same lock).
      for (const { u, id } of toCreate) {
        await tx.user.create({
          data: {
            id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            passwordHash: await argon2.hash(creds[u.email]!, { type: argon2.argon2id }),
          },
        });
      }
      return toCreate.length;
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
  report.usersCreated += created;
  const S = (k: string) => staff.get(k)!;
  const C = (k: string) => customers.get(k)!;

  const wn = time.workNow(anchor);
  const T = (n: number, hhmm: string) => time.at(time.wd(anchor, n), hhmm);
  const lastFriday = (() => {
    for (let d = time.dayStart(anchor); ; d -= DAY) {
      if (time.isWorkingDay(d) && time.weekday(d) === 5 && time.at(d, '18:00') <= anchor) return d;
    }
  })();

  const scenarios: Scenario[] = [];
  const sc = (no: string) => {
    const s = new Scenario(no, cal);
    scenarios.push(s);
    return s;
  };

  // FD-001 urgent: response and resolution both overdue; breaches recorded by the (simulated) sweep.
  sc('FD-001')
    .staffIntake(
      S('arjun'),
      C('aarav'),
      'URGENT',
      'Production API returning 500s',
      'Our order API has been failing since this morning.',
      T(3, '10:00'),
    )
    .claim(S('arjun'), T(3, '10:20'))
    .sweep(anchor);
  // FD-002 medium: response on time, resolution overdue (recorded).
  sc('FD-002')
    .customerIntake(
      C('diya'),
      'Invoice export mismatch',
      'Exported invoices do not match the dashboard totals.',
      T(6, '09:45'),
    )
    .claim(S('priya'), T(6, '10:00'))
    .reply(S('priya'), 'We are reproducing the mismatch now.', T(6, '11:00'))
    .sweep(anchor);
  // FD-003 Friday 18:00 medium, left OPEN (may be overdue relative to the anchor; never labelled on track).
  sc('FD-003').customerIntake(
    C('sana'),
    'Weekend-crossing support request',
    'Raised just before the weekend; please look Monday.',
    time.at(lastFriday, '18:00'),
  );
  // FD-004 / FD-005 unassigned for claim races.
  sc('FD-004').customerIntake(
    C('aarav'),
    'Shared mailbox rule not applying',
    'Two agents will try to claim this one.',
    anchor - 2 * MIN,
  );
  sc('FD-005').customerIntake(
    C('diya'),
    'SSO login loop for one user',
    'Nine-agent contention fixture.',
    anchor - MIN,
  );
  // FD-006 waiting ~2 working days.
  sc('FD-006')
    .customerIntake(
      C('sana'),
      'Report scheduling question',
      'How do I schedule weekly reports?',
      T(4, '10:00'),
    )
    .claim(S('rohan'), T(4, '10:10'))
    .reply(S('rohan'), 'Happy to help with scheduling.', T(4, '10:30'))
    .request(S('rohan'), 'Which timezone should the report use? Please confirm.', T(2, '11:00'));
  // FD-007 waiting ~6 working days: strictly past the 2700-minute cutoff (unprocessed sweep candidate).
  sc('FD-007')
    .staffIntake(
      S('kavya'),
      C('aarav'),
      'LOW',
      'Bulk import failed validation',
      'The CSV import rejects every row.',
      T(8, '10:00'),
    )
    .claim(S('kavya'), T(8, '10:15'))
    .reply(S('kavya'), 'Looking into the importer.', T(8, '10:30'))
    .request(S('kavya'), 'Please share the CSV header row so we can compare.', T(6, '11:00'));
  // FD-008 resolved ~2 calendar days ago (reopen window open).
  const r8 = time.workNow(anchor - 2 * DAY);
  sc('FD-008')
    .customerIntake(
      C('diya'),
      'Password reset email delayed',
      'Reset emails arrive after an hour.',
      time.sub(r8, 300 * MIN),
    )
    .claim(S('vikram'), time.sub(r8, 290 * MIN))
    .reply(S('vikram'), 'We are checking the mail queue.', time.sub(r8, 120 * MIN))
    .resolve(S('vikram'), 'Queue backlog cleared; emails now arrive immediately.', r8);
  // FD-009 resolved ~10 calendar days ago (window expired; unprocessed sweep candidate).
  const r9 = time.workNow(anchor - 10 * DAY);
  sc('FD-009')
    .staffIntake(
      S('ananya'),
      C('sana'),
      'LOW',
      'Dashboard widget blank',
      'The usage widget shows no data.',
      time.sub(r9, 400 * MIN),
    )
    .claim(S('ananya'), time.sub(r9, 390 * MIN))
    .reply(S('ananya'), 'We will refresh the aggregates.', time.sub(r9, 200 * MIN))
    .resolve(S('ananya'), 'Aggregates rebuilt; widget populated.', r9);
  // FD-010 public + private messages (private marker for leak tests).
  sc('FD-010')
    .customerIntake(
      C('aarav'),
      'Billing address change',
      'Please update our billing address.',
      T(2, '10:00'),
    )
    .claim(S('imran'), T(2, '10:10'))
    .reply(S('imran'), 'Happy to help; can you confirm the new address?', T(2, '10:30'))
    .note(
      S('imran'),
      `${PRIVATE_NOTE_MARKER}: customer previously disputed an invoice; handle with care.`,
      T(2, '10:35'),
    )
    .customerReply(C('aarav'), 'New address: 12 Example Road, Bengaluru.', T(2, '11:00'))
    .reply(S('imran'), 'Updated. You will see it on the next invoice.', T(2, '11:30'));
  // FD-011 LOW, response RUNNING with 150 active minutes elapsed at the anchor, no public staff reply.
  const c11 = time.sub(wn, 150 * MIN);
  sc('FD-011')
    .staffIntake(
      S('sneha'),
      C('diya'),
      'LOW',
      'Escalation candidate: sync stalled',
      'Data sync has stalled for our whole warehouse team.',
      c11,
    )
    .claim(S('sneha'), c11 + 10 * MIN);
  // FD-012 paused LOW resolution: cycle start 17:30, 90 active minutes before waiting, response completed.
  const x = time.wd(anchor, 3);
  sc('FD-012')
    .staffIntake(
      S('meera'),
      C('sana'),
      'LOW',
      'Escalation while paused',
      'Cannot export audit logs; deadline tomorrow.',
      time.at(x, '17:30'),
    )
    .claim(S('meera'), time.at(x, '17:35'))
    .reply(S('meera'), 'Investigating the export job.', time.at(x, '17:50'))
    .request(
      S('meera'),
      'Please confirm which date range you need.',
      time.at(time.nextWorkingDay(x), '10:00'),
    );
  // FD-013 festival holiday crossing (Fri 2026-11-06 17:30 -> configured holiday Mon 2026-11-09).
  const f13 = Date.parse('2026-11-06T17:30:00+05:30');
  sc('FD-013')
    .customerIntake(
      C('aarav'),
      'Holiday-crossing deadline',
      'Warehouse scanner firmware update failing.',
      f13,
    )
    .claim(S('arjun'), f13 + 15 * MIN)
    .reply(
      S('arjun'),
      'Firmware rollback package prepared.',
      Date.parse('2026-11-10T11:00:00+05:30'),
    );
  // FD-014 audit reconstruction: reply, request, customer resume, escalation to URGENT.
  sc('FD-014')
    .customerIntake(
      C('diya'),
      'Audit reconstruction exemplar',
      'Intermittent timeouts on report generation.',
      T(5, '10:00'),
    )
    .claim(S('priya'), T(5, '10:10'))
    .reply(S('priya'), 'Collecting timing traces.', T(5, '10:40'))
    .request(S('priya'), 'Please run the report once more and send the time.', T(5, '14:00'))
    .customerReply(C('diya'), 'Ran it again at 11:00; still timing out.', T(4, '11:00'))
    .priority(S('priya'), 'URGENT', T(4, '15:00'));
  // FD-015 first public reply COMPLETED with a known completion time.
  sc('FD-015')
    .customerIntake(
      C('sana'),
      'Response completed before escalation',
      'Need guidance on role permissions.',
      T(1, '10:00'),
    )
    .claim(S('kavya'), T(1, '10:05'))
    .reply(
      S('kavya'),
      'Here is the permissions matrix; reply if anything is unclear.',
      T(1, '10:50'),
    );

  for (const s of scenarios) {
    const id = s.agg.ticket.id;
    if (await prisma.ticket.findUnique({ where: { id }, select: { id: true } })) {
      report.ticketsSkipped++;
      continue;
    }
    await prisma.$transaction(async (tx) => {
      await tx.ticket.create({ data: ticketToRow(s.agg.ticket) });
      await tx.message.createMany({ data: s.results.flatMap((r) => r.messages.map(messageToRow)) });
      await tx.slaClock.createMany({ data: s.agg.clocks.map(clockToRow) });
      let seq = 0;
      const audits = s.results.flatMap((r, i) =>
        r.events.map((e) => {
          const n = seq++;
          return auditToRow(e, {
            id: uuidFor(`audit:${s.no}:${n}`),
            correlationId: uuidFor(`corr:${s.no}:${i}`),
            eventKey: `seed:${s.no}:${n}`,
          });
        }),
      );
      await tx.auditEvent.createMany({ data: audits });
    });
    report.ticketsCreated++;
  }
  return report;
}

function loadDotEnv(file: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2];
    }
  }
  return env;
}

/** Serialises complete seed runs on one database (users + historical tickets); see main(). */
const SEED_RUN_LOCK_NAME = 'frontdesk:seed-run';

async function main() {
  const env = loadDotEnv(path.resolve(__dirname, '../.env'));
  const url = env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required (seed runs as the owner role)');
  const anchor = env.SEED_ANCHOR ? Date.parse(env.SEED_ANCHOR) : Date.now();
  if (!Number.isFinite(anchor)) throw new Error('SEED_ANCHOR must be an ISO timestamp');
  if (env.NODE_ENV === 'production' && env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed production without ALLOW_DEMO_SEED=true');
  }
  // Explicit targeting: credentials are either deliberately skipped or written to <.local/credentials.<db>.json>.
  if (env.SEED_CREDENTIALS !== 'none' && env.SEED_CREDENTIALS !== 'write') {
    throw new Error(
      'set SEED_CREDENTIALS=write (record new passwords for this database) or SEED_CREDENTIALS=none',
    );
  }
  const noCredentials = env.SEED_CREDENTIALS === 'none';
  // ONE connection, so the session-level advisory lock below and every seed statement share a backend: the lock
  // serialises whole seed runs per database (final audit M02 — two authorised overlapping seeds would otherwise
  // race on users AND historical tickets). Released explicitly, and by PostgreSQL if the process dies.
  const single = new URL(url);
  single.searchParams.set('connection_limit', '1');
  const prisma = new PrismaClient({ datasources: { db: { url: single.toString() } } });
  try {
    await prisma.$executeRaw`SELECT pg_advisory_lock(hashtextextended(${SEED_RUN_LOCK_NAME}, 0))`;
    const r = await runSeed(prisma, {
      anchor: Math.floor(anchor),
      credentialsFile: noCredentials
        ? null
        : credentialsFileFor(targetDatabase(url), env.SEED_TARGET_LABEL),
      allowCredentialOverwrite: env.SEED_ALLOW_CREDENTIAL_OVERWRITE === 'true',
    });
    console.log(JSON.stringify({ anchor: new Date(anchor).toISOString(), ...r }));
  } finally {
    await prisma.$executeRaw`SELECT pg_advisory_unlock_all()`.catch(() => undefined);
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
