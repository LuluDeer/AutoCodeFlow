module.exports = {
  // NETOPT-DEBT（e2e-full 收编）：三份 legacy spec（e2e-full / e2e-python-executor /
  // e2e-ui09-mobile）已从仓库根等价移动到 apps/admin-web/e2e/legacy/（内容零变更）。
  // 本 config 改为精确指向该目录——scripts/e2e-full.sh 的 Playwright 入口
  // （--config=../../playwright.e2e.config.js）不变，CI e2e-full / e2e-full-windows
  // 两个 job 跑的就是这三份 legacy。
  // 互斥性（与 apps/admin-web/playwright.config.ts 的权威套件）：
  //  - 本 config testDir 精确圈定 legacy/，天然碰不到权威套件（e2e/*.spec.ts）；
  //  - 反向由 admin-web config 的 testIgnore '**/legacy/**' 承接（legacy 三份是
  //    CJS require 风格 + 需 e2e-full.sh 全链编排，被权威套件拾取必然红且重复）。
  // legacy/ 内含 {"type":"commonjs"} 的 package.json：隔离 apps/admin-web 根
  // package.json 的 "type":"module"——三份 spec 是 require 风格，无此作用域声明
  // 会被按 ESM 加载而炸 CJS require（旧根级 config testIgnore '**/apps/**' 的
  // 同根原因，收编后以目录级 package.json 消解）。
  testDir: 'apps/admin-web/e2e/legacy',
  testMatch: '**/e2e-*.spec.js',
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
