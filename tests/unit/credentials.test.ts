import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  assertCredentialsWritable,
  CredentialOverwriteError,
  credentialsFileFor,
  targetDatabase,
  writeCredentials,
} from '../../prisma/credentials';

describe('credential file safety (credentials-file overwrite incident)', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'fd-cred-'));
  const file = path.join(base, 'credentials.frontdesk_demo.json');

  it('derives an environment-specific file name from the TARGET database', () => {
    expect(
      path.basename(credentialsFileFor(targetDatabase('postgresql://o:p@h:5432/frontdesk_demo'))),
    ).toBe('credentials.frontdesk_demo.json');
    expect(
      path.basename(credentialsFileFor(targetDatabase('postgresql://o:p@h:5432/frontdesk'))),
    ).toBe('credentials.frontdesk.json');
    expect(path.basename(credentialsFileFor('frontdesk', 'prod-compose'))).toBe(
      'credentials.prod-compose.json',
    ); // same DB name, different environment
    expect(() => credentialsFileFor('frontdesk', '../evil')).toThrow();
    expect(() => targetDatabase('postgresql://o:p@h:5432/..%2Fevil')).toThrow();
  });

  it('writes atomically with mode 0600 and leaves no temp files', () => {
    writeCredentials(file, { 'a@x.example': 'pw-a' }, false, base);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(base)).toEqual(['credentials.frontdesk_demo.json']);
  });

  it('refuses to overwrite an existing entry unless explicitly authorised; other entries merge', () => {
    expect(() => writeCredentials(file, { 'a@x.example': 'new' }, false, base)).toThrow(
      CredentialOverwriteError,
    );
    expect(JSON.parse(readFileSync(file, 'utf8'))['a@x.example']).toBe('pw-a'); // untouched
    writeCredentials(file, { 'b@x.example': 'pw-b' }, false, base);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual([
      'a@x.example',
      'b@x.example',
    ]);
    writeCredentials(file, { 'a@x.example': 'replaced' }, true, base);
    expect(JSON.parse(readFileSync(file, 'utf8'))['a@x.example']).toBe('replaced');
  });

  it('error text never contains a password; files outside the credentials directory are rejected', () => {
    try {
      writeCredentials(file, { 'a@x.example': 'SUPER-SECRET-VALUE' }, false, base);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('SUPER-SECRET-VALUE');
    }
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'fd-outside-')), 'elsewhere.json'); // private dir, not a predictable /tmp name
    writeFileSync(outside, '{}');
    expect(() => writeCredentials(outside, { 'a@x.example': 'x' }, false, base)).toThrow(/under/);
  });

  it('rejects traversal out of the credentials directory even when the path string starts with it', () => {
    const sneaky = path.join(base, '..', 'escaped.json'); // normalised by join; build the raw form too
    const raw = `${base}${path.sep}..${path.sep}escaped-raw.json`;
    expect(() => writeCredentials(sneaky, { 'a@x.example': 'x' }, false, base)).toThrow(/under/);
    expect(() => writeCredentials(raw, { 'a@x.example': 'x' }, false, base)).toThrow(/under/);
  });

  it('a concurrent writer is refused (exclusive lock) and leaves no temp or lock files behind', () => {
    const f = path.join(base, 'credentials.locked.json');
    writeFileSync(`${f}.lock`, '');
    expect(() => writeCredentials(f, { 'z@x.example': 'x' }, false, base)).toThrow(
      /another credential write/,
    );
    rmSync(`${f}.lock`);
    writeCredentials(f, { 'z@x.example': 'x' }, false, base);
    expect(readdirSync(base).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock'))).toEqual([]);
  });

  it('assertCredentialsWritable fails BEFORE any database change when an entry would be clobbered', () => {
    const f = path.join(base, 'credentials.precheck.json');
    writeCredentials(f, { 'p@x.example': 'old' }, false, base);
    expect(() => assertCredentialsWritable(f, ['p@x.example'], false, base)).toThrow(
      CredentialOverwriteError,
    );
    expect(() => assertCredentialsWritable(f, ['q@x.example'], false, base)).not.toThrow();
  });
});
