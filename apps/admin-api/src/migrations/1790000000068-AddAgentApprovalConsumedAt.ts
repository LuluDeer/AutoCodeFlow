import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 实施轮 #15：agent_approvals 补 `consumedAt`（审批单的「真的执行了」时刻）。
 *
 * ## 为什么不是"有 status 就够了"
 *
 * `consumed` 是**状态**，不是一个时刻：审批单上能回答「谁在什么时候批准」
 * （decidedBy / decidedAt），却回答不了「批准之后这次动作到底有没有发生、
 * 什么时候发生的」。这不是展示细节，而是审计语义的断层：
 *   · 批准后执行体领取失败（并发已用 / 崩溃在领取与副作用之间）→ 单子停在
 *     granted，永远看不出「批准了但从未执行」；
 *   · 执行发生在批准之后很久 → 只能靠日志对时间，表里无锚点；
 *   · 运营看板想算「批准到执行的时延」时，没有可用的列。
 *
 * 所以 executed 与 approved 必须各自留下时刻。
 *
 * ## 为什么存量行不回填
 *
 * 历史 `consumed` 行的真实执行时刻只存在于日志里，表内不可推导——拿
 * updatedAt 之类的近似值回填等于**伪造审计事实**（与 1790000000055/0061
 * 「不猜映射」同一结论）。读面对 NULL 显示「—」，语义是"当时没有记录"，
 * 而不是"没有执行"。
 *
 * down：DROP COLUMN IF EXISTS（新增列，回收无数据损失）。
 */
export class AddAgentApprovalConsumedAt1790000000068 implements MigrationInterface {
  name = "AddAgentApprovalConsumedAt1790000000068";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_approvals"
        ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMPTZ NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" DROP COLUMN IF EXISTS "consumedAt"`,
    );
  }
}
