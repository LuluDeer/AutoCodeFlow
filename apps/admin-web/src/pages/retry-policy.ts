/**
 * CORE-02: 重试策略的表单序列化纯逻辑层（与 executor-mode.ts /
 * timeout-policy.ts 同层次，独立成文件以满足 react-refresh 只导出组件
 * 的限制并便于单测）。
 *
 * retryableErrors 的后端消费语义（task.processor.ts RETRY-01）：非空白名单
 * = 仅白名单内的失败（错误消息子串或 failureReason 枚举值，大小写不敏感）
 * 才会重试，其余转 UnrecoverableError 烧尽预算；null/undefined/[] = 全部
 * 可重试（既有行为）。前端提交约定（N28 同源——PATCH 缺省=保留旧值）：
 *  - 用户显式清空多选 → 必须提交 null（回到"全部可重试"缺省语义）；
 *  - 字段未挂载（undefined）→ 同样归 null，与"未配置"一致。
 */

/** ExecutionFailureReason 枚举值的中文文案映射（与 ExecutionDetailPage
 *  的 FAILURE_REASON_MAP 标签口径一致；不含 killed/stale_recovered——
 *  killed 是手动终止动作、stale_recovered 是中台回收标记，均非"错误
 *  类型"，作为可重试错误选项没有意义）。 */
export const RETRYABLE_ERROR_OPTIONS: { value: string; label: string }[] = [
  { value: 'package_fetch_failed', label: '包拉取失败' },
  { value: 'dependency_install_failed', label: '依赖安装失败' },
  { value: 'git_fetch_failed', label: 'Git 拉取失败' },
  { value: 'runtime_missing', label: '运行时缺失' },
  { value: 'script_error', label: '脚本错误' },
  { value: 'timeout', label: '执行超时' },
  { value: 'executor_offline', label: '执行器离线' },
  { value: 'executor_restart', label: '执行器重启' },
  { value: 'unknown', label: '未知原因' },
];

/**
 * 提交序列化：逐项 trim、丢空项；空集/未挂载显式归 null
 * （PATCH 缺省=保留旧值，"清空白名单"必须发 null 才能回到全量重试语义）。
 */
export function applyRetryableErrorsPayload(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...values };
  const raw = payload.retryableErrors;
  if (Array.isArray(raw)) {
    const cleaned = raw
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter((r) => r.length > 0);
    payload.retryableErrors = cleaned.length > 0 ? cleaned : null;
  } else {
    payload.retryableErrors = null;
  }
  return payload;
}

/** 编辑态加载：任务读回字段 → 表单初值（null/缺省 → 空数组占位） */
export function retryableErrorsFormValues(task: {
  retryableErrors?: string[] | null;
}): { retryableErrors: string[] } {
  return {
    retryableErrors: Array.isArray(task.retryableErrors)
      ? task.retryableErrors.filter((r) => typeof r === 'string')
      : [],
  };
}
