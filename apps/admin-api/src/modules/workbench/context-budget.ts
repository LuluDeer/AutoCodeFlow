/**
 * N12 上下文成本投影（纯函数，零 Nest / DB / 跨模块依赖）。
 *
 * 工具集：不 import `toolsForSessionKind`，也不重建 kind×phase 白名单或 tier
 * 规则——本函数只消费调用方已经过闸门收窄的 `availableTools`，再与下面的
 * 最小工具清单求交。这样跨 workbench → agent/tools 没有新增依赖，且本层
 * 永远不能把闸门未给出的工具重新放出来。
 *
 * 预算：方案卡只给出轮次与能力提示，没有真实 token 样本；因此返回的是
 * 相对预算单位（RU），不把公式伪装成 token 计费。
 */

export const OUTPUT_BUDGET_TURNS_CAP = 20;
export const OUTPUT_BUDGET_DEFAULT_TURNS = 10;
export const OUTPUT_BUDGET_UNITS_CAP = 100;

const UNITS_PER_TURN = 4;
const UNITS_PER_CAPABILITY = 8;

const PROJECTED_CAPABILITIES: ReadonlySet<string> = new Set([
  "browser",
  "gui",
  "filesystem",
]);

const MINIMAL_TOOLS_BY_KIND: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "ops_watch",
    [
      "list_tasks",
      "get_task",
      "list_executions",
      "get_execution",
      "get_scheduler_health",
      "list_dead_letters",
    ],
  ],
  [
    "incident",
    [
      "get_execution",
      "get_execution_logs",
      "get_execution_timeline",
      "list_executions",
      "trigger_task",
      "retry_execution",
      "kill_execution",
    ],
  ],
  [
    "sop_authoring",
    [
      "sop_list",
      "sop_get",
      "sop_draft",
      "create_application",
      "create_task_from_template",
    ],
  ],
  [
    "sop_review",
    [
      "sop_list",
      "sop_get",
      "sop_reply_clarification",
      "get_execution",
      "get_execution_logs",
    ],
  ],
  [
    "app_scaffold",
    [
      "list_applications",
      "get_application",
      "create_application",
      "create_task_from_template",
      "deploy_application",
    ],
  ],
  ["chat", ["list_tasks", "get_task", "list_executions", "get_execution"]],
]);

/**
 * 按会话 kind 把已收窄的工具列表进一步投影成最小工具集。
 * 未知 kind、null/非数组 available、非字符串工具名一律 fail-closed 为空集；
 * 输出顺序沿用 availableTools，不新增工具、不去重以外的改写。
 */
export function minimalToolsForKind(
  kind: string,
  availableTools: readonly string[],
): readonly string[] {
  const minimal = MINIMAL_TOOLS_BY_KIND.get(kind);
  if (!minimal) return [];
  if (!Array.isArray(availableTools)) return [];

  const allowed = new Set(minimal);
  const seen = new Set<string>();
  const projected: string[] = [];
  for (const tool of availableTools) {
    if (typeof tool !== "string") continue;
    if (!allowed.has(tool) || seen.has(tool)) continue;
    seen.add(tool);
    projected.push(tool);
  }
  return projected;
}

export interface PlanCardBudgetInput {
  readonly maxTurns?: unknown;
}

export interface PlanCardContextInput {
  readonly budget?: PlanCardBudgetInput | null;
  readonly capabilityHints?: readonly unknown[] | null;
}

export interface OutputBudgetVerdict {
  /** 相对预算单位（RU）；有真实 token 样本前不折算真实 token。 */
  readonly units: number;
  readonly unit: "relative";
  readonly maxTurns: number;
  readonly capabilityCount: number;
  /** maxTurns 或总单位是否触发过钳制。 */
  readonly clamped: boolean;
  readonly reasons: readonly string[];
}

interface TurnResolution {
  turns: number;
  reason: string;
  clamped: boolean;
}

interface CapabilityResolution {
  names: readonly string[];
  ignored: readonly string[];
}

