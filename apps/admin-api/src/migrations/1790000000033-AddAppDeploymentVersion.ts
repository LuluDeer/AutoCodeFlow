import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * E-P1-R2：app_deployments 增 `version` INTEGER NOT NULL DEFAULT 1 列
 * （@VersionColumn 乐观锁，对照 task_executions / executors 既有范式
 * 1717473142692 / 1717473142693）。
 *
 * 背景：AppDeployment 此前无版本戳，stop/upgrade/回滚等 read-modify-write
 * save 与心跳并发时后写覆盖先写（丢失更新）。加列后 TypeORM save 自动追加
 * `AND version = :expected`，并发后写抛 OptimisticLockVersionMismatchError，
 * service 侧转 409。
 *
 * 列语义：
 * - NOT NULL DEFAULT 1：存量行一次性回填为 1，与新行起始值一致；
 *   @VersionColumn 不允许可空（对照 executors/task_executions 同为 NOT NULL）。
 * - 心跳不经过 save（改走条件 UPDATE），故高频心跳不会 bump version、
 *   不会与用户动作互撞。
 *
 * 幂等：ADD/DROP COLUMN IF [NOT] EXISTS——重放与 revert 均无副作用。
 */
export class AddAppDeploymentVersion1790000000033
  implements MigrationInterface
{
  name = "AddAppDeploymentVersion1790000000033";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_deployments"
      ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_deployments" DROP COLUMN IF EXISTS "version"
    `);
  }
}
