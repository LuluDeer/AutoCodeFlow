// N-10：executor-desktop Electron e2e 三例（启动与主窗口 / 托盘与菜单 / 任务面板）。
//
// 与 desktop-smoke.spec.js 的分工：那份是 QA-12 安全与可启动性冒烟（preload
// 白名单/脱敏/黑屏回归），本文件钉 N-10 计划点名的三个场景，断言面各自独立：
//   用例 1「启动与主窗口」：隔离 userData 首启 → 配置向导渲染 → 向导完成
//     （saveAndCloseWizard）→ 主窗口（状态页）创建且关键元素可见 → 干净退出。
//     环境注入只有 ELECTRON_USER_DATA_DIR（src/main/index.ts 既有隔离通道）
//     + --lang=zh-CN（托盘/文案断言需要确定语言）——离线态，无 admin 依赖。
//   用例 2「托盘与菜单」：经 app.evaluate 在主进程给 Tray.prototype
//     （setContextMenu/setToolTip）挂探针，再从渲染层走真实 IPC 触发菜单重建
//     （autolaunch:set / config:save 都会调 trayManager.rebuildMenu()），从
//     探针读回 Electron 真实构建的 Menu 对象条目，对 tray-texts.ts 双语表的
//     zh 形态逐项断言（信息行/启停项/复选框/退出），tooltip 同口径。
//     无托盘宿主的无头 Linux 上 Tray 对象不可观测——该环境降级为 skip
//     （Windows 桌面 / 有托盘环境是硬断言），取舍见 desktop-e2e.yml 头注。
//   用例 3「任务面板/状态页」：hash 路由到 #status（托盘打开状态页的同一
//     载入形态）→ 预置 workDir/meta 终态样本（经 config:save 指向）→ 切到
//     「历史」tab 断言分组/徽章/退出码渲染。数据 mock 走文件系统注入
//     （history:get 的唯一数据源就是 workDir/meta/*.json），零 admin 依赖。
//
// 运行方式（Windows 本机有显示直接跑；Linux CI 需 xvfb + dbus，见
// .github/workflows/desktop-e2e.yml）：
//   cd apps/executor-desktop && npm run build:main && npm run build:renderer
//   npx playwright test --config=e2e/playwright.config.js e2e/n10-desktop.spec.js
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const APP_ENTRY = path.join(__dirname, '..', 'dist', 'main', 'index.js');
// 显式指到本包安装的 electron 可执行（W-25 教训：跨包解析不到）
const ELECTRON_BIN = require('electron');

// 隔离 userData（index.ts 既有通道）：绝不触碰开发者真实 ~/.config，
// 也规避单实例锁冲突。每例独立临时目录，退出即清理。
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function launchApp(extraEnv = {}) {
  return electron.launch({
    executablePath: ELECTRON_BIN,
    // --lang=zh-CN：托盘 locale 取 app.getLocale()（resolveTrayLocale 对
    // en* 走英文表）；CI runner 缺省 locale 是 en，必须在启动参数里钉住
    // 中文，用例 2 的 zh 文案断言才是确定性的（env LANG 作 Linux 侧双保险）。
    args: ['--lang=zh-CN', APP_ENTRY],
    env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', ...extraEnv },
  });
}

/** 首启必经向导；等它的标题渲染出来，返回窗口句柄。 */
async function waitWizard(app) {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.getByText('AutoCodeFlow Executor').first()).toBeVisible({ timeout: 20000 });
  await expect(win.getByText('欢迎使用').first()).toBeVisible();
  return win;
}

