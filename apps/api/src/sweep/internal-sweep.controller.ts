import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, Controller, ExecutionContext, HttpCode, Inject, Injectable, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { AppError, Errors } from '../common/app-error';
import { RateLimiter } from '../common/rate-limiter';
import { parse } from '../common/validation';
import { MachineEndpoint, Public } from '../auth/guards';
import { SweepService } from './sweep.service';

const digest = (v: string) => createHash('sha256').update(v).digest();

/**
 * Explicit machine credential boundary for /api/internal/*. Not a user session: no cookies are read and no user
 * identity exists. Disabled (404) unless SWEEP_TRIGGER_TOKEN is configured. Constant-time comparison of digests;
 * failures are rate limited per IP like any unauthenticated traffic; successes are rate limited per credential.
 */
@Injectable()
export class MachineTokenGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = this.config.SWEEP_TRIGGER_TOKEN;
    if (!token) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !timingSafeEqual(digest(presented), digest(token))) {
      this.limiter.consume(`authfail:ip:${req.ip}`, this.config.ANON_RATE_LIMIT_PER_MIN);
      throw Errors.unauthenticated('Machine credential required.');
    }
    this.limiter.consume('machine:sweep', this.config.SWEEP_TRIGGER_RATE_LIMIT_PER_MIN);
    return true;
  }
}

/** Slot key: deterministic per scheduled slot (e.g. "cron-202611241130"); 8-120 chars of [A-Za-z0-9_-]. */
const slotKey = z.string().regex(/^[A-Za-z0-9_-]{8,120}$/, 'Idempotency-Key must be 8-120 chars of [A-Za-z0-9_-]');

@Public()
@MachineEndpoint()
@UseGuards(MachineTokenGuard)
@Controller('internal')
export class InternalSweepController {
  constructor(private readonly sweeps: SweepService) {}

  /**
   * External scheduler trigger (e.g. Supabase Cron + pg_net while the web service sleeps). Runs the SAME sweep
   * service as the in-process scheduler with the SYSTEM actor: leases, fencing, per-ticket transactions, durable
   * counters and recovery all apply. No body, no clock or time input is accepted.
   */
  @Post('sweep')
  @HttpCode(200)
  async run(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (req.body !== undefined && Object.keys(req.body as object).length) throw Errors.badRequest('VALIDATION_FAILED', 'No request body is accepted.');
    const key = parse(slotKey, req.header('idempotency-key'), 'Idempotency-Key header');
    const out = await this.sweeps.runExternal(key, req.id);
    res.status(out.status);
    return out.body;
  }
}
