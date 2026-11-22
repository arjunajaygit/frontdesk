import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import * as argon2 from 'argon2';
import { Client } from 'pg';
import { credentialsFileFor, writeCredentials } from '../../prisma/credentials';
import { AGENTS, CUSTOMERS } from '../../prisma/seed-data';
import { roleUrl, runNode, SEED_ANCHOR } from '../helpers/db';
import { dropDatabase, freshDatabase } from '../helpers/scratch';

/**
 * Credentials-file overwrite incident regression, end to end on real PostgreSQL: the seed must never leave a password hash
 * whose plaintext was not recorded, and a refused credential write must happen BEFORE any user is created.
 */
describe('seed credential recording (real PostgreSQL)', () => {
  const label = `it-${randomBytes(4).toString('hex')}`;
  const file = credentialsFileFor('unused', label);
  let db: string;
  let c: Client;
  const seed = () =>
    runNode(['tsx', 'prisma/seed.ts'], {
      MIGRATION_DATABASE_URL: roleUrl('owner', db),
      SEED_ANCHOR,
      SEED_CREDENTIALS: 'write',
      SEED_TARGET_LABEL: label,
    });
  const userCount = async () => Number((await c.query(`SELECT count(*) n FROM "User"`)).rows[0].n);

  beforeAll(async () => {
    db = await freshDatabase('seedcreds');
    c = new Client({ connectionString: roleUrl('owner', db) });
    await c.connect();
    await c.query(`DELETE FROM "User"`); // start from a database with no users at all
  });
  afterAll(async () => {
    await c?.end();
    rmSync(file, { force: true });
    if (db) await dropDatabase(db);
  });

  it('refuses to clobber an existing entry BEFORE creating any user (no stranded hashes)', async () => {
    writeCredentials(file, { [AGENTS[0]!.email]: 'previously-recorded' });
    const before = readFileSync(file, 'utf8');
    const run = seed();
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toMatch(/refusing to overwrite 1 existing credential entry/);
    expect(run.stderr + run.stdout).not.toContain('previously-recorded');
    expect(await userCount()).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
    rmSync(file);
  });

  it('every created user has a recorded password that verifies against its stored Argon2id hash', async () => {
    const run = seed();
    expect(run.status).toBe(0);
    expect(run.stdout + run.stderr).not.toMatch(/"[A-Za-z0-9_-]{20}"/); // generated passwords are never printed
    // Mode check and content read through ONE descriptor (the file inspected is the file read).
    const fd = openSync(file, 'r');
    let recorded: Record<string, string>;
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      recorded = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, string>;
    } finally {
      closeSync(fd);
    }
    const users = (await c.query(`SELECT email, "passwordHash" h FROM "User" ORDER BY email`)).rows;
    expect(users).toHaveLength(AGENTS.length + CUSTOMERS.length);
    expect(Object.keys(recorded).sort()).toEqual(users.map((u) => u.email).sort());
    for (const u of users) expect(await argon2.verify(u.h, recorded[u.email]!)).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('re-running creates nobody and leaves the recorded passwords untouched', async () => {
    const before = readFileSync(file, 'utf8');
    const run = seed();
    expect(run.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('seed credential recovery after a database failure that follows the credentials write', () => {
  const label = `it-${randomBytes(4).toString('hex')}`;
  const file = credentialsFileFor('unused', label);
  const failOn = AGENTS[2]!.email; // the third user insert fails inside PostgreSQL
  let db: string;
  let c: Client;
  const seed = (extra: Record<string, string> = {}) =>
    runNode(['tsx', 'prisma/seed.ts'], {
      MIGRATION_DATABASE_URL: roleUrl('owner', db),
      SEED_ANCHOR,
      SEED_CREDENTIALS: 'write',
      SEED_TARGET_LABEL: label,
      ...extra,
    });
  const users = async () =>
    (await c.query(`SELECT email, "passwordHash" h FROM "User" ORDER BY email`)).rows as Array<{
      email: string;
      h: string;
    }>;

  beforeAll(async () => {
    db = await freshDatabase('seedrecover');
    c = new Client({ connectionString: roleUrl('owner', db) });
    await c.connect();
    await c.query(`DELETE FROM "User"`);
    await c.query(`CREATE FUNCTION it_fail_user() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.email = '${failOn}' THEN RAISE EXCEPTION 'simulated database failure'; END IF; RETURN NEW; END $$`);
    await c.query(
      `CREATE TRIGGER it_fail_user BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION it_fail_user()`,
    );
  });
  afterAll(async () => {
    await c?.end();
    rmSync(file, { force: true });
    if (db) await dropDatabase(db);
  });

  it('a failure after the write strands no login: user creation is all-or-nothing, so no hash exists without its recorded password', async () => {
    const run = seed();
    expect(run.status).not.toBe(0);
    const created = await users();
    expect(created).toEqual([]); // the failing insert rolled back the whole credential-producing transaction
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    for (const u of created) expect(await argon2.verify(u.h, recorded[u.email]!)).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('re-running without authorisation refuses (stale entries for uncreated users) and changes nothing', async () => {
    await c.query(`DROP TRIGGER it_fail_user ON "User"`);
    const before = readFileSync(file, 'utf8');
    const run = seed();
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toMatch(
      /refusing to overwrite \d+ existing credential entries/,
    );
    expect(await users()).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('explicitly authorised recovery completes the seed; every recorded password verifies', async () => {
    const recordedBefore = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    const run = seed({ SEED_ALLOW_CREDENTIAL_OVERWRITE: 'true' });
    expect(run.status).toBe(0);
    const all = await users();
    expect(all).toHaveLength(AGENTS.length + CUSTOMERS.length);
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    for (const u of all) expect(await argon2.verify(u.h, recorded[u.email]!)).toBe(true);
    // stale entries from the failed run were replaced (authorised); nothing references them any more
    expect(Object.keys(recordedBefore).length).toBeGreaterThan(0);
  });
});
