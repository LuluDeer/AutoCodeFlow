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

/**
 * ExecutionFailureReason 枚举值的可重试候选（与 ExecutionDetailPage 的
 * FAILURE_REASON_MAP 标签口径一致；不含 killed/stale_recovered——killed 是
 * 手动终止动作、stale_recovered 是中台回收标记，均非"错误类型"，作为可重试
 * 错误选项没有意义）。
 *
 * P3-2：标签**只存 i18n 键**（labelKey），不再硬编码中文 label。历史上消费处
 * 写作 `LABELS(t)[value] ?? o.label`，而 o.label 是中文字面量——任何漏收录的
 * 枚举值都会在英文界面静默漏出中文且不报错（interpreter_unavailable 即此漏网）。
 * 根因修复后没有中文兜底可漏；retry-policy.test.ts 逐值钉死 labelKey 在
 * zh/en 两套词条里都存在。
 */
export const RETRYABLE_ERROR_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'package_fetch_failed', labelKey: 'taskForm.retryable.packageFetch' },
  { value: 'dependency_install_failed', labelKey: 'taskForm.retryable.dependencyInstall' },
  { value: 'git_fetch_failed', labelKey: 'taskForm.retryable.gitFetch' },
  { value: 'runtime_missing', labelKey: 'taskForm.retryable.runtimeMissing' },
  { value: 'script_error', labelKey: 'taskForm.retryable.scriptError' },
  { value: 'timeout', labelKey: 'taskForm.retryable.timeout' },
  { value: 'executor_offline', labelKey: 'taskForm.retryable.executorOffline' },
  { value: 'executor_restart', labelKey: 'taskForm.retryable.executorRestart' },
  // python_task_multiversion：解释器不可用（环境/配置类）。列在候选中让运维
  // **可以**显式勾选，但刻意不进任何默认值——重试不会让 3.7 变得可下载、也不会
  // 补上缺失的 uv，默认重试只会白烧预算并把真实故障延后暴露（修复动作在环境侧，
  // 见 failure-runbook）。
  { value: 'interpreter_unavailable', labelKey: 'taskForm.retryable.interpreterUnavailable' },
  { value: 'unknown', labelKey: 'taskForm.retryable.unknown' },
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
