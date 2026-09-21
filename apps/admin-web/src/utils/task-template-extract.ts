import type { Task } from '../api/tasks';
import { toPriorityValue } from './priority';

/**
 * CORE-03 收尾：「保存为自定义模板」的 config 抽取纯映射。
 *
 * 从 Task 对象抽取 CreateTaskDto 子集字段作为模板 config——后端
 * POST /task-templates 会以 CreateTaskDto `plainToInstance + validate(
 * whitelist + forbidNonWhitelisted)` 语义校验，非白名单键直接 400，
 * 因此这里必须只提交 DTO 真实声明的字段。
 *
 * 排除的非配置字段（有独立语义或模板不应携带）：
 *  - id（模板生成自己的 UUID）、name（实例化时由用户提供，后端 expand
 *    也会剥离模板 config 里的 name）、status 等运行态；
 *  - description（模板有自己的 description 元字段，避免二义）；
 *  - applicationId（任务与应用的部署绑定关系，克隆到别的执行器不成立）；
 *  - executorAppName（展示用冗余字段，DTO 只有 executorId/executorGroup/executorTags）；
 *  - maintenanceWindows / glueSource / glueLanguage
 *    （maintenanceWindows 是调度侧窗口非任务形态、glue 模板化留后续轮；
 *    **gitRepo/gitBranch 不在此列**——见 P1-7：它们与 codeSource='git' 配对，
 *    漏带会让模板实例化时"代码来源"静默失效甚至 400）；
 *  - 注意 `runtimeVersion` 与 `codeSource` **不**在排除之列：两者都是
 *    CreateTaskDto 的合法字段且是用户显式做过的选择（python_task_multiversion
 *    FR-06/FR-18），漏带会让从模板实例化的任务静默落回宿主默认解释器、
 *    代码来源被迁移期隐式推断改写（与 task-template-config-from-form.ts 同源修复）；
 *  - currentVersion / gitCommit（部署时点快照，模板应允许部署新版本）；
 *  - timeout（legacy 别名，统一收敛为 DTO 优先字段 timeoutSeconds）。
 *
 * priority 双形态桥接：PG enum 读回 label 字符串而 DTO @IsEnum 收数字 1-4
 * （CORE-01 契约），经 utils/priority.toPriorityValue 归一为数字再提交。
 */
export function extractTemplateConfigFromTask(task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) out[key] = value;
  };

  put('triggerType', task.triggerType);
  put('cronExpression', task.cronExpression);
  put('timezone', task.timezone);
  put('fixedRate', task.fixedRate);
  put('runtime', task.runtime);
  // python_task_multiversion（FR-06 / FR-18）：版本声明与代码来源必须随模板
  // 固化——TaskDetailPage「存为模板」走的正是本映射，漏掉它们与表单侧漏项
  // 是同一条用户可见缺陷（见 task-template-config-from-form.ts 的同段注释）。
  put('runtimeVersion', task.runtimeVersion);
  put('codeSource', task.codeSource);
  // P1-7：codeSource='git' 必须配对 gitRepo/gitBranch 固化（见 config-from-form 同段）。
  put('gitRepo', task.gitRepo);
  put('gitBranch', task.gitBranch);
  put('entrypoint', task.entrypoint);
  put('requirements', task.requirements);
  put('dependencies', task.dependencies);
  put('params', task.params);
  // 空对象 params/dependencies 无模板价值，归一为省略
  if (out.params && Object.keys(out.params as object).length === 0) delete out.params;
  if (out.dependencies && Object.keys(out.dependencies as object).length === 0) delete out.dependencies;
  if (Array.isArray(out.requirements) && (out.requirements as unknown[]).length === 0) delete out.requirements;
  // timeoutSeconds 为 DTO 优先字段；task.timeout（legacy）作回填兜底
  put('timeoutSeconds', task.timeoutSeconds ?? task.timeout);
  put('timeoutAction', task.timeoutAction);
  put('timeoutWarnRatio', task.timeoutWarnRatio);
  put('maxRetry', task.maxRetry);
  put('retryDelay', task.retryDelay);
  put('retryableErrors', task.retryableErrors);
  if (Array.isArray(out.retryableErrors) && (out.retryableErrors as unknown[]).length === 0) delete out.retryableErrors;
  put('priority', toPriorityValue(task.priority));
  put('executeMode', task.executeMode);
  put('executorId', task.executorId);
  put('executorGroup', task.executorGroup);
  put('executorTags', task.executorTags);
  if (Array.isArray(out.executorTags) && (out.executorTags as unknown[]).length === 0) delete out.executorTags;
  put('runbook', task.runbook);
  return out;
}
