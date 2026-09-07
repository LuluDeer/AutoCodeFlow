import type { TaskTemplate } from '../api/task-templates';

/**
 * CORE-03：模板 config → TaskFormPage 表单初值的纯映射。
 *
 * 只搬运表单实际消费的字段（其余 config 键如 blockStrategy 在表单路径下无对应
 * 控件，忽略即可——一键实例化端点在服务侧原样保留完整 config）。
 * 关键差异：后端模板用 `timeoutSeconds`，表单字段名是 `timeout`，此处桥接。
 */
export function templateConfigToFormValues(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const pick = <K extends string>(key: K, target: string = key) => {
    if (config[key] !== undefined) out[target] = config[key];
  };
  pick('triggerType');
  pick('cronExpression');
  pick('timezone');
  pick('fixedRate');
  pick('runtime');
  pick('entrypoint');
  pick('maxRetry');
  pick('retryDelay');
  pick('priority');
  pick('params');
  pick('timeoutAction');
  pick('timeoutWarnRatio');
  // timeoutSeconds（模板）→ timeout（表单字段名）
  const to = config.timeoutSeconds ?? config.timeout;
  if (to !== undefined) out.timeout = to;
  return out;
}

/** 供组件决定要同步的内部 state（triggerType 影响条件渲染、runtime 影响 glue）。 */
export function templateTriggerAndRuntime(tpl: TaskTemplate): {
  triggerType: string;
  runtime: string;
} {
  return {
    triggerType:
      typeof tpl.config.triggerType === 'string'
        ? (tpl.config.triggerType as string)
        : 'manual',
    runtime:
      typeof tpl.config.runtime === 'string'
        ? (tpl.config.runtime as string)
        : 'python',
  };
}
