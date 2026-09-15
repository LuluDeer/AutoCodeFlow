// E-33（DEEP_REVIEW 0ef3bbe）：retries/workers 串行约束——防两 spec 并行打同一
// 后端（e2e-full 共享 admin-api:3105 + executor-node:8002，并行会互踩执行器注册
// 与任务派发槽位）。CI 串行（workers=1）+ 单次重试容抖动；本地保留默认并发。
const isCI = !!process.env.CI;

module.exports = {
  testDir: '.',
  testMatch: '**/e2e-full.spec.js',
  timeout: 60000,
  // E-33: 串行执行——e2e spec 共享后端拓扑，并行会争抢执行器注册/派发槽。
  workers: isCI ? 1 : undefined,
  fullyParallel: false,
  // E-33: CI 单次重试吸收启动竞态/端口抖动；本地零重试保持失败可复现。
  retries: isCI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:5176',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15000,
    navigationTimeout: 20000,
  },
  reporter: [['list']],
};
