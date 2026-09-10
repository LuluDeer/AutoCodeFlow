/**
 * R7 (N19): 任务表单执行器策略的纯逻辑层。
 * 独立成文件是为了同时满足 react-refresh（组件文件只导出组件）与可测性。
 */

export type ExecutorMode = 'auto' | 'group' | 'pinned' | 'broadcast';

/** NF-04：编辑态任务对象的亲和/反亲和字段。保留最小结构类型以避免
 * 将表单纯逻辑层与完整 API 类型耦合。 */
type AffinityTaskFields = {
  executorAffinityTags?: string[] | null;
  executorAntiAffinityTags?: string[] | null;
};

/**
 * NF-04：亲和/反亲和标签归一为「非空数组 | 显式 null」。两列是可空
 * simple-array，PATCH 语义为缺省=保留旧值、显式 null=清除（N28）。antd
 * Select 清空后值可能是 undefined（未挂载/未触碰）或 []（点 clear），
 * 两者都必须归一为 null，否则用户清空后旧约束仍在后端生效。
 */
export function normalizeAffinityTags(v: unknown): string[] | null {
  return Array.isArray(v) && v.length > 0 ? (v as string[]) : null;
}

/**
 * NF-04：后端任务 → 表单亲和/反亲和初值（编辑态回填）。数组原样回填；
 * null/空数组归一 undefined（antd Form 空态），提交侧再由
 * buildExecutorPayload 统一归一为显式 null。
 * 入参为 unknown：调用方任务对象可能来自不同 API 载荷形态。
 */
export function affinityFormValues(task: unknown): {
  executorAffinityTags?: string[];
  executorAntiAffinityTags?: string[];
} {
  const t = (task ?? {}) as AffinityTaskFields;
  const norm = (v?: string[] | null) => (v && v.length > 0 ? v : undefined);
  return {
    executorAffinityTags: norm(t.executorAffinityTags),
    executorAntiAffinityTags: norm(t.executorAntiAffinityTags),
  };
}

/**
 * 从后端任务映射到表单的执行器策略。优先级：
 * broadcast > executorId(真 pinning，后端 dispatch 唯一认可) > executorAppName
 * (legacy appName 语义，仍显示为 pinned 但需按 id 重选) > group/tags > auto。
 * NF-04 亲和/反亲和不参与模式推导——它们是正交约束，auto/group/broadcast
 * 下均可生效（见 buildExecutorPayload 注释）。
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
  // NF-04: 亲和/反亲和是与执行器选择模式正交的调度约束，而非 group 模式
  // 的限定字段——后端单发路径（auto/group）在 group/tags/runtime 过滤之后、
  // loadScore 之前过滤候选（亲和 OR 命中 / 反亲和排除，executor.service.ts
  // 2.2b 段）；broadcast 路径同样过滤，把广播收窄为命中亲和标签的子集
  // （pinning=一台、普通广播=全部、广播+亲和=命中子集，即第三态价值）。
  // 故 auto/group/broadcast 三模式保留其值；清空（undefined/[]）归一为
  // 显式 null——PATCH 缺省=Object.assign 保留旧值（N28），不显式发 null 会
  // 「界面已清空、后端仍生效」。
  payload.executorAffinityTags = normalizeAffinityTags(payload.executorAffinityTags);
  payload.executorAntiAffinityTags = normalizeAffinityTags(
    payload.executorAntiAffinityTags,
  );
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
    // NF-04: pinned 分支在后端 dispatch 直接取 [pinned] 绕过一切过滤
    // （executor.service.ts，含亲和/反亲和），所以两字段在 pinned 下不生效。
    // API 仍允许保存两列，且 PATCH 缺省=保留；不要因为切到 pinned 就
    // 擦除用户已配置的约束。控件在 pinned 下禁用，切回非 pinned 后约束可继续生效。
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
