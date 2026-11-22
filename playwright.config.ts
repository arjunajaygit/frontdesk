import { defineConfig, devices } from '@playwright/test';
import { API_PORT, WEB_ORIGIN, WEB_PORT, apiEnv } from './tests/e2e/helpers/env';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts/,
  // The e2e database is prepared by `npm run e2e:db` BEFORE Playwright starts the web servers.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: WEB_ORIGIN, trace: 'off', screenshot: 'off', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      url: `http://localhost:${API_PORT}/api/healthz`,
      env: apiEnv(),
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite --config apps/web/vite.config.ts apps/web',
      url: WEB_ORIGIN,
      env: {
        WEB_PORT: String(WEB_PORT),
        API_TARGET: `http://localhost:${API_PORT}`,
        PATH: process.env.PATH ?? '',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
