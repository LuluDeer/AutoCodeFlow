import { BrowserWindow, app, screen } from 'electron';
import * as path from 'path';
import log from './logger';

const PRELOAD_PATH = path.join(__dirname, '../preload/index.js');

const RENDERER_INDEX = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');

function loadPage(win: BrowserWindow, page: string): void {
  if (process.env.VITE_DEV_SERVER_URL) {
    // Dev mode: use Vite dev server with hash routing
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${page}`);
  } else {
    // Production: use loadFile (handles Windows paths correctly, avoids file:// CSP issues)
    win.loadFile(RENDERER_INDEX, { hash: page });
  }
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
      width: 560,
      height: 600,
      resizable: false,
      center: true,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: true,
      },
    });

    this.wizardWindow.once('ready-to-show', () => { this.wizardWindow?.show(); });
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
    const winW = Math.round(sw * 0.5);
    const winH = Math.round(sh * 0.667);
    this.statusWindow = new BrowserWindow({
      width: winW,
      height: winH,
      minWidth: 620,
      minHeight: 520,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: true,
      },
    });

    this.statusWindow.once('ready-to-show', () => { this.statusWindow?.show(); });
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
