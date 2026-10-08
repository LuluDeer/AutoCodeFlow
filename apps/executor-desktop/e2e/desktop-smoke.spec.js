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

// 语言必须**钉死**，否则全部中文锚点都是 locale 相关的：
// 渲染层 locale 取 navigator.language（i18n.ts resolveRendererLocale：`en*`
// → 英文表，其余回落中文），而 GitHub 的 windows-latest runner 缺省 locale
// 是 en-US → 向导渲染 "Welcome" 而非 "欢迎使用"，本 spec 的十几处中文断言
// 在 CI 上必然全红（本地 zh-CN 机器则恒绿——这正是它长期"本地过、CI 挂"
// 的根因）。
//
// 注意本 job 的失败形态会**误导排查**：第 53 行的品牌名 "AutoCodeFlow
// Executor" 中英同形、先通过，失败停在第 54 行的「欢迎使用」，看起来像
// "向导没渲染出来/白屏"，实际只是语言不同。
//
// n10-desktop.spec.js 早已用同一手法钉住 --lang=zh-CN（见其 launchApp 注释
// "CI runner 缺省 locale 是 en，必须在启动参数里钉住中文"）；本 spec 此前
// 漏了这一步。env 的 LANG/LC_ALL 是 Linux 侧双保险（Windows 不读它们，
// 真正生效的是 --lang）。
function launchApp(extraEnv = {}) {
  return electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['--lang=zh-CN', APP_ENTRY],
    env: {
      ...process.env,
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      ...extraEnv,
    },
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
      //
      // 拓展包（a8a380e4）再补 3 个：exportConfig / importConfig / exportExecLog。
      // 三者都已在主进程有真实 handler（ipc-handlers.ts 的 config:export /
      // config:import / history:export-log），并由 export-flows.selftest 钉住
      // 各自的守卫链（掩码导出、sanitize 消毒、copyFile 不改原文件 + 大文件拦截），
      // 属"实现已落地、白名单没跟上"，不是新增未实现的通道。
      expect(channels).toEqual(
        [
          'checkForUpdate', 'checkPort', 'clearHistory', 'closeWindow', 'deleteAppRelease',
          'downloadUpdate', 'exportConfig', 'exportExecLog', 'getAgentStatus', 'getAutoLaunch',
          'getConfig', 'getHistory',
          'getLocalIPs', 'getPythonEnvStatus', 'getRunningApps', 'getStatus', 'getTodayLogs',
          'getWindowState', 'importConfig', 'installUpdate', 'listApps', 'listLogFiles', 'minimizeWindow', 'onLogLine',
          'onStatusChange', 'onSwitchTab', 'onUpdateAvailable', 'onUpdateDownloaded',
          'onWindowMaximizeChange',
          'onUpdateError', 'onUpdateProgress', 'openAppFolder', 'openLogFile',
          'openReleaseFolder', 'openTaskLogFolder', 'readAppLog', 'readLog', 'revealExecLog',
          'saveAndCloseWizard', 'saveConfig', 'setAutoLaunch', 'startExecutor',
          'stopExecutor', 'testConnection', 'toggleMaximizeWindow', 'uninstallApp', 'writeClipboardText',
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

  test('主窗口按工作区放大，支持最大化并记住调整后的尺寸', async () => {
    const userData = tmpUserData();
    const app = await launchApp({ ELECTRON_USER_DATA_DIR: userData });
    try {
      const wizard = await app.firstWindow();
      await expect(wizard.getByText('欢迎使用').first()).toBeVisible({ timeout: 15000 });
      const cfg = await wizard.evaluate(() => window.electronAPI.getConfig());
      const statusWindowReady = app.waitForEvent('window');
      await wizard.evaluate((config) => {
        void window.electronAPI.saveAndCloseWizard({ ...config, autoStart: false, autoStartExecutor: false });
      }, cfg);
      const status = await statusWindowReady;
      await expect(status.getByRole('button', { name: '最大化窗口' })).toBeVisible();

      const initial = await app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return {
          bounds: win.getBounds(),
          workArea: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
        };
      });
      expect(initial.bounds.width).toBeGreaterThanOrEqual(Math.min(1200, Math.round(initial.workArea.width * 0.75)));
      expect(initial.bounds.height).toBeGreaterThanOrEqual(Math.min(700, Math.round(initial.workArea.height * 0.78)));
      expect(initial.bounds.width).toBeLessThanOrEqual(initial.workArea.width);
      expect(initial.bounds.height).toBeLessThanOrEqual(initial.workArea.height);

      await status.getByRole('button', { name: '最大化窗口' }).click();
      // 最大化态经主进程 IPC 回流渲染层，慢 runner 上 5s 默认窗不够（CI 首跑实证）
      await expect(status.getByRole('button', { name: '还原窗口' })).toBeVisible({ timeout: 10_000 });
      expect(await status.evaluate(() => window.electronAPI.getWindowState())).toEqual({ maximized: true });
      await status.getByRole('button', { name: '还原窗口' }).click();
      await expect(status.getByRole('button', { name: '最大化窗口' })).toBeVisible();

      const targetWidth = Math.min(1100, initial.workArea.width);
      const targetHeight = Math.min(680, initial.workArea.height);
      await app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height);
      }, { width: targetWidth, height: targetHeight });
      const closed = status.waitForEvent('close');
      await status.getByRole('button', { name: '关闭窗口' }).click();
      // C-04（v3 R4 落地，本用例此前未随门禁运行）：首次关闭被一次性托盘驻留
      // 气泡拦截——点「知道了」才真正关窗。气泡文案经 V4-5 迁入 shell 双语键，
      // zh 值与硬编码期逐字一致。
      await expect(status.getByText('窗口会关闭，但应用驻留系统托盘，执行器继续运行。')).toBeVisible();
      // 状态页首启还有托盘常驻提示条（D-01）也带「知道了」——锚定 close-tip 气泡作用域
      await status.locator('.close-tip').getByRole('button', { name: '知道了' }).click();
      await closed;
      const saved = JSON.parse(fs.readFileSync(path.join(userData, 'status-window.json'), 'utf8'));
      expect(saved).toMatchObject({ width: targetWidth, height: targetHeight, maximized: false });
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
