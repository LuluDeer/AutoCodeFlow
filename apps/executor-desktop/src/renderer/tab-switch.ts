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

/** 切到历史页时可附带的状态过滤（V4 后续优化：最近失败入口直达失败记录）。 */
export type HistoryStatusFilter = 'success' | 'failed' | 'running';

/**
 * T1/T3 共用的历史深链白名单字段。
 *
 * 任务终态通知点击（T1）与状态页「最近失败」/详情面板「同任务」（T3）都要求
 * 切到历史页后**落到具体执行**，而不是让用户再搜一遍。字段故意收窄到四枚：
 * 执行 ID、任务检索串、状态过滤、Tab 本身；meta 里的 errorMessage / token /
 * 绝对路径等敏感字段一律不进载荷（与 notifier-rules.ts 的安全口径一致）。
 */
export interface HistoryDeepLinkFields {
  historyExecutionId?: string;
  historyTaskQuery?: string;
  historyStatusFilter?: HistoryStatusFilter;
}

export interface TabSwitchDetail extends HistoryDeepLinkFields {
  tab: SwitchableTab;
}

const TAB_WHITELIST: readonly SwitchableTab[] = ['status', 'config', 'history', 'apps'];
const STATUS_FILTER_WHITELIST: readonly HistoryStatusFilter[] = ['success', 'failed', 'running'];
const DEEP_LINK_FIELD_MAX = 256;

function readDetailString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' && value.length <= DEEP_LINK_FIELD_MAX
    ? value.trim()
    : undefined;
}

/**
 * 白名单归一：字符串 tab 保持向后兼容；对象形态只保留 `TabSwitchDetail` 的四类
 * 键，任何未知键（含 `__proto__` / errorMessage / filePath）都被剥掉。非法 tab
 * 返回 null（调用方不切换，避免所有面板被 hidden）。
 */
export function normalizeTabSwitchDetail(raw: unknown): TabSwitchDetail | null {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const tab = typeof raw === 'string' ? raw : obj?.tab;
  if (typeof tab !== 'string' || !(TAB_WHITELIST as readonly string[]).includes(tab)) return null;
  const detail: TabSwitchDetail = { tab: tab as SwitchableTab };
  if (!obj) return detail;
  const executionId = readDetailString(obj, 'historyExecutionId');
  const query = readDetailString(obj, 'historyTaskQuery');
  const status = obj.historyStatusFilter;
  if (executionId) detail.historyExecutionId = executionId;
  if (query) detail.historyTaskQuery = query;
  if ((STATUS_FILTER_WHITELIST as readonly string[]).includes(String(status))) {
    detail.historyStatusFilter = status as HistoryStatusFilter;
  }
  return detail;
}

/**
 * 请求切换到某个 Tab。
 *
 * history 参数既兼容旧的 `HistoryStatusFilter` 字符串，也接受深链对象
 * `{ historyExecutionId, historyTaskQuery, historyStatusFilter }`（T1/T3）。detail
 * 一律经 normalizeTabSwitchDetail 归一后才 dispatch——白名单外的字段不进事件。
 * 静默失败：事件无人监听（如单页测试渲染）时不该抛错打断用户操作。
 */
export function requestTabSwitch(
  tab: SwitchableTab,
  history?: HistoryStatusFilter | Omit<HistoryDeepLinkFields, 'tab'>,
): void {
  try {
    const extra = typeof history === 'string' ? { historyStatusFilter: history } : history ?? {};
    const detail = normalizeTabSwitchDetail({ tab, ...extra });
    if (!detail) return;
    window.dispatchEvent(new CustomEvent(TAB_SWITCH_EVENT, { detail }));
  } catch {
    /* CustomEvent 不可用（极端环境）：忽略，不阻断调用方 */
  }
}
