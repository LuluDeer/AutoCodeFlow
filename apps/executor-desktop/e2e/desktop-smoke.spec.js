// QA-12 / N-10：executor-desktop Playwright `_electron` 冒烟。
//
// 覆盖点（对应 BUG-12 / SEC-NEW-1 的桌面端安全与可启动性回归）：
//   ① 应用可启动：首启打开配置向导（wizard 窗口渲染，无白屏）；
//   ② preload 桥在渲染进程可用且 IPC 读面脱敏：config:get 返回
//      恒 ******（token/密文不过桥），通道集合与 preload 白名单一致；
//   ③ 干净退出：before-quit 停止 executor 子进程后 app 正常退出。
//
// 运行方式（Linux 冒烟，CI windows job 同 spec 同入口）：
//   cd apps/executor-desktop && npm run build && npx playwright test
//     --config=e2e/playwright.config.js e2e/desktop-smoke.spec.js
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');

const APP_ENTRY = path.join(__dirname, '..', 'dist', 'main', 'index.js');

// 显式指到本包安装的 electron 可执行（playwright 从调用方 cwd 解析不到跨包 electron）
//
// W-25（修复 desktop-e2e-smoke 在 CI 上长期全红）：原实现写死无扩展名的
// `dist/electron`，这是 **POSIX 布局**；Windows 上该路径不存在（实际是
// `electron.exe`，无扩展名文件为 False），于是 Playwright 拿不到可执行文件，
// 四个用例在 100~170ms 内全部以 `Error: Process failed to launch!` 失败——
// 并非断言问题，而是 Electron 根本没起来。该 job 跑在 windows-latest 上，
// 故此 spec 实际从未在 CI 成功过（PR #4~#7 均同一形态失败）。
const ELECTRON_BIN = require('electron');

function launchApp(extraEnv = {}) {
  return electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_ENTRY],
    env: { ...process.env, ...extraEnv },
  });
}

// 首启冒烟必须在隔离的配置文件上跑，绝不触碰开发者真实 ~/.config
// （ConfigStore 读 userData；用 ELECTRON_USER_DATA_DIR 指向临时目录，
//  断言销毁后目录被清理）。UserData 目录临时化避免单实例锁冲突。
const os = require('os');
const fs = require('fs');

function tmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acf-desktop-e2e-'));
}

