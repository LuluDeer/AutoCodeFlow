import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * TASKCORE-STATUS-01：把 `tasks.status` 的 DB 层默认值对齐 API 缺省口径。
 *
 * create 链路已在服务层显式写 `dto.status ?? PAUSED`，因此本迁移只改默认值，
 * **不回填任何存量行**：现有任务的状态是既成事实，批量改状态会破坏运行中/
 * 已暂停任务的语义。迁移只影响未来绕过服务层、依赖列默认值的 INSERT。
 *
 * `ALTER COLUMN SET DEFAULT` 在 PG 是 catalog-only 操作，无表重写、无长锁，
 * 因此不需要 CONCURRENTLY，也不需要 statement_timeout 豁免。
 */
export class AlterTaskStatusDefaultPaused1790000000110 implements MigrationInterface {
  name = "AlterTaskStatusDefaultPaused1790000000110";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'paused'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'active'`,
    );
  }
}
