/**
 * N23 — Capability generation swap 纯状态机（零 Nest / DB / API 依赖）。
 *
 * 与 N10（impl-n10-part-model）统一口径：
 * - generation 是 opaque string token，不做数值递增比较；
 * - 相等即同代（严格字符串相等）；
 * - 缺失（null / undefined）判旧代，不参与同代比较，也不得被提升为 active；
 * - 作废判据：incoming 与 active 同代 ⇒ swap 作废（no-op）；incoming 陈旧 ⇒ swap 作废。
 *
 * 相位语义：
 * - serving：单代服务，active 对外解析。
 * - staged：两代并存，incoming 已就绪但 active 不变（老代继续服务）。
 * - swapped：原子提交完成，active 已是新一代，retired 保存 swap 前的 active 供回滚。
 *
 * 不变量：任何时刻 resolveCurrent 都返回 active；swap 要么完整提交要么原状态引用不变，
 * 不存在半切换；rollback 精确恢复到 swap 前的 active（引用级）。
 */

/** 不可透明代际令牌：相等即同代；缺失判旧。 */
export type GenerationToken = string;

/** 一代解析快照。generation 缺失时该代判为旧代。 */
export interface GenerationSnapshot<T> {
  readonly generation: GenerationToken | null;
  readonly value: T;
}

/** 状态机相位。 */
export type SwapPhase = "serving" | "staged" | "swapped";

/** 不可变状态：active 始终对外服务，retired 仅 swapped 相位保存 swap 前的 active。 */
export interface SwapState<T> {
  readonly phase: SwapPhase;
  readonly active: GenerationSnapshot<T>;
  readonly incoming: GenerationSnapshot<T> | null;
  readonly retired: GenerationSnapshot<T> | null;
}

/** 缺失即旧代：null / undefined 都判陈旧。 */
export function isStaleGeneration(
  generation: GenerationToken | null | undefined,
): boolean {
  return generation === null || generation === undefined;
}

/** 相等即同代：两边都非陈旧且严格相等才成立。 */
export function sameGeneration(
  left: GenerationToken | null | undefined,
  right: GenerationToken | null | undefined,
): boolean {
  if (isStaleGeneration(left) || isStaleGeneration(right)) return false;
  return left === right;
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value) as Readonly<T>;
}

function snapshot<T>(
  generation: GenerationToken | null,
  value: T,
): GenerationSnapshot<T> {
  return freeze({ generation, value });
}

/** 初始状态：单代服务，无 incoming / retired。 */
export function createSwapState<T>(
  active: GenerationSnapshot<T>,
): SwapState<T> {
  return freeze({
    phase: "serving" as const,
    active: snapshot(active.generation, active.value),
    incoming: null,
    retired: null,
  });
}

/**
 * 放入候选代：active 保持不变（老代继续服务），retired 清空（开启新一轮准备）。
 * 与 active 同代的 incoming 作废，返回原状态引用。
 */
export function stageIncoming<T>(
  state: SwapState<T>,
  incoming: GenerationSnapshot<T>,
): SwapState<T> {
  if (sameGeneration(state.active.generation, incoming.generation))
    return state;
  return freeze({
    phase: "staged" as const,
    active: state.active,
    incoming: snapshot(incoming.generation, incoming.value),
    retired: null,
  });
}

/**
 * 原子 swap：把 incoming 提升为 active，并把 swap 前的 active 存入 retired。
 *
 * 作废（返回原状态引用，不半切换）的条件：
 * - 无 incoming；
 * - incoming 陈旧（generation 缺失）；
 * - incoming 与 active 同代；
 * - validate 返回 false 或抛错（提交点失败 ⇒ 回滚到 swap 前状态）。
 *
 * 成功返回新状态：active === 原 incoming，retired === 原 active，incoming === null。
 */
export function swap<T>(
  state: SwapState<T>,
  validate?: (candidate: GenerationSnapshot<T>) => boolean,
): SwapState<T> {
  const incoming = state.incoming;
  if (incoming === null) return state;
  if (isStaleGeneration(incoming.generation)) return state;
  if (sameGeneration(state.active.generation, incoming.generation))
    return state;
  if (validate !== undefined) {
    let accepted: boolean;
    try {
      accepted = validate(incoming);
    } catch {
      return state;
    }
    if (!accepted) return state;
  }
  return freeze({
    phase: "swapped" as const,
    active: incoming,
    incoming: null,
    retired: state.active,
  });
}

/**
 * 回滚：仅 swapped 相位有效，精确恢复 retired 为 active，清空 retired / incoming。
 * 其余相位返回原状态引用（无可回滚内容）。
 */
export function rollback<T>(state: SwapState<T>): SwapState<T> {
  if (state.phase !== "swapped" || state.retired === null) return state;
  return freeze({
    phase: "serving" as const,
    active: state.retired,
    incoming: null,
    retired: null,
  });
}

/** 对外解析入口：任何相位都只返回 active，两代并存时旧代继续服务。 */
export function resolveCurrent<T>(state: SwapState<T>): GenerationSnapshot<T> {
  return state.active;
}
