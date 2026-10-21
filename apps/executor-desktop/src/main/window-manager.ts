import { BrowserWindow, app, screen } from 'electron';
import * as path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import log from './logger';
// R106：导航白名单判定（纯函数，selftest 直接驱动）。
import { isAllowedNavigation } from './navigation-policy';
import { pathToFileURL } from 'url';

const PRELOAD_PATH = path.join(__dirname, '../preload/index.js');

// QA-12：裸 electron 跑 e2e 时 getAppPath()===__dirname（dist/main），
//   dist/renderer 是上一级 sibling；打包形态才是 <app>/dist/renderer。
// 双路径探测取存在者——两种形态同一语义，无行为差异。
//
// SEC-IPC-SENDER（R86-A1 轴 1）：**导出**给 ipc-handlers 做 sender 白名单锚点。
// 必须复用这一份而不是另算一遍：loadFile 加载的入口页与 IPC 允许的页一旦漂移，
// 要么闸门误杀（应用直接不可用），要么白名单形同虚设。
let rendererIndexCache: string | null = null;
function resolveRendererV1Index(): string {
  // 进程内只判定一次（存在性探测有 I/O）：IPC 闸每次调用都要取锚点，
  // 热路径（log:read 1.5s 轮询等）不该反复 stat 磁盘。
  if (rendererIndexCache === null) {
    const preferred = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
    const adjacent = path.join(__dirname, '..', 'renderer', 'index.html');
    rendererIndexCache = existsSync(preferred) ? preferred : adjacent;
  }
  return rendererIndexCache;
}

/**
 * V2 渲染层入口（`dist/renderer-v2/index.html`）。
 *
 * 与 V1 同样双路径探测：打包态在 `<app>/dist/renderer-v2`，裸 electron 跑 e2e 时
 * 在 `__dirname/../renderer-v2`。是否启用由 `ACF_RENDERER=v2` 决定（见
 * resolveActiveRendererIndex），默认仍走 V1，切换是显式动作。
 */
let rendererV2IndexCache: string | null = null;
export function resolveRendererV2Index(): string {
  if (rendererV2IndexCache === null) {
    const preferred = path.join(app.getAppPath(), 'dist', 'renderer-v2', 'index.html');
    const adjacent = path.join(__dirname, '..', 'renderer-v2', 'index.html');
    rendererV2IndexCache = existsSync(preferred) ? preferred : adjacent;
  }
  return rendererV2IndexCache;
}

/**
 * 当前进程该加载的渲染层入口 —— **loadPage / 导航守卫 / IPC sender 闸共用这一份**。
 *
 * 2026-10 起 V2 是**默认**渲染层；`ACF_RENDERER=v1` 是显式逃生门（回退旧 UI）。
 * V2 产物缺失时同样回退 V1 并落 warn，绝不出现白屏。
 */
export function resolveRendererIndex(): string {
  if (process.env.ACF_RENDERER === 'v1') return resolveRendererV1Index();
  const v2 = resolveRendererV2Index();
  if (existsSync(v2)) return v2;
  log.warn('V2 renderer missing (dist/renderer-v2); falling back to V1 renderer');
  return resolveRendererV1Index();
}

type SavedWindowSize = { width: number; height: number; maximized: boolean };

function statusWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'status-window.json');
}

