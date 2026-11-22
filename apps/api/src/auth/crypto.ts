import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { decodeSecret } from '../config/env';

export function keyBytes(secret: string): Buffer {
  const b = decodeSecret(secret);
  if (!b) throw new Error('invalid secret encoding'); // unreachable: validated at startup
  return b;
}

/** Purpose-bound subkey so one validated secret never signs two kinds of artefact. */
export function subkey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', keyBytes(secret), Buffer.alloc(0), `frontdesk:${purpose}:v1`, 32));
}

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
export const hmac = (key: Buffer, v: string): string => createHmac('sha256', key).update(v).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
