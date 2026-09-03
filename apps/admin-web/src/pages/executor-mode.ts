/**
 * R7 (N19): 任务表单执行器策略的纯逻辑层。
 * 独立成文件是为了同时满足 react-refresh（组件文件只导出组件）与可测性。
 */

export type ExecutorMode = 'auto' | 'group' | 'pinned' | 'broadcast';

/**
 * 从后端任务映射到表单的执行器策略。优先级：
 * broadcast > executorId(真 pinning，后端 dispatch 唯一认可) > executorAppName
 * (legacy appName 语义，仍显示为 pinned 但需按 id 重选) > group/tags > auto。
 */
export function deriveExecutorMode(task: {
  executeMode?: string | null;
  executorId?: string | null;
  executorAppName?: string | null;
  executorGroup?: string | null;
  executorTags?: string[] | null;
}): ExecutorMode {
  if (task.executeMode === 'broadcast') return 'broadcast';
  if (task.executorId) return 'pinned';
  if (task.executorAppName) return 'pinned';
  if (task.executorGroup || (task.executorTags && task.executorTags.length > 0)) return 'group';
  return 'auto';
}

/**
 * 按当前策略构造提交 payload。executorId 是后端唯一认可的 pinning
 * 字段（pinned 分支完全绕过 appName/group/tags），因此除 pinned 外的所有模式
 * 都显式置 executorId=null，避免 PATCH 白名单保留旧 pin 造成"界面 auto、实际
 * 钉死"的静默错位；pinned 模式则清空 legacy executorAppName 消除并存歧义。
 */
export function buildExecutorPayload(
  values: Record<string, unknown>,
  executorMode: ExecutorMode,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...values };
  if (executorMode === 'broadcast') {
    payload.executeMode = 'broadcast';
    payload.executorId = null;
    delete payload.executorAppName;
    delete payload.executorGroup;
    delete payload.executorTags;
  } else if (executorMode === 'group') {
    payload.executeMode = 'single';
    payload.executorId = null;
    delete payload.executorAppName;
  } else if (executorMode === 'pinned') {
    payload.executeMode = 'single';
    // executorId 由选择器写入 values；清空旧 executorAppName 避免与 pin 并存歧义。
    payload.executorAppName = null;
    delete payload.executorGroup;
    delete payload.executorTags;
  } else {
    payload.executeMode = 'single';
    payload.executorId = null;
    delete payload.executorGroup;
    delete payload.executorTags;
    delete payload.executorAppName;
  }
  return payload;
}
