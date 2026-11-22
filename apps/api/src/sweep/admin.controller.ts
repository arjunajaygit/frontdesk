import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { Errors } from '../common/app-error';
import { RateLimiter } from '../common/rate-limiter';
import { Schemas, parse } from '../common/validation';
import { Roles } from '../auth/guards';
import { SweepService } from './sweep.service';

@Roles('LEAD', 'ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly sweeps: SweepService,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Lead/admin only, CSRF + Origin (guard), Idempotency-Key, bounded rate. No time or customer input accepted. */
  @Post('run-sla-sweep')
  async run(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    parse(Schemas.empty, body, 'body');
    const p = req.principal;
    if (!p || (p.role !== 'LEAD' && p.role !== 'ADMIN')) throw Errors.forbidden();
    const key = parse(Schemas.idempotencyKey, req.header('idempotency-key'), 'Idempotency-Key header');
    this.limiter.consume(`sweep:${p.userId}`, this.config.SWEEP_RATE_LIMIT_PER_MIN);
    const out = await this.sweeps.runManual({ type: p.role, id: p.userId }, key, req.id);
    res.status(out.status);
    return out.body;
  }
}
