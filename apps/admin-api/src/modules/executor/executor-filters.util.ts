import type { Executor } from "./entities/executor.entity";

/**
 * 派发候选过滤链（**单一事实源**）——三条派发路径共用同一份维度与语义。
 *
 * ## 为什么必须共用一份
 *
 * 本仓有**三条**「从在线执行器里挑候选」的路径，它们各自的过滤链是**分别
 * 手写**的：
 *
 *   ① `dispatch()`            —— 单机派发（`executor.service.ts`）
 *   ② `dispatchBroadcast()`   —— 广播派发（同上）
 *   ③ `selectLeastLoaded()`   —— 部署选机（`app-deployment.service.ts` 调用）
 *
 * 而它们过滤的维度是**同一组**：`group` / `tags`（AND 子集）/ `affinity`（OR）/
 * `anti-affinity`（排除）/ `runtime`（capabilities）/ `interpreter`（版本）。
 *
 * **分叉已经发生**（本轮审计实测）：`selectLeastLoaded()` 只实现了
 * `group` / `tags` / `runtime` 三维，**缺 affinity 与 anti-affinity** ⇒
 * 同一条「要求亲和到 X 标签」的部署选机请求，会被派发路径正确排除、
 * 却被选机路径放行。这是**同一语义的两种实现**，其中一份是错的。
 *
 * 更麻烦的是这种分叉**不会报错**：两处都自洽、都有测试覆盖，只是覆盖的
 * 维度不同 ⇒ 缺陷能长期存活，直到某天有人在选机路径上加了 affinity 才发现
 * 两边行为不一致。
 *
 * ## 为什么 `selectLeastLoaded` 补齐 affinity 是**行为变更**、需要开关
 *
 * 补齐后，部署选机会开始**排除**不满足 affinity 的执行器 ⇒ 可能选到与
 * 原来不同的机器。这是**语义变更**，不是 bugfix。
 *
 * 本仓的既有纪律（`packages/executor-protocol/protocol.json` 的 `envForward`
 * 段）是「**只登记现状，不扩面**」；反过来，**行为变更必须显式**——
 * 故本模块用 `applyAffinityFilters` 开关控制，默认**关闭**（保持现状），
 * 由调用方（`ExecutorService`）从系统配置读取。
 *
 * ## 为什么这里是**纯函数**
 *
 * 过滤链不碰 DB、不发 HTTP、不读时钟 ⇒ 可以表驱动地穷举维度组合做单测，
 * 且**两侧（派发 / 选机）调用的是同一段代码**，不可能再分叉。
 *
 * ⚠️ 但解释器维度**不在**本模块：它需要 `interpreterSatisfies` /
 * `isOnlineDownloadable` / `buildInterpreterMismatchMessage` 三个语义更重的
 * 判定（且 online-downloadable 时**不拦**），放进来会让本 util 背上解释器
 * 契约的全部知识。解释器过滤留在 `ExecutorService.applyInterpreterFilter`
 * （已由三条路径共用），本模块只管**标签/分组/运行时**这几个同构维度。
 */

/** 过滤条件的输入（与三条路径各自的入参形状解耦）。 */
export interface ExecutorFilterCriteria {
  /** 分组名（点名为**等值**匹配）。 */
  group?: string | null;
  /** 必需标签：**AND 子集**语义（执行器须持有全部）。 */
  tags?: string[] | null;
  /** 亲和标签：**OR** 语义（执行器持有**任一**即合格）。 */
  affinityTags?: string[] | null;
  /** 反亲和标签：**排除**语义（持有**任一**即淘汰）。 */
  antiAffinityTags?: string[] | null;
  /** 运行时（匹配 `capabilities`；空 capabilities = 万能）。 */
  runtime?: string | null;
}

/** 过滤链的调用场景（决定哪些维度参与）。 */
export type ExecutorFilterMode =
  /** 单机派发：`dispatch()`。 */
  | "dispatch"
  /** 广播派发：`dispatchBroadcast()`。 */
  | "broadcast"
  /** 部署选机：`selectLeastLoaded()`。 */
  | "selection";

/**
 * 亲和/反亲和维度是否参与过滤。
 *
 * ## 为什么要它独立成开关
 *
 * `dispatch()` / `dispatchBroadcast()` 自从引入 affinity（NF-04）起就一直
 * 实施该维度；而 `selectLeastLoaded()` **从来没有**实施过。补齐它 = **行为
 * 变更**（部署选机可能选到不同的机器）。
 *
 * 本仓纪律：行为变更必须**显式且可回退**。故默认 `false`（= 保持选机路径现状），
 * 由运维通过系统配置开启，灰度观察后再固化。
 *
 * ⚠️ 注意：把开关置 `false` 时，**派发路径也不实施**亲和过滤——这与现状
 * 不同（现状派发路径**是**实施的）！
 *
 * → 故本开关的语义必须严格区分「两条路径的差异」与「全局开关」：
 *   · `dispatch` / `broadcast`：**恒实施**亲和过滤（与现状逐字一致）。
 *   · `selection`：**仅当开关开启时**实施（默认关闭 = 保持现状）。
 *
 * 见 `applyAffinityFilters` 的实现——它按 mode 决定，而不是按一个全局布尔。
 */

/**
 * 按标签集合判定「执行器持有全部必需标签」（AND 子集）。
 *
 * ⚠️ **空标签的执行器不满足任何非空必需集**（`!e.tags ⇒ false`）——
 * 这与派发路径的既有语义一致（`executor.service.ts` 的 2.2）。
 */
