import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { MetricsService } from './metrics.service';

/**
 * Metrics are served on a SEPARATE internal listener (METRICS_PORT), never on the public same-origin port, so a
 * reverse proxy publishing the app cannot expose them by accident. Disabled unless METRICS_PORT > 0. When
 * METRICS_TOKEN is set (required in production) scrapes must present `Authorization: Bearer <token>`.
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server?: Server;
  constructor(
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(MetricsServer.name) private readonly log: PinoLogger,
  ) {}

  private authorised(header: string | undefined): boolean {
    const token = this.config.METRICS_TOKEN;
    if (!token) return true;
    const presented = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(token);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.METRICS_PORT) return;
    this.server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      if (!this.authorised(req.headers.authorization)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
        return;
      }
      this.metrics
        .render()
        .then(({ contentType, body }) => res.writeHead(200, { 'Content-Type': contentType }).end(body))
        .catch(() => res.writeHead(500).end());
    });
    await new Promise<void>((resolve) => this.server!.listen(this.config.METRICS_PORT, this.config.METRICS_HOST, resolve));
    this.log.info({ host: this.config.METRICS_HOST, port: this.config.METRICS_PORT, auth: !!this.config.METRICS_TOKEN }, 'metrics listener started (internal)');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** Bound address (tests use port 0 equivalents via METRICS_PORT). */
  address() {
    return this.server?.address();
  }
}
