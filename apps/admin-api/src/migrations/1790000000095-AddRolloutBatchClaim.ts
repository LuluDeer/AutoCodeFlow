import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R1 阶段 1 · 1-B（重做版）：关闭**灰度批次创建**的 TOCTOU 窗口。
 *
 * ## 缺陷（Round 1 审计 P-7 / S-7，存量）
 *
 * `upgradeAllWithRollout`（canary 分支）判「同一应用是否已有在途灰度」是**读后判**：
 *   ① `findInFlightRolloutRows(appId)` 读 `rolloutState IN ('pending','probing')`；
 *   ② 未命中则继续；③ **然后才** `markRolloutState(PENDING)` + 逐台 `upgrade()`。
 * ②与③之间**无原子占坑** ⇒ 两实例可同时通过检查 ⇒ 都建批次 ⇒ 后者覆盖前者的
 * `rolloutMeta.batchId` ⇒ 两批次各自对全部 canary 行调 upgrade ⇒ 同一行被两次 upgrade。
 * `claimRolloutRows` 只在**失败终结**时用，批次**创建**没有对应 claim。
 *
 * ## 为什么**不能**在 `rolloutState` 列上做应用级唯一（已否决方案，勿重犯）
 *
 * 曾实现的方案是 `UNIQUE ("applicationId") WHERE "rolloutState" IN ('pending','probing')`。
 * 它与「一批多行」**结构性冲突**：canary 首批台数 `canaryBatchSize(N, pct) = ceil(N×pct/100)`
 * （`dto/rollout.dto.ts`，默认 pct=50）⇒ N=10 时**5 行同时置 pending**，而唯一索引
 * 在这 5 行上要求 applicationId 各不相同 ⇒ **第 2 行必然 23505** ⇒ 多机灰度全线失效；
 * 且第 1 行已落 pending、无人回滚 ⇒ `findInFlightRolloutRows` 恒命中 ⇒ 该应用**后续
 * 所有灰度永久阻塞**。
 * 同样不可行的是 `UNIQUE ("applicationId", "batchId")`：一个批次的 5 行**共享同一个
 * `batchId`** ⇒ 第 2 行照样撞 23505；且 `batchId` 是 `rollout-${Date.now()}-${rand}`
 * **随机**生成，两实例各建批次会得到**不同** batchId ⇒ 该唯一键**根本挡不住**它想挡的场景
 * （既误伤多行、又不生效）。
 *
 * ## 本方案的载体：**claim 标记列**（每批次恰好一行携带）
 *
 * 新增可空列 `rolloutBatchClaimId`，**只写在 owner 行**（`canaryRows[0]`）上，其余
 * canary 行保持 NULL。于是：
 *   · 部分唯一索引 `UNIQUE ("applicationId") WHERE "rolloutBatchClaimId" IS NOT NULL`
 *     约束的是「**携带 claim 的行**」——每个应用至多一个 ⇒ 产品约束（一个应用同时只有
 *     一个在途灰度批次）的真正载体；
 *   · 同一批次的其他 canary 行 claim 为 NULL，**完全不参与**该索引 ⇒ 多行 canary 合法；
 *   · 两实例抢**不同** owner 行：第二个 UPDATE 把第 2 行 claim 置非空后，表里出现两行
 *     `(applicationId=X, claim IS NOT NULL)` ⇒ **必然 23505**。⚠️ 唯一索引在 **UPDATE**
 *     时同样做冲突检查，「不是 INSERT 就不冲突」是错的——这正是本方案能成立的关键，
 *     也是有别于「只靠 CAS」的地方：**DB 约束是结构底线**。
 *   · 两实例抢**同一** owner 行：走 service 的 CAS（`WHERE claim IS NULL`），
 *     `affected=0` 干净落败，不产生异常噪声。CAS 是**快路径**，不是唯一防线。
 *
 * ## 为什么列可空、且**不做存量回填**
 *
 * claim 是「此刻是否有一个批次在推进」的瞬时事实，不是行的固有属性。存量行全部
 * `NULL`（= 没有批次在推进）**语义天然正确**，故：
 *   · `ALTER TABLE ... ADD COLUMN` 为 metadata-only（无 DEFAULT、零回填）；
 *   · 建索引时存量**无需去重**——部分索引的谓词只匹配非 NULL，全 NULL 即零参与。
 *   · **若**库中曾被人工写入双 claim（本方案上线前不可能出现），`CREATE UNIQUE INDEX`
 *     会失败并中断迁移，需人工介入清理解后重跑。这是有意的 fail-closed：宁可迁移
 *     失败，也不静默丢一条真实在途批次。
 *
 * ## 崩溃窗口
 *
 * claim 的释放由 service 侧的**终结事件驱动** + `markInterruptedRolloutsFailed`
 * 覆盖扫描兜底；本迁移只负责让「同时两个批次」在结构上不可能。
 *
 * ## 幂等
 *
 * `ADD COLUMN IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` /
 * `DROP ... IF EXISTS` ⇒ 重放无副作用。**不用 CONCURRENTLY**：`app_deployments`
 * 是每应用几十行的表（历史部署行），非执行记录那种百万级表；且 CONCURRENTLY 不能在
 * 迁移事务里跑。同表既有 `uq_app_deployments_application_in_flight`（1789000000000）
 * 即先例。
 */
export class AddRolloutBatchClaim1790000000095 implements MigrationInterface {
  name = "AddRolloutBatchClaim1790000000095";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ① 载体列：可空、无默认 ⇒ metadata-only，存量零回填。
    await queryRunner.query(`
      ALTER TABLE "app_deployments"
        ADD COLUMN IF NOT EXISTS "rolloutBatchClaimId" VARCHAR NULL
    `);

    // ② 结构底线：**携带 claim 的行**在 applicationId 上唯一。
    //    谓词把不携带 claim 的行（含全部 canary 非 owner 行、全部存量行）排除在
    //    唯一性判定之外 ⇒ 多行 canary 不受任何约束。
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_deployments_rollout_claim"
      ON "app_deployments" ("applicationId")
      WHERE "rolloutBatchClaimId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_app_deployments_rollout_claim"
    `);
    await queryRunner.query(`
      ALTER TABLE "app_deployments"
        DROP COLUMN IF EXISTS "rolloutBatchClaimId"
    `);
  }
}