function readStatusWindowSize(): SavedWindowSize | null {
  try {
    const value: unknown = JSON.parse(readFileSync(statusWindowStatePath(), 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const state = value as Partial<SavedWindowSize>;
    if (!Number.isFinite(state.width) || !Number.isFinite(state.height)) return null;
    return { width: state.width!, height: state.height!, maximized: state.maximized === true };
  } catch {
    return null;
  }
}

function saveStatusWindowSize(win: BrowserWindow): void {
  try {
    const { width, height } = win.getNormalBounds();
    writeFileSync(statusWindowStatePath(), JSON.stringify({
      width,
      height,
      maximized: win.isMaximized(),
    } satisfies SavedWindowSize));
  } catch (error) {
    log.warn('Could not save status window size:', error);
  }
}

/**
 * BUG-12: one hardened webPreferences block shared by every window.
 * contextIsolation on + nodeIntegration off keep the renderer sandboxed away
 * from Node; devTools stays true — this is a tray/desktop tool where users
 * diagnose their own installs, and disabling it is a UX cost with no security
 * boundary here (renderer never receives secrets; see SEC-NEW-1 masking).
 */
function sharedWebPreferences(): Electron.WebPreferences {
  return {
    preload: PRELOAD_PATH,
    contextIsolation: true,
    nodeIntegration: false,
    // SEC-DSK-01：显式开启沙箱。Electron ≥20 默认已开，但显式写出可防
    // 未来 Electron 版本默认值变化 / 配置被无意改动时静默退化。
    sandbox: true,
    // 渲染层不需要 webview 标签；显式关闭标签注入面（配合 will-attach-webview）
    webviewTag: false,
    devTools: true,
  };
}

/**
 * WIN-DISPLAY (1.4.3 Hotfix / N47)：可靠显示窗口。
 * 原逻辑仅 `once('ready-to-show', show)`——若打包形态下渲染进程首绘推迟或
 * `ready-to-show` 极慢，窗口会停留在 `show:false` 永久不可见（用户报告的
 * 「托盘在但任何窗口都打不开、重装一样」）。这里双保险：
 *   - ready-to-show 一到就 show；
 *   - 兜底定时器（3s）强制 show，避免首绘分钟级延迟时窗口永不出现。
 * 窗口已带不透明 backgroundColor，提前 show 也无白闪/透明空洞。
 */
function showWhenReady(win: BrowserWindow, maximize = false): void {
  let shown = false;
  const doShow = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (maximize) win.maximize();
    win.show();
  };
  win.once('ready-to-show', doShow);
  const timer = setTimeout(doShow, 3000);
  win.once('closed', () => clearTimeout(timer));
}

/**
 * 渲染层基址覆盖。
 *
 * `ACF_RENDERER_URL` 是给 V2 渲染层联调/换壳验证用的显式入口；未设置时
 * 行为与之前完全一致（VITE_DEV_SERVER_URL → 打包入口）。导航守卫必须与
 * 这里用**同一个**基址，否则加载成功但导航被拦。
 */
function rendererBaseUrl(): string | null {
  const raw = process.env.ACF_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function loadPage(win: BrowserWindow, page: string): void {
  const base = rendererBaseUrl();
  if (base) {
    // Dev / V2 联调：远程 URL + hash 路由（V2 忽略 hash，等价于首页）
    win.loadURL(`${base}#${page}`);
  } else {
    // Production: use loadFile (handles Windows paths correctly, avoids file:// CSP issues)
    win.loadFile(resolveRendererIndex(), { hash: page });
  }
}

/**
 * SEC-DSK-01：导航与窗口打开守卫。
 *
 * 桌面端渲染层是本机 UI，不应具备"把窗口导航到别处"的能力：一旦
 * 某个 XSS/注入点在渲染层落地，未加守卫时攻击者可整页导航到远端页面
 * （此时 preload 桥仍在，等于把 electronAPI 暴露给任意网页），或弹出一个
 * 无 preload 但可伪装成应用界面的窗口。两道守卫：
 *
 *  - will-navigate：只允许留在本应用页面（dev server 或 file:// 自身），
 *    其余一律阻止；外链交给系统浏览器（shell.openExternal 由 IPC 面处理）。
 *  - setWindowOpenHandler：一律 deny——本应用没有合法的 window.open 需求，
 *    任何弹出请求都不该被满足（返回 deny 比 allow 更安全，避免遗漏）。
 */
function hardenWindow(win: BrowserWindow): void {
  const devUrl = rendererBaseUrl();
  // R106：生产只允许**入口页本身**（忽略 hash/query），不再放行任意 file://。
  // 之前那条前缀判据等于「任何本地 HTML 都能接管这个 webContents」——而导航后
  // preload 桥仍挂着，等于把整套 electronAPI 交给那个页面。
  const policy = {
    devUrl: devUrl ?? null,
    rendererFileUrl: devUrl ? null : pathToFileURL(resolveRendererIndex()).toString(),
  };

  // R127：**两个 handler 各自内联 preventDefault**，不再抽 helper。
  //
  // 抽 helper 更 DRY，但会让「守卫必须真的阻止」这条静态判据失去锚点：
  // 判据只能在 will-navigate 附近找 preventDefault，而 helper 写在上面 —— 于是它
  // 会去**同一个函数里 will-attach-webview 那一处**找，把「删掉 will-navigate 的阻止逻辑」
  // 也判成绿（本轮反证实测）。
  //
  // 在这里**可检查性优先于 DRY**：多写三行，换一条判据真的能红。
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, policy)) {
      event.preventDefault();
      log.warn(`Blocked navigation to ${url}`);
    }
  });
  // R106：`will-redirect` 与 `will-navigate` 是**两条独立事件**，只挂前者等于给服务端 3xx 留了后门
  // （dev 形态下尤其明显）。同一条判据同时挂上去。
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url, policy)) {
      event.preventDefault();
      log.warn(`Blocked redirect to ${url}`);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    log.warn(`Blocked window.open to ${url}`);
    return { action: 'deny' };
  });

  // 阻止渲染层通过 <webview>/iframe 挂载任意内容（本应用无该需求）
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log.warn('Blocked webview attach');
  });
}

