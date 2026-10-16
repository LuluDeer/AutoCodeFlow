import { MigrationInterface, QueryRunner } from "typeorm";
// ADR-017 阶段 3：legacy 身份键必须与 register 创建路径同形（单一事实源）。
// 先例：1790000000048 迁移导入 common/utils 的 flipDependencyMap。
import { legacyExecutorIdentity } from "../modules/executor/executor-fingerprint.util";

/**
 * ADR-017 阶段 3：把 `deviceFingerprint` 从「可空观测列」提升为**注册/心跳定位键**
 * （迁移 1790000000038 加列 + 非唯一索引是阶段 2 的前置，本迁移是定位切换的数据面）。
 *
 * 四步：
 *
 * 1. **加宽列** `VARCHAR(64) → VARCHAR(80)`：legacy 兜底键的超长形态
 *    `legacy-h:` + sha256(address)（73 字符）需要 > 64。常规形态
 *    `legacy:{address}` 在地址长度 ≤ 73 时恰好装得下 80（address 74 字符起
 *    走 hash 形态）——IPv4 `ip:port` 约 21 字符，常规主机名远在界内。
 *
 * 2. **回填 NULL → legacy 身份键**：未上报指纹的存量执行器（协议 < 3）不因缺
 *    指纹被拒，行身份用 `legacyExecutorIdentity(address)` 兜底（与 register
 *    创建路径同形）。NULL 从此只在迁移前存在。
 *
 * 3. **SET NOT NULL**：此后每行都有身份键（真实指纹或 legacy 键），
 *    `WHERE deviceFingerprint = $1` 成为 register/heartbeat 的常规定位查询。
 *
 * 4. **`address` 唯一性收窄为 push 模式行**（ADR-017 §5）：
 *    `DROP uq_executors_address` → `CREATE UNIQUE INDEX ... WHERE dispatchMode = 'push'`。
 *    pull 执行器零入站、`address` 只是自报标签——两家不同内网的同网段同 IP
 *    必须允许各自成行（各自独立的历史/部署）。push 行仍强制唯一（否则无法路由），
 *    冲突由 register 的 409 姿态处置（ADR-017 §4）。
 *
 * ## 幂等性与事务范围（如实记录，勿轻信"全部幂等"）
 *
 * - **up 可重跑**：四步都是幂等的（加宽列在 PG 里同类型为 no-op；回填带
 *   `IS NULL` 谓词；SET NOT NULL 重跑 no-op；DROP IF EXISTS + CREATE IF NOT
 *   EXISTS）。
 * - **up 不是"无条件成功"**：第 4 步的 CREATE UNIQUE INDEX 在「表内已有重复
 *   address」时会失败——本迁移**先探测并在有重复时抛可读错误**（防运维现场里
 *   全局唯一早已被手工卸掉）。
 * - **事务**：本迁移**未**关闭事务（未声明 TypeORM 的 `transaction` 覆盖），故按
 *   `data-source.ts` 的 `migrationsTransactionMode: "each"` 把整个 up 包在一个
 *   事务里 → 失败即整体回滚，**不存在"跑到一半"的中间态**。这也是这里不用
 *   `CREATE INDEX CONCURRENTLY` 的原因（CONCURRENTLY 不能在事务块内执行）。
 * - **本表小**（executors 是机队规模，非 task_executions 那种高频大表），故
 *   `ALTER COLUMN TYPE` 的表重写持锁可接受，不需要 1790000000051/0053 那套
 *   关事务 + CONCURRENTLY 的大表纪律。
 *
 * down：逆序回收。**down 的失败姿态已如实写明在方法内**——若迁移后已产生
 * 「同地址并存的多条 pull 行」，全局唯一索引重建会失败，且失败后表上**没有任何
 * address 唯一性**（不可自愈）。回滚前必须先收敛并存行。
 */
