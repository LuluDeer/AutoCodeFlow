/**
 * P3 审计（状态→色收敛）：全站状态枚举 → 颜色映射的**单一事实源**。
 *
 * 此前同一份"状态→色"知识散落五处、各自手写漂移（本轮审计清单）：
 *  - TaskDetailPage       `STATUS_COLOR`（执行状态 → Badge status）
 *  - ExecutionRetryChain  `RETRY_STATUS_COLOR`（执行状态 → Tag color）
 *  - AgentSessionsPage    `STATUS_COLORS` / `TOOL_STATUS_COLORS`
 *  - ApplicationDetailPage `STATUS_COLORS` / `RELEASE_DEPLOY_STATUS_COLORS`
 *  - SopsPage（经 utils/sop-label.ts）`SOP_STATUS_COLOR` / `SOP_ASSIGNMENT_STATUS_COLOR`
 *
 * 收敛纪律：**只搬运、不改值**——各域既有取值原样保留（用户看到的颜色逐像素
 * 不变）。同一枚举在不同渲染目标下的取值语义不同（Badge status 是
 * success/error/warning 词表，Tag color 是 antd 预设色名词表），故执行状态
 * 按 Badge / Tag 两张表导出，不硬合成一张超集（killed 的 Badge=error 而
 * Tag=volcano，无法用单一取值同时表达两者）。
 *
 * 各表键集互不相同的域（应用/发布/Agent/SOP）独立命名导出 + `Record<string, …>`
 * 宽键：调用点沿用 `?? 'default'` 兜底未知值（后端新增枚举时页面回退中性色，
 * 与既有行为一致），不因收窄类型在编译期挡住未知 token。
 */

/** Badge `status` 词表（antd BadgeProps['status']，不含响应式 success 处理） */
export type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';

/** 执行状态 → Badge status（TaskDetailPage 执行列表；原 STATUS_COLOR 原值迁移） */
export const EXECUTION_BADGE_STATUS: Record<string, BadgeStatus> = {
  pending: 'default', running: 'processing', success: 'success',
  failed: 'error', timeout: 'warning', killed: 'error', cancelled: 'default',
};

/** 执行状态 → Tag color（ExecutionRetryChain 重试链；原 RETRY_STATUS_COLOR 原值迁移） */
export const EXECUTION_TAG_COLOR: Record<string, string> = {
  pending: 'default', running: 'processing', success: 'green',
  failed: 'red', timeout: 'orange', killed: 'volcano', cancelled: 'default',
};

/** Agent 会话状态 → Tag color（AgentSessionsPage；原 STATUS_COLORS 原值迁移） */
export const AGENT_SESSION_STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  waiting_input: 'orange',
  succeeded: 'green',
  failed: 'red',
  aborted: 'default',
  budget_exceeded: 'volcano',
};

/** Agent 工具调用状态 → Tag color（AgentSessionsPage；原 TOOL_STATUS_COLORS 原值迁移） */
export const AGENT_TOOL_STATUS_COLOR: Record<string, string> = {
  ok: 'green',
  denied: 'red',
  error: 'red',
  circuit_open: 'volcano',
  awaiting_approval: 'orange',
};

/** 应用状态 → Tag color（ApplicationDetailPage 概览；原 STATUS_COLORS 原值迁移） */
export const APPLICATION_STATUS_COLOR: Record<string, string> = {
  active: 'green', deploying: 'blue', failed: 'red',
};

/** 应用发布部署状态 → Tag color（ApplicationDetailPage Releases；原 RELEASE_DEPLOY_STATUS_COLORS 原值迁移） */
export const RELEASE_DEPLOY_STATUS_COLOR: Record<string, string> = {
  running: 'green', stopped: 'default', failed: 'red', deploying: 'blue', upgrading: 'blue', pending: 'default',
};

/** SOP 状态 → Tag color（自 utils/sop-label.ts 迁入收口；取值与迁出前逐字一致） */
export const SOP_STATUS_COLOR: Record<string, string> = {
  draft: 'gold',
  published: 'green',
  deprecated: 'default',
};

/** SOP 工单状态 → Tag color（自 utils/sop-label.ts 迁入收口；取值与迁出前逐字一致） */
export const SOP_ASSIGNMENT_STATUS_COLOR: Record<string, string> = {
  assigned: 'blue',
  in_progress: 'processing',
  blocked: 'orange',
  completed: 'green',
  failed: 'red',
  cancelled: 'default',
  stalled: 'volcano',
};
