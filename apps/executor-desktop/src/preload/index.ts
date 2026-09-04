import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg: Record<string, unknown>) => ipcRenderer.invoke('config:save', cfg),
  saveAndCloseWizard: (cfg: Record<string, unknown>) =>
    ipcRenderer.invoke('config:save-and-close-wizard', cfg),
  testConnection: (url: string) => ipcRenderer.invoke('config:test-connection', url),
  checkPort: (port: number) => ipcRenderer.invoke('config:check-port', port),

  // 执行器控制
  startExecutor: () => ipcRenderer.invoke('executor:start'),
  stopExecutor: () => ipcRenderer.invoke('executor:stop'),
  getStatus: () => ipcRenderer.invoke('executor:status'),

  // 开机自启
  getAutoLaunch: () => ipcRenderer.invoke('autolaunch:get'),
  setAutoLaunch: (enable: boolean) => ipcRenderer.invoke('autolaunch:set', enable),

  // 网络工具
  getLocalIPs: () => ipcRenderer.invoke('network:local-ips'),

  // 无边框窗口控制
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // 历史记录 & 日志文件读取
  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  readLog: (executionId: string, fromLine?: number) =>
    ipcRenderer.invoke('log:read', executionId, fromLine ?? 0),

  // 日志文件列表 & 打开
  listLogFiles: () => ipcRenderer.invoke('log:list-files'),
  openLogFile: (filePath: string) => ipcRenderer.invoke('log:open-file', filePath),

  // 已部署应用
  listApps: () => ipcRenderer.invoke('apps:list'),
  readAppLog: (logPath: string, fromLine?: number) =>
    ipcRenderer.invoke('apps:log:read', logPath, fromLine ?? 0),

  // 日志流（主进程 → 渲染进程，单向推送）
  onLogLine: (cb: (line: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on('executor:log-line', handler);
    // 返回取消订阅函数
    return () => ipcRenderer.removeListener('executor:log-line', handler);
  },

  // 执行器状态变更通知
  onStatusChange: (cb: (status: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, status: string) => cb(status);
    ipcRenderer.on('executor:status-change', handler);
    return () => ipcRenderer.removeListener('executor:status-change', handler);
  },

  // 主进程请求切换 tab（托盘菜单）
  onSwitchTab: (cb: (tab: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, tab: string) => cb(tab);
    ipcRenderer.on('switch-tab', handler);
    return () => ipcRenderer.removeListener('switch-tab', handler);
  },
});
