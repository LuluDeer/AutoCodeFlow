import type { TaskTemplate } from '../api/task-templates';
import { dependenciesFormValues } from './task-dependencies';
import { deriveExecutorMode, type ExecutorMode } from './executor-mode';

/**
 * CORE-03：模板 config → TaskFormPage 表单初值的纯映射。
 *
 * FIX-PREFILL-SYMMETRY：键集必须与 utils/task-template-config-from-form.ts
 * （表单值 → config 的反向通路）**对称**——写侧固化的每个键，读侧都要回填，
 * 否则"存模板 → 从模板建任务"会静默丢掉用户在模板里配好的字段（此前丢了
 * requirements/dependencies/retryableErrors/维护窗口/runbook/执行器策略）。
 * 对称性由 __tests__/task-template-prefill-symmetry.test.ts 以
 * 「写键集合 === 读键集合（经桥接表归一）」守护，两侧再补键必须同步。
 *
 * 已知的字段名桥接（对称测试按此表归一后比较）：
 *  - 后端模板 `timeoutSeconds`（DTO 优先字段）↔ 表单字段 `timeout`；
 *  - 后端模板 `dependencies`（Record<显示名, 上游任务id>）↔ 表单载体
 *    `upstreamDependencies`（Select 的 taskId 列表，DTO 未声明该载体键）。
 *
 * 只搬运表单实际消费的字段（其余 config 键在表单路径下无对应控件，忽略即可
 * ——一键实例化端点在服务侧原样保留完整 config）。
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
  // python_task_multiversion（FR-06 / FR-18）：模板固化过的 Python 版本与代码
  // 来源必须回填，否则"存模板 → 预填"这条通路会把它们丢掉（正方向的漏项见
  // utils/task-template-config-from-form.ts）。旧模板没有这两个键时
  // `pick` 天然不写入，保持表单默认空态，向后兼容。
  pick('runtimeVersion');
  pick('codeSource');
  // P1-7：git 代码来源的仓库/分支必须随模板预填，否则"从模板建任务"时
  // 代码来源选择静默失效（与 config-from-form / extract 正向映射同段修复）。
  pick('gitRepo');
  pick('gitBranch');
  // FIX-PREFILL-SYMMETRY：依赖渠道（requirements/上游依赖）与重试白名单此前
  // 只写不读——从模板建任务时静默丢失。requirements/retryableErrors 与表单
  // 字段同名直取；dependencies 经 dependenciesFormValues 反序列化为表单载体
  // upstreamDependencies（名称快照由 templateDependencySnapshot 单独导出，
  // 供 TaskFormPage 回填 depNameSnapshotRef，提交时按快照重建映射）。
  pick('requirements');
  const deps = dependenciesFormValues(
    config.dependencies as Record<string, string> | null | undefined,
  );
  if (deps.selected.length > 0) out.upstreamDependencies = deps.selected;
  const retryable = config.retryableErrors;
  if (Array.isArray(retryable) && retryable.length > 0) {
    out.retryableErrors = retryable;
  }
  pick('maxRetry');
  pick('retryDelay');
  pick('priority');
  pick('params');
  // FIX-PREFILL-SYMMETRY：维护窗口与 runbook 同批补齐（写侧 config-from-form
  // 固化 maintenanceWindows/runbook；旧模板缺键时保持空态）。
  const windows = config.maintenanceWindows;
  if (Array.isArray(windows) && windows.length > 0) {
    // 浅拷贝行对象，避免模板缓存与表单共享引用（编辑态同款语义）。
    out.maintenanceWindows = (windows as Record<string, unknown>[]).map((w) => ({ ...w }));
  }
  pick('runbook');
  // NF-04：亲和/反亲和与执行器模式正交，模板预填时必须回写；旧模板
  // 缺少字段时保持表单默认空态。与 affinityFormValues 一致，null/空数组
  // 归一为未设置，避免 Select 收到空值占位。
  const pickAffinity = (key: 'executorAffinityTags' | 'executorAntiAffinityTags') => {
    const value = config[key];
    if (Array.isArray(value) && value.length > 0) out[key] = value;
  };
  pickAffinity('executorAffinityTags');
  pickAffinity('executorAntiAffinityTags');
  // FIX-PREFILL-SYMMETRY：执行器策略（single 模式下的 pin/group/tags）此前只写
  // 不读——从模板建任务时执行器选择静默失效（表单恒回 auto）。broadcast 模板
  // 不携带这三个键（写侧 broadcast 分支省略），仅回填存在的键；模式推导见
  // templateExecutorMode（须由调用方同步进 setExecutorMode，否则提交时
  // buildExecutorPayload 会按 auto 把回填值清掉）。
  pick('executorId');
  pick('executorGroup');
  const tags = config.executorTags;
  if (Array.isArray(tags) && tags.length > 0) out.executorTags = tags;
  pick('timeoutAction');
  pick('timeoutWarnRatio');
  // timeoutSeconds（模板）→ timeout（表单字段名）
  const to = config.timeoutSeconds ?? config.timeout;
  if (to !== undefined) out.timeout = to;
  return out;
}

/**
 * FIX-PREFILL-SYMMETRY：模板 config → 表单执行器模式（TaskFormPage 的
 * executorMode state 不在字段树里，必须由调用方显式 set）。
 * 复用 deriveExecutorMode（与编辑态回填同一判据）：broadcast > executorId
 * > group/tags > auto。config 未声明任何执行器键时返回 'auto'（新建默认）。
 */
export function templateExecutorMode(config: Record<string, unknown>): ExecutorMode {
  return deriveExecutorMode(config as Parameters<typeof deriveExecutorMode>[0]);
}

/**
 * FIX-PREFILL-SYMMETRY：模板 config.dependencies 的显示名快照（taskId →
 * 显示名）。TaskFormPage 预填时须回填 depNameSnapshotRef，否则提交路径
 * applyDependenciesPayload 按快照重建映射时拿不到显示名，key 降级为 id
 * （语义位 value=id 不丢，仅展示别名退化——与编辑态 dependenciesFormValues
 * 的消费方式一致）。
 */
export function templateDependencySnapshot(
  config: Record<string, unknown>,
): Record<string, string> {
  return dependenciesFormValues(
    config.dependencies as Record<string, string> | null | undefined,
  ).nameSnapshot;
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
