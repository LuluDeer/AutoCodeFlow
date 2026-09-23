import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ARCH-36（ADR-017 阶段 2）：executors 增 `deviceFingerprint` 可空列 + 非唯一
 * 索引——执行器 register/heartbeat 上报的**稳定唯一身份**
 * `sha256(deviceId + ":" + installSalt)`（64 位小写十六进制）。
 *
 * 语义（见 `executor.entity.ts` 的列注释与 `executor-fingerprint.util.ts`）：
 * - `NULL` = **未上报**：存量旧执行器（协议 < 3），或新执行器采集失败
 *   （容器无 machine-id、数据目录只读——执行器侧 fail-open 是硬约束）。
 * - 具体值 = 上报并被采纳；字段缺省/非法时**保留 DB 旧值**（不被擦除）。
 *
 * **本迁移不改变任何定位逻辑**：注册仍按 `address` 定位行。该列在阶段 2 只用于
 * 采集与冲突观测；阶段 3 才提升为注册幂等键并把 address 降级为可达性元数据。
 *
 * 为什么只加可空列、不给默认值：合并「未上报」与「上报了某值」两态会让冲突率
 * 与覆盖率两个观测口径同时失去意义（无法区分「旧执行器从未上报」与「新执行器
 * 采集失败」——两者的处置完全不同）。
 *
 * 为什么索引非唯一：阶段 3 会把「`WHERE deviceFingerprint = $1`」变成注册路径
 * 的常规查询，故索引与列同批落盘；但存量行全为 NULL，且过渡期允许「同一安装
 * 短时间内出现两行」（先注册到新 address、旧行由 stale sweep 收敛），此刻加
 * 唯一约束会让迁移直接失败。唯一性留到阶段 3 回填完成后单独加。
 *
 * 幂等：ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS（对齐
 * AddExecutorProtocolVersion / AddExecutorInterpreters 先例）；
 * down：DROP INDEX IF EXISTS + DROP COLUMN IF EXISTS。
 */
export class AddExecutorDeviceFingerprint1790000000038 implements MigrationInterface {
  name = "AddExecutorDeviceFingerprint1790000000038";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "deviceFingerprint" VARCHAR(64) NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_executors_device_fingerprint" ON "executors" ("deviceFingerprint")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_executors_device_fingerprint"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "deviceFingerprint"`,
    );
  }
}
