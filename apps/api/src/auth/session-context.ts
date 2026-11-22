import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { Errors } from '../common/app-error';
import { hmac, safeEqual, subkey } from './crypto';

export const SESSION_CONTEXT_HEADER = 'x-session-context';

/**
 * Opaque, non-secret per-session context. Each browser tab learns the context of the session it
 * was rendered for (login / refresh / GET /auth/me) and echoes it on requests. Tabs share cookies, so after another
 * tab signs in as someone else a stale tab would otherwise act with the REPLACEMENT session's cookies. The server
 * compares the echoed context with the context of the session actually authenticated by the cookies and rejects
 * the request (409 SESSION_CHANGED) when they differ: a stale tab can never act as, or read as, the new identity.
 * Knowing a context grants nothing (it is an HMAC of the session id under a purpose-bound key; cookies are still
 * required). Stable across refresh-token rotation because the session id is.
 */
@Injectable()
export class SessionContextService {
  private readonly key: Buffer;
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = subkey(config.CSRF_SIGNING_KEY, 'session-context');
  }

  of(sessionId: string): string {
    return hmac(this.key, `ctx:${sessionId}`).slice(0, 32);
  }

  /** `required`: business mutations must carry it; elsewhere it is enforced whenever present. */
  check(header: string | undefined, sessionId: string, required: boolean): void {
    if (header === undefined || header === '') {
      if (required) throw Errors.badRequest('SESSION_CONTEXT_REQUIRED', 'Missing session context. Reload the page.');
      return;
    }
    if (header.length > 64 || !safeEqual(header, this.of(sessionId))) throw sessionChanged();
  }
}

export const sessionChanged = () =>
  Errors.conflict('SESSION_CHANGED', 'Your session changed in another tab or window. Nothing was saved; reload to continue.');
