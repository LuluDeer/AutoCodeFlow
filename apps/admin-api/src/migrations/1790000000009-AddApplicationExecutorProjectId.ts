import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AUTH-01（多租户 Project，第一批后端）：applications / executors /
 * executor_packages 三表加 projectId 可空列 + FK + 索引。
 *
 * 与 tasks（迁移 1790000000008）的差异：三表**不回填**——用户已拍板
 * 「可空 = 未分配，归默认项目视图」：applications/executors 是平台级资源
 * （应用与执行器舰队先于项目存在），存量行保持 NULL，由列表过滤面的
 * `IS NULL OR projectId = 默认` 归入默认项目视图（application.service.findAll
 * 与后续执行器侧消费）。FK ON DELETE SET NULL：项目删除后资源不连带消失。
 *
 * 幂等：ADD COLUMN IF NOT EXISTS + pg_constraint 存在性探测 +
 * CREATE INDEX IF NOT EXISTS；down 对称 DROP。
 */
export class AddApplicationExecutorProjectId1790000000009 implements MigrationInterface {
  name = "AddApplicationExecutorProjectId1790000000009";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // applications
    await queryRunner.query(`
      ALTER TABLE "applications"
      ADD COLUMN IF NOT EXISTS "projectId" uuid NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_applications_project'
        ) THEN
          ALTER TABLE "applications" ADD CONSTRAINT "FK_applications_project"
          FOREIGN KEY ("projectId") REFERENCES "projects"("id")
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_applications_project_id"
      ON "applications" ("projectId")
    `);

    // executors
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "projectId" uuid NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_executors_project'
        ) THEN
          ALTER TABLE "executors" ADD CONSTRAINT "FK_executors_project"
          FOREIGN KEY ("projectId") REFERENCES "projects"("id")
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_executors_project_id"
      ON "executors" ("projectId")
    `);

    // executor_packages
    await queryRunner.query(`
      ALTER TABLE "executor_packages"
      ADD COLUMN IF NOT EXISTS "projectId" uuid NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_executor_packages_project'
        ) THEN
          ALTER TABLE "executor_packages"
          ADD CONSTRAINT "FK_executor_packages_project"
          FOREIGN KEY ("projectId") REFERENCES "projects"("id")
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_executor_packages_project_id"
      ON "executor_packages" ("projectId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_executor_packages_project_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "executor_packages"
      DROP CONSTRAINT IF EXISTS "FK_executor_packages_project"
    `);
    await queryRunner.query(`
      ALTER TABLE "executor_packages" DROP COLUMN IF EXISTS "projectId"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_executors_project_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "executors" DROP CONSTRAINT IF EXISTS "FK_executors_project"
    `);
    await queryRunner.query(`
      ALTER TABLE "executors" DROP COLUMN IF EXISTS "projectId"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_applications_project_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "applications"
      DROP CONSTRAINT IF EXISTS "FK_applications_project"
    `);
    await queryRunner.query(`
      ALTER TABLE "applications" DROP COLUMN IF EXISTS "projectId"
    `);
  }
}