export class WindowManager {
  private statusWindow: BrowserWindow | null = null;
  private wizardWindow: BrowserWindow | null = null;
  // 重跑向导流（2026-10-13）：主窗已开着时唤出向导，主窗 hide 让位（不
  // close——未保存的配置改动与页面状态保留）。向导以任何方式关闭（完成或
  // 取消）都在 wizardWindow 的 closed 钩子里唤回主窗；finish 路径的
  // focusOrOpenStatus 与此幂等（已 show 的窗口只聚焦，不新建）。
  private statusHiddenByWizard = false;

  openWizard(): void {
    if (this.wizardWindow && !this.wizardWindow.isDestroyed()) {
      this.wizardWindow.focus();
      return;
    }

    // 重跑向导：主窗可见时为向导让位（首次启动无主窗，此分支不触发）——
    // 与首次启动行为一致：向导是唯一窗口，而不是叠在旧窗上的对话框。
    if (this.statusWindow && !this.statusWindow.isDestroyed() && this.statusWindow.isVisible()) {
      this.statusHiddenByWizard = true;
      this.statusWindow.hide();
    }

    this.wizardWindow = new BrowserWindow({
      width: 660,
      height: 780,
      resizable: false,
      center: true,
      show: false,
      frame: false,
      // WIN-DISPLAY (1.4.3 Hotfix / N47): transparent+frameless 窗口在部分
      // Windows 机器上整窗复合失败（窗口 show() 了但屏幕上看不到——首个
      // 发布的 Windows 安装包被真用户报告的致命问题）。改实心背景色渲染，
      // backgroundColor 与 app.css 的 --bg (#f5f6f8，明亮风基线) 对齐，UI 视觉不变。
      backgroundColor: '#f5f6f8',
      webPreferences: sharedWebPreferences(),
    });

    showWhenReady(this.wizardWindow);
    // SEC-DSK-01：导航/弹窗/webview 守卫（每个窗口都必须挂）
    hardenWindow(this.wizardWindow);
    loadPage(this.wizardWindow, 'wizard');
    this.wizardWindow.on('closed', () => {
      this.wizardWindow = null;
      // 重跑向导流收尾：无论向导是完成（save-and-close-wizard）还是用户
      // 直接点关闭取消，都把为主窗让位时隐藏的窗口唤回——否则取消路径下
      // 桌面上什么都不剩（配置未动，只是界面消失了）。
      if (this.statusHiddenByWizard) {
        this.statusHiddenByWizard = false;
        this.focusOrOpenStatus();
      }
    });
    log.info('Wizard window opened');
  }

