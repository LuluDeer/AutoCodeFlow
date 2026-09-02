import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

/**
 * DB-005: 此迁移原名 1717473142685-CreateExecutorPackagesTable，与
 * 1717473142685-AddExecutorMissingColumns 时间戳重复。相同时间戳的迁移
 * 执行顺序仅由文件名字母序决定，跨平台/工具不稳定，且 TypeORM 按类名
 * 后 13 位解析 timestamp 排序，重复值无法保证顺序。
 *
 * 从内容语义看：AddExecutorMissingColumns 是对 InitialSchema 中 executors
 * 表缺列的补漏（缺列会导致任务派发全部失败），必须先执行；本迁移创建
 * executor_packages 表属于后续独立功能，是"后语义"一方，因此重命名为
 * 1717473142694（2687-2693 均已被占用），执行顺序语义与原字母序一致
 * （AddExecutorMissingColumns 先于 CreateExecutorPackagesTable）。
 *
 * 已部署库注意事项：TypeORM 按类名（migrations 表 name 列）匹配执行记录，
 * 重命名后若线上已按旧类名记账，本迁移会被视为"未执行"而再次运行。
 * 为此 up/down 全部改为幂等写法（IF NOT EXISTS / IF EXISTS + EXISTS 检查），
 * 重复执行无副作用。需要严格保持历史一致时，可手动执行：
 *   UPDATE migrations SET name = 'CreateExecutorPackagesTable1717473142694'
 *   WHERE name = 'CreateExecutorPackagesTable1717473142685';
 */
export class CreateExecutorPackagesTable1717473142694 implements MigrationInterface {
  name = "CreateExecutorPackagesTable1717473142694";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "executor_packages",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          { name: "name", type: "varchar", length: "255" },
          { name: "version", type: "varchar", length: "64" },
          {
            name: "type",
            type: "enum",
            enum: ["node", "python", "universal"],
            default: "'universal'",
          },
          {
            name: "platform",
            type: "varchar",
            length: "128",
            isNullable: true,
          },
          { name: "filePath", type: "varchar", length: "1024" },
          { name: "fileSize", type: "bigint", default: 0 },
          {
            name: "checksum",
            type: "varchar",
            length: "64",
            isNullable: true,
          },
          { name: "description", type: "text", isNullable: true },
          {
            name: "status",
            type: "enum",
            enum: ["active", "deprecated", "uploading"],
            default: "'active'",
          },
          {
            name: "uploadedBy",
            type: "varchar",
            length: "255",
            isNullable: true,
          },
          {
            name: "createdAt",
            type: "timestamp",
            default: "CURRENT_TIMESTAMP",
          },
          {
            name: "updatedAt",
            type: "timestamp",
            default: "CURRENT_TIMESTAMP",
            onUpdate: "CURRENT_TIMESTAMP",
          },
        ],
      }),
      // 幂等：表已存在（重命名导致重复执行）时跳过
      true,
    );

    const indexExists = async (name: string): Promise<boolean> => {
      const result: { exists: boolean }[] = await queryRunner.query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = current_schema() AND indexname = $1
         ) AS exists`,
        [name],
      );
      return !!result[0]?.exists;
    };

    if (!(await indexExists("IDX_executor_packages_name_version_type"))) {
      await queryRunner.createIndex(
        "executor_packages",
        new TableIndex({
          name: "IDX_executor_packages_name_version_type",
          columnNames: ["name", "version", "type"],
          isUnique: true,
        }),
      );
    }

    if (!(await indexExists("IDX_executor_packages_status"))) {
      await queryRunner.createIndex(
        "executor_packages",
        new TableIndex({
          name: "IDX_executor_packages_status",
          columnNames: ["status"],
        }),
      );
    }

    if (!(await indexExists("IDX_executor_packages_type"))) {
      await queryRunner.createIndex(
        "executor_packages",
        new TableIndex({
          name: "IDX_executor_packages_type",
          columnNames: ["type"],
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 幂等：IF EXISTS 防止重复回滚报错；enum 类型由 createTable 创建，此处不回删（与原实现一致）
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_executor_packages_type"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_executor_packages_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_executor_packages_name_version_type"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "executor_packages"`);
  }
}
