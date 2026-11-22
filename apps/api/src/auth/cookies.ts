import type { CookieOptions, Response } from 'express';
import { ACCESS_TOKEN_TTL_MS, COOKIE_NAMES, CSRF_TOKEN_TTL_MS } from '@frontdesk/contracts';

/** AUTH_CONTRACT cookie table: HttpOnly, SameSite=Lax, host-only (no Domain), exact paths. */
export const COOKIE_PATHS = { access: '/api', refresh: '/api/auth', csrf: '/api' } as const;

export class CookieWriter {
  /** Secure everywhere except the documented loopback-HTTP development exception. */
  constructor(private readonly secure: boolean) {}

  private opts(path: string, maxAge?: number): CookieOptions {
    return { httpOnly: true, secure: this.secure, sameSite: 'lax', path, ...(maxAge !== undefined ? { maxAge } : {}) };
  }

  access(res: Response, token: string): void {
    res.cookie(COOKIE_NAMES.access, token, this.opts(COOKIE_PATHS.access, ACCESS_TOKEN_TTL_MS));
  }
  refresh(res: Response, value: string, expiresAt: Date): void {
    res.cookie(COOKIE_NAMES.refresh, value, this.opts(COOKIE_PATHS.refresh, Math.max(0, expiresAt.getTime() - Date.now())));
  }
  csrf(res: Response, token: string): void {
    res.cookie(COOKIE_NAMES.csrf, token, this.opts(COOKIE_PATHS.csrf, CSRF_TOKEN_TTL_MS));
  }
  clearAll(res: Response): void {
    res.clearCookie(COOKIE_NAMES.access, this.opts(COOKIE_PATHS.access));
    res.clearCookie(COOKIE_NAMES.refresh, this.opts(COOKIE_PATHS.refresh));
    res.clearCookie(COOKIE_NAMES.csrf, this.opts(COOKIE_PATHS.csrf));
  }
}
