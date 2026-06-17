module.exports = {
  testDir: '.',
  testMatch: '**/e2e-full.spec.js',
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15000,
    navigationTimeout: 20000,
  },
  reporter: [['list']],
};
