import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export const SPEC_PATH = resolve(__dirname, '../../docs/openapi.draft.yaml');
export type Json = any;

export function loadSpec(): Json {
  return parse(readFileSync(SPEC_PATH, 'utf8'));
}

/** Ajv 8 natively implements OpenAPI 3.0 `nullable`; enum values must still list null explicitly. */
export function makeValidator(spec: Json) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ components: { schemas: spec.components.schemas } }, 'oas');
  const cache = new Map<string, ValidateFunction>();
  return (name: string): ValidateFunction => {
    let fn = cache.get(name);
    if (!fn) {
      fn = ajv.compile({ $ref: `oas#/components/schemas/${name}` });
      cache.set(name, fn);
    }
    return fn;
  };
}

/** Collect every property name reachable from a schema (following local $refs). */
export function reachableProps(
  spec: Json,
  node: Json,
  seen = new Set<string>(),
  out = new Set<string>(),
) {
  if (Array.isArray(node)) {
    node.forEach((n) => reachableProps(spec, n, seen, out));
  } else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') {
      if (!seen.has(node.$ref)) {
        seen.add(node.$ref);
        const target = node.$ref
          .slice(2)
          .split('/')
          .reduce((acc: Json, k: string) => acc[k], spec);
        reachableProps(spec, target, seen, out);
      }
      return out;
    }
    if (node.properties) Object.keys(node.properties).forEach((k) => out.add(k));
    Object.values(node).forEach((v) => reachableProps(spec, v, seen, out));
  }
  return out;
}
