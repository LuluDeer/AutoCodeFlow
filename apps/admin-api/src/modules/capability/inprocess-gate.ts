/**
 * N24 中间形态（P1/P2）—— 进程内能力权限层（纯函数，零 Nest / DB / I/O）。
 *
 * 本层只消费调用方投影进来的「能力条目 + 调用面」，产出权限判定、进程内预算
 * 判定与失败降级标记。它是 plan agent 只读档（tier<=read）在能力侧的同类收紧：
 * 同一个进程里先把 managed 硬约束、危险能力、副作用面与相对预算算清楚。
 *
 * 与 P4 进程外 host 的边界（本文件不跨这条线）：
 *  - 本层没有 slots/streams 双限流、没有坏版本回退、没有进程外 host / IPC；
 *  - budget 的计数是相对单位（一次调用=1 单位的默认口径），不虚构 token、不读
 *    tokenizer、不读配额表；它只回答「当前代在本进程内还能不能继续」
 *  - degradeOnFailure 只返回标记，不读缓存、不清缓存、不发空响应。真实副作用
 *    由调用链按标记执行，本层零副作用。
 *
 * 策略求值不重写：权限判定把能力条目投影成 (resource, action) + 四语义层，
 * 交给 scope-engine 的 evaluateAll 聚合。这里只做投影与 fail-closed 前置消毒。
 */
import type {
  CapabilityAttestation,
  CapabilityGuidance,
  CapabilityScopeMode,
} from "./entities/capability.entity";
import {
  evaluateAll,
  type Decision,
  type PolicyRef,
  type SemanticPolicyLayer,
} from "./scope/scope-engine";

export type { Decision } from "./scope/scope-engine";

/** 调用副作用面。plan agent 走 read（只读范例）；write 是有副作用调用。 */
export type CapabilityInvokeMode = "read" | "write";

/**
 * 进程内能力条目投影：兼容注册表实体（key/kind/scope/version/attestation）
 * 与内存替身。`access` / `dangerous` 是调用链投影进来的运行时标记，不是落库
 * manifest 键；缺席时按最保守解释（未知 access ⇒ 写，未知 dangerous ⇒ 由
 * guidance/kind 推导）。
 */
export interface InProcessCapability {
  readonly key?: string;
  readonly kind?: string;
  readonly version?: string | null;
  readonly versionPin?: string | null;
  readonly scope?: {
    readonly mode?: CapabilityScopeMode | string;
    readonly guidance?: CapabilityGuidance | string;
  } | null;
  readonly attestation?: Pick<CapabilityAttestation, "signer" | "scope"> | null;
  readonly access?: "read" | "write";
  readonly dangerous?: boolean;
}

// ── 权限判定 ────────────────────────────────────────────────────────────

const SCOPE_MODES: ReadonlySet<string> = new Set([
  "managed",
  "supervised",
  "self_service",
]);
const GUIDANCE_LEVELS: ReadonlySet<string> = new Set(["L1", "L2", "L3"]);

function isPlainCapability(
  capability: InProcessCapability | null | undefined,
): capability is InProcessCapability {
  return (
    capability !== null &&
    typeof capability === "object" &&
    !Array.isArray(capability)
  );
}

/** 资源名：key 非空才用 key，否则退化为类级资源（仍由四语义层判定）。 */
function resourceOf(capability: InProcessCapability): string {
  const key = capability.key;
  if (typeof key === "string" && key.trim().length > 0) return key.trim();
  return "capability";
}

/** managed 的授权证据只认 N16 背书声明的 signer；无 signer 即未授权。 */
function hasManagedAuthorization(capability: InProcessCapability): boolean {
  const attestation = capability.attestation;
  if (attestation === null || typeof attestation !== "object") return false;
  return (
    typeof attestation.signer === "string" &&
    attestation.signer.trim().length > 0
  );
}

/** 危险能力：显式标记 / 模型渠道 / L1 强引导档。 */
function isDangerous(
  capability: InProcessCapability,
  guidance: CapabilityGuidance,
): boolean {
  if (capability.dangerous === true) return true;
  if (capability.kind === "provider") return true;
  return guidance === "L1";
}

/** 只读性：只有显式 read 才是只读，缺席/畸形按写处理（fail-closed）。 */
function isReadOnlyCapability(capability: InProcessCapability): boolean {
  return capability.access === "read";
}

/**
 * 能力条目 → 资源/动作映射：单个 invocation 只投影一个 (resource, action)，
 * 由下面的四语义层给出各档决策；多资源/多动作的 any-deny 聚合交给 evaluateAll。
 */