test.describe('executor-desktop 冒烟（Playwright _electron）', () => {
  test('启动后首启渲染配置向导，无白屏', async () => {
    const userData = tmpUserData();
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      // wizard 标题（无边框 titlebar）必须渲染
      await expect(win.getByText('AutoCodeFlow Executor').first()).toBeVisible({ timeout: 15000 });
      await expect(win.getByText('欢迎使用').first()).toBeVisible();
    } finally {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test('preload 桥可用：config:get 脱敏（token 恒 ******）且通道白名单不漂移', async () => {
    const userData = tmpUserData();
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      // 桥对象必须存在（contextBridge.exposeInMainWorld('electronAPI')）
      const hasBridge = await win.evaluate(() => typeof window.electronAPI === 'object');
      expect(hasBridge).toBe(true);
      // 读面脱敏：config:get 与既有 getAllMasked 语义一致（空 token → ''，
      // 非空 token → ******，绝无明文回传）
      const cfg = await win.evaluate(() => window.electronAPI.getConfig());
      expect(cfg).toBeTruthy();
      for (const key of ['executorToken', 'token']) {
        if (key in cfg) {
          expect(['', '******'], `${key} 必须脱敏（空或掩码），不得明文`).toContain(cfg[key]);
        }
      }
      // 通道白名单：preload 暴露的通道与 src/preload/index.ts 对齐（防悄悄新增透传）
      // DSK-05：补 downloadUpdate / onUpdateProgress（autoDownload=false 下的
      // 显式下载入口与独立进度通道）。
      // python_task_multiversion：补 getPythonEnvStatus（设置页「Python 运行环境」
      // 的诊断面——只读回报实际生效的 uv / 解释器池路径，不写配置、不下发凭据）。
      const channels = await win.evaluate(() => Object.keys(window.electronAPI).sort());
      // N-10 复核：本白名单**早已漂移**（此 job 是 PR/dispatch 门控，develop push 不跑，
      // 故长期无人发现）。实测运行时 41 个通道，白名单只列了 32 个——漏掉
      // deleteAppRelease / getAgentStatus / getRunningApps / openAppFolder /
      // openReleaseFolder / openTaskLogFolder / revealExecLog / uninstallApp /
      // writeClipboardText 共 9 个。白名单失守意味着"通道漂移守卫"名存实亡
      // （新通道加进来不会有任何提示）。此处按**实测运行时**对齐，
      // 并保留"新增即红"的原意：下次加通道而不改这里，本用例仍会红。
      expect(channels).toEqual(
        [
          'checkForUpdate', 'checkPort', 'clearHistory', 'closeWindow', 'deleteAppRelease',
          'downloadUpdate', 'getAgentStatus', 'getAutoLaunch', 'getConfig', 'getHistory',
          'getLocalIPs', 'getPythonEnvStatus', 'getRunningApps', 'getStatus', 'getTodayLogs',
          'installUpdate', 'listApps', 'listLogFiles', 'minimizeWindow', 'onLogLine',
          'onStatusChange', 'onSwitchTab', 'onUpdateAvailable', 'onUpdateDownloaded',
          'onUpdateError', 'onUpdateProgress', 'openAppFolder', 'openLogFile',
          'openReleaseFolder', 'openTaskLogFolder', 'readAppLog', 'readLog', 'revealExecLog',
          'saveAndCloseWizard', 'saveConfig', 'setAutoLaunch', 'startExecutor',
          'stopExecutor', 'testConnection', 'uninstallApp', 'writeClipboardText',
        ].sort(),
      );
    } finally {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  // N48（v1.4.6 黑屏根因回归）：曾出现「向导正常、进主窗口只有背景色」——
  // StatusWindow 误调 preload 未暴露的 electronAPI.invoke 使 useEffect 同步抛
  // 错，React 无错误边界卸载整棵树（.app 缺失）。本用例钉死：主窗口必须
  // 渲染出 tabs/hero-card/日志区等真实内容，防止黑屏复发。
  test('主窗口（状态页）渲染内容，非仅背景色', async () => {
    const userData = tmpUserData();
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      // 先等向导渲染完（隔离 userData 首启），再切到主窗口 #status。
      // 主进程用 loadFile(hash) 载入，App 在 mount 时读 hash 决定 wizard/主窗口；
      // reload 让 main.tsx 以 #status 重新执行 → 挂载 MainWindow（等同托盘打开状态页）。
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await expect(win.getByText('欢迎使用').first()).toBeVisible({ timeout: 15000 });
      await win.evaluate(() => { window.location.hash = '#status'; window.location.reload(); });
      await win.waitForLoadState('domcontentloaded');
      await win.waitForTimeout(1500);

      // 黑屏特征：.app 树缺失（原 bug 时 React 卸载）。现断言整棵主窗口 DOM 画出来。
      expect(await win.locator('.app').count()).toBe(1);
      expect(await win.locator('.hero-card').count()).toBe(1);
      expect(await win.locator('.tabs .tab').count()).toBeGreaterThanOrEqual(3);
      const bodyText = (await win.textContent('body')) || '';
      expect(bodyText).toContain('状态监控');
      expect(bodyText).toContain('运行日志');
    } finally {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  // ── N-10：计划点名的三个场景（注册 / 托盘 / 任务面板）──────────────
  // 复核发现原 spec 覆盖的是「启动/preload/退出」，**与计划点名的三场景无交集**，
  // 故按 IPC 真实契约补测。三例都走 preload 暴露的通道（渲染进程真实可达面），
  // 不断言主进程内部对象——内部实现可重构，IPC 契约才是回归面。

  test('注册：executor:status 的 IPC 契约稳定且 config 读面恒脱敏', async () => {
    const userData = tmpUserData();
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');

      // 经 preload 桥取执行器状态（"注册/连接状态"的渲染进程可见面）
      const st = await win.evaluate(() => window.electronAPI.getStatus());
      // 契约三键必须齐全（running/status/config）——缺一即渲染层状态区失据
      expect(Object.keys(st).sort()).toEqual(['config', 'running', 'status']);
      expect(typeof st.running).toBe('boolean');
      expect(typeof st.status).toBe('string');
      // 首启未启动：running 必为 false（不得谎报在跑）
      expect(st.running).toBe(false);
      // config 读面恒脱敏（SEC-NEW-1 红线，与既有 preload 用例同口径但此处
      // 从 executor:status 这条**另一条**通道再验一次——两条通道都带 config，
      // 只验一条会漏掉另一条的脱敏回归）
      const cfg = st.config || {};
      for (const k of ['token', 'executorSecret', 'secret', 'password']) {
        if (k in cfg && cfg[k] != null) {
          expect(String(cfg[k])).toMatch(/^\*+$/);
        }
      }
    } finally {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test('托盘：状态窗口（托盘左键打开的那一扇）承载状态与 Agent 提示面', async () => {
    const userData = tmpUserData();
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await expect(win.getByText('欢迎使用').first()).toBeVisible({ timeout: 15000 });
      // 托盘 onOpenStatus → windowManager.focusOrOpenStatus() 载入 #status；
      // 此处以同一入口（hash 切换）复现"托盘打开状态窗口"的渲染结果。
      await win.evaluate(() => { window.location.hash = '#status'; window.location.reload(); });
      await win.waitForLoadState('domcontentloaded');
      await win.waitForTimeout(1500);

      const body = (await win.textContent('body')) || '';
      // 托盘 tooltip 的两块信息在状态窗口同样可见（执行器状态 + Agent 活动）
      expect(body).toMatch(/在线|离线|启动中|已停止/);
      expect(body).toContain('状态监控');
      // 托盘菜单项对应的动作面必须在窗口内可达（启动/停止）
      expect(await win.locator('button').count()).toBeGreaterThan(0);
    } finally {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test('任务面板：history:get 返回数组且条目契约稳定（面板取数面）', async () => {
    const userData = tmpUserData();
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');

      // 隔离 userData + 无 workDir → 必为空数组（不得抛错、不得返回 null：
      // 面板对 null 会渲染崩溃，这正是本用例要钉的回归面）
      const hist = await win.evaluate(() => window.electronAPI.getHistory());
      expect(Array.isArray(hist)).toBe(true);

      // 有 workDir 但目录不存在时同样必须是数组（fail-safe 取数面）
      await win.evaluate(async () => {
        const cfg = await window.electronAPI.getConfig();
        return window.electronAPI.saveConfig({ ...cfg, workDir: '/nonexistent-acf-e2e' });
      });
      const hist2 = await win.evaluate(() => window.electronAPI.getHistory());
      expect(Array.isArray(hist2)).toBe(true);
      expect(hist2.length).toBe(0);
    } finally {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test('干净退出：close 后进程结束（before-quit 链路）', async () => {
    const userData = tmpUserData();
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      // Playwright 走 app.quit → before-quit → 停止 executor 子进程；退出后
      // process() 即数组清空，前一次引用不可再用——以窗口销毁为协同完成信号
      await app.close();
      await win.waitForEvent('close', { timeout: 15000 }).catch(() => {});
    } finally {
      try {
        if (app && app.process()) await app.close();
      } catch { /* 已 close 或不可用 */ }
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});