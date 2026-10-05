/**
 * 审计二轮 B-7②：托盘文案双语常量表。
 *
 * tray.ts 顶层 import electron——selftest 环境（纯 node）加载不了它，因此
 * 文案表与语言判定抽成无 electron 依赖的纯模块（同 updater-runcheck 的可测
 * 性理由），行为由 tray-texts.selftest.ts 直接驱动。
 *
 * 语言判定：app.getLocale() 前缀 `en*` → 英文，其余回落中文（与桌面端既有
 * 中文缺省一致；Electron 托盘菜单不支持运行时热切语言，重建菜单时按当前
 * locale 取表）。
 *
 * 覆盖口径：tray.ts 原第 63-124 行的硬编码中文（tooltip + 菜单全部标签），
 * 以及 agent-status-view.ts 的 Agent 活动/结果标签（NETOPT-DEBT 双语收尾：
 * 原为遗留项，现已迁入本表——agent-status-view.ts 只保留「状态 → 键」映射，
 * 文案本体全部在本表，杜绝第三处硬编码文案）。
 */
export type TrayLocale = 'en' | 'zh';

/** 托盘状态的四个取值（与 ExecutorStatus 对齐；独立声明避免拉入 electron 侧模块）。 */
export type TrayExecutorStatus = 'online' | 'offline' | 'pending' | 'stopped';

/** Agent 活动状态分支键（agent-status-view.ts 的状态机出口；文案查本表）。 */
export type AgentActivityState =
  | 'working'
  | 'workingAfterStop'
  | 'disabled'
  | 'awaitingConfig'
  | 'polling';

/** Agent 处理结果键（与 agent/loop 的 outcome 枚举对齐；none = 无记录）。 */
export type AgentOutcomeKey =
  | 'delivered'
  | 'deliver_failed'
  | 'clarification_requested'
  | 'escalated'
  | 'gate_stopped'
  | 'permission_denied'
  | 'error'
  | 'host_error'
  | 'none';

export interface TrayTexts {
  /** 托盘 tooltip 的执行器状态段。 */
  tooltip: Record<TrayExecutorStatus, string>;
  /** 菜单首行状态段。 */
  statusLabel: Record<TrayExecutorStatus, string>;
  /** 菜单状态行前缀（`状态: ● 在线` / `Status: ● Online`）。 */
  statusPrefix: string;
  /** Agent 活动标签（键 = AgentActivityState，消费方 agent-status-view.ts）。 */
  agentActivity: Record<AgentActivityState, string>;
  /** Agent 最近结果标签（键 = AgentOutcomeKey；未知 outcome 由消费方回退原文）。 */
  agentOutcomes: Record<AgentOutcomeKey, string>;
  /** Agent 活动行。 */
  agentLine: (activity: string) => string;
  /** tooltip 的 Agent 尾段（zh：`；Agent：…`，en：`; Agent: …`）。 */
  agentSuffix: (activity: string) => string;
  /** Agent 处理统计行。 */
  agentProcessedLine: (processed: number, lastOutcome: string) => string;
  startExecutor: string;
  stopExecutor: string;
  viewStatus: string;
  openConfig: string;
  openHistory: string;
  /** V4-4：托盘菜单补齐第四 Tab（X-04 顺带项：菜单原只覆盖 3/4） */
  openApps: string;
  autoLaunch: string;
  quit: string;
}

export const TRAY_TEXTS: Record<TrayLocale, TrayTexts> = {
  zh: {
    tooltip: {
      online: 'AutoCodeFlow Executor — 在线 ●',
      offline: 'AutoCodeFlow Executor — 离线 ○',
      pending: 'AutoCodeFlow Executor — 启动中 ◐',
      stopped: 'AutoCodeFlow Executor — 已停止',
    },
    statusLabel: {
      online: '● 在线',
      offline: '○ 离线',
      pending: '◐ 启动中...',
      stopped: '— 已停止',
    },
    statusPrefix: '状态',
    agentActivity: {
      working: '正在处理指派',
      workingAfterStop: '正在处理当前指派（已停止接新单）',
      disabled: '未启用',
      awaitingConfig: '已启用，等待完成连接配置',
      polling: '已启用，正在轮询指派',
    },
    agentOutcomes: {
      delivered: '候选应用已交付',
      deliver_failed: '候选应用交付失败',
      clarification_requested: '已发起澄清',
      escalated: '已转人工',
      gate_stopped: '达到执行上限',
      permission_denied: '权限不足',
      error: '执行失败',
      host_error: '托管异常',
      none: '暂无',
    },
    agentLine: (activity) => `Agent：${activity}`,
    agentSuffix: (activity) => `；Agent：${activity}`,
    agentProcessedLine: (processed, lastOutcome) =>
      `Agent 已处理 ${processed} 个指派；最近结果：${lastOutcome}`,
    startExecutor: '启动执行器',
    stopExecutor: '停止执行器',
    viewStatus: '查看状态...',
    openConfig: '打开配置...',
    openHistory: '历史日志...',
    openApps: '打开应用...',
    autoLaunch: '开机自启',
    quit: '退出',
  },
  en: {
    tooltip: {
      online: 'AutoCodeFlow Executor — Online ●',
      offline: 'AutoCodeFlow Executor — Offline ○',
      pending: 'AutoCodeFlow Executor — Starting ◐',
      stopped: 'AutoCodeFlow Executor — Stopped',
    },
    statusLabel: {
      online: '● Online',
      offline: '○ Offline',
      pending: '◐ Starting...',
      stopped: '— Stopped',
    },
    statusPrefix: 'Status',
    agentActivity: {
      working: 'Working on an assignment',
      workingAfterStop: 'Finishing current assignment (not accepting new ones)',
      disabled: 'Not enabled',
      awaitingConfig: 'Enabled, waiting for connection setup',
      polling: 'Enabled, polling for assignments',
    },
    agentOutcomes: {
      delivered: 'Candidate app delivered',
      deliver_failed: 'Candidate app delivery failed',
      clarification_requested: 'Clarification requested',
      escalated: 'Escalated to human',
      gate_stopped: 'Execution limit reached',
      permission_denied: 'Permission denied',
      error: 'Execution failed',
      host_error: 'Agent host error',
      none: 'None yet',
    },
    agentLine: (activity) => `Agent: ${activity}`,
    agentSuffix: (activity) => `; Agent: ${activity}`,
    agentProcessedLine: (processed, lastOutcome) =>
      `Agent processed ${processed} assignments; last outcome: ${lastOutcome}`,
    startExecutor: 'Start Executor',
    stopExecutor: 'Stop Executor',
    viewStatus: 'View Status...',
    openConfig: 'Open Settings...',
    openHistory: 'History Logs...',
    openApps: 'Open Apps...',
    autoLaunch: 'Launch at Login',
    quit: 'Quit',
  },
};

/** `en*` 一律英文，其余 locale（zh-CN / fr / 空 / 未知）回落中文。 */
export function resolveTrayLocale(getLocale: () => string): TrayLocale {
  return getLocale().toLowerCase().startsWith('en') ? 'en' : 'zh';
}

/**
 * Linux 的 AppIndicator 协议不派发托盘 click 事件（Electron 已知限制）——
 * 「左键单击打开状态窗口」只在支持 click 的平台接线；Linux 一律依赖菜单
 * （rebuildMenu 在 linux 下把「查看状态」固定在菜单顶部承接该职责）。
 */
export function traySupportsClick(platform: string): boolean {
  return platform !== 'linux';
}