function projectRefs(
  capability: InProcessCapability,
  mode: CapabilityInvokeMode,
): PolicyRef[] {
  return [{ resource: resourceOf(capability), action: mode }];
}

/**
 * 能力条目 → 四语义策略层（高一低顺序）：
 *  1. managed 硬层：已背书 ⇒ override allow；未背书 ⇒ restrict deny（下层不可撤销）
 *  2. 危险能力 restrict ask：不能被下层放松成 allow
 *  3. guidance 规则层：L1 ask / L3 allow；L2 落到 supervised 默认 ask
 *  4. write 规则层：有副作用调用收紧为 ask
 *  5. supervised 兜底：任何未覆盖组合落 ask（fail-closed）
 */
function projectLayers(
  capability: InProcessCapability,
  mode: CapabilityScopeMode,
  guidance: CapabilityGuidance,
  invokeMode: CapabilityInvokeMode,
): SemanticPolicyLayer[] {
  const layers: SemanticPolicyLayer[] = [];

  if (mode === "managed") {
    const authorized = hasManagedAuthorization(capability);
    layers.push({
      name: "managed",
      semantic: authorized ? "override" : "restrict",
      config: { policy: { default: authorized ? "allow" : "deny" } },
    });
  }

  if (isDangerous(capability, guidance)) {
    layers.push({
      name: "dangerous",
      semantic: "restrict",
      config: { policy: { default: "ask" } },
    });
  }

  if (guidance !== "L2") {
    layers.push({
      name: `guidance:${guidance}`,
      semantic: "rules",
      config: { policy: { default: guidance === "L3" ? "allow" : "ask" } },
    });
  }

  if (invokeMode === "write") {
    layers.push({
      name: "mode:write",
      semantic: "rules",
      config: { policy: { default: "ask" } },
    });
  }

  layers.push({
    name: "supervised-fallback",
    semantic: "fallback",
    config: { policy: { default: "ask" } },
  });

  return layers;
}

/**
 * 能力调用权限三态。前置消毒全部 fail-closed：未知 mode/guidance/scope.mode、
 * managed+L3（治理锁定却允许业务直配）、只读能力承接写调用，一律 deny。
 * 通过消毒后只输出 evaluateAll 的四语义聚合结果，不在本层重写策略求值。
 */
export function classifyCapabilityPermission(
  capability: InProcessCapability | null | undefined,
  mode: CapabilityInvokeMode | string | null | undefined,
): Decision {
  if (mode !== "read" && mode !== "write") return "deny";
  if (!isPlainCapability(capability)) return "deny";

  const scopeMode = capability.scope?.mode;
  const guidance = capability.scope?.guidance;
  if (
    typeof scopeMode !== "string" ||
    !SCOPE_MODES.has(scopeMode) ||
    typeof guidance !== "string" ||
    !GUIDANCE_LEVELS.has(guidance)
  ) {
    return "deny";
  }
  // 治理硬约束：managed ⇒ guidance <= L2。
  if (scopeMode === "managed" && guidance === "L3") return "deny";
  // 只读能力被要求产生副作用：越权，不放行。
  if (mode === "write" && isReadOnlyCapability(capability)) return "deny";

  const decision = evaluateAll(
    projectLayers(
      capability,
      scopeMode as CapabilityScopeMode,
      guidance as CapabilityGuidance,
      mode,
    ),
    projectRefs(capability, mode),
  );
  return decision === "allow" || decision === "ask" || decision === "deny"
    ? decision
    : "deny";
}

// ── 进程内预算（相对单位） ──────────────────────────────────────────────

/** 一代的已用相对单位；generation 是 opaque token，不做数值递增比较。 */
export interface BudgetGenerationUsage {
  readonly generation: string;
  readonly units: number;
}

/**
 * 进程内预算状态。按 capability key 分桶，桶内按 generation/version 再分代；
 * 一个代的用量不污染另一个代。state 为只读输入，判定不修改它。
 */
export interface InProcessBudgetState {
  readonly usage: Readonly<Record<string, readonly BudgetGenerationUsage[]>>;
  /** 单代相对预算上限（调用权重单位，不是 token）。 */
  readonly limitPerGeneration: number;
}

