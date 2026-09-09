import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AUTH-01（多租户 Project，第一批后端）：建 projects 表 + 种子默认项目。
 *
 * 单默认项目起步（用户已拍板）：所有存量数据回填/归属 Default 项目，
 * 语义上「未分配 = 默认项目」。固定 uuid '00000000-0000-0000-0000-000000000001'
 * 由 migrations 1790000000008/1790000000009 的回填 SQL 与应用层
 * DEFAULT_PROJECT_ID（project.entity.ts）共同引用，三处必须一致。
 *
 * name 加 UNIQUE 约束——项目以名称标识，重名会破坏前端选择面与
 * ProjectsService.remove 的 Default 拦截判定。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING，
 * 重复执行与 revert 重放均无副作用。
 */
export const DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_PROJECT_NAME = "Default";

export class CreateProjects1790000000007 implements MigrationInterface {
  name = "CreateProjects1790000000007";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "projects" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" varchar NOT NULL,
        "description" varchar NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_projects_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_projects_name" ON "projects" ("name")
    `);
    // 种子默认项目：幂等（重复执行不覆盖、不报错）。已有自定义 Default
    // 行（同 name）时 DO NOTHING——绝不静默改写用户数据。
    await queryRunner.query(
      `
      INSERT INTO "projects" ("id", "name", "description")
      VALUES ($1, $2, $3)
      ON CONFLICT ("id") DO NOTHING
    `,
      [
        DEFAULT_PROJECT_ID,
        DEFAULT_PROJECT_NAME,
        "Default project (auto-seeded)",
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_projects_name"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "projects"
    `);
  }
}