// ── 用例 1：启动与主窗口 ─────────────────────────────────────────────
// 钉的是「一次能用的完整启动故事」：首启向导 → 完成配置 → 主窗口带真实
// 内容出现（N48 黑屏回归的启动面版本）→ before-quit 干净退出。
test.describe('N-10 三例', () => {
  // 冷启动预算：本文件首例要吃 Windows 下 Electron 进程冷启动（Defender
  // 首扫等），60s 共享 config 上限对首例太紧——只放宽本文件，不动共享 config。
  test.setTimeout(120_000);

  test('用例1 启动与主窗口：首启向导 → 完成配置 → 状态页主窗口创建且关键元素可见', async () => {
    const userData = tmpDir('acf-n10-boot-');
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      // ① 进程活着且至少一个窗口被创建
      const win = await waitWizard(app);
      expect(app.windows().length).toBeGreaterThanOrEqual(1);

      // ② 向导完成（真实用户流）：autoStart 全关，避免触碰系统自启。
      //    注意必须 void 调用且不 await 返回值：closeWizard() 会在 IPC 响应
      //    回程前销毁向导窗口，await 桥 promise 必然吃「Target closed」。
      //    waitForEvent 显式给超时——无界等待会把失败拖成 test timeout。
      const cfg = await win.evaluate(() => window.electronAPI.getConfig());
      const statusWindowReady = app.waitForEvent('window', { timeout: 30_000 });
      await win.evaluate((config) => {
        void window.electronAPI.saveAndCloseWizard({ ...config, autoStart: false, autoStartExecutor: false });
      }, cfg);
      const status = await statusWindowReady;
      await status.waitForLoadState('domcontentloaded');

      // ③ 主窗口（状态页）关键渲染面：整棵 DOM 画出来（防 N48 黑屏复发）
      await expect(status.locator('.app')).toHaveCount(1, { timeout: 15000 });
      await expect(status.locator('.hero-card')).toHaveCount(1);
      // tabs：状态监控 / 配置 / 历史 / 应用（role=tab + 固定 id）
      expect(await status.locator('[role="tab"]').count()).toBeGreaterThanOrEqual(3);
      for (const id of ['status-tab', 'config-tab', 'history-tab']) {
        await expect(status.locator(`#${id}`)).toHaveCount(1);
      }
      const bodyText = (await status.textContent('body')) || '';
      expect(bodyText).toContain('状态监控');
      expect(bodyText).toContain('运行日志');

      // ④ 向导窗口已关：现在只剩主窗口这一扇（close 的销毁事件是异步的，轮询等收敛）
      await expect.poll(() => app.windows().length, { timeout: 10000 }).toBe(1);

      // ⑤ 干净退出（before-quit 停 executor 链路）——close 不挂起即过
      await app.close();
    } finally {
      try {
        if (app && app.process()) await app.close();
      } catch { /* 已 close */ }
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  // ── 用例 2：托盘与菜单 ──────────────────────────────────────────────
  // Electron 没有枚举 Tray 实例/读回菜单文案的公开 API，探针是唯一不打
  // 生产代码的观测缝：给 Tray.prototype 两个 setter 挂记录（CDP evaluate 跑在
  // 主进程，globalThis 跨 evaluate 持久），菜单重建是既有业务路径必然触发的
  // （autolaunch:set / config:save 尾部都调 trayManager.rebuildMenu()），
  // 不需要任何测试专用后门。
  test('用例2 托盘与菜单：真实 Menu 条目逐项匹配 tray-texts zh 表 + tooltip 同口径', async () => {
    const userData = tmpDir('acf-n10-tray-');
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      const win = await waitWizard(app);

      // ① locale 必须钉成 zh（--lang 失效时这里响亮地红，而不是断言悄悄错语言）
      const locale = await app.evaluate(({ app: electronApp }) => electronApp.getLocale());
      expect(
        locale.toLowerCase().startsWith('zh'),
        `--lang=zh-CN 未生效：app.getLocale()=${locale}，托盘 zh 断言失去前提`,
      ).toBe(true);

      // ② 挂探针（只记录、不改行为；读回值全部拍平成可序列化原始值）
      const installed = await app.evaluate(({ Tray }) => {
        const g = globalThis;
        g.__n10TrayProbe = { tooltips: [], menus: 0, menuItems: null };
        const origTip = Tray.prototype.setToolTip;
        Tray.prototype.setToolTip = function (text) {
          try { g.__n10TrayProbe.tooltips.push(String(text)); } catch { /* 不阻塞 */ }
          return origTip.call(this, text);
        };
        const origMenu = Tray.prototype.setContextMenu;
        Tray.prototype.setContextMenu = function (menu) {
          g.__n10TrayProbe.menus += 1;
          try {
            g.__n10TrayProbe.menuItems = (menu && menu.items ? menu.items : []).map((it) => ({
              label: typeof it.label === 'string' ? it.label : '',
              type: it.type,
              enabled: it.enabled === true,
              checked: it.checked === true,
            }));
          } catch { /* 不阻塞 */ }
          return origMenu.call(this, menu);
        };
        return 'installed';
      });
      expect(installed).toBe('installed');

      // ③ 触发 A：autolaunch:set 尾部必调 rebuildMenu（DEV 模式下写入被拒但
      //    菜单照常重建，autolaunch.ts DEV-AUTOLAUNCH 契约）——零配置副作用
      await win.evaluate(() => window.electronAPI.setAutoLaunch(false));
      const menuA = await app.evaluate(() => globalThis.__n10TrayProbe.menuItems);
      if (!menuA) {
        // 无托盘宿主的无头 Linux：Tray 对象根本没建成（setContextMenu 无人接收）。
        // 该环境下托盘语义本就不存在（tray-texts.ts traySupportsClick 同款平台
        // 分支思路），降级 skip；Windows 桌面 / ci.yml 的 windows job 是硬断言。
        test.skip(true, '托盘子系统在当前无头环境不可观测（Tray 未创建），托盘硬断言在 Windows/有托盘环境执行');
        return;
      }
      // setContextMenu 探针被真实命中 = 有活的 Tray 实例在收菜单
      expect(await app.evaluate(() => globalThis.__n10TrayProbe.menus)).toBeGreaterThanOrEqual(1);

      // 信息三行（stopped 初始态 + Agent 未启用 + 处理数 0）——文案逐字节对
      // tray-texts.ts zh 表（statusPrefix/statusLabel/agentLine/agentProcessedLine）
      const infoLines = ['状态: — 已停止', 'Agent：未启用', 'Agent 已处理 0 个指派；最近结果：暂无'];
      // win/darwin 模板以三行信息开头；linux 顶部多一个「查看状态...」承接
      // 无 click 事件的平台（traySupportsClick 分支），三行整体后移两位。
      const headIdx = process.platform === 'linux' ? 2 : 0;
      for (let i = 0; i < infoLines.length; i++) {
        expect(menuA[headIdx + i], `菜单第 ${headIdx + i + 1} 项`).toEqual({
          label: infoLines[i], type: 'normal', enabled: false, checked: false,
        });
      }
      // 动作项：文案 + 可用态（stopped → 启动可用 / 停止禁用）
      const byLabel = Object.fromEntries(menuA.map((it) => [it.label, it]));
      expect(byLabel['启动执行器']).toEqual({ label: '启动执行器', type: 'normal', enabled: true, checked: false });
      expect(byLabel['停止执行器']).toEqual({ label: '停止执行器', type: 'normal', enabled: false, checked: false });
      expect(byLabel['查看状态...']).toBeTruthy();
      expect(byLabel['打开配置...']).toBeTruthy();
      expect(byLabel['历史日志...']).toBeTruthy();
      // 开机自启：checkbox 且未勾选（隔离 userData 的 autoStart 缺省 false）
      expect(byLabel['开机自启']).toEqual({ label: '开机自启', type: 'checkbox', enabled: true, checked: false });
      expect(byLabel['退出']).toBeTruthy();
      expect(menuA[menuA.length - 1].label).toBe('退出');

      // ④ 触发 B：config:save 改 agentEnabled → 立即热同步 Agent 快照
      //    （index.ts syncAgentHostWithConfig finally 必刷托盘）→ 菜单 Agent 行
      //    与 tooltip 都要用「已启用，等待完成连接配置」（enabled=true、
      //    adminApiUrl 空 → 不起轮询 → awaitingConfig 分支）
      const cfg = await win.evaluate(() => window.electronAPI.getConfig());
      const saved = await win.evaluate((config) => window.electronAPI.saveConfig({ ...config, agentEnabled: true }), cfg);
      expect(saved.ok).toBe(true);
      const menuB = await app.evaluate(() => globalThis.__n10TrayProbe.menuItems);
      expect(menuB.map((it) => it.label)).toContain('Agent：已启用，等待完成连接配置');
      // tooltip：状态段（执行器 stopped）+ Agent 尾段同语言、同口径
      const tips = await app.evaluate(() => globalThis.__n10TrayProbe.tooltips);
      expect(tips.length).toBeGreaterThanOrEqual(1);
      expect(tips[tips.length - 1]).toBe('AutoCodeFlow Executor — 已停止；Agent：已启用，等待完成连接配置');

      await app.close();
    } finally {
      try {
        if (app && app.process()) await app.close();
      } catch { /* 已 close */ }
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  // ── 用例 3：任务面板 / 状态页 ───────────────────────────────────────
  // 数据 mock 的最顺路径不是拦 IPC 也不是起 admin：history:get 的唯一数据源
  // 就是 workDir/meta/*.json（ipc-handlers.ts）——预置终态样本文件 + 经
  // config:save 把 workDir 指过去，面板读到的就是注入数据。顺带把
  // 「损坏 meta 不击穿整批」（pickRecentMetaFiles 逐条容错）也钉进去。
  test('用例3 任务面板：状态页 hash 路由渲染 + 历史面板消费预置终态样本（含损坏文件容错）', async () => {
    const userData = tmpDir('acf-n10-panel-');
    // 预置 workDir/meta：一条失败终态 + 一条损坏 JSON（必须被逐条容错剔除）
    const workDir = tmpDir('acf-n10-workdir-');
    const metaDir = path.join(workDir, 'meta');
    fs.mkdirSync(metaDir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(
      path.join(metaDir, 'seed-exec-1.json'),
      JSON.stringify({
        executionId: 'exec-n10-0001',
        taskId: 'task-n10-seed',
        taskName: 'N-10 混沌冒烟任务',
        startTime: now - 60_000,
        endTime: now,
        status: 'failed',
        exitCode: 1,
        errorMessage: 'CHAOS-DRILL 注入样本：任务执行失败',
      }),
      'utf-8',
    );
    fs.writeFileSync(path.join(metaDir, 'seed-broken.json'), '{ not valid json', 'utf-8');

    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      // ① 托盘左键打开状态页 = 载入 #status 的同一形态（既有 hash 路由入口）
      const win = await waitWizard(app);
      await win.evaluate(() => { window.location.hash = '#status'; window.location.reload(); });
      await win.waitForLoadState('domcontentloaded');
      await expect(win.locator('.hero-card')).toHaveCount(1, { timeout: 15000 });

      // ② 注入 workDir（经真实 config:save 通道 + 消毒层）。
      //    evaluate 的函数体拿不到 Node 闭包变量，且只收一个参数——打包成对象注入。
      const cfg = await win.evaluate(() => window.electronAPI.getConfig());
      const saved = await win.evaluate(
        ({ config, dir }) => window.electronAPI.saveConfig({ ...config, workDir: dir }),
        { config: cfg, dir: workDir },
      );
      expect(saved.ok).toBe(true);

      // ③ 切到「历史」tab（页面常驻 DOM、active 才拉数）→ 分组渲染
      await win.locator('#history-tab').click();
      const group = win.locator('.history-group-header', { hasText: 'N-10 混沌冒烟任务' });
      await expect(group).toBeVisible({ timeout: 15000 });
      // 组级统计：1 失败 / 1 次（损坏文件不得计入、不得让面板空白）
      await expect(group.locator('.history-stat.failed')).toHaveText('1 失败');
      await expect(group.locator('.history-stat.total')).toHaveText('1 次');
      await expect(group.locator('.history-group-meta .badge')).toHaveText('失败');

      // ④ 运行行：首个组有 auto-expand 语义（expandedApp 为 null 时自动展开
      //    第一组，HistoryPage 的报障修复）——此处不该再点头部（点了反而会
      //    toggle 收起），直接断言展开后的运行行徽章 + 注入的 errorMessage
      const runRow = win.locator('.history-run-row');
      await expect(runRow).toHaveCount(1, { timeout: 10000 });
      await expect(runRow.locator('.badge')).toHaveText('失败');
      await expect(runRow.locator('.history-run-err')).toContainText('CHAOS-DRILL 注入样本');

      // ⑤ 状态页主面在切走后依然完好（常驻 DOM 显隐语义）
      await win.locator('#status-tab').click();
      await expect(win.locator('.hero-card')).toHaveCount(1);

      await app.close();
    } finally {
      try {
        if (app && app.process()) await app.close();
      } catch { /* 已 close */ }
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
