import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { startApp, TestApp } from '../helpers/http';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/** Production topology: one process serves the compiled SPA and the API on the same origin. */
let t: TestApp;
let db: string;
const dist = mkdtempSync(path.join(tmpdir(), 'fd-web-'));

beforeAll(async () => {
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(
    path.join(dist, 'index.html'),
    '<!doctype html><title>Frontdesk</title><div id="root"></div>',
  );
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  db = await cloneTemplate('static');
  t = await startApp(db, { WEB_DIST_DIR: dist });
});
afterAll(async () => {
  await t?.close();
  await dropDatabase(db);
});

describe('same-origin static serving', () => {
  it('serves index.html at / and for deep SPA routes (revalidated), with an app-specific CSP', async () => {
    for (const p of [
      '/',
      '/staff',
      '/staff?view=mine&ticket=abc',
      '/portal/tickets/123',
      '/login',
    ]) {
      const r = await request(t.server).get(p);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.text).toContain('<div id="root">');
      expect(r.headers['cache-control']).toBe('no-cache');
      const csp = r.headers['content-security-policy'] as string;
      expect(csp).toMatch(/script-src 'self'/);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(csp).toMatch(/frame-ancestors 'none'/);
      expect(csp).toMatch(/connect-src 'self'/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('hashed assets are immutable-cacheable; missing assets are a plain 404, never the SPA shell', async () => {
    const ok = await request(t.server).get('/assets/app-abc123.js');
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const missing = await request(t.server).get('/assets/nope.js');
    expect(missing.status).toBe(404);
    expect(missing.text).not.toContain('<div id="root">');
  });

  it('API routes are excluded from the SPA fallback and keep strict headers (no-store, CSP default-src none)', async () => {
    const health = await request(t.server).get('/api/healthz');
    expect(health.body).toEqual({ ok: true, commit: 'unknown' }); // release images report their exact build commit
    expect(health.headers['cache-control']).toBe('no-store');
    expect(health.headers['content-security-policy']).toMatch(/default-src 'none'/);
    const unknown = await request(t.server).get('/api/does-not-exist');
    expect(unknown.status).toBe(404);
    expect(unknown.headers['content-type']).toMatch(/json/);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(unknown.text).not.toContain('<div id="root">');
    expect((await request(t.server).get('/api/tickets')).status).toBe(401);
  });

  it('only GET/HEAD navigations fall back; other methods on page URLs are not turned into HTML', async () => {
    const post = await request(t.server).post('/staff').send({});
    expect(post.status).not.toBe(200);
    expect(post.text).not.toContain('<div id="root">');
    const head = await request(t.server).head('/portal');
    expect(head.status).toBe(200);
  });

  it('M7 ZAP hardening: Permissions-Policy and cross-origin isolation on pages and API; API CSP has no helmet defaults', async () => {
    for (const path of ['/', '/portal/tickets/x', '/api/healthz']) {
      const r = await request(t.server).get(path);
      expect(r.headers['permissions-policy']).toMatch(/camera=\(\)/);
      expect(r.headers['permissions-policy']).toMatch(/geolocation=\(\)/);
      // Regression: no tokens browsers do not recognise (each one logs a console warning on every page).
      expect(r.headers['permissions-policy']).not.toMatch(/browsing-topics|interest-cohort/);
      expect(r.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
    const api = (await request(t.server).get('/api/healthz')).headers[
      'content-security-policy'
    ] as string;
    expect(api).not.toMatch(/https:|unsafe-inline/);
    expect(api).toMatch(/default-src 'none'/);
  });

  it('no CORS is offered to other origins', async () => {
    const r = await request(t.server).get('/api/healthz').set('Origin', 'https://evil.example');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});
