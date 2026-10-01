/**
 * NF-02: 任务上游依赖（编排）表单的纯逻辑层。
 * 独立成文件与 executor-mode.ts 同理由：react-refresh（组件文件只导出组件）
 * 与可测性。
 *
 * 后端契约（FIX-1.1，2026-09-30 定死）：tasks.dependencies jsonb =
 * **Record<显示名快照, 上游任务id>**——**value 是上游依赖的任务 ID**。
 * 后端环检测（checkCircularDependency/detectCycle）、依赖满足判定
 * （checkDependencies）、上游 SUCCESS 扇出匹配（triggerDependentTasks 的
 * `Object.values(...).includes(completedTaskId)`）与前端 DAG 图
 * （dag-layout.ts）全部按 **value=id** 消费；key 仅作展示别名，
 * 不参与任何语义判定。旧实现把映射写成 {taskId: taskName}（value=名字），
 * 导致扇出匹配/环检测/DAG 图对 UI 建链静默失效——本文件已随契约翻转，
 * 存量 {uuid→name} 行由迁移 1790000000048 幂等翻转。
 *
 * 上游全部最近执行 SUCCESS 时由 task.service.triggerDependentTasks
 * 自动扇出触发下游。
 */

/** 表单控件值：Select 的 value=taskId，label 由 options 提供（taskName）。 */
export type DependencySelection = string[];

/**
 * 提交序列化：选中 taskId 列表 → 后端 dependencies 映射。
 *  - **value 恒为上游任务 id**（后端按 value 做环检测与扇出——见文件头契约）；
 *  - key 取加载时的显示名快照（nameSnapshot），供 DAG 图与排查场景人读；
 *    快照缺失（任务刚被删除等竞态）时 key 与 value 同用 taskId——不再做
 *    「value 兜底为 id」的反向兜底（旧实现 value=名字会让后端扇出静默失效）；
 *  - 同名上游任务（key 冲突）时后者降级为 key=id，保证 value（语义位）永不丢；
 *  - 空集必须**显式 null** 而非缺省/delete——PATCH 是 Object.assign 语义
 *    （N28 教训：缺省字段=保留旧值），清空全部依赖不发 null 会
 *    「界面已清空、后端仍保留旧依赖链」。
 */
export function buildDependenciesPayload(
  selected: DependencySelection | undefined,
  nameSnapshot: Record<string, string>,
): Record<string, string> | null {
  if (!Array.isArray(selected) || selected.length === 0) return null;
  const map: Record<string, string> = {};
  for (const id of selected) {
    // key = 显示名（缺省回退 id）；value 恒为任务 id（后端语义位）。
    const key = nameSnapshot[id] ?? id;
    // key 冲突（两个上游同名）：展示别名可牺牲，语义位不可——降级 key=id。
    if (map[key] !== undefined && map[key] !== id) {
      map[id] = id;
    } else {
      map[key] = id;
    }
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
 * 编辑态回填：后端 dependencies 映射（Record<显示名, 上游任务id>）→
 * Select 值（taskId 列表，取 **value**）+ 名称快照（taskId → 显示名，
 * 供提交时重建映射，避免再拉一次任务列表）。
 */
export function dependenciesFormValues(
  deps: Record<string, string> | null | undefined,
): { selected: DependencySelection; nameSnapshot: Record<string, string> } {
  if (!deps) return { selected: [], nameSnapshot: {} };
  const selected: DependencySelection = [];
  const nameSnapshot: Record<string, string> = {};
  for (const [displayName, id] of Object.entries(deps)) {
    // value=id 是语义位（Select 的值）；key=显示名进快照供展示/重建映射。
    selected.push(id);
    nameSnapshot[id] = displayName;
  }
  return { selected, nameSnapshot };
}
