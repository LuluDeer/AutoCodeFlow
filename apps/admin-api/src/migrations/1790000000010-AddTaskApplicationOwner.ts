import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * NF-03（任务级 RBAC 预研，AUTH-02 全量隔离的前置轻量版）：tasks/applications
 * 加 ownerUserId 可空列，写面按「ADMIN 全量 / 属主可改自己 / 无主仅 ADMIN」
 * 三态守卫（守卫在 service 层，见 task.service.assertCanWrite /
 * application.service.assertCanWrite）。
 *
 * 语义（轻量预研拍板）：
 * - 存量行 ownerUserId=NULL =「无主」——**不回填**（与 AUTH-01 projectId 的
 *   「回填默认项目」相反：误绑 owner 会把行锁给错误用户，NULL 保守默认只
 *   收紧为 ADMIN-only，方向安全）。
 * - 新建行落创建者 id（含 ADMIN 创建——ADMIN 本就全量可改，落 id 让
 *   「谁建的」可追溯，也为 AUTH-02 读面过滤预铺数据）。
 * - 列不加 FK：users 表不在本迁移事务保证内且轻量预研避免级联复杂度
 *   （用户删除后 ownerUserId 保留为悬垂 id，守卫按「≠当前用户」比较，
 *   悬垂 id 语义=非本人 → 非 admin 403，方向安全）。
 *
 * down 对称 DROP COLUMN。
 */
export class AddTaskApplicationOwner1790000000010 implements MigrationInterface {
  name = "AddTaskApplicationOwner1790000000010";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "ownerUserId" integer NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "applications"
      ADD COLUMN IF NOT EXISTS "ownerUserId" integer NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      DROP COLUMN IF EXISTS "ownerUserId"
    `);
    await queryRunner.query(`
      ALTER TABLE "applications"
      DROP COLUMN IF EXISTS "ownerUserId"
    `);
  }
}
