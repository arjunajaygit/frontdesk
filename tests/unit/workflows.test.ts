import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** Offline policy checks for CI/CD configuration (supply-chain hygiene). Real execution needs a remote run. */
const dir = join(__dirname, '../../.github/workflows');
const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
type Job = {
  needs?: string | string[];
  'timeout-minutes'?: number;
  steps?: { uses?: string; run?: string }[];
  permissions?: unknown;
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};
const load = (f: string): Workflow => parse(readFileSync(join(dir, f), 'utf8')) as Workflow;

describe('GitHub Actions workflows', () => {
  it('exist for CI, security and CodeQL', () =>
    expect(files.sort()).toEqual(['ci.yml', 'codeql.yml', 'release.yml', 'security.yml']));

  it.each(files)(
    '%s: least-privilege default token, no pull_request_target, every job has a timeout',
    (f) => {
      const w = load(f);
      expect(w.permissions).toEqual({ contents: 'read' });
      expect(Object.keys(w.on)).not.toContain('pull_request_target');
      for (const [name, job] of Object.entries(w.jobs))
        expect({ f, name, timeout: typeof job['timeout-minutes'] }).toEqual({
          f,
          name,
          timeout: 'number',
        });
    },
  );

  it.each(files)(
    '%s: third-party actions pinned to 40-hex commit SHAs; docker images pinned by digest',
    (f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      const uses = [...text.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]!);
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses)
        expect({ f, u, pinned: /@[0-9a-f]{40}$/.test(u) }).toEqual({ f, u, pinned: true });
      for (const m of text.matchAll(
        /docker run[^\n]*\n?[^\n]*?\s((?:zricethezav|semgrep|aquasec|grafana|zaproxy)\/[^\s"']+)/g,
      ))
        expect(m[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
    },
  );

  it.each(files)(
    '%s: no untrusted GitHub context is interpolated into shell scripts (script injection)',
    (f) => {
      const w = load(f);
      for (const job of Object.values(w.jobs))
        for (const s of job.steps ?? []) {
          expect(s.run ?? '').not.toMatch(/\$\{\{\s*github\.(event\.|head_ref)/);
          expect(s.run ?? '').not.toMatch(/\$\{\{\s*secrets\./);
        }
    },
  );

  it('release workflow: manual dispatch only; gate job first; elevated permissions only on environment-protected jobs', () => {
    const w = load('release.yml');
    expect(Object.keys(w.on)).toEqual(['workflow_dispatch']);
    const jobs = w.jobs as Record<string, Job & { environment?: string; if?: string }>;
    expect(jobs.gate!.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(jobs['build-test-sign']!.needs).toBe('gate');
    expect(jobs['build-test-sign']!.environment).toBe('release');
    expect(jobs['build-test-sign']!.permissions).toEqual({
      contents: 'read',
      packages: 'write',
      'id-token': 'write',
    });
    expect(jobs.deploy!.environment).toBe('release');
    expect(jobs.deploy!.permissions).toEqual({ contents: 'read' });
    for (const f of files.filter((x) => x !== 'release.yml'))
      for (const j of Object.values(load(f).jobs))
        expect(JSON.stringify(j.permissions ?? {})).not.toMatch(
          /packages|id-token|"contents":"write"/,
        ); // CodeQL keeps only security-events
    const text = readFileSync(join(dir, 'release.yml'), 'utf8');
    expect(text).toContain('node scripts/release-gate.mjs gate');
    expect(text).toContain('node scripts/release-gate.mjs digest');
    expect(text).toContain('--platform linux/amd64');
    expect(text).toContain('cosign verify --certificate-identity "$ID"');
    expect(text).not.toMatch(
      /certificate-identity-regexp|--tlog-upload=false|insecure-ignore-tlog/,
    );
  });

  it('CI: jobs depend correctly and the release gate requires every mandatory job to succeed', () => {
    const w = load('ci.yml');
    const jobs = Object.keys(w.jobs);
    expect(jobs).toEqual(
      expect.arrayContaining(['static', 'unit', 'integration', 'e2e', 'docker', 'ci-success']),
    );
    const gate = w.jobs['ci-success']!;
    expect([...(gate.needs as string[])].sort()).toEqual([
      'docker',
      'e2e',
      'integration',
      'static',
      'unit',
    ]);
    const text = readFileSync(join(dir, 'ci.yml'), 'utf8');
    for (const j of ['static', 'unit', 'integration', 'e2e', 'docker'])
      expect(text).toContain(`test "\${{ needs.${j}.result }}" = "success"`);
    for (const job of Object.values(w.jobs))
      for (const n of ([] as string[]).concat(job.needs ?? [])) expect(jobs).toContain(n);
  });

  it('CI runs every mandatory gate somewhere', () => {
    const text = readFileSync(join(dir, 'ci.yml'), 'utf8');
    for (const cmd of [
      'npm run test:calendar',
      'npm run test:unit',
      'npm run test:web',
      'npm run test:integration',
      'npm run test:e2e',
      'npm run typecheck',
      'npx eslint .',
      'npx prettier --check .',
      'gen-audit-schema.ts --check',
      'npx prisma validate',
      'smoke-prod.mjs',
      'docker build --target runtime',
    ])
      expect(text).toContain(cmd);
  });

  it('forked pull requests cannot reach secrets: only the environment-protected release deploy job uses one', () => {
    for (const f of files.filter((x) => x !== 'release.yml'))
      expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/secrets\./);
    const release = load('release.yml');
    for (const [name, job] of Object.entries(
      release.jobs as Record<string, Job & { environment?: string }>,
    )) {
      const uses = JSON.stringify(job).match(/secrets\./g) ?? [];
      if (uses.length)
        expect({ name, environment: job.environment }).toEqual({
          name: 'deploy',
          environment: 'release',
        });
    }
  });
});
