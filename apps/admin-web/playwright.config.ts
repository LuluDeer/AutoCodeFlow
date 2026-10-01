import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // NETOPT-DEBT（e2e-full 收编）：e2e/legacy/ 是 scripts/e2e-full.sh 专属的三份
  // 旧 spec 存档（CJS require 风格 + 依赖 e2e-full.sh 全链编排），由根级
  // playwright.e2e.config.js 精确圈定运行。此处排除，保证两套 Playwright 配置
  // 互斥不重复——权威套件（e2e/*.spec.ts）不会拾取 legacy。
  testIgnore: '**/legacy/**',
  timeout: 30000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5176',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
