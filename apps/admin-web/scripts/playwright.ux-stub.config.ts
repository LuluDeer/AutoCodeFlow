import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config';

// browser-stub 权威走查：真实构建产物 + 浏览器，API 由 spec 内 Playwright route
// 夹具提供。与 browser-real 配置互斥：real spec 不在这里拾取。
const port = 4178;
const baseURL = `http://127.0.0.1:${port}`;
const outDir = 'node_modules/.cache/ux-stub-dist';

export default defineConfig({
  ...base,
  testDir: '../e2e',
  testMatch: /e2e\/ux-.*\.spec\.ts$/,
  testIgnore: [/e2e\/ux-real-backend\.spec\.ts$/, '**/legacy/**'],
  timeout: 60_000,
  use: {
    ...base.use,
    baseURL,
    channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined,
  },
  projects: [
    {
      name: 'browser-stub-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run build -- --outDir ${outDir} && npm run preview -- --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_API_URL_INTERNAL: '/api', VITE_API_URL_EXTERNAL: '' },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
