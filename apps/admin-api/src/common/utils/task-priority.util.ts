/**
 * A4（第三轮审计·高）：BullMQ 任务优先级方向换算。
 *
 * 语义背景——两套「优先级」数值方向相反：
 * - DB/UI 语义（task.entity.ts `TaskPriority`）：数值越大越紧急——
 *   LOW=1 < NORMAL=2 < HIGH=3 < CRITICAL=4（UI 上 4 = 紧急）。
 * - BullMQ 语义：job 的 `priority` 选项数值**越小越先出队**（1 = 最高）。
 *
 * 此前入队把 DB 原值（1..4）直接传给 BullMQ，方向恰好倒置：CRITICAL(4)
 * 在队列里排最后、LOW(1) 排最前——紧急任务反而被低优任务压后（优先级越
 * 高越慢）。本函数在入队边界把「DB 优先级」换算为「BullMQ 出队优先级」：
 *
 *   toBullPriority(dbPriority) = 5 - dbPriority
 *   DB CRITICAL(4) → BullMQ 1（最先出队）；DB LOW(1) → BullMQ 4（最后出队）；
 *   DB NORMAL(2) → BullMQ 3。
 *
 * 入参约定：调用方必须先经 `normalizeTaskPriority`（task.entity.ts）把 PG
 * 字符串枚举/垃圾值归一化为 1..4 整数——label 解析与回退是归一化层的职责，
 * 本函数不重复。这里仅保留最后一道数值防线（非有限值回 NORMAL、越界钳制），
 * 保证任何调用形态下都不会把 0/负数/NaN/小数交给 BullMQ（其 lua 校验会以
 * "Priority should not be float" 拒绝整个入队命令）。
 */
export function toBullPriority(priority: number): number {
  // NaN/Infinity 兜底回 NORMAL(2)；其余四舍五入到整数再钳制到 1..4。
  const normalized = Number.isFinite(priority) ? Math.round(priority) : 2;
  const clamped = Math.min(4, Math.max(1, normalized));
  return 5 - clamped;
}
