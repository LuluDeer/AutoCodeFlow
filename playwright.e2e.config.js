module.exports = {
  testDir: '.',
  // UI-09：根级新增移动端真机走查 spec（e2e-ui09-mobile.spec.js）——放宽为 e2e-*.spec.js，
  // 仍排除 apps/** 下副本（其 type:module 会炸 CJS require）
  testMatch: '**/e2e-*.spec.js',
  // apps/admin-web 下有同名副本，其 package.json type:module 会炸 CJS require——排除
  testIgnore: '**/apps/**',
  timeout: 60000,
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
