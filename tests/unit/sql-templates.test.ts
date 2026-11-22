import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const migrations = readdirSync(join(root, 'prisma/migrations'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const migrationSql = (suffix: string) => {
  const dir = migrations.find((m) => m.endsWith(suffix));
  if (!dir) throw new Error(`migration ${suffix} missing`);
  return readFileSync(join(root, 'prisma/migrations', dir, 'migration.sql'), 'utf8');
};
const body = (sql: string) => sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));

describe('SQL templates are the executed migrations (no drift)', () => {
  it.each([
    ['domain_constraints.sql', 'domain_constraints'],
    ['audit_immutability.sql', 'audit_immutability_and_grants'],
  ])('%s is fully contained in migration *_%s', (template, suffix) => {
    const tpl = body(readFileSync(join(root, 'prisma/sql', template), 'utf8'));
    const mig = migrationSql(suffix)
      .split('\n')
      .map((l) => l.trim());
    for (const line of tpl)
      expect({ template, line, present: mig.includes(line.trim()) }).toEqual({
        template,
        line,
        present: true,
      });
  });

  it('migrations are ordered baseline -> constraints -> immutability/grants -> retention -> function hardening (M8)', () => {
    expect(migrations.map((m) => m.replace(/^\d+_/, ''))).toEqual([
      'baseline_schema',
      'domain_constraints',
      'audit_immutability_and_grants',
      'retention_grants',
      'function_execute_hardening',
    ]);
  });
});
