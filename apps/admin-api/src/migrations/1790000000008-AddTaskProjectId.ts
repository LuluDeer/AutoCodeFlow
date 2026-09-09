import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AUTH-01（多租户 Project，第一批后端）：tasks 加 projectId 可空列 + FK + 索引，
 * 并把存量任务回填到默认项目。
 *
 * 语义（用户已拍板）：存量数据回填默认项目——tasks 是用户「工作」的核心
 * 载体，回填后默认项目视图在存量数据上立刻有意义。
 *
 * 可空列设计：NULL 保留为「显式未分配」逃逸口（新建任务在 DTO 未接 projectId
 * 前一律落 NULL），列表过滤面用 `IS NULL OR projectId = 默认` 归入默认项目
 * 视图（task.service.findAll / DEFAULT_PROJECT_ID）。FK ON DELETE SET NULL：
 * 项目删除后任务不连带消失，退回未分配态。
 *
 * 回填安全：FK 已先行建立后按 id 引用回填（默认项目行由迁移
 * 1790000000007 种子保证存在）；WHERE projectId IS NULL 保证幂等重放不重复写。
 * down 对称 DROP INDEX/CONSTRAINT/COLUMN。
 */
export const DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001";

export class AddTaskProjectId1790000000008 implements MigrationInterface {
  name = "AddTaskProjectId1790000000008";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "projectId" uuid NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_tasks_project'
        ) THEN
          ALTER TABLE "tasks" ADD CONSTRAINT "FK_tasks_project"
          FOREIGN KEY ("projectId") REFERENCES "projects"("id")
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tasks_project_id" ON "tasks" ("projectId")
    `);
    // 存量回填：所有未分配任务归默认项目（幂等——已回填行不再命中 WHERE）。
    // 应用层外键保证默认项目行存在（迁移 1790000000007 种子）；仅在该行
    // 存在时回填，避免裸迁移（跳号执行 008）场景下 FK 违例。
    await queryRunner.query(
      `
      UPDATE "tasks" SET "projectId" = $1
      WHERE "projectId" IS NULL
        AND EXISTS (
          SELECT 1 FROM "projects" WHERE "id" = $1
        )
    `,
      [DEFAULT_PROJECT_ID],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_tasks_project_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "FK_tasks_project"
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks" DROP COLUMN IF EXISTS "projectId"
    `);
  }
}
