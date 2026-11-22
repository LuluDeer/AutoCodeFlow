import { defineConfig, devices } from '@playwright/test';

/**
 * R436 — 真后端 + 真浏览器端到端验收入口（北极星看板）。
 *
 * 与既有 playwright.*.config.ts 完全独立：baseURL 5176 + 系统 Chrome channel，
 * webServer 同时拉起真后端 dist（3105，env 覆盖测试库 + fixture key）与
 * vite dev server（5176，/api proxy → 3105）。口令类变量从 Playwright 进程
 * 环境继承（运行前 source /tmp/r436-env.sh，由 .env 经 node dotenv 安全解析），
 * 本文件只写非秘密的 fixture key / 测试库名 / 端口。
 */
const port = 5176;
const apiPort = 3105;
const baseURL = `http://127.0.0.1:${port}`;
// 非生产密钥：仅用于派生匿名 install/execution id 的 32B hex fixture。
const FIXTURE_SECRETS_KEY =
  '4a6b8c0d2e1f3a5b7c9d0e2f4a6b8c0d2e1f3a5b7c9d0e2f4a6b8c0d2e1f3a5b';

export default defineConfig({
  testDir: './e2e',
  testMatch: /e2e\/north-star-real-backend\.spec\.ts$/,
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
      name: 'northstar-chrome',
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
        // vite dev proxy 默认把 Origin 改写成 demo 栈白名单的 8088；本真栈
        // 后端白名单含 localhost:5176，这里显式改回同源值避免 CORS 误伤。
        VITE_API_PROXY_ORIGIN_REWRITE: 'http://localhost:5176',
      },
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
