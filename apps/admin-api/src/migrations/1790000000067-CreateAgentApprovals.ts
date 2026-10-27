import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A1 审批闭环（审计轮 #11 → 实施轮 #12）：agent_approvals 建表。
 *
 * 5 个 approvalRequired 工具此前「声明可经人工点头执行，实际永久不可执行」
 * （requestApproval 只拼字符串推通知、controller 无批准端点、markWaiting
 * 生产零调用）。本表是闭环的落库半边：申请落库 → grant/deny 条件写翻转
 * 状态 → grant 后 controller 复用既有 resume 链路恢复会话。
 *
 * 列语义见 agent-approval.entity.ts 头注（为什么独立实体、为什么 approvalKey
 * 是逻辑外键）。
 *
 * down：直接 DROP——闭环上线前的历史行只有测试环境会有，不做数据迁移。
 */
export class CreateAgentApprovals1790000000067 implements MigrationInterface {
  name = "CreateAgentApprovals1790000000067";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_approvals" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "approvalKey" varchar(128) NOT NULL,
        "sessionId" uuid NOT NULL,
        "toolName" varchar(64) NOT NULL,
        "reason" text NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "decidedBy" varchar(64),
        "decidedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_approvals_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_agent_approvals_approvalKey" ON "agent_approvals" ("approvalKey")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_approvals_status_createdAt" ON "agent_approvals" ("status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_approvals_sessionId" ON "agent_approvals" ("sessionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_approvals"`);
  }
}
