/**
 * R18（2026-11-05）：详情页「实际在跑」展示口径的**唯一换算点**。
 *
 * ## 为什么要有这个纯函数
 *
 * 展示口径是 `实际在跑 = runningTaskCount − reservedSlots`（E-01-RPT：`runningTaskCount` 统计
 * **已占槽位**（含 pull 预留），`reservedSlots` 是其中「已预留但尚未领取」的部分）。
 *
 * R16 之后 `runningTaskCount = max(客户端上报, 服务端在途占坑)` —— 服务端会把计数**抬高**，
 * 而 `reservedSlots` 仍是客户端自述值。两者的写入时机与校验基准不同（采纳时只校验
 * `reservedSlots <= 当时行上的 runningTaskCount`，而 R16 的下限是**写入前**才生效），
 * 于是**落库状态里完全可能出现 `reservedSlots > runningTaskCount`**（R17 事实核查已确认该形态可存在）。
 *
 * 此时直接相减会得到**负数**，界面上出现「-6 个运行中」。故：
 * · `reservedSlots == null`（旧版执行器未上报）⇒ **回落旧口径**（`= occupiedSlots`），行为与引入前一致；
 * · 其余情况 ⇒ `max(occupiedSlots − reservedSlots, 0)`，**下限钳到 0**。
 *
 * ## 边界（刻意）
 *
 * 本函数**只用于展示**：不改任何落库字段，也不参与派发/容量判断（派发闸门只读
 * `runningTaskCount`，见 `apps/admin-api/src/modules/executor/entities/executor.entity.ts:207`）。
 */
export function resolveRunningCount(
  occupiedSlots: number,
  reservedSlots: number | null | undefined,
): number {
  const occupied = Number.isFinite(occupiedSlots) ? Math.max(occupiedSlots, 0) : 0;
  if (reservedSlots === null || reservedSlots === undefined) return occupied;
  const reserved = Number.isFinite(reservedSlots) ? Math.max(reservedSlots, 0) : 0;
  // 下限钳 0：reserved 超过 occupied 属"上报与服务的写入时机错位"，显示 0 而不是负数。
  return Math.max(occupied - reserved, 0);
}

/**
 * 「是否展示预留说明」的判定：只有**合理预留**（`0 < reserved <= occupied`）才解释差额；
 * `reserved > occupied` 是不一致态，此时差额已被钳成 0，再解释会误导。
 */
export function hasMeaningfulReservation(
  occupiedSlots: number,
  reservedSlots: number | null | undefined,
): boolean {
  if (reservedSlots === null || reservedSlots === undefined) return false;
  if (!Number.isFinite(reservedSlots) || reservedSlots <= 0) return false;
  if (!Number.isFinite(occupiedSlots)) return false;
  return reservedSlots <= Math.max(occupiedSlots, 0);
}

/**
 * R59（§7.17 P3）：后端上报的计数**自相矛盾**（`reservedSlots > runningTaskCount`）。
 *
 * ## 为什么需要它
 *
 * `resolveRunningCount` 已经把这个形态钳到 0（不显示负数），但**钳制是无声的**：
 * 卡片上只剩一个安静的 `0`，运维无法区分「这台确实空闲」与「后端两个计数打架」。
 * 前者不需要动作，后者需要查执行器上报/服务端在途占坑链路——把两者显示成同一个
 * 像素，等于把可观测性问题转嫁给用户。故把判据抽成谓词，由 UI 显式提示。
 *
 * ## 语义（与 `resolveRunningCount` 同源，避免"钳了但没提示"的错位）
 *
 * · 归一化完全一致：非有限值 ⇒ 0、负数钳 0；
 * · `reservedSlots` 为 null/undefined（旧版执行器未上报）⇒ **无从判断** ⇒ false；
 * · `reserved === occupied`（全部已占都是预留）是**合法**状态 ⇒ false；
 * · 仅在 `reserved > occupied` 时 true。
 *
 * 本函数**只判真假**：不改任何落库字段，也不参与派发/容量判断（派发闸门只读
 * `runningTaskCount`，见 `apps/admin-api/src/modules/executor/entities/executor.entity.ts:207`）。
 */
export function hasInconsistentMetrics(
  occupiedSlots: number,
  reservedSlots: number | null | undefined,
): boolean {
  if (reservedSlots === null || reservedSlots === undefined) return false;
  // 两侧都必须可判读：非有限值参与比较会得出荒谬结论（NaN 比较恒 false，
  // Infinity 会恒真 ⇒ 常亮告警），故先整体否决。
  if (!Number.isFinite(occupiedSlots) || !Number.isFinite(reservedSlots)) return false;
  const occupied = Math.max(occupiedSlots, 0);
  const reserved = Math.max(reservedSlots, 0);
  return reserved > occupied;
}

/**
 * R62（§7.17 P3 收尾）：列表页「任务数」的显示值与排序键。
 *
 * 列表页此前把 `runningTaskCount` 原始值当「在跑数」显示——那是**已占槽位**
 * （含 E-01 pull 取件预留），与详情页的「实际在跑」是两套口径 ⇒ 同一个执行器
 * 列表显示「1/10」、详情显示「0/10」，运维只能二选一相信。
 *
 * 这两个函数放在 `utils/`（而非组件文件）是为了让**判据与换算只有一个落点**：
 * 表格单元格、卡片、详情页都从这里取数，排序键也用同一个函数（否则会出现
 * 「看着是 0 的行排在 3 的后面」这种自相矛盾的观感）。
 */
export function displayedRunningCount(executor: {
  runningTaskCount?: number | null;
  reservedSlots?: number | null;
}): number {
  return resolveRunningCount(executor.runningTaskCount ?? 0, executor.reservedSlots);
}
