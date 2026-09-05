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
 *
 * R8 (N28)：legacy 三字段 executorAppName/executorGroup/executorTags 的清理
 * 同样必须**显式置 null** 而非 `delete`——PATCH 请求体缺省字段 = 后端
 * Object.assign 保留旧值，而 dispatch 优先级 appName > group/tags，只 delete
 * 会让"界面 auto、实际按 appName pin"的 N19 症状换字段复现。后端
 * UpdateTaskDto 的 @IsOptional() 对 null 放行、entity 列均 nullable、
 * dispatch 以 falsy 判定，null 即清除语义（与 executorId 三端一致）。
 */
export function buildExecutorPayload(
  values: Record<string, unknown>,
  executorMode: ExecutorMode,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...values };
  if (executorMode === 'broadcast') {
    payload.executeMode = 'broadcast';
    payload.executorId = null;
    payload.executorAppName = null;
    payload.executorGroup = null;
    payload.executorTags = null;
  } else if (executorMode === 'group') {
    payload.executeMode = 'single';
    payload.executorId = null;
    payload.executorAppName = null;
    // group/tags 是本模式的限定字段：用户清空 Select 后值为 undefined，
    // PATCH 缺省同样会保留旧过滤条件，因此 undefined 也显式置 null。
    if (payload.executorGroup === undefined) payload.executorGroup = null;
    if (payload.executorTags === undefined) payload.executorTags = null;
  } else if (executorMode === 'pinned') {
    payload.executeMode = 'single';
    // executorId 由选择器写入 values；清空 legacy executorAppName 避免与 pin 并存歧义。
    payload.executorAppName = null;
    payload.executorGroup = null;
    payload.executorTags = null;
  } else {
    payload.executeMode = 'single';
    payload.executorId = null;
    payload.executorGroup = null;
    payload.executorTags = null;
    payload.executorAppName = null;
  }
  return payload;
}

/**
 * W-21: requirements 提交序列化（与 buildExecutorPayload 同层的纯逻辑，
 * 独立可测）。表单控件是 antd Select tags 模式，值已是 string[]：
 *  - 逐项 trim、丢空项（标签模式误触空格会产出 ""）；
 *  - 空集必须**显式 null** 而非缺省/delete——后端 PATCH 是
 *    Object.assign 语义（N28 教训：缺省字段=保留旧值），删除全部依赖
 *    若不发 null 会"界面已清空、后端仍安装旧依赖"。
 * 字段未挂载（glue 任务等不渲染该项）→ undefined 同样归一为 null，
 * 与执行器端"glue 任务清零 requirements"的既有语义一致，无副作用。
 */
export function applyRequirementsPayload(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...values };
  const raw = payload.requirements;
  if (Array.isArray(raw)) {
    const cleaned = raw
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter((r) => r.length > 0);
    payload.requirements = cleaned.length > 0 ? cleaned : null;
  } else {
    payload.requirements = null;
  }
  return payload;
}
