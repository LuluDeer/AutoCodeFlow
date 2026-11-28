import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// browser-real 权威走查：真浏览器 + 真 admin-api dist + 真 PG/Redis（由 CI job
// services 提供），与 browser-stub 的离线夹具套件互斥。
// 本 config 位于 scripts/ 子目录：Playwright 以 config 所在目录为 webServer cwd，
// 旧的相对 `cd ../admin-api` 会解析到 apps/admin-web/admin-api（不存在），
// 而根目录的 northstar/telemetry config 同样写法却正常（run 46144200900 实证）。
// 用 config 文件位置锚定绝对路径，与 cwd / 调用方式无关。
const apiDir = fileURLToPath(new URL('../../admin-api', import.meta.url));
const port = 5179;
const apiPort = 3107;
const baseURL = `http://127.0.0.1:${port}`;
const dbName = process.env.UX_E2E_DB_NAME || 'autoflow_ux_e2e';

export default defineConfig({
  testDir: '../e2e',
  testMatch: /e2e\/ux-real-backend\.spec\.ts$/,
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  },
  projects: [
    {
      name: 'browser-real-chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      },
    },
  ],
  webServer: [
    {
      command: `cd "${apiDir}" && node dist/main`,
      env: {
        PORT: String(apiPort),
        DB_DATABASE: dbName,
        CORS_ORIGINS: 'http://localhost,http://localhost:5179,http://127.0.0.1:5179',
        LOG_LEVEL: 'warn',
      },
      url: `http://127.0.0.1:${apiPort}/api/health/live`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
      env: {
        VITE_API_URL_INTERNAL: '/api',
        VITE_API_URL_EXTERNAL: '',
        VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
        VITE_API_PROXY_ORIGIN_REWRITE: `http://localhost:${port}`,
      },
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
