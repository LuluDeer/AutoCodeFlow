module.exports = {
  testDir: '.',
  testMatch: '**/e2e-full.spec.cjs',
  globalSetup: './e2e-global-setup.cjs',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5176',
    headless: true,
    // LANG-ERR-01 / UI-10：同根级 playwright.e2e.config.js——detectLanguage 改为
    // 「优先跟随浏览器语言、其次默认英文」后，Chromium 默认 en-US 会让界面渲染
    // 英文，而 e2e-full.spec.cjs 断言的是中文文案（`系统`/`普通用户`…）→ 集体超时。
    // 语言是测试环境属性，故在 config 单点钉死 zh-CN。
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15000,
    navigationTimeout: 20000,
  },
  reporter: [['list']],
};
