/**
 * Agent 托管状态的纯展示语义。托盘和状态窗共用，避免两处对「已开启但
 * 配置未齐」或「关闭后仍在处理当前指派」给出矛盾的提示。
 */
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

export function agentActivityLabel(status: AgentStatusSnapshot): string {
  if (status.working) {
    return status.enabled ? '正在处理指派' : '正在处理当前指派（已停止接新单）';
  }
  if (!status.enabled) return '未启用';
  if (!status.polling) return '已启用，等待完成连接配置';
  return '已启用，正在轮询指派';
}

const OUTCOME_LABELS: Record<string, string> = {
  delivered: '候选应用已交付',
  deliver_failed: '候选应用交付失败',
  clarification_requested: '已发起澄清',
  escalated: '已转人工',
  gate_stopped: '达到执行上限',
  permission_denied: '权限不足',
  error: '执行失败',
  host_error: '托管异常',
};

export function agentOutcomeLabel(outcome: string | null): string {
  if (!outcome) return '暂无';
  return OUTCOME_LABELS[outcome] ?? outcome;
}
