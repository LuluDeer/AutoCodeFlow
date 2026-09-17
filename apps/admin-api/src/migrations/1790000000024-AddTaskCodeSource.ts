import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * python_task_multiversion（WS1 · FR-18 / CONTRACT §2.1）：tasks 增 `codeSource`
 * 可空 enum 列（`git` / `glue` / `application_zip`）。
 *
 * 背景：既有三条代码接入渠道只能靠"哪个字段非空"隐式推断来源（gitRepo /
 * glueSource / applicationId），新增整包上传（zip）渠道后 `applicationId`
 * 与 git 语义重叠，产生歧义（AC-17b 要求可区分、不产生语义歧义）。本列把
 * "恰好一种来源"显式化，为执行器侧 zip 分支与调度/提示提供确定判据。
 *
 * 列语义：
 * - **可空**（不加 NOT NULL / DEFAULT）——`NULL` = 存量行未声明来源，读路径
 *   继续按 `applicationId` 非空的并集语义兜底，存量任务零行为变化（NFR-05）。
 * - PG enum 名 `tasks_codeSource_enum`（TypeORM 0.3.x 的 `<table>_<property>_enum`
 *   约定，与实体 `@Column({ type: "enum", enum: TaskCodeSource })` 对齐）。
 *
 * 存量回填（一次性，优先级由 CONTRACT §2.1 钉死）：
 *   `gitRepo NOT NULL → 'git'` > `glueSource NOT NULL → 'glue'`
 *   > `applicationId NOT NULL → 'application_zip'` > 保持 NULL。
 * 单条 UPDATE 用 CASE 表达式按优先级取首个命中——避免三次顺序 UPDATE 在
 * 并发/重放下的中间态，也保证同一行不会被后一条规则覆盖前一条。
 * 回填**只写 NULL 行**（`WHERE "codeSource" IS NULL`）：本迁移重放时不会
 * 覆盖用户已经显式改过的值（幂等的关键，见下）。
 *
 * 幂等：CREATE TYPE 走 pg_type 存在性守卫（PG 无 `CREATE TYPE IF NOT EXISTS`），
 * 列走 `ADD COLUMN IF NOT EXISTS`，回填带 `IS NULL` 谓词，down 走
 * `DROP COLUMN IF EXISTS` + 类型存在性守卫——重复执行与 revert 重放均无副作用
 * （同 1790000000019 / 1788274394055 先例）。
 *
 * 与 PK-26 enum-drift 守卫的关系：`scripts/check-enum-drift.mjs` 的 TS_TO_PG
 * 映射是**手维护**清单，本次未把 `TaskCodeSource` 纳入（属该守卫的独立改动，
 * 不在 WS1 边界）；该脚本的 PG 侧扫描器会自动收集本文件的 `CREATE TYPE` 取值，
 * 因此后续若把 `TaskCodeSource: "tasks_codeSource_enum"` 加进映射即可直接生效。
 */
export class AddTaskCodeSource1790000000024 implements MigrationInterface {
  name = "AddTaskCodeSource1790000000024";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PG 无 CREATE TYPE IF NOT EXISTS —— 用 pg_type 存在性守卫（先例：
    // 1788274394055-CreateAppDeploymentsTable.ts）。
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'tasks_codeSource_enum'
            AND n.nspname = current_schema()
        ) THEN
          CREATE TYPE "tasks_codeSource_enum" AS ENUM ('git', 'glue', 'application_zip');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "codeSource" "tasks_codeSource_enum"
    `);

    // 一次性回填：CASE 按契约优先级短路（首个 WHEN 命中即返回），只触碰 NULL 行。
    await queryRunner.query(`
      UPDATE "tasks"
      SET "codeSource" = CASE
        WHEN "gitRepo" IS NOT NULL THEN 'git'::"tasks_codeSource_enum"
        WHEN "glueSource" IS NOT NULL THEN 'glue'::"tasks_codeSource_enum"
        WHEN "applicationId" IS NOT NULL THEN 'application_zip'::"tasks_codeSource_enum"
        ELSE NULL
      END
      WHERE "codeSource" IS NULL
        AND (
          "gitRepo" IS NOT NULL
          OR "glueSource" IS NOT NULL
          OR "applicationId" IS NOT NULL
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks" DROP COLUMN IF EXISTS "codeSource"
    `);
    // 列删除后类型即无引用；守卫使 revert 重放安全（已删则跳过）。
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'tasks_codeSource_enum'
            AND n.nspname = current_schema()
        ) THEN
          DROP TYPE "tasks_codeSource_enum";
        END IF;
      END
      $$;
    `);
  }
}
