/**
 * N9 能力可达性纯判定层。
 *
 * 本文件只消费外部喂入的探测结果并返回标记：零网络、零 DB、零 X11 调用。
 * 首个 e2e 用已有 API / 已就绪文件数据源（browser / gui / filesystem），
 * 不用幽灵能力；finance.erp.readonly 这类 id 即使带 ok 信号也归 unknown。
 */

export type Reachability = "reachable" | "unreachable" | "unknown";

export type DegradePath = "direct" | "x11+fromVideo" | "unknown";

export type ReachabilitySignalStatus =
  | "reachable"
  | "ok"
  | "unreachable"
  | "error"
  | "timeout"
  | "denied"
  | "unknown";

/** 外部探测结果；本模块只做分级，不负责产生信号。 */
export interface ReachabilitySignal {
  capabilityId?: string;
  capabilityKey?: string;
  status?: ReachabilitySignalStatus | string;
  ok?: boolean;
}

/** 能力描述的最小结构，兼容注册表实体（key/source/manifest）与内存替身。 */
export interface ReachabilityCapability {
  id?: string;
  key?: string;
  hasGui?: boolean;
  manifest?: Record<string, unknown>;
  source?: { type?: string; ref?: string };
}

/** 与方案卡白名单一同口径的真实数据源，幽灵能力一律 fail-closed。 */
export const E2E_DATA_SOURCE_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "browser",
  "gui",
  "filesystem",
]);

/** 幽灵能力样例：判定层必须让它停在 unknown。 */
export const GHOST_CAPABILITY_ID = "finance.erp.readonly";

const UNREACHABLE_STATUSES: ReadonlySet<string> = new Set([
  "unreachable",
  "error",
  "timeout",
  "denied",
]);

const REACHABLE_STATUSES: ReadonlySet<string> = new Set(["reachable", "ok"]);

function signalCapabilityId(signal: ReachabilitySignal): string {
  for (const candidate of [signal.capabilityId, signal.capabilityKey]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function hasGuiCapability(
  capability: ReachabilityCapability | null | undefined,
): boolean {
  if (!capability || typeof capability !== "object") return false;
  if (capability.hasGui === true) return true;

  for (const candidate of [capability.id, capability.key]) {
    if (typeof candidate === "string" && candidate.trim() === "gui")
      return true;
  }

  const manifest = capability.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return false;
  }
  return (
    manifest.gui === true ||
    manifest.driver === "x11" ||
    manifest.mode === "gui" ||
    manifest.capabilityId === "gui"
  );
}

/**
 * 把外部探测信号分成三档。只有真实数据源 + 明确可达证据才返回 reachable；
 * 明确失败证据返回 unreachable；其余（含幽灵能力、缺字段、畸形信号）返回 unknown。
 */
export function classifyReachability(
  signal: ReachabilitySignal | null | undefined,
): Reachability {
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
    return "unknown";
  }

  const capabilityId = signalCapabilityId(signal);
  if (
    capabilityId.length === 0 ||
    !E2E_DATA_SOURCE_CAPABILITY_IDS.has(capabilityId)
  ) {
    return "unknown";
  }

  const status =
    typeof signal.status === "string" ? signal.status.trim().toLowerCase() : "";

  if (UNREACHABLE_STATUSES.has(status) || signal.ok === false) {
    return "unreachable";
  }
  if (REACHABLE_STATUSES.has(status)) {
    return "reachable";
  }
  return "unknown";
}

/**
 * 可达性 → 编排标记：reachable 走 direct；unknown fail-closed；
 * unreachable 且具备 GUI 能力时走 x11+fromVideo（executor-desktop X11 GUI 驱动 +
 * fromVideo 录屏的编排标记，本层只返回标记）。
 */
export function degradePath(
  capability: ReachabilityCapability | null | undefined,
  reachability: Reachability,
): DegradePath {
  if (reachability === "unknown") return "unknown";
  if (reachability === "reachable") return "direct";
  return hasGuiCapability(capability) ? "x11+fromVideo" : "unknown";
}
