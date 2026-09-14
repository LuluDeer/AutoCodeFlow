module.exports = {
  testDir: '.',
  // UI-09：根级新增移动端真机走查 spec（e2e-ui09-mobile.spec.js）——放宽为 e2e-*.spec.js，
  // 仍排除 apps/** 下副本（其 type:module 会炸 CJS require）
  testMatch: '**/e2e-*.spec.js',
  // apps/admin-web 下有同名副本，其 package.json type:module 会炸 CJS require——排除
  testIgnore: '**/apps/**',
  timeout: 60000,
  // E-33（DEEP_REVIEW 0ef3bbe）：e2e 全链只起单后端实例（e2e-full.sh 编排
  // admin-api:3105 + executor-node:8002），多 worker 并行会让两个 spec 同时打同一
  // 后端造成数据竞争/状态污染（flaky 根因）。workers:1 串行执行消除交叉干扰；
  // retries:1 给偶发 flaky 一次重试机会但不掩盖真实失败（对齐 admin-web 副本
  // playwright.e2e.config.cjs 既有 workers:1 惯例）。
  workers: 1,
  retries: 1,
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
