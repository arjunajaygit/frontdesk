// Fails on HIGH/CRITICAL npm advisories in PRODUCTION dependencies unless they are documented, time-limited
// waivers (docs/DEVSECOPS.md). Waivers are matched by advisory id, never by package alone.
import { spawnSync } from 'node:child_process';

const ZOD = { id: 'GHSA-mrhx-c7xc-m3w5', expires: '2027-02-28' };
// Prisma CLI tooling chain (prisma/@prisma/config/effect/deepmerge-ts) enters via @prisma/client's PEER dependency;
// it is excluded from the runtime image (`npm ci --omit=peer`) and exists only as build/migration tooling.
const TOOLING = new Set(['prisma', '@prisma/config', 'effect', 'deepmerge-ts']);

const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
const report = JSON.parse(r.stdout || '{}');
let failed = 0;
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  if (!['high', 'critical'].includes(v.severity)) continue;
  const ids = v.via.filter((x) => typeof x === 'object').map((x) => x.url?.split('/').pop());
  if (TOOLING.has(name)) {
    console.log(`WAIVED (tooling only, not in runtime image): ${v.severity} ${name}`);
  } else if (
    name === 'zod' &&
    ids.every((i) => i === ZOD.id) &&
    new Date() < new Date(ZOD.expires)
  ) {
    console.log(
      `WAIVED (unreachable; expires ${ZOD.expires}): ${v.severity} ${name} ${ids.join(',')}`,
    );
  } else {
    console.log(`FAIL: ${v.severity} ${name} ${ids.join(',')}`);
    failed++;
  }
}
console.log(
  failed
    ? `${failed} unwaived high/critical advisory(ies)`
    : 'npm audit gate: no unwaived high/critical advisories',
);
process.exit(failed ? 1 : 0);
