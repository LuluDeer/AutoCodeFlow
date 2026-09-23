import { BrowserWindow, app, screen } from 'electron';
import * as path from 'path';
import { existsSync } from 'fs';
import log from './logger';

const PRELOAD_PATH = path.join(__dirname, '../preload/index.js');

// QA-12：裸 electron 跑 e2e 时 getAppPath()===__dirname（dist/main），
//   dist/renderer 是上一级 sibling；打包形态才是 <app>/dist/renderer。
// 双路径探测取存在者——两种形态同一语义，无行为差异。
function resolveRendererIndex(): string {
  const preferred = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
  const adjacent = path.join(__dirname, '..', 'renderer', 'index.html');
  return existsSync(preferred) ? preferred : adjacent;
}

const RENDERER_INDEX = resolveRendererIndex();

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
function showWhenReady(win: BrowserWindow): void {
  let shown = false;
  const doShow = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', doShow);
  const timer = setTimeout(doShow, 3000);
  win.once('closed', () => clearTimeout(timer));
}

function loadPage(win: BrowserWindow, page: string): void {
  if (process.env.VITE_DEV_SERVER_URL) {
    // Dev mode: use Vite dev server with hash routing
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${page}`);
  } else {
    // Production: use loadFile (handles Windows paths correctly, avoids file:// CSP issues)
    win.loadFile(RENDERER_INDEX, { hash: page });
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
  const devUrl = process.env.VITE_DEV_SERVER_URL;

  win.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      log.warn(`Blocked navigation to ${url}`);
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
  private configWindow: BrowserWindow | null = null;

  openWizard(): void {
    if (this.wizardWindow && !this.wizardWindow.isDestroyed()) {
      this.wizardWindow.focus();
      return;
    }

    this.wizardWindow = new BrowserWindow({
      width: 520,
      height: 640,
      resizable: false,
      center: true,
      show: false,
      frame: false,
      // WIN-DISPLAY (1.4.3 Hotfix / N47): transparent+frameless 窗口在部分
      // Windows 机器上整窗复合失败（窗口 show() 了但屏幕上看不到——首个
      // 发布的 Windows 安装包被真用户报告的致命问题）。改实心背景色渲染，
      // backgroundColor 与 app.css 的 --bg (#020617) 对齐，UI 视觉不变。
      backgroundColor: '#020617',
      webPreferences: sharedWebPreferences(),
    });

    showWhenReady(this.wizardWindow);
    // SEC-DSK-01：导航/弹窗/webview 守卫（每个窗口都必须挂）
    hardenWindow(this.wizardWindow);
    loadPage(this.wizardWindow, 'wizard');
    this.wizardWindow.on('closed', () => { this.wizardWindow = null; });
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
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    // 固定窗口大小：约屏幕的 60% 宽 × 80% 高，保证内容空间充足且不会太占屏。
    // 高度上限 720 → 820：配置页的「Python 运行环境」一节（诊断块 + 提示条 +
    // 5 个字段）在 720px 下几乎整页都要滚动，标题常被裁切；1080p 工作区下
    // 80% ≈ 820px 可容纳。
    const winW = Math.round(Math.min(sw * 0.6, 960));
    const winH = Math.round(Math.min(sh * 0.8, 820));
    this.statusWindow = new BrowserWindow({
      width: winW,
      height: winH,
      minWidth: 760,
      minHeight: 560,
      show: false,
      frame: false,
      resizable: true,
      // WIN-DISPLAY (1.4.3 Hotfix / N47): 同 wizard——去掉 transparent，
      // 改实心 backgroundColor，避免 Windows 部分机器透明窗口整窗不可见。
      backgroundColor: '#020617',
      // BUG-12: single hardened webPreferences source for every window.
      // sandbox defaults on (Electron ≥20), which also blocks the preload
      // from pulling full Node modules into the renderer bridge.
      webPreferences: sharedWebPreferences(),
    });

    showWhenReady(this.statusWindow);
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

  closeWizard(): void {
    if (this.wizardWindow && !this.wizardWindow.isDestroyed()) {
      this.wizardWindow.close();
    }
  }
}
