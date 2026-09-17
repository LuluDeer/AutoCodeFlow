// QA-12：executor-desktop Playwright `_electron` 冒烟 3 例。
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
      expect(channels).toEqual(
        [
          'checkForUpdate', 'checkPort', 'clearHistory', 'closeWindow', 'downloadUpdate',
          'getAutoLaunch', 'getConfig', 'getHistory', 'getLocalIPs', 'getPythonEnvStatus',
          'getStatus',
          'getTodayLogs', 'installUpdate', 'listApps', 'listLogFiles', 'minimizeWindow', 'onLogLine',
          'onStatusChange', 'onSwitchTab', 'onUpdateAvailable', 'onUpdateDownloaded',
          'onUpdateError', 'onUpdateProgress', 'openLogFile', 'readAppLog', 'readLog',
          'saveAndCloseWizard', 'saveConfig', 'setAutoLaunch', 'startExecutor',
          'stopExecutor', 'testConnection',
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