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
 * 提交序列化（完整版）：读取表单载体字段 upstreamDependencies（Select 值 =
 * taskId 列表），写入 DTO 声明的 dependencies 映射，并**删除载体字段本身**。
 *
 * 删除载体是硬性要求（QA-01 / e2e 例 23-24 连红根因）：全局 ValidationPipe 开启
 * whitelist + forbidNonWhitelisted，而 CreateTaskDto 只声明 dependencies、未声明
 * upstreamDependencies。编辑态 setFieldValue 恒把该字段置为数组（无依赖时 []），
 * 未删除则 PATCH 请求体携带未声明键 -> 后端 400 -> 前端弹「更新失败」，表现为
 * 「界面已切换、服务端旧值不变」（例 23/24 的 executeMode 断言超时是次生症状）。
 *
 * 必须 delete 而非置 null/undefined：whitelist 按 Object.keys 判定键是否声明，
 * 值为 null 的未声明键同样触发 400；只有 delete 才能让键彻底不出现在请求体里。
 */
export function applyDependenciesPayload(
  values: Record<string, unknown>,
  nameSnapshot: Record<string, string>,
): Record<string, unknown> {
  const payload = { ...values };
  payload.dependencies = buildDependenciesPayload(
    payload.upstreamDependencies as DependencySelection | undefined,
    nameSnapshot,
  );
  delete payload.upstreamDependencies;
  return payload;
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
