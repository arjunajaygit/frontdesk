/**
 * Extracts the strict AuditEvent union (+ every schema it references) from the authoritative
 * docs/openapi.draft.yaml into packages/contracts/src/audit-event.schema.json for runtime validation.
 * `--check` exits non-zero on drift (enforced by tests/unit/audit-schema.test.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

type Json = Record<string, unknown>;
const root = resolve(__dirname, '..');
export const OUT = resolve(root, 'packages/contracts/src/audit-event.schema.json');

export function extractAuditSchema(): Json {
  const api = parse(readFileSync(resolve(root, 'docs/openapi.draft.yaml'), 'utf8')) as {
    components: { schemas: Record<string, Json> };
  };
  const all = api.components.schemas;
  const picked: Record<string, Json> = {};
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const ref = (node as Json).$ref;
    if (typeof ref === 'string') {
      const name = ref.replace('#/components/schemas/', '');
      if (!picked[name]) {
        picked[name] = all[name]!;
        visit(all[name]);
      }
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit({ $ref: '#/components/schemas/AuditEvent' });
  const sorted = Object.fromEntries(
    Object.keys(picked)
      .sort()
      .map((k) => [k, picked[k]]),
  );
  return {
    $id: 'frontdesk-audit',
    description:
      'GENERATED from docs/openapi.draft.yaml by scripts/gen-audit-schema.ts — do not edit.',
    components: { schemas: sorted },
  };
}

if (require.main === module) {
  const text = `${JSON.stringify(extractAuditSchema(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) {
      console.error('audit-event.schema.json is out of date; run npm run gen:audit-schema');
      process.exit(1);
    }
    console.log('audit schema up to date');
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
