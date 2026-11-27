/**
 * 阶段 A（ADR-044）：业务人员工作台窗口的**独立 preload**。
 *
 * 这是与四页全量桥（`src/preload/index.ts`）刻意分离的第二座桥：本文件只把
 * 会话 / 导航相关的最小能力过桥——读取工作台 URL、在工作台内部导航、关闭窗口。
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
  /** 只读：当前工作台 URL（来自配置的中台地址，不含凭据）。 */
  getUrl: () => ipcRenderer.invoke('workbench:getUrl'),
  /** 同源相对路径导航；主进程会二次白名单校验，绝对/外部 URL 一律拒绝。 */
  navigate: (target: string) => ipcRenderer.invoke('workbench:navigate', target),
  /** 关闭工作台窗口（不影响四页 / 托盘 / 执行器）。 */
  close: () => ipcRenderer.invoke('workbench:close'),
});
