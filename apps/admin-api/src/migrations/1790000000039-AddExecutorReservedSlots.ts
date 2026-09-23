import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * E-01-RPT（生产实证：RPA5 执行器在中台恒显「当前运行任务 1/10」「活性上报
 * 0 条，与运行计数 1 不一致」，而该设备上并无任务在跑）：executors 增
 * `reservedSlots` 可空 int 列——执行器心跳上报的 pull 长轮询**「已预留但尚未
 * 认领」的槽位数**（协议 4，executor-node `scheduler.ts` / executor-python
 * `scheduler.py` 的 `reservedSlots`）。
 *
 * 根因（为什么需要这一列）：E-01 防超卖机制要求 pull 循环在发起 25s 长轮询
 * **之前**先原子预留一个容量槽位（node `pull.ts` 的 `Atomics.add` / python
 * `try_reserve_running_slot`），预留计入**同一个并发账本**，因此
 * `runningTaskCount` 在长轮询窗口内**诚实包含**该预留——这正是「长轮询窗口内
 * 中台不会再往最后一个空槽 push 派发」的实现方式本身。
 *
 * 但 `runningExecutionIds` 来自**另一个账本**（node 的 `liveExecutions` Map /
 * python 的 `_live_executions` 字典），只有真正领取到的执行才有 id。空闲执行器
 * 几乎始终处在长轮询窗口内，于是稳态上报恒为「runningTaskCount=1 +
 * runningExecutionIds=[]」——两个数字都对，却度量了不同的东西：前者是**已占
 * 槽位**，后者是**在跑执行**。中台详情页交叉核对两者，遂恒亮不一致告警。
 *
 * 语义（与 `runningExecutionIds` 同款三态纪律）：
 * - `NULL` = **未上报**（存量旧执行器，协议 < 4）→ UI 回落「按已占槽位显示」的
 *   旧口径，行为与引入前**逐字节一致**（兼容性红线）；
 * - `0` = 已上报且无预留；
 * - `>0` = 有预留中的槽位（单飞保证真值恒 0/1）。
 *
 * **本列只用于展示与告警换算**（实际运行数 = `runningTaskCount` −
 * `reservedSlots`）；派发闸门（`selectLeastLoaded` / 容量守卫）**绝不读本列**，
 * E-01 的防超卖语义逐字节不变。反向修法（用 `runningExecutionIds.length` 覆盖
 * `runningTaskCount`）被明确否决：那会让中台在预留窗口内误判有空槽 → push
 * 派发进已被预留的槽位 → 执行器 accept 返回 429 → 任务被误判永久失败，恰是
 * E-01 要关闭的竞态。
 *
 * 为什么只加可空列、不给默认值：`NULL` 与 `0` 必须可区分——合并两态会让中台
 * 无法判断「该执行器是否上报了本字段」，从而无法决定用新口径还是旧口径，旧
 * 执行器会被静默按新口径（减去 0）解释，虽然结果相同却失去了协议演进的可观测
 * 性（与 AddExecutorDeviceFingerprint / AddExecutorProtocolVersion 同调）。
 *
 * 幂等：ADD COLUMN IF NOT EXISTS（对齐 AddExecutorDeviceFingerprint /
 * AddExecutorProtocolVersion / AddExecutorInterpreters 先例）；
 * down：DROP COLUMN IF EXISTS。
 */
export class AddExecutorReservedSlots1790000000039 implements MigrationInterface {
  name = "AddExecutorReservedSlots1790000000039";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "reservedSlots" INTEGER NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "reservedSlots"`,
    );
  }
}
