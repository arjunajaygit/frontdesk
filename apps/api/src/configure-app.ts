import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './config/env';
import { SafeExceptionFilter } from './common/exception.filter';
import { RateLimiter } from './common/rate-limiter';
import { MetricsService } from './observability/metrics.service';
import { requestContext } from './common/request-context';

export const BODY_LIMIT = '64kb';

/** Shared by main.ts and the HTTP test harness so tests exercise the exact production pipeline. */
const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), browsing-topics=()';

export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.TRUST_PROXY_HOPS > 0 ? config.TRUST_PROXY_HOPS : false);
  app.disable('x-powered-by');
  app.disable('etag');
  const webDist = config.WEB_DIST_DIR;
  if (webDist && (!isAbsolute(webDist) || !existsSync(resolve(webDist, 'index.html')))) {
    throw new Error('WEB_DIST_DIR must be an absolute path to a built web app containing index.html');
  }
  app.use('/api', requestContext); // correlation id + no-store/Vary only on API responses (static assets stay cacheable)
  const hsts = config.PUBLIC_ORIGIN.startsWith('https://') ? { maxAge: 15_552_000, includeSubDomains: true } : false;
  const apiHelmet = helmet({
    // JSON only: no helmet CSP defaults (they would add https: fonts/styles an API never needs).
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    strictTransportSecurity: hsts,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  // The SPA needs to load its own scripts/styles only; no third-party origins, no inline scripts, no framing.
  const webHelmet = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React/Radix set style attributes and a bundled UI library creates <style> elements at runtime, so styles
        // need 'unsafe-inline' (ZAP 10055, accepted: style injection only; scripts stay 'self', React escapes text).
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
    },
    strictTransportSecurity: hsts,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    // Same-origin assets only, so cross-origin isolation costs nothing (ZAP 90004).
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
  });
  // Deny powerful browser features the app never uses (ZAP 10063) on every response.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    next();
  });
  app.use((req: Request, res: Response, next: NextFunction) => (req.path === '/api' || req.path.startsWith('/api/') ? apiHelmet(req, res, next) : webHelmet(req, res, next)));
  if (webDist) {
    // Hashed build assets are immutable; everything else (index.html) must revalidate so releases take effect.
    app.use(
      express.static(webDist, {
        index: false,
        fallthrough: true,
        dotfiles: 'ignore',
        setHeaders: (res, filePath) => res.setHeader('Cache-Control', filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
      }),
    );
    // SPA history fallback: only for navigations (GET/HEAD, no file extension, never /api). Missing assets stay 404.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const isApi = req.path === '/api' || req.path.startsWith('/api/');
      if ((req.method !== 'GET' && req.method !== 'HEAD') || isApi || extname(req.path) !== '') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(resolve(webDist, 'index.html'));
    });
  }
  // Prometheus HTTP metrics for /api only; the label is the matched route TEMPLATE, never the raw URL.
  const metrics = app.get(MetricsService);
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const route = (req as Request & { route?: { path?: string } }).route?.path;
      const template = route ? `${req.baseUrl}${route}`.replace(/:([A-Za-z]+)/g, '{$1}') : undefined;
      metrics.observeHttp(req.method, template, res.statusCode, Number(process.hrtime.bigint() - started) / 1e9);
    });
    next();
  });
  const limiter = app.get(RateLimiter);
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    try {
      // Coarse pre-authentication flood ceiling per IP (M01). Per-user and unauthenticated budgets are in AuthGuard.
      limiter.consume(`api:ip:${req.ip}`, config.API_IP_RATE_LIMIT_PER_MIN);
      next();
    } catch (e) {
      next(e);
    }
  });
  app.use(cookieParser());
  app.use(express.json({ limit: BODY_LIMIT, strict: true, type: 'application/json' }));
  const logger = app.get(Logger);
  const filter = new SafeExceptionFilter({ error: (obj, msg) => logger.error(obj, msg) });
  // Errors raised by express-level middleware (body parsing, rate limit) never reach Nest's filter chain.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { status?: number; type?: string };
    const { status, body } =
      e.type === 'entity.too.large'
        ? { status: 413, body: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large.', requestId: req.id } }
        : e.type === 'entity.parse.failed'
          ? { status: 400, body: { code: 'INVALID_JSON', message: 'Malformed JSON body.', requestId: req.id } }
          : filter.toEnvelope(err, req.id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(body);
  });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(filter);
  // CORS deliberately NOT enabled: the browser talks to one origin (same-origin proxy), so cross-origin reads
  // are blocked by the browser and cross-origin writes by exact Origin + CSRF checks.
  if (config.NODE_ENV !== 'production') {
    // Serve the AUTHORITATIVE contract (not a decorator-derived approximation) in development.
    const spec = parseYaml(readFileSync(resolve(__dirname, '../../../docs/openapi.draft.yaml'), 'utf8')) as OpenAPIObject;
    SwaggerModule.setup('api/docs', app, spec, { swaggerOptions: { supportedSubmitMethods: [] } });
  }
  // Signal handlers are process-global; tests boot many app instances in one process, production boots one.
  if (config.NODE_ENV !== 'test') app.enableShutdownHooks();
}
