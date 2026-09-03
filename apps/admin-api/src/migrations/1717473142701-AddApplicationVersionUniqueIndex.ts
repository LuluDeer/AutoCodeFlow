import { MigrationInterface, QueryRunner, TableIndex } from "typeorm";

/**
 * DB-004: application_versions 增加 (applicationId, version) 唯一索引。
 *
 * entity 对应改动：application-version.entity.ts 中
 *   @Index(["applicationId", "version"], { unique: true })
 *
 * 执行前去重检查 SQL（若线上存在重复数据，本迁移将失败——属预期，
 * 必须先人工/脚本去重再执行）：
 *
 *   -- 找出重复 (applicationId, version) 组合
 *   SELECT "applicationId", "version", COUNT(*) AS cnt
 *   FROM "application_versions"
 *   GROUP BY "applicationId", "version"
 *   HAVING COUNT(*) > 1;
 *
 *   -- 去重示例（保留每组 createdAt 最新一条，删除其余；执行前先确认业务语义）
 *   DELETE FROM "application_versions" a
 *   USING "application_versions" b
 *   WHERE a."applicationId" = b."applicationId"
 *     AND a."version" = b."version"
 *     AND a."id" <> b."id"
 *     AND a."createdAt" < b."createdAt";
 */
export class AddApplicationVersionUniqueIndex1717473142701 implements MigrationInterface {
  name = "AddApplicationVersionUniqueIndex1717473142701";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 与初始建表迁移中的普通索引 idx_application_versions_applicationId_version
    // 同列；先删旧普通索引再建唯一索引，避免同列双索引冗余。
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_application_versions_applicationId_version"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_application_versions_applicationId_version"
      ON "application_versions" ("applicationId", "version")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_application_versions_applicationId_version"`,
    );
    // 还原为原普通索引，保持与 1717473142686 建表时的结构一致
    await queryRunner.createIndex(
      "application_versions",
      new TableIndex({
        name: "idx_application_versions_applicationId_version",
        columnNames: ["applicationId", "version"],
      }),
    );
  }
}
