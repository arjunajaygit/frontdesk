import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Credential-file safety (M6, after the M5 overwrite incident):
 *  - the file name is DERIVED from the target database (`.local/credentials.<db>.json`), so one environment can
 *    never write into another's file; there is no free-form output path any more;
 *  - an existing entry is never replaced unless SEED_ALLOW_CREDENTIAL_OVERWRITE=true;
 *  - the write is atomic (temp file, mode 0600, fsync, rename), serialised by an exclusive lock file, confined to
 *    the credentials directory after path normalisation, and the contents are never printed;
 *  - callers check writability BEFORE changing hashes and record plaintext BEFORE committing new hashes, so a
 *    password hash can never exist without its recorded plaintext (the M5 failure mode).
 */
export const LOCAL_DIR = path.resolve(__dirname, '..', '.local');

export function targetDatabase(connectionUrl: string): string {
  const db = decodeURIComponent(new URL(connectionUrl).pathname.replace(/^\//, ''));
  if (!/^[a-z0-9_]{1,63}$/.test(db))
    throw new Error('refusing to derive a credentials file from an unusual database name');
  return db;
}

/** `label` distinguishes environments that share a database NAME (e.g. two clusters both called `frontdesk`). */
export function credentialsFileFor(db: string, label?: string): string {
  const name = label ?? db;
  if (!/^[a-z0-9_-]{1,63}$/.test(name)) throw new Error('invalid credentials target label');
  return path.join(LOCAL_DIR, `credentials.${name}.json`);
}

/**
 * Name of the PostgreSQL advisory lock that serialises EVERY credential-producing operation on one database
 * (seed user creation, password reset): discovery -> generation -> file record -> hash insert/update all happen
 * inside one transaction holding pg_advisory_xact_lock(hashtextextended(<this>, 0)). Final audit M02: the file
 * lock alone ended before the database insert, so two authorised overlapping runs could record one run's
 * passwords while committing the other's hashes. Transaction-scoped: released on commit, rollback or crash.
 */
export const CREDENTIAL_LOCK_NAME = 'frontdesk:credential-producing-operation';

export class CredentialOverwriteError extends Error {
  constructor(readonly emails: string[]) {
    super(
      `refusing to overwrite ${emails.length} existing credential entr${emails.length === 1 ? 'y' : 'ies'}; ` +
        'set SEED_ALLOW_CREDENTIAL_OVERWRITE=true only if you really intend to replace them',
    );
    this.name = 'CredentialOverwriteError';
  }
}

function resolveUnder(file: string, baseDir: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(file); // collapses `..` so a raw prefix match cannot be bypassed
  if (path.dirname(resolved) !== base)
    throw new Error('credential files must live directly under .local/');
  return resolved;
}

function readExisting(file: string): Record<string, string> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
}

/** Pre-flight: call BEFORE changing any password hash, so a refusal can never strand un-recorded logins. */
export function assertCredentialsWritable(
  file: string,
  emails: string[],
  allowOverwrite = false,
  baseDir = LOCAL_DIR,
): void {
  const resolved = resolveUnder(file, baseDir);
  const existing = readExisting(resolved);
  const clash = emails.filter((e) => e in existing);
  if (clash.length && !allowOverwrite) throw new CredentialOverwriteError(clash);
}

export function writeCredentials(
  file: string,
  fresh: Record<string, string>,
  allowOverwrite = false,
  baseDir = LOCAL_DIR,
): void {
  const resolved = resolveUnder(file, baseDir);
  mkdirSync(path.resolve(baseDir), { recursive: true, mode: 0o700 });
  // Exclusive lock: two concurrent seeds/resets could otherwise both read-merge-write and lose entries.
  const lock = `${resolved}.lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lock, 'wx', 0o600);
  } catch {
    throw new Error(
      'another credential write is in progress (or crashed); remove the .lock file only if none is running',
    );
  }
  const tmp = `${resolved}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const existing = readExisting(resolved);
    const clash = Object.keys(fresh).filter((e) => e in existing);
    if (clash.length && !allowOverwrite) throw new CredentialOverwriteError(clash);
    const fd = openSync(tmp, 'wx', 0o600); // fails if it exists; never world-readable
    try {
      writeSync(fd, JSON.stringify({ ...existing, ...fresh }, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, resolved); // atomic replace
  } finally {
    rmSync(tmp, { force: true }); // no-op after a successful rename; removes a partial temp file on failure
    closeSync(lockFd);
    rmSync(lock, { force: true });
  }
}
