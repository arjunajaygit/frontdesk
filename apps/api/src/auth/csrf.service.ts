import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CSRF_TOKEN_TTL_MS } from '@frontdesk/contracts';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { Errors } from '../common/app-error';
import { hmac, safeEqual, subkey } from './crypto';

export type CsrfBinding = { kind: 'session'; sessionId: string } | { kind: 'prelogin' };

/**
 * Signed double-submit token (AUTH_CONTRACT): HMAC with CSRF_SIGNING_KEY (independent of the JWT key),
 * 1h expiry, bound to the session id or to a pre-login nonce. Header must equal cookie (constant time).
 */
@Injectable()
export class CsrfService {
  private readonly key: Buffer;
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.key = subkey(config.CSRF_SIGNING_KEY, 'csrf');
  }

  issue(binding: CsrfBinding, now = Date.now()): string {
    const b = binding.kind === 'session' ? `s:${binding.sessionId}` : `p:${randomBytes(16).toString('base64url')}`;
    const payload = Buffer.from(JSON.stringify({ b, n: randomBytes(16).toString('base64url'), e: now + CSRF_TOKEN_TTL_MS })).toString('base64url');
    return `${payload}.${hmac(this.key, payload)}`;
  }

  /** Throws 403 unless header == cookie, signature valid, unexpired and bound as expected. */
  verify(header: string | undefined, cookie: string | undefined, expected: CsrfBinding, now = Date.now()): void {
    const fail = () => Errors.forbidden('CSRF_REJECTED', 'Missing or invalid CSRF token.');
    if (!header || !cookie || header.length > 1024 || !safeEqual(header, cookie)) throw fail();
    const [payload, sig] = header.split('.');
    if (!payload || !sig || !safeEqual(sig, hmac(this.key, payload))) throw fail();
    let claims: { b?: unknown; e?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw fail();
    }
    if (typeof claims.e !== 'number' || claims.e <= now || typeof claims.b !== 'string') throw fail();
    const ok = expected.kind === 'session' ? claims.b === `s:${expected.sessionId}` : claims.b.startsWith('p:');
    if (!ok) throw fail();
  }

  /** Exact Origin equality with the configured canonical origin; missing or "null" rejected. */
  verifyOrigin(origin: string | undefined): void {
    if (!origin || origin === 'null' || origin !== this.config.PUBLIC_ORIGIN) {
      throw Errors.forbidden('ORIGIN_REJECTED', 'Cross-origin request rejected.');
    }
  }
}