export class AddExecutorDeviceFingerprintIdentity1790000000054 implements MigrationInterface {
  name = "AddExecutorDeviceFingerprintIdentity1790000000054";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 前置：把 `uq_executors_address` 从「索引或唯一约束」两种形态都能卸掉。
    // 见下方 dropAddressUniqueIndex 的注释（PG 的 DROP INDEX 卸不掉约束）。
    // 4) address 唯一性收窄为 push 模式行（ADR-017 §5）。
    await this.dropAddressUniqueIndex(queryRunner);
    // 1) 加宽列。
    await queryRunner.query(
      `ALTER TABLE "executors" ALTER COLUMN "deviceFingerprint" TYPE VARCHAR(80)`,
    );
    // 2) 回填 NULL → legacy 身份键（逐行，与 legacyExecutorIdentity 同形）。
    //    WHERE 谓词保证重跑幂等（第二次选 0 行）。
    const nullRows: Array<{ id: string; address: string }> =
      await queryRunner.query(
        `SELECT "id", "address" FROM "executors" WHERE "deviceFingerprint" IS NULL`,
      );
    for (const row of nullRows) {
      await queryRunner.query(
        `UPDATE "executors" SET "deviceFingerprint" = $1 WHERE "id" = $2`,
        [legacyExecutorIdentity(row.address), row.id],
      );
    }
    // 3) NOT NULL（重跑为 no-op）。
    await queryRunner.query(
      `ALTER TABLE "executors" ALTER COLUMN "deviceFingerprint" SET NOT NULL`,
    );
    // 4) 重建为 partial 唯一（仅 push 行）。此时全局唯一刚被卸掉、表内不可能
    //    存在重复 address（旧约束在整个历史里一直生效），故无需去重前置；
    //    但为防「约束曾被手工卸掉」的运维现场，这里仍显式**先探测**重复并在
    //    存在时给出可读错误（而不是让 CREATE UNIQUE INDEX 抛一句泛泛的
    //    "could not create unique index"）。
    const dupes: Array<{ address: string }> = await queryRunner.query(
      `SELECT "address" FROM "executors" GROUP BY "address" HAVING COUNT(*) > 1 LIMIT 5`,
    );
    if (dupes.length > 0) {
      throw new Error(
        `无法将 uq_executors_address 收窄为仅 push 模式：executors 表中已存在 ${dupes.length}+ ` +
          `个重复的 address 值` +
          `（例如 ${dupes.map((d) => d.address).join(", ")}）。这说明本次迁移前 ` +
          `全局唯一索引缺失 —— 请在重新执行前解决这些` +
          `重复项（为每台机器指定唯一的 EXECUTOR_ADDRESS_PUBLIC，或` +
          `合并这些行）。`,
      );
    }
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_executors_address" ON "executors" ("address") WHERE "dispatchMode" = 'push'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 4') 地址唯一恢复全局。
    //
    // **预期失败，且失败后表上没有任何 address 唯一性**（如实记录，不粉饰）：
    // up 明确允许 pull 同址多行并存（ADR-017 §5），若迁移后确实产生了并存行，
    // 这条 CREATE UNIQUE INDEX 必然失败。此时 DROP INDEX 已执行 → 表上既没有
    // partial 也没有全局唯一约束，**中间态是"零 address 唯一性"**。且重跑
    // down 会因 `DROP INDEX IF EXISTS` 空转而再次失败——即该失败**不可自愈**。
    //
    // 处置：回滚前先收敛并存 pull 行（给每台配唯一 EXECUTOR_ADDRESS_PUBLIC 或
    // 合并行），或在失败后用 partial 索引临时顶住（CREATE UNIQUE INDEX … WHERE
    // dispatchMode='push'）。这是刻意的姿态：让"回滚不安全"可见并阻断，而不是
    // 静默丢掉约束。
    await this.dropAddressUniqueIndex(queryRunner);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_executors_address" ON "executors" ("address")`,
    );
    // 3') DROP NOT NULL。
    await queryRunner.query(
      `ALTER TABLE "executors" ALTER COLUMN "deviceFingerprint" DROP NOT NULL`,
    );
    // 2') 清除 legacy 身份键（真实指纹保留——它们在迁移前就存在）。
    //    `LIKE 'legacy%'` 对真实指纹零误伤：真实指纹是 `^[0-9a-f]{64}$`
    //    （FINGERPRINT_RE），'l' 不是十六进制字符，故永不匹配。模式是常量、
    //    无插值，不存在 LIKE 元字符注入。
    await queryRunner.query(
      `UPDATE "executors" SET "deviceFingerprint" = NULL WHERE "deviceFingerprint" LIKE 'legacy%'`,
    );
    // 1') 列宽还原。
    await queryRunner.query(
      `ALTER TABLE "executors" ALTER COLUMN "deviceFingerprint" TYPE VARCHAR(64)`,
    );
  }

  /**
   * 卸掉 `uq_executors_address`——**两种形态都要覆盖**。
   *
   * `DROP INDEX` 卸不掉「唯一**约束**」：若该名字在某个环境里是以
   * `ALTER TABLE … ADD CONSTRAINT uq_executors_address UNIQUE (address)` 落下的，
   * PG 会报 `cannot drop index ... because constraint ... requires it`，整个迁移
   * 硬失败。今天它是 `CREATE UNIQUE INDEX`（1717473142691），故 DROP INDEX 可用；
   * 但 `synchronize` 曾开过的环境/手工运维现场可能落成约束形态，这里显式兜底。
   *
   * 顺序：先按约束卸（`DROP CONSTRAINT IF EXISTS`），再按索引卸
   * （`DROP INDEX IF EXISTS`）——两者都幂等，且对已不存在的对象是 no-op。
   */
  private async dropAddressUniqueIndex(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" DROP CONSTRAINT IF EXISTS "uq_executors_address"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_executors_address"`);
  }
}
