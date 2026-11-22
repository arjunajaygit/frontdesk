/**
 * AUTHORISED recovery of lost plaintext logins (e.g. the M5 incident) WITHOUT deleting any data:
 * replaces ONLY password hashes of existing users in ONE explicitly named database and records the new random
 * passwords in that database's own credentials file. Refuses to run without the double-confirmation flag.
 *
 *   npx tsx scripts/reset-passwords.ts --db frontdesk --confirm-reset-passwords-for frontdesk
 */
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  CREDENTIAL_LOCK_NAME,
  assertCredentialsWritable,
  credentialsFileFor,
  writeCredentials,
} from '../prisma/credentials';

async function main() {
  const arg = (n: string) => process.argv[process.argv.indexOf(n) + 1];
  const db = arg('--db');
  if (!db || arg('--confirm-reset-passwords-for') !== db)
    throw new Error('refusing: pass --db <name> and --confirm-reset-passwords-for <same name>');
  if (!/^[a-z0-9_]{1,63}$/.test(db)) throw new Error('invalid database name');
  const envFile = path.resolve(__dirname, '../.env');
  const line = existsSync(envFile)
    ? /^MIGRATION_DATABASE_URL=(.*)$/m.exec(readFileSync(envFile, 'utf8'))
    : null;
  if (!line?.[1]) throw new Error('MIGRATION_DATABASE_URL missing from .env');
  const u = new URL(line[1]);
  u.pathname = `/${db}`;
  const prisma = new PrismaClient({ datasources: { db: { url: u.toString() } } });
  try {
    // One transaction holding the per-database credential lock (final audit M02): discovery, generation, file
    // record and hash update can never interleave with a seed or another reset on the same database.
    const users = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CREDENTIAL_LOCK_NAME}, 0))`;
        const found = await tx.user.findMany({
          select: { id: true, email: true },
          orderBy: { email: 'asc' },
        });
        // Refuse before the (slow) hashing and before any change if this would clobber recorded logins.
        assertCredentialsWritable(
          credentialsFileFor(db),
          found.map((x) => x.email),
          false,
        );
        const fresh: Record<string, string> = {};
        for (const x of found) fresh[x.email] = randomBytes(15).toString('base64url');
        const hashes = await Promise.all(
          found.map((x) => argon2.hash(fresh[x.email]!, { type: argon2.argon2id })),
        );
        // Record the plaintext FIRST (atomic, refuses to clobber); then change hashes in this same transaction.
        writeCredentials(credentialsFileFor(db), fresh, false);
        for (const [i, x] of found.entries())
          await tx.user.update({ where: { id: x.id }, data: { passwordHash: hashes[i]! } });
        return found;
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
    console.log(
      `reset ${users.length} password hashes in ${db}; new passwords saved to .local/credentials.${db}.json (0600)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
