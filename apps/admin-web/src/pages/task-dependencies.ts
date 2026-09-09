/**
 * NF-02: 任务上游依赖（编排）表单的纯逻辑层。
 * 独立成文件与 executor-mode.ts 同理由：react-refresh（组件文件只导出组件）
 * 与可测性。后端契约：tasks.dependencies jsonb = Record<taskId, taskName>
 * （create-task.dto.ts「Upstream task dependency map」），上游全部最近执行
 * SUCCESS 时由 task.service.triggerDependentTasks 自动扇出触发下游。
 */

/** 表单控件值：Select 的 value=taskId，label 由 options 提供（taskName）。 */
export type DependencySelection = string[];

/**
 * 提交序列化：选中 taskId 列表 → 后端 dependencies 映射。
 *  - 空集必须**显式 null** 而非缺省/delete——PATCH 是 Object.assign 语义
 *    （N28 教训：缺省字段=保留旧值），清空全部依赖不发 null 会
 *    「界面已清空、后端仍保留旧依赖链」。
 *  - taskName 取自加载时的任务快照（nameSnapshot），快照缺失（任务刚被
 *    删除等竞态）时以 taskId 兜底——后端只按 value（taskId）做环检测与
 *    扇出，name 仅展示用途。
 */
export function buildDependenciesPayload(
  selected: DependencySelection | undefined,
  nameSnapshot: Record<string, string>,
): Record<string, string> | null {
  if (!Array.isArray(selected) || selected.length === 0) return null;
  const map: Record<string, string> = {};
  for (const id of selected) {
    map[id] = nameSnapshot[id] ?? id;
  }
  return map;
}

/**
 * 编辑态回填：后端 dependencies 映射 → Select 值（taskId 列表）+ 名称快照
 * （供提交时重建映射，避免再拉一次任务列表）。
 */
export function dependenciesFormValues(
  deps: Record<string, string> | null | undefined,
): { selected: DependencySelection; nameSnapshot: Record<string, string> } {
  if (!deps) return { selected: [], nameSnapshot: {} };
  const selected: DependencySelection = [];
  const nameSnapshot: Record<string, string> = {};
  for (const [id, name] of Object.entries(deps)) {
    selected.push(id);
    nameSnapshot[id] = name;
  }
  return { selected, nameSnapshot };
}
