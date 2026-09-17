import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * python_task_multiversion（WS2）：executors 增 `interpreters` 可空 jsonb 列
 * ——执行器上报的**解释器缓存池清单**（CONTRACT.md §2.2）。
 *
 * 形状：
 * ```jsonc
 * [{ "version": "3.7.9", "path": "/data/interpreters/.../bin/python3",
 *    "available": true, "discoveredAt": "2026-09-16T10:00:00.000Z" }]
 * ```
 *
 * **为什么必须可空（不加 NOT NULL、不给 DEFAULT）**：三态语义必须可区分，
 * 合并任意两态都会造成调度错判（CONTRACT §2.2 硬要求）：
 * - `NULL` = **未上报**（存量旧执行器）→ 调度按 `["3.12"]` 兜底
 *   （兼容性红线 2：旧执行器不得因缺字段被剔除）；
 * - `[]`   = **已上报且缓存池为空** → 调度视为无任何版本可满足（**不兜底**）；
 * - `[{...}]` = 已上报的具体清单。
 *
 * 若给 DEFAULT '[]'::jsonb，存量旧执行器会被一并写成"池空"，注册上线瞬间即
 * 无法承接任何声明版本的任务——这是本迁移最关键的一处"不能图省事"。
 *
 * 幂等：ADD COLUMN IF NOT EXISTS（重复执行 no-op，对齐
 * 1788700000000-AddExecutorRunningExecutionIds 先例）。
 * down：DROP COLUMN IF EXISTS。
 */
export class AddExecutorInterpreters1790000000025 implements MigrationInterface {
  name = "AddExecutorInterpreters1790000000025";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "interpreters" JSONB NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "interpreters"`,
    );
  }
}
