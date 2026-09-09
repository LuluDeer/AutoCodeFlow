/**
 * FEAT-13：「保存为模板」表单值 → 模板 config 的纯映射（task-template-prefill
 * 的反向通路——预填是 config → 表单值，此处是表单值 → config）。
 *
 * 与 utils/task-template-extract.ts（Task 对象 → config，CORE-03 收尾）的差异：
 * 表单值是 CreateTaskDto 超集的运行时形态，需按 CORE-03 语义收口——
 *  - 排除非配置元字段：name（模板实例化时由用户提供，后端 expand 也会剥离）、
 *    description（模板有自己的 description 元字段，避免二义）、applicationId
 *    （任务与应用的部署绑定关系，克隆到别的执行器不成立）、runbook 单独映射、
 *    executorAppName（DTO 无此字段，forbidNonWhitelisted 会 400）；
 *  - 字段名桥接：表单字段 `timeout` → DTO 优先字段 `timeoutSeconds`；
 *  - priority 双形态归一：表单值恒为数字（Select option value），
 *    兼容传入 PG label 字符串时经 toPriorityValue 归一；
 *  - 空值省略：空数组/空对象无模板价值，归一为不携带；
 *  - 执行器策略由调用方按 deriveExecutorMode 语义（executor-mode.ts）先行
 *    解析后显式传入——表单原始值含大量 null 占位（buildExecutorPayload 的
 *    PATCH 清理语义），模板 config 只保留 DTO 真实声明的字段形态。
 */
import { toPriorityValue } from './priority';

export function templateConfigFromFormValues(  values: Record<string, unknown>,
  executor: { executeMode?: string | null; executorId?: string | null; executorGroup?: string | null; executorTags?: string[] | null } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) out[key] = value;
  };

  put('triggerType', values.triggerType);
  put('cronExpression', values.cronExpression);
  put('timezone', values.timezone);
  put('fixedRate', values.fixedRate);
  put('runtime', values.runtime);
  put('entrypoint', values.entrypoint);
  put('requirements', values.requirements);
  put('dependencies', values.dependencies);
  put('params', values.params);
  // 空对象/空集合无模板价值，归一为省略
  if (out.params && Object.keys(out.params as object).length === 0) delete out.params;
  if (out.dependencies && Object.keys(out.dependencies as object).length === 0) delete out.dependencies;
  if (Array.isArray(out.requirements) && (out.requirements as unknown[]).length === 0) delete out.requirements;
  // 表单字段名 timeout → DTO 优先字段 timeoutSeconds
  put('timeoutSeconds', values.timeoutSeconds ?? values.timeout);
  put('timeoutAction', values.timeoutAction);
  put('timeoutWarnRatio', values.timeoutWarnRatio);
  put('maxRetry', values.maxRetry);
  put('retryDelay', values.retryDelay);
  put('retryableErrors', values.retryableErrors);
  if (Array.isArray(out.retryableErrors) && (out.retryableErrors as unknown[]).length === 0) delete out.retryableErrors;
  put(
    'priority',
    values.priority === undefined || values.priority === null
      ? undefined
      : toPriorityValue(values.priority as string | number),
  );
  // 执行器策略（调用方按 executor-mode 语义解析后传入；broadcast 模式不携带 pin/group/tags）
  if (executor.executeMode === 'broadcast') {
    out.executeMode = 'broadcast';
  } else {
    out.executeMode = 'single';
    put('executorId', executor.executorId);
    put('executorGroup', executor.executorGroup);
    put('executorTags', executor.executorTags);
    if (Array.isArray(out.executorTags) && (out.executorTags as unknown[]).length === 0) delete out.executorTags;
  }
  put('runbook', values.runbook);
  if (typeof out.runbook === 'string' && out.runbook.length === 0) delete out.runbook;
  return out;
}
