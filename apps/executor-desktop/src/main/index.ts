import { app, Menu } from 'electron';
import { ConfigStore } from './config-store';
import { ExecutorProcess } from './executor-process';
import { HeartbeatMonitor } from './heartbeat';
import { TrayManager } from './tray';
import { WindowManager } from './window-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { getAutoLaunchEnabled, setAutoLaunchEnabled } from './autolaunch';
import { initUpdater } from './updater';
import { Notifier } from './notifier';
import * as path from 'path';
import log from './logger';

// 单例导出，供 ipc-handlers 等模块使用
// QA-12：e2e 隔离通道——冒烟用例经 env 覆盖 userData 指向临时目录，
// 绝不触碰开发者真实配置；未设置时行为与旧版逐字节一致。
if (process.env.ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', process.env.ELECTRON_USER_DATA_DIR);
}
export const configStore = new ConfigStore();
export const executorProcess = new ExecutorProcess();
export const heartbeat = new HeartbeatMonitor();
export const trayManager = new TrayManager();
export const windowManager = new WindowManager();
// DSK-04：系统通知（任务终态 / 执行器离线）
export const notifier = new Notifier();

// 单实例锁：第二个进程启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  windowManager.focusOrOpenStatus();
});

// 托盘应用不随最后一个窗口关闭而退出
app.on('window-all-closed', () => undefined);

// before-quit 是同步事件，Electron 不等 async 回调。
// 用 preventDefault 阻止退出，待 executor-node 子进程真正结束后再 quit。
let isQuitting = false;
app.on('before-quit', (e) => {
  if (isQuitting) return; // 第二次进来直接放行
  e.preventDefault();
  isQuitting = true;
  log.info('App quitting, stopping executor and heartbeat...');
  heartbeat.stop();
  executorProcess.stop().finally(() => {
    app.quit(); // 子进程已退出，真正退出
  });
});

app.whenReady().then(async () => {
  // 移除默认菜单栏（File/Edit/View 等），Linux/Windows 上会显示原生菜单
  Menu.setApplicationMenu(null);
  log.info(`App ready. userData: ${app.getPath('userData')}`);

  // 注入托盘回调
  trayManager.onStart = async () => {
    await executorProcess.start(configStore.getAll());
    heartbeat.start(configStore.get('executorPort'));
  };
  trayManager.onStop = async () => {
    heartbeat.stop();
    await executorProcess.stop();
  };
  trayManager.onOpenStatus = () => windowManager.focusOrOpenStatus();
  trayManager.onOpenConfig = () => windowManager.openConfig();
  trayManager.onOpenHistory = () => windowManager.openHistory();
  trayManager.onToggleAutoLaunch = async (enable) => {
    await setAutoLaunchEnabled(enable);
    configStore.save({ autoStart: enable });
    trayManager.rebuildMenu();
  };
  trayManager.getAutoLaunch = () => configStore.get('autoStart');

  // 执行器状态变化 → 同步托盘图标 + 系统通知（DSK-04：仅 offline 转移报）
  executorProcess.setStatusCallback((status) => {
    trayManager.setStatus(status);
    notifier.onExecutorStatus(status);
  });

  // 心跳结果 → 同步托盘图标 + 系统通知
  heartbeat.setCallback((status) => {
    trayManager.setStatus(status);
    notifier.onExecutorStatus(status);
  });

  // 初始化托盘
  trayManager.init();

  // DSK-04：系统通知初始化——开关读配置；点击通知聚焦状态窗口；
  // 轮询 workDir/meta 捕获任务终态（executor-node writeExecMeta 落盘）。
  notifier.onOpenStatusCallback = () => windowManager.focusOrOpenStatus();
  notifier.setEnabled(configStore.get('notifyEnabled'));
  const workDir = configStore.get('workDir');
  notifier.startMetaPolling(workDir ? path.join(workDir, 'meta') : null);

  // 注册所有 IPC handlers
  registerIpcHandlers();

  // DSK-03：自动更新仅生产包启用（dev 下 electron-updater 无 app-update.yml
  // 会报错；且开发期不应触发升级流程）。initUpdater 内部延迟 30s 检查、
  // 失败静默，见 src/main/updater.ts。
  if (app.isPackaged) {
    initUpdater();
  } else {
    log.info('updater: skipped in unpackaged dev run');
  }

  const cfg = configStore.getAll();
  if (!cfg.configured) {
    // 首次运行，打开配置向导
    windowManager.openWizard();
  } else if (cfg.autoStartExecutor) {
    // 已配置且设置了自动启动
    await executorProcess.start(cfg);
    heartbeat.start(cfg.executorPort);
  }
});

// DSK-04：配置保存后热同步通知开关与 meta 轮询目录（workDir 可能被改）。
// 由 ipc-handlers 的 config:save 面调用，避免 ipc-handlers 反向 import index
// 之外的模块知识。
export function syncNotifierWithConfig(): void {
  notifier.setEnabled(configStore.get('notifyEnabled'));
  const workDir = configStore.get('workDir');
  notifier.startMetaPolling(workDir ? path.join(workDir, 'meta') : null);
}
