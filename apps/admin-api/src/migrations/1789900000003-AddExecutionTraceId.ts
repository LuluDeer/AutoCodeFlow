import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * OBS-01: task_executions.traceId（nullable varchar(64)）。
 *
 * 一次执行的分布式追踪标识（W3C trace-id，32 hex；预留 64 宽度兼容未来
 * TraceID 变体）。触发/入队侧生成（OTEL_ENABLED=true 时），经 dispatch
 * traceparent 头透传执行器，终态行携带 traceId 供 UI 展示与 Jaeger/Tempo
 * 按 trace-id 检索。
 * 语义：NULL = 追踪未开启（默认）或旧数据——UI 不渲染追踪段。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddExecutionTraceId1789900000003 implements MigrationInterface {
  name = "AddExecutionTraceId1789900000003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "traceId" VARCHAR(64) NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_executions_trace_id"
      ON "task_executions" ("traceId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_task_executions_trace_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "traceId"
    `);
  }
}
