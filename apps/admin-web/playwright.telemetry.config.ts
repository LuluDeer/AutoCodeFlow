import { defineConfig, devices } from '@playwright/test';

/**
 * R437 — 北极星「生产启用完整用户操作路径」真浏览器 + 真后端验收入口。
 *
 * 与 R436 的 playwright.northstar.config.ts 独立：testMatch 只匹配
 * telemetry-enablement-real.spec.ts。webServer 两段完全照抄 R436（真后端 dist
 * 3105 + vite 5176、测试库、fixture key、CORS/proxy rewrite 组合），口令类变量
 * 由 Playwright 进程环境继承（运行前 source /tmp/r436-run-env.sh）。
 */
const port = 5176;
const apiPort = 3105;
const baseURL = `http://127.0.0.1:${port}`;
// 非生产密钥：仅用于派生匿名 install/execution id 的 32B hex fixture。
const FIXTURE_SECRETS_KEY =
  '4a6b8c0d2e1f3a5b7c9d0e2f4a6b8c0d2e1f3a5b7c9d0e2f4a6b8c0d2e1f3a5b';

export default defineConfig({
  testDir: './e2e',
  testMatch: /e2e\/telemetry-enablement-real\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
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
      name: 'telemetry-chrome',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      },
    },
  ],
  webServer: [
    {
      command: 'cd ../admin-api && node dist/main',
      env: {
        PORT: String(apiPort),
        DB_DATABASE: 'autoflow_ttfv_e2e',
        SEC_SECRETS_KEY: FIXTURE_SECRETS_KEY,
        CORS_ORIGINS:
          'http://localhost,http://localhost:5176,http://127.0.0.1:8088',
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
        // R436 踩坑点：vite 代理默认改写 Origin 到 8088；真栈白名单含
        // localhost:5176，这里显式改回同源值，避免 consent POST 被 CORS 误伤。
        VITE_API_PROXY_ORIGIN_REWRITE: 'http://localhost:5176',
      },
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
