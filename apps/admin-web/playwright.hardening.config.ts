import { defineConfig, devices } from '@playwright/test';

/**
 * Level-4 (real browser + real backend) verification for the hardening round:
 * workbench resume/polling, artifact download entry, and execution-log SSE reconnect.
 *
 * This config intentionally has NO webServer. scripts/verify-hardening-browser.sh
 * starts the whole throwaway stack (PG + Redis + admin-api + vite) and then invokes
 * this config so there is only one stack and one browser channel.
 */
const webPort = Number(process.env.HARDENING_WEB_PORT ?? 5178);
const baseURL = `http://127.0.0.1:${webPort}`;
const channel = (process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome') as 'chrome';

export default defineConfig({
  testDir: './e2e',
  testMatch: /e2e\/hardening-browser\.spec\.ts$/,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.HARDENING_PW_JSON ?? 'node_modules/.cache/hardening-browser-results.json' }],
  ],
  outputDir: process.env.HARDENING_OUTPUT_DIR ?? 'node_modules/.cache/hardening-browser-results',
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
    acceptDownloads: true,
    launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  },
  projects: [
    {
      name: 'hardening-chrome',
      use: { ...devices['Desktop Chrome'], channel },
    },
  ],
});
