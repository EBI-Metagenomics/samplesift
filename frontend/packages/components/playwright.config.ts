import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: './tests',
  testMatch: ['browser.spec.ts', 'filters.browser.spec.ts', 'collection.browser.spec.ts', 'map-layers.browser.spec.ts', 'styling.browser.spec.ts'],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  webServer: {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173/demo/contract.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
