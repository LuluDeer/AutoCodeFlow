"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    // 配置
    getConfig: () => electron_1.ipcRenderer.invoke('config:get'),
    saveConfig: (cfg) => electron_1.ipcRenderer.invoke('config:save', cfg),
    saveAndCloseWizard: (cfg) => electron_1.ipcRenderer.invoke('config:save-and-close-wizard', cfg),
    testConnection: (url) => electron_1.ipcRenderer.invoke('config:test-connection', url),
    // 执行器控制
    startExecutor: () => electron_1.ipcRenderer.invoke('executor:start'),
    stopExecutor: () => electron_1.ipcRenderer.invoke('executor:stop'),
    getStatus: () => electron_1.ipcRenderer.invoke('executor:status'),
    // 开机自启
    getAutoLaunch: () => electron_1.ipcRenderer.invoke('autolaunch:get'),
    setAutoLaunch: (enable) => electron_1.ipcRenderer.invoke('autolaunch:set', enable),
    // 日志流（主进程 → 渲染进程，单向推送）
    onLogLine: (cb) => {
        const handler = (_, line) => cb(line);
        electron_1.ipcRenderer.on('executor:log-line', handler);
        // 返回取消订阅函数
        return () => electron_1.ipcRenderer.removeListener('executor:log-line', handler);
    },
    // 执行器状态变更通知
    onStatusChange: (cb) => {
        const handler = (_, status) => cb(status);
        electron_1.ipcRenderer.on('executor:status-change', handler);
        return () => electron_1.ipcRenderer.removeListener('executor:status-change', handler);
    },
});
//# sourceMappingURL=index.js.map