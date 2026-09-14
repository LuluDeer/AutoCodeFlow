import type { Executor } from '../api/executors';

/**
 * F-36（DEEP_REVIEW 0ef3bbe）：执行器「编辑」弹窗的字段白名单（纯逻辑层，
 * 与 executor-mode.ts / maintenance-windows.ts 同层次，便于单测）。
 *
 * 原实现 `editForm.setFieldsValue(executor)` 把整行 Executor 快照灌进表单，
 * onFinish 又把 values 整体交给 `PATCH /executors/:id`——一旦 antd 把未注册的
 * 快照字段带进 values（或未来给 Executor 增补只读字段），id / status /
 * lastHeartbeat / cpuUsage 等只读字段就会被一并写回。现收口为：
 *  - 回填只取可编辑的四个字段（executorEditFormValues）；
 *  - 提交前按同一白名单裁剪（pickExecutorEditPayload）。
 */
export const EDITABLE_EXECUTOR_FIELDS = [
  'groupName',
  'tags',
  'description',
  'maxConcurrentTasks',
] as const;

export interface ExecutorEditValues {
  groupName?: string | null;
  tags?: string[] | null;
  description?: string | null;
  maxConcurrentTasks?: number | null;
}

/** 执行器实体 → 编辑表单初值（只回填可编辑字段；null 归 undefined 走空态） */
export function executorEditFormValues(executor: Executor): ExecutorEditValues {
  return {
    groupName: executor.groupName ?? undefined,
    tags: executor.tags ?? undefined,
    description: executor.description ?? undefined,
    maxConcurrentTasks: executor.maxConcurrentTasks ?? undefined,
  };
}

/** 表单值 → PATCH 请求体（只发白名单字段；未提交的键不携带 = PATCH 保留旧值） */
export function pickExecutorEditPayload(values: Record<string, unknown>): ExecutorEditValues {
  const out: ExecutorEditValues = {};
  const target = out as Record<string, unknown>;
  for (const key of EDITABLE_EXECUTOR_FIELDS) {
    if (key in values) target[key] = values[key];
  }
  return out;
}
