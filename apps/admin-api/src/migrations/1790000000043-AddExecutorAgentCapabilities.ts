import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * P7c：Agent 协作能力与普通任务运行时能力分列。
 *
 * 不从旧 capabilities 回填：该列可能是早期 Agent 覆盖后的陈旧清单，无法
 * 判断客户端是否仍启用 GUI；新列 NULL 在执行器重新显式上报前按无权限处理。
 * 旧 runtime 列不改写，避免只剩 Agent 标签的旧行被清成空数组后触发
 * 「空能力 = runtime 通用」的既有派发兜底。executor-node 重注册会恢复
 * 真实运行时清单，desktop Agent 的下次上报会写入新列。
 */
export class AddExecutorAgentCapabilities1790000000043 implements MigrationInterface {
  name = "AddExecutorAgentCapabilities1790000000043";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "agentCapabilities" text NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "agentCapabilitiesUpdatedAt" timestamptz NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "agentCapabilitiesUpdatedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "agentCapabilities"`,
    );
  }
}
