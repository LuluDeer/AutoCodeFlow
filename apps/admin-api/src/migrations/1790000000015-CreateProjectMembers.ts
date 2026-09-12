import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AUTH-02（项目级角色细化）：项目成员表。
 *
 * 设计要点（ADR-013）：
 * - (projectId, userId) 唯一——同一用户在同一项目只有一种角色，判定无歧义；
 * - 外键 ON DELETE CASCADE：项目删除时成员行随之清理（projects.remove 已保护
 *   默认项目；非默认项目删除无需额外级联代码）；
 * - **不回填任何成员行**：零破坏升级——没有成员行时写面判定与此前完全一致
 *   （放行面只增不减），管理员按需逐步配置项目角色。
 * - userId 为 integer（对齐 users.id），不加 FK：用户删除后保留悬垂行比级联
 *   删掉项目授权更可预期（与 tasks.ownerUserId 同姿态，守卫按「非成员」处理）。
 *
 * 幂等：建表与索引均带 IF NOT EXISTS 守卫，down 完整回滚。
 */
export class CreateProjectMembers1790000000015 implements MigrationInterface {
  name = "CreateProjectMembers1790000000015";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_members" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "projectId" uuid NOT NULL,
        "userId" integer NOT NULL,
        "role" varchar(16) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_project_members" PRIMARY KEY ("id"),
        CONSTRAINT "uq_project_members_project_user" UNIQUE ("projectId", "userId"),
        CONSTRAINT "fk_project_members_project"
          FOREIGN KEY ("projectId") REFERENCES "projects"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_project_members_userId"
      ON "project_members" ("userId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_project_members_userId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "project_members"`);
  }
}