  focusOrOpenStatus(): void {
    if (this.statusWindow && !this.statusWindow.isDestroyed()) {
      this.statusWindow.show();
      this.statusWindow.focus();
      return;
    }
    this.openStatus();
  }

  openStatus(): void {
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const saved = readStatusWindowSize();
    // 首次打开以工作区 84% × 88% 为基准；高密度应用/任务/日志有足够宽度。
    // 用户手动调整后记住常规尺寸；换显示器时再钳进当前工作区。
    const minWidth = Math.min(760, workArea.width);
    const minHeight = Math.min(560, workArea.height);
    const fit = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
    const winW = fit(saved?.width ?? Math.min(workArea.width * 0.84, 2200), minWidth, workArea.width);
    const winH = fit(saved?.height ?? Math.min(workArea.height * 0.88, 1200), minHeight, workArea.height);
    this.statusWindow = new BrowserWindow({
      width: winW,
      height: winH,
      x: Math.round(workArea.x + (workArea.width - winW) / 2),
      y: Math.round(workArea.y + (workArea.height - winH) / 2),
      minWidth,
      minHeight,
      show: false,
      frame: false,
      resizable: true,
      // WIN-DISPLAY (1.4.3 Hotfix / N47): 同 wizard——去掉 transparent，
      // 改实心 backgroundColor，避免 Windows 部分机器透明窗口整窗不可见。
      // #f5f6f8 与 app.css 的 --bg（明亮风基线）对齐。
      backgroundColor: '#f5f6f8',
      // BUG-12: single hardened webPreferences source for every window.
      // sandbox defaults on (Electron ≥20), which also blocks the preload
      // from pulling full Node modules into the renderer bridge.
      webPreferences: sharedWebPreferences(),
    });

    const win = this.statusWindow;
    showWhenReady(win, saved?.maximized === true);
    win.on('maximize', () => win.webContents.send('window:maximize-change', true));
    win.on('unmaximize', () => win.webContents.send('window:maximize-change', false));
    win.on('close', () => { if (!win.isDestroyed()) saveStatusWindowSize(win); });
    // SEC-DSK-01：导航/弹窗/webview 守卫（每个窗口都必须挂）
    hardenWindow(this.statusWindow);
    loadPage(this.statusWindow, 'status');
    this.statusWindow.on('closed', () => { this.statusWindow = null; });
    log.info('Status window opened');
  }

  openConfig(): void {
    const isNew = !this.statusWindow || this.statusWindow.isDestroyed();
    this.focusOrOpenStatus();
    const win = this.statusWindow;
    if (!win) return;
    if (isNew) {
      win.once('ready-to-show', () => win.webContents.send('switch-tab', 'config'));
    } else {
      win.webContents.send('switch-tab', 'config');
    }
  }

  openHistory(): void {
    const isNew = !this.statusWindow || this.statusWindow.isDestroyed();
    this.focusOrOpenStatus();
    const win = this.statusWindow;
    if (!win) return;
    if (isNew) {
      win.once('ready-to-show', () => win.webContents.send('switch-tab', 'history'));
    } else {
      win.webContents.send('switch-tab', 'history');
    }
  }

  /** V4-4：托盘菜单补齐第四 Tab（与 openConfig/openHistory 同形态）。 */
  openApps(): void {
    const isNew = !this.statusWindow || this.statusWindow.isDestroyed();
    this.focusOrOpenStatus();
    const win = this.statusWindow;
    if (!win) return;
    if (isNew) {
      win.once('ready-to-show', () => win.webContents.send('switch-tab', 'apps'));
    } else {
      win.webContents.send('switch-tab', 'apps');
    }
  }

  closeWizard(): void {
    if (this.wizardWindow && !this.wizardWindow.isDestroyed()) {
      this.wizardWindow.close();
    }
  }
}
