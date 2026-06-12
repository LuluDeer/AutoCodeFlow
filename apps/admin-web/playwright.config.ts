import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    headless: true,
    launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  },
  reporter: 'line',
});
