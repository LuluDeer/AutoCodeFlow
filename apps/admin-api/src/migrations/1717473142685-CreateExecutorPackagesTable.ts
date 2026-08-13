import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class CreateExecutorPackagesTable1717473142685 implements MigrationInterface {
  name = "CreateExecutorPackagesTable1717473142685";

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
      true,
    );

    await queryRunner.createIndex(
      "executor_packages",
      new TableIndex({
        name: "IDX_executor_packages_name_version_type",
        columnNames: ["name", "version", "type"],
        isUnique: true,
      }),
    );

    await queryRunner.createIndex(
      "executor_packages",
      new TableIndex({
        name: "IDX_executor_packages_status",
        columnNames: ["status"],
      }),
    );

    await queryRunner.createIndex(
      "executor_packages",
      new TableIndex({
        name: "IDX_executor_packages_type",
        columnNames: ["type"],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex(
      "executor_packages",
      "IDX_executor_packages_type",
    );
    await queryRunner.dropIndex(
      "executor_packages",
      "IDX_executor_packages_status",
    );
    await queryRunner.dropIndex(
      "executor_packages",
      "IDX_executor_packages_name_version_type",
    );
    await queryRunner.dropTable("executor_packages");
  }
}
