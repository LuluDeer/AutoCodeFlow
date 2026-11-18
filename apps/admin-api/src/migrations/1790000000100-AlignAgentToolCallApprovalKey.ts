import { MigrationInterface, QueryRunner } from "typeorm";

/** 0040 存的是 uuid；0067 的审批业务键是 varchar(128)，与审批行主键不同。 */
export class AlignAgentToolCallApprovalKey1790000000100 implements MigrationInterface {
  name = "AlignAgentToolCallApprovalKey1790000000100";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // uuid::text 给出规范拼写，NULL 保持 NULL；没有历史外键证明该值指向哪张审批单。
    await queryRunner.query(`
      ALTER TABLE "agent_tool_calls" ALTER COLUMN "approvalId" TYPE varchar(128)
        USING "approvalId"::text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 锁、检查、转型放在同一条语句里：检查之后不会插进新的业务键。
    // PG 也接受大写、花括号等 UUID 拼写，但转型会改变原文；只还原可无损往返的值。
    await queryRunner.query(`
      DO $$
      BEGIN
        LOCK TABLE "agent_tool_calls" IN ACCESS EXCLUSIVE MODE;
        IF EXISTS (
          SELECT 1 FROM "agent_tool_calls"
          WHERE "approvalId" COLLATE "C" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '22P02',
            MESSAGE = '1790000000100 rollback blocked: agent_tool_calls.approvalId contains a non-canonical UUID string',
            HINT = 'Keep the varchar(128) column to preserve approval keys.';
        END IF;
        ALTER TABLE "agent_tool_calls" ALTER COLUMN "approvalId" TYPE uuid
          USING "approvalId"::uuid;
      END $$
    `);
  }
}
