module.exports = {
  testDir: '.',
  testMatch: '**/e2e-full.spec.js',
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
