import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R122（ADR-038 方案 B）：给**广播占坑**一个独立计数列，把两种语义分开。
 *
 * ## 为什么需要这一列（ADR-038 §1.2）
 *
 * 同一列 `executors.runningTaskCount` 上目前挂着两个**方向相反**的语义：
 *   · 单播占坑（`executor-dispatch-slot.collaborator.ts:101-119`）：每个 `+1` 之前执行行已提交
 *     ⇒ ADR-037 的心跳下限按「非终态行数」取大、且**不许改小**；
 *   · 广播占坑（`executor.service.ts:6034`）：对每个接单执行器 `+1`，但**只有一行**执行记录
 *     （`executorAddress` 只能落一个地址，同文件 `:5852-5855`）⇒ 未持行的目标 `计数1/行数0`
 *     ⇒ 心跳按行数算下限时**看不见**它、会把它抹掉；而 `:6020-6026` 的既有注释又**依赖**
 *     「执行器心跳 30s 覆写」来纠正广播少计 ⇒ 两条规则在广播目标上互相抵消 ⇒ **容量少计**。
 *
 * 本列把广播占坑从 `runningTaskCount` 里**搬出来**：容量判定改为两列之和，
 * 心跳下限继续只管单播列 ⇒ 两条规则都成立、互不覆盖（ADR-038 §2.2）。
 *
 * ## 形状（为什么可空 + 默认 0）
 *
 * `integer NULL DEFAULT 0` ⇒ PG 11+ **catalog-only**（不重写表、**零回填**）；
 * 存量行为 `0`（今天没有广播占坑的记账），与引入本列前**逐字节一致**。
 * 语义：`null` 与 `0` 等价（旧行 / 无广播占坑），读取侧一律按 `?? 0` 处理。
 *
 * ## 不建索引
 *
 * 唯一访问形态是按主键 `WHERE id = :id` 读单行（容量判定已有主键/唯一入口），
 * 不需要额外索引；加索引只会给心跳这条高频写面增加维护成本。
 *
 * ## 回滚
 *
 * `down()` = `DROP COLUMN IF EXISTS`。回滚**不需要数据修补**：本列的值可由
 * 「该机在途广播执行数」重建，最坏从 0 重新累计 ⇒ 短时**少派单**（安全方向），**不会超卖**。
 */
export class AddBroadcastReservedCount1790000000098 implements MigrationInterface {
  name = "AddBroadcastReservedCount1790000000098";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ① 载体列：可空 + 默认 0 ⇒ metadata-only、存量零回填。
    await queryRunner.query(`
      ALTER TABLE "executors"
        ADD COLUMN IF NOT EXISTS "broadcastReservedCount" INTEGER NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors"
        DROP COLUMN IF EXISTS "broadcastReservedCount"
    `);
  }
}