function resolveTurns(raw: unknown): TurnResolution {
  if (raw === undefined) {
    return {
      turns: OUTPUT_BUDGET_DEFAULT_TURNS,
      reason: `未提供 maxTurns，按默认 ${OUTPUT_BUDGET_DEFAULT_TURNS} 轮`,
      clamped: false,
    };
  }

  let requested: number;
  if (typeof raw === "number") requested = raw;
  else if (typeof raw === "string" && raw.trim() !== "")
    requested = Number(raw);
  else requested = Number.NaN;

  if (!Number.isFinite(requested) || requested <= 0) {
    return {
      turns: OUTPUT_BUDGET_DEFAULT_TURNS,
      reason: `maxTurns 非法，回落默认 ${OUTPUT_BUDGET_DEFAULT_TURNS} 轮`,
      clamped: true,
    };
  }

  const truncated = Math.trunc(requested);
  if (truncated < 1) {
    return {
      turns: OUTPUT_BUDGET_DEFAULT_TURNS,
      reason: `maxTurns=${requested} 截断后不足 1 轮，回落默认 ${OUTPUT_BUDGET_DEFAULT_TURNS} 轮`,
      clamped: true,
    };
  }

  if (truncated > OUTPUT_BUDGET_TURNS_CAP) {
    return {
      turns: OUTPUT_BUDGET_TURNS_CAP,
      reason: `请求 maxTurns=${truncated} 超过轮次上限 ${OUTPUT_BUDGET_TURNS_CAP}，已钳制`,
      clamped: true,
    };
  }

  return {
    turns: truncated,
    reason: `maxTurns=${truncated} 在轮次上限 ${OUTPUT_BUDGET_TURNS_CAP} 内`,
    clamped: false,
  };
}

function resolveCapabilities(raw: unknown): CapabilityResolution {
  if (!Array.isArray(raw)) return { names: [], ignored: [] };

  const names: string[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (PROJECTED_CAPABILITIES.has(name)) names.push(name);
    else ignored.push(name);
  }
  return { names, ignored };
}

/**
 * 方案卡 → 输出预算投影。公式仅用于相对预算，不是 token 计费：
 * `RU = min(100, maxTurns * 4 + 可识别能力数 * 8)`。
 * 轮次非法回落默认值，轮次与总单位都钳到硬上限，未知能力不追加预算。
 */
export function outputBudgetFor(
  planCard: PlanCardContextInput | null | undefined,
): OutputBudgetVerdict {
  const budgetInput = planCard?.budget;
  const rawTurns =
    budgetInput && typeof budgetInput === "object"
      ? budgetInput.maxTurns
      : undefined;
  const turns = resolveTurns(rawTurns);
  const capabilities = resolveCapabilities(planCard?.capabilityHints);

  const rawUnits =
    turns.turns * UNITS_PER_TURN +
    capabilities.names.length * UNITS_PER_CAPABILITY;
  const units = Math.min(OUTPUT_BUDGET_UNITS_CAP, rawUnits);
  const unitsClamped = rawUnits > OUTPUT_BUDGET_UNITS_CAP;
  const reasons: string[] = [turns.reason];

  if (capabilities.names.length > 0) {
    reasons.push(
      `能力 ${capabilities.names.join("/")} 计入 ${capabilities.names.length} 项附加预算（每项 ${UNITS_PER_CAPABILITY} RU）`,
    );
  } else {
    reasons.push("未声明可识别能力，能力附加预算 0 RU");
  }
  if (capabilities.ignored.length > 0) {
    reasons.push(
      `忽略不在投影能力集合的 ${capabilities.ignored.join("/")}（不追加预算）`,
    );
  }
  if (unitsClamped) {
    reasons.push(
      `相对预算 ${rawUnits} RU 超过上限 ${OUTPUT_BUDGET_UNITS_CAP} RU，已钳制为 ${units} RU`,
    );
  }
  reasons.push("单位为相对预算单位（RU），不折算真实 token");

  return {
    units,
    unit: "relative",
    maxTurns: turns.turns,
    capabilityCount: capabilities.names.length,
    clamped: turns.clamped || unitsClamped,
    reasons,
  };
}
