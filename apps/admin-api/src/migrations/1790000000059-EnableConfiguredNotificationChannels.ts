import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R150-A1 收尾：让「已经配好的通知渠道」在开关开始生效后**继续投递**。
 *
 * ## 背景（为什么需要这条 data-only 迁移）
 *
 * R150-A1 给 slack/dingtalk/wecom/feishu/email 补上了 `isEnabled` 闸（此前只有 webhook 认这个开关）。
 * 在那之前，`notification_channel_configs.enabled` 对 5 个渠道**只是个显示值**：管理台把它显示成关闭，
 * 投递却照常进行。于是大量存量行的真实状态是「**配置是满的，enabled 是 false**」——
 * 用户从没拨过那个开关（因为它本来没有作用），行却是关机态。
 *
 * 闸一旦生效，这些行会立刻停止投递 ⇒ **上线那一刻，正在收告警的人不再收到**，
 * 而他们什么都没改。所以必须在同一批次里把「配了就该发」的存量行校准回来。
 *
 * ## 判据：配置非空 ⇒ 视为启用
 *
 * `config::text <> '{}'` —— 只处理**确实填过东西**的行。空配置的渠道即使 enabled=true 也发不出去
 * （渠道实现会因为缺 URL/凭据返回 skipped），所以不必也不该动它们。
 *
 * ## ★ 这条判据是**近似**，必须说清代价
 *
 * 它无法区分两种历史行：
 *   ① 「配好了但没拨开关」（用户想要它生效）—— 本迁移要救的；
 *   ② 「配过、后来**主动**关掉」（用户明确不想要）—— 本迁移会把它们**误开**。
 *
 * 历史行没有记录「是否被显式关过」，所以**这两种无法区分**。选择偏向 ① 的理由：
 * 在开关只是显示值的那些版本里，用户关掉它**没有任何效果**，因此「主动关掉且真的依赖它关闭」
 * 这一情形在实践中不成立（他关不关，告警都一样发）；而 ① 是主流。
 * 上线后若发现某渠道被误开，管理台关一次即可 —— 从这一刻起开关是真的了。
 *
 * ## 数据风险
 *
 * 单条 UPDATE，作用于 notification_channel_configs 全表（行数 = 渠道数 × 少量历史行，量级极小），
 * 不改 schema、不建索引、不锁表。幂等：`enabled = false` 在 WHERE 里，重放不会重复处理。
 * `updatedAt` 由 @UpdateDateColumn 维护，本迁移**不动**它（数据校准不是用户编辑）。
 *
 * ## 回滚
 *
 * **刻意不提供反向**：up 之后无法区分「本条迁移开的」与「用户自己开的」，
 * 任何 down 都会把用户后来主动打开的渠道一起关掉。回滚请用管理台按渠道操作（可见、可审计）。
 */
export class EnableConfiguredNotificationChannels1790000000059
  implements MigrationInterface
{
  name = "EnableConfiguredNotificationChannels1790000000059";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "notification_channel_configs"
      SET "enabled" = true
      WHERE "enabled" = false
        AND "config" IS NOT NULL
        AND "config"::text NOT IN ('{}', 'null')
    `);
  }

  public async down(): Promise<void> {
    // 见类注释「回滚」：不做反向，避免把用户后来主动打开的渠道一起关掉。
  }
}
