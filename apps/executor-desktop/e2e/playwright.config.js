// QA-12：executor-desktop Electron 冒烟专用 Playwright 配置。
// 独立于根级 e2e config（那是 admin-web 浏览器链路）；本配置只跑 local
// _electron 冒烟，无网络依赖。CI windows job 与本地同入口：
//   npx playwright test --config=e2e/playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.js',
  timeout: 60000,
  workers: 1, // 单实例锁 + 托盘应用：串行最稳
  reporter: [['list']],
  use: {
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});