export interface InProcessBudgetRequest {
  readonly capabilityKey: string;
  /** generation 优先，缺席回退 version；两者皆无 ⇒ 不归代，fail-closed。 */
  readonly generation?: string | null;
  readonly version?: string | null;
  /** 本次相对消耗；缺省 1。0 / 负数 / 非有限数 ⇒ degraded。 */
  readonly units?: number;
}

export interface BudgetVerdict {
  readonly decision: "allow" | "degraded";
  readonly generation: string;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
}

function positiveUnit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function budgetVerdict(
  decision: "allow" | "degraded",
  generation: string,
  used: number,
  limit: number,
): BudgetVerdict {
  return {
    decision,
    generation,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  };
}

function generationOf(request: InProcessBudgetRequest): string {
  for (const candidate of [request.generation, request.version]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

/**
 * 进程内预算判定：同一 capability 的同一代累计 > limit ⇒ degraded，否则 allow。
 * 不虚构 token、不读外部配额、不写回 state；统计口径由调用方维护 state 时决定。
 * 非法 limit / 空 key / 不归代 / 非法 units / 畸形历史行全部 degraded。
 */
export function checkInProcessBudget(
  state: InProcessBudgetState,
  request: InProcessBudgetRequest,
): BudgetVerdict {
  const limit = positiveUnit(state?.limitPerGeneration);
  if (limit === null) return budgetVerdict("degraded", "", 0, 0);

  const key =
    typeof request?.capabilityKey === "string"
      ? request.capabilityKey.trim()
      : "";
  if (key.length === 0) return budgetVerdict("degraded", "", 0, limit);

  const generation = generationOf(request);
  if (generation.length === 0) {
    return budgetVerdict("degraded", "", 0, limit);
  }

  const units = request.units === undefined ? 1 : positiveUnit(request.units);
  if (units === null) {
    return budgetVerdict("degraded", generation, 0, limit);
  }

  const rows: readonly unknown[] = state.usage?.[key] ?? [];
  let used = 0;
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return budgetVerdict("degraded", generation, 0, limit);
    }
    const entry = row as Partial<BudgetGenerationUsage>;
    if (typeof entry.generation !== "string") {
      return budgetVerdict("degraded", generation, 0, limit);
    }
    if (entry.units !== 0 && positiveUnit(entry.units) === null) {
      return budgetVerdict("degraded", generation, 0, limit);
    }
    if (entry.generation === generation) used += entry.units ?? 0;
  }

  const next = used + units;
  return budgetVerdict(
    next > limit ? "degraded" : "allow",
    generation,
    next,
    limit,
  );
}

// ── 失败降级（标记，不执行） ────────────────────────────────────────────

export type DegradeAction = "use-cached" | "empty-result" | "fail-closed";

export interface DegradeVerdict {
  readonly action: DegradeAction;
  readonly readOnly: boolean;
  readonly errorKind: string;
  /** 是否允许调用方拿缓存结果顶上；只有明确可缓存的错误才为 true。 */
  readonly cachedResultAllowed: boolean;
}

const CACHEABLE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "timeout",
  "unreachable",
  "unavailable",
  "transient",
]);

const EMPTY_RESULT_ERROR_KINDS: ReadonlySet<string> = new Set([
  "not_found",
  "no_data",
  "empty",
]);

function failClosed(errorKind: string, readOnly: boolean): DegradeVerdict {
  return {
    action: "fail-closed",
    readOnly,
    errorKind,
    cachedResultAllowed: false,
  };
}

/**
 * 失败降级标记：read-only 能力按错误类别返回缓存/空结果标记；write 能力
 * fail-closed；未知 errorKind / 畸形 capability 同样 fail-closed。
 * 本函数不读缓存、不发响应、不产生任何真实副作用。
 */
export function degradeOnFailure(
  capability: InProcessCapability | null | undefined,
  errorKind: string | null | undefined,
): DegradeVerdict {
  const kind =
    typeof errorKind === "string" ? errorKind.trim().toLowerCase() : "";
  const readOnly =
    isPlainCapability(capability) && isReadOnlyCapability(capability);
  if (!readOnly || kind.length === 0) return failClosed(kind, readOnly);

  if (CACHEABLE_ERROR_KINDS.has(kind)) {
    return {
      action: "use-cached",
      readOnly: true,
      errorKind: kind,
      cachedResultAllowed: true,
    };
  }
  if (EMPTY_RESULT_ERROR_KINDS.has(kind)) {
    return {
      action: "empty-result",
      readOnly: true,
      errorKind: kind,
      cachedResultAllowed: false,
    };
  }
  return failClosed(kind, true);
}
