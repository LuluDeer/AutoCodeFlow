/**
 * 渲染层内的 Tab 切换请求（跨页面跳转）。
 *
 * ## 为什么需要它
 *
 * 用户报障：「明明有日志，但是应用tab却显示没日志」。真实原因是**两类日志
 * 不是一回事**：应用 tab 显示的是部署产物自带的 `app.log`（只有常驻
 * daemon/once 模式才会写），而用户看到的日志是**任务执行日志**
 * （`workDir/logs/<date>/<executionId>.log`，在「历史」tab 里）。
 *
 * 光在应用 tab 写一句「见历史页」是不够的——用户还得自己找过去、再自己找
 * 是哪一次执行。这里给出一条**可点的**通路。
 *
 * ## 为什么用 CustomEvent 而不是 prop 透传
 *
 * Tab 状态由 App.tsx 持有（`MainWindow` 的 `useState`），而 AppsPage 是它的
 * 兄弟节点（同在 `.main-content` 下，各自独立挂载）。透传需要把 setTab 一路
 * 传进四个页面并新增 props 形状——而页面是**常驻挂载**的（用 hidden 控制
 * 显隐），任何 props 变化都会触发全部四个面板重渲染。
 *
 * 用 window 上的 CustomEvent：App.tsx 一处监听，页面侧只调一个函数，无 props
 * 变化、无额外重渲染，也与既有的 `onSwitchTab`（托盘 → 主进程 → 渲染层）保持
 * 同一「事件驱动切 tab」形态。
 *
 * 安全性：事件 detail 由 App.tsx 侧按 `TAB_ORDER` 白名单校验——与托盘路径
 * 同款约束，非法值不切（否则所有面板都会被 hidden，窗口一片空白）。
 */
export const TAB_SWITCH_EVENT = 'acf:switch-tab';

export type SwitchableTab = 'status' | 'config' | 'history' | 'apps';

/**
 * 请求切换到某个 Tab。
 *
 * 静默失败：事件无人监听（如单页测试渲染）时不该抛错打断用户操作。
 */
export function requestTabSwitch(tab: SwitchableTab): void {
  try {
    window.dispatchEvent(new CustomEvent(TAB_SWITCH_EVENT, { detail: tab }));
  } catch {
    /* CustomEvent 不可用（极端环境）：忽略，不阻断调用方 */
  }
}
