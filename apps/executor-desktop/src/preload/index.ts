import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg: Record<string, unknown>) => ipcRenderer.invoke('config:save', cfg),
  saveAndCloseWizard: (cfg: Record<string, unknown>) =>
    ipcRenderer.invoke('config:save-and-close-wizard', cfg),
  testConnection: (url: string) => ipcRenderer.invoke('config:test-connection', url),
  // B-8：host 透传——端口可用性检测必须按调用方表单的 executorHost 监听
  // （与执行器实际 bind 的 host 同源），缺省仍回落 0.0.0.0（主进程归一化）。
  checkPort: (port: number, host?: string) => ipcRenderer.invoke('config:check-port', port, host),
  // python_task_multiversion：设置页诊断——回报**实际生效**的 uv 与解释器池
  // （纯读、不 spawn 进程），让"配置没生效"这类问题当场可见。
  getPythonEnvStatus: () => ipcRenderer.invoke('config:python-env-status'),

  // 配置导出 / 导入（拓展包）：主进程 saveDialog/openDialog + 文件读写都在
  // 主进程侧完成，渲染层只传回结果。导出内容是 getAllMasked() 的掩码配置
  // （token 不落明文）；导入走 config:save 同一条消毒+保存链路。
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),

  // Agent 托管状态（P7b，只读）——设置页 Agent 组的状态行；旧版 preload
  // 未暴露时渲染层容错降级为不显示（同 getAutoLaunch 先例）。
  getAgentStatus: () => ipcRenderer.invoke('agent:get-status'),

  // 执行器控制
  startExecutor: () => ipcRenderer.invoke('executor:start'),
  stopExecutor: () => ipcRenderer.invoke('executor:stop'),
  getStatus: () => ipcRenderer.invoke('executor:status'),

  // 开机自启
  getAutoLaunch: () => ipcRenderer.invoke('autolaunch:get'),
  setAutoLaunch: (enable: boolean) => ipcRenderer.invoke('autolaunch:set', enable),

  // 系统通知开关（DSK-04：随 config:get/config:save 走，notifyEnabled 是
  // AppConfig 常规布尔字段，无独立通道——preload 仅透传，不加新 IPC 面）

  // 网络工具
  getLocalIPs: () => ipcRenderer.invoke('network:local-ips'),

  // 无边框窗口控制
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  getWindowState: () => ipcRenderer.invoke('window:get-state'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  onWindowMaximizeChange: (cb: (maximized: boolean) => void) => {
    const handler = (_: Electron.IpcRendererEvent, maximized: boolean) => cb(maximized);
    ipcRenderer.on('window:maximize-change', handler);
    return () => ipcRenderer.removeListener('window:maximize-change', handler);
  },
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // 历史记录 & 日志文件读取
  getHistory: () => ipcRenderer.invoke('history:get'),
  // getHistory 推送化：meta 目录变更哨（主进程 fs.watch+debounce）→ 单向
  // 推送「有变化」，页面据此刷新一次；10s 轮询退役（60s 兜底保留）。
  onHistoryChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('history:changed', handler);
    return () => ipcRenderer.removeListener('history:changed', handler);
  },
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  readLog: (executionId: string, fromLine?: number) =>
    ipcRenderer.invoke('log:read', executionId, fromLine ?? 0),
  // 用户报障：历史执行记录体验差——此前只能看/复制 executionId，日志落在哪个
  // 文件、能不能直接拿到手都无从得知。
  revealExecLog: (executionId: string) =>
    ipcRenderer.invoke('history:reveal-log', executionId),
  openTaskLogFolder: () => ipcRenderer.invoke('history:open-log-folder'),
  // 拓展包：导出某次执行的日志文件（主进程 copyFile 到用户选择的路径；
  // 大文件返回 tooLarge，由 UI 引导走「打开日志文件夹」手动复制）。
  exportExecLog: (executionId: string) =>
    ipcRenderer.invoke('history:export-log', executionId),

  // 当天日志（主进程日志，用于主窗口启动时加载历史）——此前 StatusWindow
  // 误用 window.electronAPI.invoke('logs:getToday')，而 preload 从未暴露 invoke，
  // 导致主窗口 useEffect 同步抛异常 → React 卸载整棵树 → 窗口只有背景色黑屏。
  getTodayLogs: () => ipcRenderer.invoke('logs:getToday'),

  // 日志文件列表 & 打开
  listLogFiles: () => ipcRenderer.invoke('log:list-files'),
  openLogFile: (filePath: string) => ipcRenderer.invoke('log:open-file', filePath),

  // 已部署应用
  listApps: () => ipcRenderer.invoke('apps:list'),
  readAppLog: (logPath: string, fromLine?: number) =>
    ipcRenderer.invoke('apps:log:read', logPath, fromLine ?? 0),
  // 用户报障：客户端本地无法查看部署的应用文件夹 / 无法撤销部署(删除)。
  // 打开目录走主进程 shell（渲染层拿不到 Electron API），删除走主进程的
  // 白名单+containment 校验——渲染层只传 apps:list 给的 appId/releaseKey。
  openAppFolder: (appId: string) => ipcRenderer.invoke('apps:open-folder', appId),
  openReleaseFolder: (appId: string, releaseKey: string) =>
    ipcRenderer.invoke('apps:open-release-folder', appId, releaseKey),
  uninstallApp: (appId: string) => ipcRenderer.invoke('apps:uninstall', appId),
  deleteAppRelease: (appId: string, releaseKey: string, deploymentId: string) =>
    ipcRenderer.invoke('apps:delete-release', appId, releaseKey, deploymentId),
  getRunningApps: () => ipcRenderer.invoke('apps:running'),

  // 写剪贴板（走主进程 Electron clipboard，不受安全上下文/权限限制）
  writeClipboardText: (text: string) =>
    ipcRenderer.invoke('clipboard:write-text', text),

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

  // 自动更新（DSK-03，主进程 → 渲染进程，单向推送；生产环境才启用）
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),
  // DSK-05：autoDownload=false 下的显式下载入口（用户点「下载」后调用）
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  // B-3②：previouslyDownloaded——main 侧 update-available 实发（同一版本此前
  // 已下载过、待装缓存应复用），渲染层 UpdateBanner 据此切换展示形态；此前
  // 本契约漏了该字段，渲染层只能各自补声明（类型漂移）。
  onUpdateAvailable: (cb: (payload: { version: string; current: string; previouslyDownloaded: boolean }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { version: string; current: string; previouslyDownloaded: boolean }) => cb(payload);
    ipcRenderer.on('updater:available', handler);
    return () => ipcRenderer.removeListener('updater:available', handler);
  },
  onUpdateProgress: (cb: (payload: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => cb(payload);
    ipcRenderer.on('updater:progress', handler);
    return () => ipcRenderer.removeListener('updater:progress', handler);
  },
  onUpdateDownloaded: (cb: (payload: { version: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { version: string }) => cb(payload);
    ipcRenderer.on('updater:downloaded', handler);
    return () => ipcRenderer.removeListener('updater:downloaded', handler);
  },
  onUpdateError: (cb: (payload: { message: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { message: string }) => cb(payload);
    ipcRenderer.on('updater:error', handler);
    return () => ipcRenderer.removeListener('updater:error', handler);
  },
});
