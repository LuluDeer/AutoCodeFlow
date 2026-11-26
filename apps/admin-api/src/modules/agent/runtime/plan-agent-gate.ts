/**
 * N11 · Plan 身份接 agent loop 的**闸门层**（纯函数，零 Nest / DB / 队列依赖）。
 *
 * 语义只有一句话：**闸门只收紧，放行回原模式**。
 *   · 闸门层先判：destructive / 未知 tier 恒 deny；write 默认 deny；
 *   · read 不因 plan 裸跑——原模式 ask/deny 原样透传（ZCode 历史 bug 的修正）；
 *   · allowedPrompts 是**意图/类别级**一次性声明，命中只把 write 从闸门 deny
 *     抬到「回原模式判定」，不生成 permission rule，不缓存，不跨调用存活；
 *   · 非 plan 身份闸门不下场，原模式判定逐字透传（fail-open 到既有行为）。
 *
 * 本文件不 import 任何 capability / boundary 服务：原模式的真实判定由调用方
 * 通过 `baseDecision` / `baseDecisions` 注入，闸门只做「收紧」这一个维度。
 */

import {
  classifyAllowedPrompt,
  isPlanIdentity,
  planBaseDecision,
  type AllowedPrompt,
} from "./plan-agent";

export type PlanGateEffect = "allow" | "ask" | "deny";

/** 闸门判定的全部输入；缺字段 / 畸形字段一律按最保守解释。 */
export interface PlanGateInput {
  /** "plan" 才受闸门约束；其余身份原样透传。 */
  readonly identity?: unknown;
  /** 进入 plan 前的执行模式：build / yolo / guarded / …（只用于诊断与消毒）。 */
  readonly baseMode?: unknown;
  /** 原模式对本工具给出的判定：allow / ask / deny。 */
  readonly baseDecision?: unknown;
  /** 工具风险层级：read / write / dangerous。 */
  readonly toolTier?: unknown;
  readonly toolName?: unknown;
  /** 显式破坏性标记：MCP 的 dangerous 没在 tier 里表达时由调用方传入。 */
  readonly isDestructive?: unknown;
  /** 意图/类别标识（与 allowedPrompts[].intent 精确相等才算命中）。 */
  readonly prompt?: unknown;
  readonly allowedPrompts?: readonly AllowedPrompt[] | null;
}

export interface PlanGateDecision {
  readonly effect: PlanGateEffect;
  /** 机器可读判据；不拼接入参原文，避免把 prompt 当日志字符串回显。 */
  readonly reason: string;
  /** 本次是否由一次性意图声明放行；永不表示「已落永久规则」。 */
  readonly onceOnly: boolean;
}

const REASONS = {
  passthrough: "non_plan_passthrough",
  unknownTier: "unknown_tool_tier",
  destructive: "destructive_denied_in_plan",
  readPassthrough: "plan_read_passthrough",
  writeDenied: "plan_write_denied",
  once: "allowed_prompt_once",
  onceBaseDenied: "allowed_prompt_once_but_base_denied",
  promptDenied: "allowed_prompt_denied",
} as const;

/**
 * 分层判定：闸门的 deny 优先于原模式的 allow；闸门的「放行」只是把判定权
 * 交还原模式，绝不把原模式的 ask / deny 升级成 allow。
 */
export function planGateDecision(input: PlanGateInput): PlanGateDecision {
  const base = planBaseDecision(input?.baseMode, input?.baseDecision);

  // 非 plan：闸门缺席，既有行为逐字不变。
  if (!isPlanIdentity(input?.identity)) {
    return { effect: base, reason: REASONS.passthrough, onceOnly: false };
  }

  const tier = input?.toolTier;
  if (tier !== "read" && tier !== "write" && tier !== "dangerous") {
    return { effect: "deny", reason: REASONS.unknownTier, onceOnly: false };
  }

  // 硬层：destructive 恒拒，yolo 原模式与意图声明都不能解锁（无「始终允许」）。
  if (input?.isDestructive === true || tier === "dangerous") {
    return { effect: "deny", reason: REASONS.destructive, onceOnly: false };
  }

  // 只读层：闸门不收紧，但也不裸跑——原模式 ask/deny 原样带回。
  if (tier === "read") {
    return { effect: base, reason: REASONS.readPassthrough, onceOnly: false };
  }

  // 写层：闸门默认 deny；只有精确意图声明能放行回原模式，且仅此一次。
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const verdict = classifyAllowedPrompt(prompt, input?.allowedPrompts ?? []);
  if (verdict === "denied") {
    return { effect: "deny", reason: REASONS.promptDenied, onceOnly: false };
  }
  if (verdict === "granted") {
    return base === "deny"
      ? { effect: "deny", reason: REASONS.onceBaseDenied, onceOnly: true }
      : { effect: base, reason: REASONS.once, onceOnly: true };
  }
  return { effect: "deny", reason: REASONS.writeDenied, onceOnly: false };
}

