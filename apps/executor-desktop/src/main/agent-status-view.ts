/**
 * Agent 托管状态的纯展示语义。托盘和状态窗共用，避免两处对「已开启但
 * 配置未齐」或「关闭后仍在处理当前指派」给出矛盾的提示。
 *
 * NETOPT-DEBT（托盘双语收尾）：文案本体已迁入 tray-texts.ts 的双语表
 * （TRAY_TEXTS[locale].agentActivity / agentOutcomes），本模块只保留
 * 「状态快照 → 文案键」的纯映射。locale 由调用方（tray.ts 按
 * resolveTrayLocale 判定）传入；缺省 'zh' 与桌面端既有中文缺省一致，
 * 旧的单参调用方行为不变。
 */
import {
  TRAY_TEXTS,
  type AgentActivityState,
  type AgentOutcomeKey,
  type TrayLocale,
} from './tray-texts';

export interface AgentStatusSnapshot {
  enabled: boolean;
  /** 已启动轮询定时器；enabled=true 但配置不完整时为 false。 */
  polling: boolean;
  working: boolean;
  lastAssignmentId: string | null;
  lastOutcome: string | null;
  processed: number;
  lastEffectiveProfile: string | null;
}

/** 状态快照 → 活动标签键（纯映射，便于自检钉住分支语义）。 */
export function agentActivityState(status: AgentStatusSnapshot): AgentActivityState {
  if (status.working) {
    // 关开关只停新单；当前任务仍在运行时不能向用户误报「未启用、无动作」。
    return status.enabled ? 'working' : 'workingAfterStop';
  }
  if (!status.enabled) return 'disabled';
  if (!status.polling) return 'awaitingConfig';
  return 'polling';
}

/** Agent 活动标签（文案查 tray-texts 双语表）。 */
export function agentActivityLabel(
  status: AgentStatusSnapshot,
  locale: TrayLocale = 'zh',
): string {
  return TRAY_TEXTS[locale].agentActivity[agentActivityState(status)];
}

/** Agent 最近结果标签；表外未知 outcome 原样透出（新枚举先上线也不炸）。 */
export function agentOutcomeLabel(
  outcome: string | null,
  locale: TrayLocale = 'zh',
): string {
  if (!outcome) return TRAY_TEXTS[locale].agentOutcomes.none;
  return TRAY_TEXTS[locale].agentOutcomes[outcome as AgentOutcomeKey] ?? outcome;
}
