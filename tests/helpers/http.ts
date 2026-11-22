import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent';
import { envFile, roleUrl } from './db';
import { loadSpec, makeValidator } from './openapi';
import { TEST_PASSWORD } from './scratch';

export const ORIGIN = 'http://localhost:5173';
/** Pass as an env override value to remove that variable for one boot. */
export const UNSET = '__unset__';
const validator = makeValidator(loadSpec());

/** Assert a response body against an authoritative OpenAPI component schema. */
export function conforms(schema: string, body: unknown): void {
  const fn = validator(schema);
  if (!fn(body))
    throw new Error(
      `${schema} mismatch: ${JSON.stringify(fn.errors)}\n${JSON.stringify(body).slice(0, 500)}`,
    );
}

export interface TestApp {
  app: NestExpressApplication;
  server: ReturnType<INestApplication['getHttpServer']>;
  close: () => Promise<void>;
}

/** Boots the real AppModule + production pipeline (configureApp) against a scratch DB as frontdesk_app. */
export async function startApp(
  db: string,
  env: Record<string, string> = {},
  customize?: (b: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  // Every boot starts from the same baseline: overrides from earlier boots (any suite in this process) are
  // removed first, so settings such as batch sizes or runtime-role names can never leak between tests.
  const g = globalThis as { __frontdeskOverrides?: Set<string> };
  const touched = (g.__frontdeskOverrides ??= new Set<string>());
  for (const k of touched) delete process.env[k];
  const merged: Record<string, string> = {
    ...envFile(),
    DATABASE_URL: roleUrl('app', db),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_ORIGIN: ORIGIN,
    SWEEP_SCHEDULER_ENABLED: 'false',
    LOGIN_RATE_LIMIT_PER_MIN: '1000',
    API_RATE_LIMIT_PER_MIN: '100000',
    SWEEP_RATE_LIMIT_PER_MIN: '1000',
    ...env,
  };
  for (const [k, v] of Object.entries(merged)) {
    touched.add(k);
    if (v === UNSET) delete process.env[k];
    else process.env[k] = v;
  }
  // Imported lazily so configuration is read from the environment prepared above.
  const { AppModule } = await import('../../apps/api/src/app.module');
  const { configureApp } = await import('../../apps/api/src/configure-app');
  const { parseEnv } = await import('../../apps/api/src/config/env');
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customize) builder = customize(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, parseEnv(process.env));
  await app.init();
  return { app, server: app.getHttpServer(), close: () => app.close() };
}

export const newKey = () => `k-${randomUUID()}`;

/** One independent browser profile: own cookie jar, own CSRF token. */
export class Browser {
  readonly agent: TestAgent;
  csrf = '';
  viewer: { id: string; displayName: string; role: string } | null = null;
  /** Opaque session context echoed as X-Session-Context, exactly like the real client (H02). */
  sessionContext = '';

  constructor(server: TestApp['server']) {
    this.agent = request.agent(server);
  }

  async primeCsrf(): Promise<string> {
    const r = await this.agent.get('/api/auth/csrf');
    this.csrf = r.body.csrfToken;
    return this.csrf;
  }

  async login(email: string, password = TEST_PASSWORD) {
    await this.primeCsrf();
    const r = await this.agent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', this.csrf)
      .send({ email, password });
    if (r.status === 200) {
      this.csrf = r.body.csrfToken;
      this.viewer = r.body.viewer;
      this.sessionContext = r.body.sessionContext;
    }
    return r;
  }

  get(path: string) {
    const r = this.agent.get(path);
    return this.sessionContext ? r.set('X-Session-Context', this.sessionContext) : r;
  }

  post(path: string, body?: object, key: string | null = newKey()) {
    let r = this.agent.post(path).set('Origin', ORIGIN).set('X-CSRF-Token', this.csrf);
    if (this.sessionContext) r = r.set('X-Session-Context', this.sessionContext);
    if (key) r = r.set('Idempotency-Key', key);
    return body === undefined ? r : r.send(body);
  }

  patch(path: string, body: object, key: string = newKey()) {
    return this.agent
      .patch(path)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', this.csrf)
      .set('X-Session-Context', this.sessionContext)
      .set('Idempotency-Key', key)
      .send(body);
  }

  cookie(name: string): string | undefined {
    const jar = (
      this.agent as unknown as {
        jar: { getCookie: (n: string, o: object) => { value: string } | undefined };
      }
    ).jar;
    return jar.getCookie(name, {
      domain: '127.0.0.1',
      path: name === 'frontdesk_refresh' ? '/api/auth' : '/api',
      secure: false,
      script: false,
    })?.value;
  }
}

export async function signedIn(t: TestApp, email: string): Promise<Browser> {
  const b = new Browser(t.server);
  const r = await b.login(email);
  if (r.status !== 200)
    throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return b;
}

/** Supertest requests are lazy; this sends one immediately so it can overlap with other work. */
export const start = <T>(req: PromiseLike<T>): Promise<T> => Promise.resolve(req);
