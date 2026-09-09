/**
 * CORE-04: 超时策略分级的表单序列化纯逻辑层（与 executor-mode.ts /
 * maintenance-windows.ts 同层次，独立成文件以满足 react-refresh
 * 只导出组件的限制并便于单测）。
 *
 * 后端 PATCH 语义（N28 同源）：字段缺省 = 保留旧值；显式 null = 清空/
 * 回缺省。超时策略两字段的提交约定：
 *  - timeoutAction：Radio 恒有值（默认 kill）。缺省值 kill 仍显式提交
 *    （语义与"树杀"现状一致，覆盖旧配置）；undefined（未挂载）归 null。
 *  - timeoutWarnRatio：InputNumber 可留空。空串/undefined/null 一律归
 *    null（未启用预警）——PATCH 缺省=保留旧值，所以"清空输入框"必须发
 *    null 才能真正关闭预警。
 */

import type { TimeoutAction } from '../api/tasks';

/** 后端 @Max(90) 对齐；timeout 缺省 300s 时 90% = 270s 预警点 */
export const TIMEOUT_WARN_RATIO_MAX = 90;
export const TIMEOUT_WARN_RATIO_MIN = 0;

/** 缺省动作：与后端 normalizeTimeoutAction 的回退一致 */
export const DEFAULT_TIMEOUT_ACTION: TimeoutAction = 'kill';

/**
 * 三动作选项（label 与 TaskDetailPage/文档口径一致）。放在本文件而非
 * api/tasks.ts：组件级测试对 api 层整模块 vi.mock，选项随 mock 丢失会
 * 炸渲染；纯逻辑文件不在 mock 范围，选项永远可用。
 */
export const TIMEOUT_ACTION_OPTIONS: { value: TimeoutAction; label: string }[] = [
  { value: 'kill', label: '终止（默认）' },
  { value: 'kill_retry', label: '终止并重试' },
  { value: 'notify_only', label: '仅通知' },
];

export function applyTimeoutPolicyPayload(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...values };

  // timeoutAction：undefined（未挂载）→ null（回到缺省 kill）；有值原样。
  const action = payload.timeoutAction;
  payload.timeoutAction =
    typeof action === 'string' && action.length > 0
      ? action
      : null;

  // timeoutWarnRatio：''（InputNumber 清空）/undefined/非法 → null。
  const ratio = payload.timeoutWarnRatio;
  if (typeof ratio === 'number' && Number.isInteger(ratio) && ratio >= TIMEOUT_WARN_RATIO_MIN && ratio <= TIMEOUT_WARN_RATIO_MAX) {
    payload.timeoutWarnRatio = ratio;
  } else {
    payload.timeoutWarnRatio = null;
  }

  return payload;
}

/** 编辑态加载：任务读回字段 → 表单初值（timeoutAction 缺省 kill，预警空态为 undefined） */
export function timeoutPolicyFormValues(task: {
  timeoutAction?: string | null;
  timeoutWarnRatio?: number | null;
}): { timeoutAction: TimeoutAction; timeoutWarnRatio?: number } {
  const action =
    task.timeoutAction === 'kill_retry' || task.timeoutAction === 'notify_only'
      ? task.timeoutAction
      : DEFAULT_TIMEOUT_ACTION;
  return {
    timeoutAction: action,
    timeoutWarnRatio:
      typeof task.timeoutWarnRatio === 'number'
        ? task.timeoutWarnRatio
        : undefined,
  };
}
