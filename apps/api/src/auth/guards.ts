import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { COOKIE_NAMES, type Role } from '@frontdesk/contracts';
import { AppError, Errors } from '../common/app-error';
import { RateLimiter } from '../common/rate-limiter';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { CsrfService } from './csrf.service';
import { SessionService } from './session.service';
import { SESSION_CONTEXT_HEADER, SessionContextService } from './session-context';

const PUBLIC = 'frontdesk:public';
const ROLES = 'frontdesk:roles';
const CSRF = 'frontdesk:csrf';
const MACHINE = 'frontdesk:machine';

/** Route needs no access token (health, csrf, login, refresh, logout). */
export const Public = () => SetMetadata(PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
/** 'session' (default for mutations) | 'prelogin' (login) | 'handler' (refresh/logout verify in-handler). */
export type CsrfMode = 'session' | 'prelogin' | 'handler';
export const CsrfMode = (mode: CsrfMode) => SetMetadata(CSRF, mode);
/**
 * Machine-to-machine route: no cookies, no browser, so no Origin/CSRF. ONLY routes carrying this marker skip the
 * browser checks, and every such route MUST also carry its own credential guard (see MachineTokenGuard).
 */
export const MachineEndpoint = () => SetMetadata(MACHINE, true);

const STAFF: Role[] = ['AGENT', 'LEAD', 'ADMIN'];
export const StaffOnly = () => Roles(...STAFF);
export const CustomerOnly = () => Roles('CUSTOMER');

const meta = <T>(r: Reflector, key: string, ctx: ExecutionContext) => r.getAllAndOverride<T | undefined>(key, [ctx.getHandler(), ctx.getClass()]);

/** Deny by default: every route requires a valid access token + live session unless @Public. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly contexts: SessionContextService,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (meta<boolean>(this.reflector, PUBLIC, ctx)) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const cookies = req.cookies as Record<string, string | undefined>;
    try {
      req.principal = await this.sessions.authenticate(cookies[COOKIE_NAMES.access]);
    } catch (e) {
      // Unauthenticated traffic (missing/expired/forged credentials) is limited per IP, strictly (M01).
      if (e instanceof AppError && e.status === 401) this.limiter.consume(`authfail:ip:${req.ip}`, this.config.ANON_RATE_LIMIT_PER_MIN);
      throw e;
    }
    // Signed-in traffic is limited per verified USER, not per IP: nine agents behind one NAT get nine budgets,
    // while one noisy user with many sessions shares a single budget (M01).
    this.limiter.consume(`api:user:${req.principal.userId}`, this.config.API_RATE_LIMIT_PER_MIN);
    // H02: a tab rendered for another session must not read or act through these cookies (enforced when sent;
    // business mutations additionally REQUIRE it in CsrfGuard).
    this.contexts.check(req.header(SESSION_CONTEXT_HEADER), req.principal.sessionId, false);
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const roles = meta<Role[]>(this.reflector, ROLES, ctx);
    if (!roles) return true;
    const p = ctx.switchToHttp().getRequest<Request>().principal;
    if (!p || !roles.includes(p.role)) throw Errors.forbidden();
    return true;
  }
}

/** Exact Origin on every state-changing request, then signed double-submit CSRF bound to the session. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly csrf: CsrfService,
    private readonly contexts: SessionContextService,
  ) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    if (meta<boolean>(this.reflector, MACHINE, ctx)) return true; // own explicit credential boundary (machine guard)
    this.csrf.verifyOrigin(req.headers.origin);
    const mode = meta<CsrfMode>(this.reflector, CSRF, ctx) ?? 'session';
    if (mode === 'handler') return true;
    const header = req.header('x-csrf-token');
    const cookie = (req.cookies as Record<string, string | undefined>)[COOKIE_NAMES.csrf];
    if (mode === 'prelogin') {
      this.csrf.verify(header, cookie, { kind: 'prelogin' });
      return true;
    }
    if (!req.principal) throw Errors.unauthenticated();
    this.csrf.verify(header, cookie, { kind: 'session', sessionId: req.principal.sessionId });
    this.contexts.check(req.header(SESSION_CONTEXT_HEADER), req.principal.sessionId, true);
    return true;
  }
}
