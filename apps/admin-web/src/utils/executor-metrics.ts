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