export function hasAllRequiredTags(
  executor: Pick<Executor, "tags">,
  required: string[] | null | undefined,
): boolean {
  if (!required || required.length === 0) return true;
  if (!executor.tags) return false;
  return required.every((tag) => executor.tags!.includes(tag));
}

/**
 * 按标签集合判定「执行器持有任一亲和标签」（OR 语义）。
 *
 * ⚠️ 空标签的执行器**不满足**亲和（`!e.tags ⇒ false`）——与派发路径的
 * 既有语义一致（`executor.service.ts` 的 2.2b）。
 */
export function hasAnyAffinityTag(
  executor: Pick<Executor, "tags">,
  affinity: string[] | null | undefined,
): boolean {
  if (!affinity || affinity.length === 0) return true;
  if (!executor.tags) return false;
  return affinity.some((tag) => executor.tags!.includes(tag));
}

/**
 * 按标签集合判定「执行器未持有任何反亲和标签」（排除语义）。
 *
 * ⚠️ 空标签的执行器**通过**（`!e.tags ⇒ true`）——执行器没有标签就无从
 * 违反反亲和约束。与派发路径的既有语义一致（`executor.service.ts` 的 2.2b）。
 */
export function hasNoAntiAffinityTag(
  executor: Pick<Executor, "tags">,
  antiAffinity: string[] | null | undefined,
): boolean {
  if (!antiAffinity || antiAffinity.length === 0) return true;
  if (!executor.tags) return true;
  return !antiAffinity.some((tag) => executor.tags!.includes(tag));
}

/**
 * 按 `capabilities` 判定运行时兼容性。
 *
 * ⚠️ **空 capabilities = 万能**（放行）——与派发路径的既有语义一致
 * （`executor.service.ts` 的 2.3）。
 */
export function satisfiesRuntime(
  executor: Pick<Executor, "capabilities">,
  runtime: string | null | undefined,
): boolean {
  if (!runtime) return true;
  if (!executor.capabilities || executor.capabilities.length === 0) {
    return true;
  }
  return executor.capabilities.includes(runtime);
}

/**
 * 应用**亲和 / 反亲和**维度（按 mode 决定是否参与）。
 *
 * @param candidates 候选集
 * @param criteria 过滤条件
 * @param mode 调用场景
 * @param options.affinityEnabled 选机路径是否实施亲和过滤（默认 false）。
 *
 *   ⚠️ D-2（2026-11-03）：此前它由 env 开关 `EXECUTOR_SELECTION_AFFINITY_ENABLED`
 *   驱动，而那个开关被独立验收判定为**空转**并已删除（选机路径的入参至今不含
 *   affinity 字段、生产调用方是零参数调用 ⇒ `hasAffinityDim` 恒 false ⇒
 *   开与不开行为完全相同）。
 *   **本形参保留**——它是**纯函数的入参**（不是全局配置），
 *   供「选机入参接入 affinity」时由调用方显式传入；
 *   在那之前，选机路径恒为 false（= 现状），派发/广播路径恒为 true。
 */
export function applyAffinityFilters<T extends Pick<Executor, "tags">>(
  candidates: T[],
  criteria: ExecutorFilterCriteria,
  mode: ExecutorFilterMode,
  options?: { affinityEnabled?: boolean },
): T[] {
  const affinity = criteria.affinityTags ?? [];
  const antiAffinity = criteria.antiAffinityTags ?? [];
  const hasAffinityDim = affinity.length > 0 || antiAffinity.length > 0;

  if (!hasAffinityDim) return candidates;

  // 派发/广播：**恒实施**（与引入 affinity 时的既有语义逐字一致）。
  // 选机：**仅当开关开启**才实施（默认关闭 = 保持现状，避免静默行为变更）。
  const enabled =
    mode === "selection" ? (options?.affinityEnabled ?? false) : true;
  if (!enabled) return candidates;

  return candidates.filter((e) => {
    if (!hasAnyAffinityTag(e, affinity)) return false;
    if (!hasNoAntiAffinityTag(e, antiAffinity)) return false;
    return true;
  });
}

/**
 * 应用**标签/分组/运行时**维度（全部路径一致）。
 *
 * @param candidates 候选集
 * @param criteria 过滤条件
 */
export function applyBasicFilters<
  T extends Pick<Executor, "groupName" | "tags" | "capabilities">,
>(candidates: T[], criteria: ExecutorFilterCriteria): T[] {
  let filtered = candidates;

  if (criteria.group) {
    filtered = filtered.filter((e) => e.groupName === criteria.group);
  }
  if (criteria.tags && criteria.tags.length > 0) {
    filtered = filtered.filter((e) => hasAllRequiredTags(e, criteria.tags));
  }
  if (criteria.runtime) {
    filtered = filtered.filter((e) => satisfiesRuntime(e, criteria.runtime));
  }

  return filtered;
}

/**
 * **完整过滤链**（标签/分组/运行时 + 亲和/反亲和）。
 *
 * 过滤**顺序**是规格的一部分（与派发路径的既有顺序一致）：
 * `group` → `tags`（AND）→ `affinity`（OR）→ `anti-affinity`（排除）→
 * `runtime`。
 *
 * ⚠️ 顺序对**结果**无影响（各维度独立、与维度间不交叉），但对**决策日志的
 * 可读性**有影响（逐维度过滤计数按此顺序呈现），故固化。
 */
export function filterExecutorCandidates<
  T extends Pick<Executor, "groupName" | "tags" | "capabilities">,
>(
  candidates: T[],
  criteria: ExecutorFilterCriteria,
  mode: ExecutorFilterMode,
  options?: { affinityEnabled?: boolean },
): T[] {
  const filtered = applyBasicFilters(candidates, criteria);
  return applyAffinityFilters(filtered, criteria, mode, options);
}
