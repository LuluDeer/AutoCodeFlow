// QA-12：executor-desktop Electron 冒烟专用 Playwright 配置。
// 独立于根级 e2e config（那是 admin-web 浏览器链路）；本配置只跑 local
// _electron 冒烟，无网络依赖。CI windows job 与本地同入口：
//   npx playwright test --config=e2e/playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.js',
  timeout: 60000,
  // CI 全新 runner 冷启动慢（Electron 首启 + IPC 往返），失败重跑 2 次吸收
  // 时序 flake；本地 0 保持快速反馈。desktop-e2e 首跑实证：最大化用例本地
  // 同形态 3.9s 通过、CI 5s 超窗（2026-10-02）。
  retries: process.env.CI ? 2 : 0,
  workers: 1, // 单实例锁 + 托盘应用：串行最稳
  reporter: [['list']],
  use: {
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});