import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ADR-030（R14 落地，2026-11-05）：per-executor 令牌的**轮换纪元**列。
 *
 * ## 为什么需要这一列
 *
 * ADR-030 §4 采纳 ②′：令牌**确定性派生**
 * `token = HMAC(K, identityKey ‖ startupEpoch ‖ rotationEpoch)`，轮换 = 用
 * **条件更新**推进 epoch（`WHERE "tokenRotationEpoch" = :epoch`）并写入 `bcrypt(token)`。
 *
 * 这一列正是那个 **CAS 谓词**，也是让「失败方重算出同一枚令牌」成为可能的前提：
 * 两个实例读到同一个 `epoch` ⇒ 派生出的令牌**逐字节相同** ⇒ 后到者不必拿到明文，
 * 用 `bcrypt.compare(自己算的, 库里新 hash)` 命中即可把**同一枚**令牌返回给调用方。
 * 没有这一列，「同输入 ⇒ 同输出」无从谈起（只能回到 ADR-030 §3 方案①的明文缓存）。
 *
 * ## 形状（为什么 `integer NOT NULL DEFAULT 0` 是安全的）
 *
 * · **metadata-only**：PG 11+ 对 `NOT NULL + 常量 DEFAULT` 走 catalog 存储
 *   （`attmissingval`），**不重写堆表**、**零回填** —— 与迁移 1790000000096 同款取舍；
 * · `0` 是正确初值：本列只在 mode=`on` 时被读写（`EXECUTOR_TOKEN_EPOCH_MODE` 默认 `off`），
 *   存量行 epoch=0 恰好表示「从未按纪元轮换过」；旧代码完全不认识该列 ⇒ 灰度期互不干扰；
 * · **不建索引**：唯一查询形态是 `WHERE id = :id AND "tokenRotationEpoch" = :epoch`
 *   （主键已定位到单行，epoch 只是谓词），建索引只付维护成本、零收益。
 *
 * ## 回滚（ADR-030 §5.1）
 *
 * `down()` 直接 `DROP COLUMN`：该列是**纯谓词 + 派生输入**，删掉后代码回到「随机令牌 +
 * 进程内缓存」的 R12 行为 —— 已签发的派生令牌**仍然有效**（库里存的是它的 bcrypt 哈希，
 * 与派生方式无关）⇒ **回滚不打断在跑的执行器**。
 */
export class AddExecutorTokenRotationEpoch1790000000097 implements MigrationInterface {
  name = "AddExecutorTokenRotationEpoch1790000000097";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "tokenRotationEpoch" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "tokenRotationEpoch"`,
    );
  }
}
