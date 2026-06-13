module.exports = {
  testDir: '.',
  testMatch: '**/e2e-full.spec.cjs',
  globalSetup: './e2e-global-setup.cjs',
  timeout: 60000,
  workers: 1,
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
