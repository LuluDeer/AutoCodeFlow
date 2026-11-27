import { defineConfig, devices } from '@playwright/test';

/**
 * Level-4 (real browser + real backend) verification for the positioning-ux-overhaul round.
 *
 * This config DOES NOT start any services. The orchestration script
 *   scripts/fullstack-verify-workbench.sh
 * starts a fresh throwaway PG + Redis container, runs the migration chain, starts
 * admin-api and admin-web vite (all with test-only env / unique ports), waits for
 * health, then invokes `npx playwright test --config=apps/admin-web/playwright.workbench.config.ts`.
 *
 * Keep this config free of webServer so we never accidentally attach to, or start,
 * a second stack. baseURL points to the vite port the orchestration script picks.
 */
const webPort = Number(process.env.WORKBENCH_WEB_PORT ?? 5176);
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /e2e\/workbench-session-fullstack\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.WORKBENCH_PW_JSON ?? 'node_modules/.cache/workbench-fullstack-results.json' }],
  ],
  outputDir: process.env.WORKBENCH_OUTPUT_DIR ?? 'node_modules/.cache/workbench-fullstack-results',
  use: {
    baseURL,
    headless: true,
    // Screenshots on failure + one explicit success shot taken inside the spec.
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
    launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  },
  projects: [
    {
      name: 'workbench-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