/** runtime 接线所需的最小会话投影（不依赖 TypeORM 实体）。 */
export interface PlanGateSessionLike {
  readonly kind?: string | null;
  readonly contextJson?: Record<string, unknown> | null;
  readonly scopeJson?: Record<string, unknown> | null;
}

/** 工具定义投影：name/tier 必有，其余字段原样透传。 */
export interface PlanGateToolLike {
  readonly name: string;
  readonly tier: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
}

export interface NarrowPlanToolsOptions {
  /** 原模式标识；缺省按 "build"（比 yolo 更保守，只影响诊断与消毒）。 */
  readonly baseMode?: unknown;
  /** 工具名 → 原模式判定；缺省 ask（没有原模式证据时不裸跑）。 */
  readonly baseDecisions?: Readonly<Record<string, PlanGateEffect>>;
  /** 工具名 → 意图标识；缺省用工具名本身做精确匹配。 */
  readonly intentsByTool?: Readonly<Record<string, string>>;
  /** 额外破坏性工具名（tier 未表达时用）。 */
  readonly destructiveToolNames?: readonly string[];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

function readAllowedPrompts(value: unknown): AllowedPrompt[] {
  if (!Array.isArray(value)) return [];
  const out: AllowedPrompt[] = [];
  for (const rule of value) {
    if (!rule || typeof rule !== "object") continue;
    const intent = (rule as { intent?: unknown }).intent;
    const decision = (rule as { decision?: unknown }).decision;
    if (typeof intent !== "string" || intent.length === 0) continue;
    if (decision !== "granted" && decision !== "denied") continue;
    out.push({ intent, decision });
  }
  return out;
}

function field(
  session: PlanGateSessionLike | null | undefined,
  name: string,
): unknown {
  const context = session?.contextJson;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    return context[name];
  }
  const scope = session?.scopeJson;
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    return scope[name];
  }
  return undefined;
}

/** plan 身份：kind === "plan" 或 contextJson/scopeJson.planIdentity === "plan"。 */
export function planSessionIdentity(
  session: PlanGateSessionLike | null | undefined,
): "plan" | null {
  if (!session || typeof session !== "object") return null;
  if (isPlanIdentity(session.kind)) return "plan";
  return isPlanIdentity(field(session, "planIdentity")) ? "plan" : null;
}

/**
 * availableTools 之后的收窄：plan 身份下移除闸门 deny 的工具；
 * ask / allow 都保留并交回原模式（ask 由既有审批链处理，不是闸门放行）。
 * 非 plan 会话返回**同一数组引用**——主链逐字不变。
 */
export function narrowPlanTools<T extends PlanGateToolLike>(
  session: PlanGateSessionLike | null | undefined,
  tools: readonly T[],
  options: NarrowPlanToolsOptions = {},
): T[] {
  if (planSessionIdentity(session) === null) return tools as T[];
  if (!Array.isArray(tools)) return tools as T[];

  const allowedPrompts = readAllowedPrompts(field(session, "allowedPrompts"));
  const baseMode =
    options.baseMode ?? field(session, "planBaseMode") ?? "build";
  const sessionIntents = field(session, "planIntents");
  const sessionDestructive = field(session, "planDestructiveTools");
  const destructive = new Set([
    ...readStringArray(sessionDestructive),
    ...readStringArray(options.destructiveToolNames),
  ]);

  return tools.filter((tool) => {
    const prompt =
      options.intentsByTool?.[tool.name] ??
      (sessionIntents && typeof sessionIntents === "object"
        ? (sessionIntents as Record<string, unknown>)[tool.name]
        : undefined) ??
      tool.name;
    const decision = planGateDecision({
      identity: "plan",
      baseMode,
      baseDecision: options.baseDecisions?.[tool.name] ?? "ask",
      toolTier: tool?.tier,
      toolName: tool?.name,
      isDestructive: tool?.tier === "dangerous" || destructive.has(tool?.name),
      prompt,
      allowedPrompts,
    });
    return decision.effect !== "deny";
  });
}
