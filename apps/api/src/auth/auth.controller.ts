import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { COOKIE_NAMES } from '@frontdesk/contracts';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { RateLimiter } from '../common/rate-limiter';
import { Schemas, parse } from '../common/validation';
import { CookieWriter } from './cookies';
import { CsrfService } from './csrf.service';
import { CsrfMode, Public } from './guards';
import { toViewer } from './principal';
import { SessionService } from './session.service';
import { Errors } from '../common/app-error';
import { sha256 } from './crypto';
import { SESSION_CONTEXT_HEADER, SessionContextService } from './session-context';

const cookiesOf = (req: Request) => req.cookies as Record<string, string | undefined>;

@Controller('auth')
export class AuthController {
  private readonly cookies: CookieWriter;

  constructor(
    private readonly sessions: SessionService,
    private readonly csrf: CsrfService,
    private readonly limiter: RateLimiter,
    private readonly contexts: SessionContextService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.cookies = new CookieWriter(config.PUBLIC_ORIGIN.startsWith('https://'));
  }

  /**
   * Read-only session check via access OR current refresh cookie; never rotates. `?purpose=login` always issues a
   * PRE-LOGIN token (final audit H01): the login form must work even while an old, still-valid refresh cookie is
   * present (login then replaces and revokes that session). A pre-login token authorises nothing but login.
   */
  @Public()
  @Get('csrf')
  async issueCsrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limiter.consume(`csrf:ip:${req.ip}`, this.config.ANON_RATE_LIMIT_PER_MIN);
    const c = cookiesOf(req);
    let sessionId: string | null = null;
    if (req.query.purpose !== 'login') sessionId = await this.currentSession(c);
    const token = this.csrf.issue(sessionId ? { kind: 'session', sessionId } : { kind: 'prelogin' });
    this.cookies.csrf(res, token);
    return { csrfToken: token };
  }

  @Public()
  @CsrfMode('prelogin')
  @Post('login')
  @HttpCode(200)
  async login(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.login, body, 'login');
    const principalKey = sha256(input.email.trim().toLowerCase()); // never keep raw emails in limiter keys
    this.limiter.consume(`login:ip:${req.ip}`, this.config.LOGIN_RATE_LIMIT_PER_MIN * 5);
    this.limiter.consume(`login:principal:${principalKey}`, this.config.LOGIN_RATE_LIMIT_PER_MIN);
    const prior = await this.currentSession(cookiesOf(req));
    const s = await this.sessions.login(input.email, input.password);
    // The browser's previous session (if any) is replaced by this login: revoke it so it can never be revived.
    if (prior && prior !== s.principal.sessionId) await this.sessions.revoke(prior);
    this.cookies.access(res, s.accessToken);
    this.cookies.refresh(res, s.refreshValue, s.expiresAt);
    const csrfToken = this.csrf.issue({ kind: 'session', sessionId: s.principal.sessionId }); // rotate on login
    this.cookies.csrf(res, csrfToken);
    return { viewer: toViewer(s.principal), csrfToken, sessionContext: this.contexts.of(s.principal.sessionId) };
  }

  private async currentSession(c: Record<string, string | undefined>): Promise<string | null> {
    try {
      return (await this.sessions.authenticate(c[COOKIE_NAMES.access])).sessionId;
    } catch {
      return this.sessions.sessionFromRefresh(c[COOKIE_NAMES.refresh]);
    }
  }

  /** Refresh uses only the refresh cookie (+ session-bound CSRF + Origin), never the access JWT. */
  @Public()
  @CsrfMode('handler')
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limiter.consume(`refresh:ip:${req.ip}`, this.config.ANON_RATE_LIMIT_PER_MIN);
    const c = cookiesOf(req);
    const sessionId = await this.sessions.sessionFromRefresh(c[COOKIE_NAMES.refresh]);
    // CSRF is verified against the refresh identity when the token is current; a reused token falls through
    // to rotation, which detects reuse and revokes the family.
    const bound = sessionId ?? (c[COOKIE_NAMES.refresh]?.split('.')[0] ?? '');
    this.csrf.verify(req.header('x-csrf-token'), c[COOKIE_NAMES.csrf], { kind: 'session', sessionId: bound });
    // H02: a stale tab must not rotate (and adopt) a session that replaced its own.
    if (bound) this.contexts.check(req.header(SESSION_CONTEXT_HEADER), bound, false);
    let s;
    try {
      s = await this.sessions.refresh(c[COOKIE_NAMES.refresh]);
    } catch (e) {
      this.cookies.clearAll(res);
      throw e;
    }
    this.cookies.access(res, s.accessToken);
    this.cookies.refresh(res, s.refreshValue, s.expiresAt);
    const csrfToken = this.csrf.issue({ kind: 'session', sessionId: s.principal.sessionId });
    this.cookies.csrf(res, csrfToken);
    return { viewer: toViewer(s.principal), csrfToken, sessionContext: this.contexts.of(s.principal.sessionId) };
  }

  /** Access OR refresh identity; revokes the family and clears all cookies. Anonymous + prelogin CSRF = 200 no-op. */
  @Public()
  @CsrfMode('handler')
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const c = cookiesOf(req);
    const sessionId = await this.currentSession(c);
    this.csrf.verify(req.header('x-csrf-token'), c[COOKIE_NAMES.csrf], sessionId ? { kind: 'session', sessionId } : { kind: 'prelogin' });
    // H02: a stale tab must not sign out the identity that replaced it.
    if (sessionId) this.contexts.check(req.header(SESSION_CONTEXT_HEADER), sessionId, false);
    if (sessionId) await this.sessions.revoke(sessionId);
    this.cookies.clearAll(res);
    return { ok: true };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const p = req.principal;
    if (!p) throw Errors.unauthenticated();
    return { ...toViewer(p), sessionContext: this.contexts.of(p.sessionId) };
  }
}
