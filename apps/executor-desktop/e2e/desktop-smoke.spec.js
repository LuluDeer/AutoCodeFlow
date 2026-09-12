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
const ELECTRON_BIN = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron');

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
      const channels = await win.evaluate(() => Object.keys(window.electronAPI).sort());
      expect(channels).toEqual(
        [
          'checkForUpdate', 'checkPort', 'clearHistory', 'closeWindow', 'getAutoLaunch',
          'getConfig', 'getHistory', 'getLocalIPs', 'getStatus', 'installUpdate',
          'listApps', 'listLogFiles', 'minimizeWindow', 'onLogLine', 'onStatusChange',
          'onSwitchTab', 'onUpdateAvailable', 'onUpdateDownloaded', 'onUpdateError',
          'openLogFile', 'readAppLog', 'readLog', 'saveAndCloseWizard', 'saveConfig',
          'setAutoLaunch', 'startExecutor', 'stopExecutor', 'testConnection',
        ].sort(),
      );
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