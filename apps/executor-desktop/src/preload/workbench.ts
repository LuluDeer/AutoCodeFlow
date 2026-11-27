/**
 * 阶段 A（ADR-044）：业务人员工作台窗口的**独立 preload**。
 *
 * 这是与四页全量桥（`src/preload/index.ts`）刻意分离的第二座桥：本文件只保留
 * 最小桥面——只读桌面上下文、Agent 事件订阅、受限本地文件选择（只返回文件名/
 * 大小/MIME/≤64KB 文本预览，绝不返回路径）、取消当前 Agent 指派与最近事件回放。
 *
 * 执行器配置 / 凭据、子进程控制、应用卸载、更新安装、Agent 状态等执行器
 * channel **刻意不暴露**：业务人员工作台的权限面与执行器管理面隔离。即便
 * 中台页面被注入脚本，它拿到的 `window.workbenchApi` 里也没有任何能读写本机
 * 配置或驱动执行器子进程的入口。主进程侧另有 sender 闸 + partition/id 双收窄
 * 作第二道保险（见 ipc-handlers 的 workbench:* 注册段）。
 *
 * 沙箱纪律：本文件必须自包含（零相对 import），esbuild 打成单文件
 * `dist/preload/workbench.js` 后由 sandbox preload 直接加载。
 */
import { contextBridge, ipcRenderer } from 'electron';

/**
 * 过桥面的唯一形态。channel 字面量**直接写在 invoke 调用里**（不抽变量），
 * 便于 `workbench-window.selftest.ts` 做严格集合断言：多一个 channel 即红。
 */
contextBridge.exposeInMainWorld('workbenchApi', {
  /** 只读桌面上下文（executorName/agentEnabled/platformConfigured；不含凭据与路径）。 */
  getDesktopContext: () => ipcRenderer.invoke('workbench:getDesktopContext'),
  /** 取消当前 Agent 指派（可选 assignmentId 防错单）。 */
  cancelAgentAssignment: (assignmentId?: string) =>
    ipcRenderer.invoke('workbench:cancelAgentAssignment', assignmentId),
  /** 选择本地文件：只返回 {name,size,mimeType,textPreview?}；路径永不越桥。 */
  pickLocalFiles: () => ipcRenderer.invoke('workbench:pickLocalFiles'),
  /** 打开窗口前的最近 Agent 事件回放（有界）。 */
  getRecentAgentEvents: () => ipcRenderer.invoke('workbench:getRecentAgentEvents'),
  /** 订阅实时 Agent 事件；返回取消订阅函数。 */
  onAgentEvent: (cb: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    // 与 main/workbench-window.ts 的 WORKBENCH_EVENT_CHANNEL 对齐；沙箱 preload 必须自包含。
    ipcRenderer.on('workbench:agentEvent', handler);
    return () => ipcRenderer.removeListener('workbench:agentEvent', handler);
  },
});
