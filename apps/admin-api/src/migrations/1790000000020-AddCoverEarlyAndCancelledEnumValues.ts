import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PK-01（DEEP_REVIEW 0ef3bbe）：PG enum 值域与 TS 枚举对齐补值。
 *
 * 背景：
 * - InitialSchema（1717473142678）建 `task_blockstrategy_enum` 时值域仅
 *   ('serial','discard')，而 TS 枚举 `BlockStrategy` 此后新增
 *   COVER_EARLY = "cover_early"（task.entity.ts）——DTO 接受 cover_early，
 *   调度重叠命中时 SchedulerService 会以 `cancelled` 条件更新
 *   task_executions.status，而 `execution_status_enum` 同样缺该值；
 * - 迁移构建库上命中即 PG 22P02（invalid input value for enum）→ 500。
 *
 * 语义：`ADD VALUE IF NOT EXISTS` 幂等。PG ≥12 允许在事务内 ADD VALUE，
 * 且本迁移不使用新增值（同事务使用新值才受限），无额外事务约束。
 * down：PG 不支持从 enum 类型删除值，按仓内不可逆迁移惯例（参考
 * EnsureSystemConfigValueText）写 no-op——保留的值域是超集，无副作用。
 */
export class AddCoverEarlyAndCancelledEnumValues1790000000020 implements MigrationInterface {
  name = "AddCoverEarlyAndCancelledEnumValues1790000000020";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "task_blockstrategy_enum" ADD VALUE IF NOT EXISTS 'cover_early'`,
    );
    await queryRunner.query(
      `ALTER TYPE "execution_status_enum" ADD VALUE IF NOT EXISTS 'cancelled'`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PG 无法删除 enum 值；值域保持补齐后的超集即可，无需操作。
  }
}
