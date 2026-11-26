/**
 * N11 · Plan agent 身份的纯状态机层。
 *
 * Plan 不是 UX 折叠开关，而是一次**受限执行身份切换**：
 *   · MemoryFileSystem —— 只读内存文件系统（fileSystem = "memory-readonly"）；
 *   · PermissionService —— 写操作全拒（writePermission = "denied"）；
 *   · 工具面只声明「tier ≤ read」，**不列工具名、不重建白名单**：具体工具集由
 *     调用方先用 toolsForSessionKind(kind, phase) 收窄，再按本层给出的 tier 集合过滤；
 *   · 方案卡一次批准 = 一次 SOP 发布 scope=once，exit 只接受 "once"。
 *
 * 零 Nest / DB / 队列依赖：FS、权限服务、审批单落库与 agent loop 接线都在调用方。
 * 所有函数不可变——返回新对象，绝不修改入参；未知 tier / 未知意图 / 非法 scope 一律
 * 收紧（fail-closed），不存在「没写规则就放行」的路径。
 */

/** 工具风险层级，取值与 AgentToolTier 逐字一致；本层不 import 实体，避免带入 DB 层。 */
export type PlanToolTier = "read" | "write" | "dangerous";

/** 执行身份。 */
export type PlanIdentity = "plan" | "executor";

/** 方案批准 scope：类型层面就只有一次性发布，"all" 不存在于该联合类型。 */
export type PlanApprovalScope = "once";

/** 意图/类别级请求规则：精确匹配 intent，命中后按 decision 判定。 */
export interface AllowedPrompt {
  /** 意图或类别标识；不做前缀、包含、大小写折叠或通配匹配。 */
  readonly intent: string;
  /** 命中后的判定；非这两个值一律按 ask 处理。 */
  readonly decision: "granted" | "denied";
}

/** 一次身份切换后的不可变状态。 */
export interface PlanState {
  readonly identity: PlanIdentity;
  /** 进入 plan 前的 tier 集合（调用方会话白名单的 tier 投影），exit 时原样恢复。 */
  readonly baseToolTiers: readonly PlanToolTier[];
  /** 当前身份下仍可触达的 tier：plan 只含 read；executor 与 base 一致。 */
  readonly toolTiers: readonly PlanToolTier[];
  /** plan = 只读内存 FS；executor = 宿主 FS。 */
  readonly fileSystem: "memory-readonly" | "host";
  /** plan = 写全拒；executor 的写权限仍由调用方闸门判定。 */
  readonly writePermission: "denied" | "caller-decided";
  /** 已发布的方案批准 scope；plan 身份恒 null，exit("once") 后为 "once"。 */
  readonly approvalScope: PlanApprovalScope | null;
  /** 意图/类别级白名单，整段带入带出，本层不解释其内容。 */
  readonly allowedPrompts: readonly AllowedPrompt[];
}

const TIER_RANK: ReadonlyMap<string, number> = new Map([
  ["read", 0],
  ["write", 1],
  ["dangerous", 2],
]);
const PLAN_TIER_CEILING_RANK = 0;

/**
 * tier 上限判定：只按 rank 比较，不按工具名或描述字符串比较。
 * 未知 tier（含新枚举、大小写变体、非字符串）rank 缺失 ⇒ false。
 */
function withinPlanCeiling(tier: unknown): boolean {
  const rank = typeof tier === "string" ? TIER_RANK.get(tier) : undefined;
  return rank !== undefined && rank <= PLAN_TIER_CEILING_RANK;
}

function describeScope(scope: unknown): string {
  if (typeof scope === "string") return JSON.stringify(scope);
  if (scope === null) return "null";
  if (scope === undefined) return "undefined";
  return typeof scope;
}

/** 非法批准 scope：拒绝状态迁移，错误信息带可诊断的实收值类型。 */
export class InvalidPlanApprovalScopeError extends Error {
  readonly code = "invalid_approval_scope";

