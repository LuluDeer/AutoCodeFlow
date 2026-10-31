import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * C2（S3 会话持久化切片）：`agent_tool_calls` 补状态迁移时间戳。
 *
 * 为什么需要：这张表此前只有 `createdAt`（插入时刻）。一行 `in_flight` 到底
 * 是「本次刚发起、副作用即将发生」还是「上次进程正死在这个窗口里」，只能拿
 * `createdAt` 去猜——崩溃点不可判定，恢复时既无法给出「未知结果」的时间窗，
 * 也无法把「结果未知」与「调用失败」在审计上分开。补一列记录**本行 status
 * 最后一次变更的时刻**，`in_flight` 行的时间戳即副作用窗口的开启时刻。
 *
 * 为什么可空且**不回填**：存量行没有这个事实，任何回填值（哪怕是 createdAt）
 * 都是伪造审计证据——审计列宁可 NULL 也不能编。读侧按 nullable 处理。
 *
 * 为什么 metadata-only：加可空列在 PG 只改系统目录（不重写表、不长时间持锁），
 * 因此不用 CONCURRENTLY、不用分批、也不需要回填脚本。down 对称删列。
 */
export class AddAgentToolCallStateChangedAt1790000000083 implements MigrationInterface {
  name = "AddAgentToolCallStateChangedAt1790000000083";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_tool_calls" ADD COLUMN IF NOT EXISTS "stateChangedAt" timestamptz NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_tool_calls" DROP COLUMN IF EXISTS "stateChangedAt"`,
    );
  }
}
