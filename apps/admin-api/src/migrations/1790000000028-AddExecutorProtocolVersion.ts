import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * B-3/U-2（中台↔执行器深度审查）：executors 增 `protocolVersion` 可空 int 列
 * ——执行器 register 上报的**协议版本**（与实现版本 executorVersion 解耦）。
 *
 * 语义（见 packages/executor-protocol/protocol.json `versioning` 段）：
 * - `NULL` = **未上报**（存量旧执行器）→ 中台按 protocolVersion=1 兜底；
 * - 具体整数 = 上报的协议版本，中台据此做兼容性分支（低于下限 warn + 兜底，
 *   不拒绝注册——与 EXECUTOR_MIN_VERSION 实现版本门禁是两套闸）。
 *
 * 只加可空列、不给默认值：合并「未上报」与「报 1」两态会让版本协商失去意义
 * （无法区分旧执行器与基线协议执行器）。幂等：ADD COLUMN IF NOT EXISTS
 * （对齐 AddExecutorInterpreters 先例）；down：DROP COLUMN IF EXISTS。
 */
export class AddExecutorProtocolVersion1790000000028 implements MigrationInterface {
  name = "AddExecutorProtocolVersion1790000000028";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "protocolVersion" INTEGER NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "protocolVersion"`,
    );
  }
}