  constructor(scope: unknown) {
    super(
      `invalid_approval_scope: only "once" is accepted (got ${describeScope(scope)})`,
    );
    this.name = "InvalidPlanApprovalScopeError";
  }
}

/**
 * 切换到受限的 plan 身份。
 *
 * 写 / 危险工具全拒是通过**按 tier 收窄**实现的：baseToolTiers 里所有 rank > read
 * 的项被剔除，未登记的 tier 同样剔除。工具名从不在本层出现——本层只声明 tier
 * 上限，调用方用 toolsForSessionKind 得到具体工具集后再按 toolTiers 过滤。
 */
export function enterPlanMode(state: PlanState): PlanState {
  const base = Array.isArray(state?.baseToolTiers) ? state.baseToolTiers : [];
  return {
    identity: "plan",
    baseToolTiers: [...base],
    toolTiers: base.filter(withinPlanCeiling),
    fileSystem: "memory-readonly",
    writePermission: "denied",
    approvalScope: null,
    allowedPrompts: Array.isArray(state?.allowedPrompts)
      ? [...state.allowedPrompts]
      : [],
  };
}

/**
 * 意图/类别级请求判定。
 *
 * 精确相等才可能 granted / denied；规则缺席、规则非法、同意图判定冲突、prompt
 * 非字符串或为空一律 "ask"（fail-closed）。不做包含匹配、通配展开或大小写折叠，
 * 避免「模仿某类别的意图名」蹭到另一类别的授权。
 */
export function classifyAllowedPrompt(
  prompt: string,
  allowedPrompts: readonly AllowedPrompt[],
): "granted" | "ask" | "denied" {
  if (typeof prompt !== "string" || prompt.length === 0) return "ask";
  if (!Array.isArray(allowedPrompts)) return "ask";

  let matched: "granted" | "denied" | null = null;
  for (const rule of allowedPrompts) {
    if (!rule || rule.intent !== prompt) continue;
    const decision: unknown = rule.decision;
    if (decision !== "granted" && decision !== "denied") return "ask";
    if (matched !== null && matched !== decision) return "ask";
    matched = decision;
  }
  return matched ?? "ask";
}

/**
 * 退出 plan 身份，恢复调用方原有工具面并发布**一次性**批准 scope。
 *
 * approvalScope 只接受字面量 "once"；"all"、session、大小写变体、空值、对象统统
 * 抛 InvalidPlanApprovalScopeError，状态不发生迁移——不存在永久授权出口。
 */
export function exitPlanMode(
  state: PlanState,
  approvalScope: unknown,
): PlanState {
  if (approvalScope !== "once") {
    throw new InvalidPlanApprovalScopeError(approvalScope);
  }
  const base = Array.isArray(state?.baseToolTiers) ? state.baseToolTiers : [];
  return {
    identity: "executor",
    baseToolTiers: [...base],
    toolTiers: [...base],
    fileSystem: "host",
    writePermission: "caller-decided",
    approvalScope: "once",
    allowedPrompts: Array.isArray(state?.allowedPrompts)
      ? [...state.allowedPrompts]
      : [],
  };
}

/**
 * N11 接线辅助（纯函数，不改动上面三个状态机函数）：
 * plan 闸门只收紧，放行一律**回原模式**——这里把原模式判定归一，未知模式 /
 * 未知判定值一律 ask（fail-closed），不存在「没写规则就当 allow」的路径。
 */
export function planBaseDecision(
  baseMode: unknown,
  baseDecision: unknown,
): "allow" | "ask" | "deny" {
  if (typeof baseMode !== "string" || baseMode.length === 0) return "ask";
  if (
    baseDecision !== "allow" &&
    baseDecision !== "ask" &&
    baseDecision !== "deny"
  ) {
    return "ask";
  }
  return baseDecision;
}

/** plan 身份判定：只认字面量 "plan"，不做大小写折叠或包含匹配。 */
export function isPlanIdentity(identity: unknown): boolean {
  return identity === "plan";
}
