import { app, Menu } from 'electron';
import { ConfigStore } from './config-store';
import { ExecutorProcess } from './executor-process';
import { HeartbeatMonitor } from './heartbeat';
import { TrayManager } from './tray';
import { WindowManager } from './window-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { getAutoLaunchEnabled, setAutoLaunchEnabled } from './autolaunch';
import log from './logger';

// 单例导出，供 ipc-handlers 等模块使用
export const configStore = new ConfigStore();
export const executorProcess = new ExecutorProcess();
export const heartbeat = new HeartbeatMonitor();
export const trayManager = new TrayManager();
export const windowManager = new WindowManager();

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

  // 执行器状态变化 → 同步托盘图标
  executorProcess.setStatusCallback((status) => {
    trayManager.setStatus(status);
  });

  // 心跳结果 → 同步托盘图标
  heartbeat.setCallback((status) => {
    trayManager.setStatus(status);
  });

  // 初始化托盘
  trayManager.init();

  // 注册所有 IPC handlers
  registerIpcHandlers();

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
