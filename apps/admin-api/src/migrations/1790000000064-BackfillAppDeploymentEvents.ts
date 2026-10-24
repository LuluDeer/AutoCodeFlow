import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R4 后续（部署模型评审 2026-10-23 §4.1A）：deployCount 存量回填——消除
 * 「混合窗口期」。
 *
 * ## 问题（本迁移要消除的窗口期）
 *
 * 事件表由迁移 1790000000062 启用，读面（buildDeployCountMap）已切事件聚合：
 * 应用有任一事件 → GROUP BY deployedVersion 计数；一条事件都没有 → 回退
 * findAllByApp 行计数（legacy）。于是存量应用在产生**第一条**新事件后，计数
 * 从 0 重新累计——迁移 62 之前的历史动作数凭空消失（混合窗口期计数 =
 * 迁移后的动作数）。本迁移把每个「一条事件都没有」的存量应用，从现存
 * app_deployments 行**合成** deploy_created 事件行，让事件聚合从**计数下界**
 * 起步，历史数字不再消失。
 *
 * ## 折算语义（诚实下界，不虚构历史）
 *
 * app_deployments 是行复用模型（见 AppDeploymentEvent 实体注释）：一行只代表
 * 「(应用×执行器) 的最后状态」，重新部署/升级/回滚都在原地覆盖同一行——「同一
 * 版本部署过几次」在行表上不可数。因此回填只能把**每行折算成一次**
 * deploy_created（该应用部署动作次数的计数下界：行还在 ⇒ 至少发生过一次把
 * 这行创建/复用成当前形态的动作；被 remove 删除的行与行复用期间被覆盖的动作
 * 无法从行表还原，**不做任何虚构**）。
 *
 * 目标应用集合 = 全量 app_deployments 的 distinct applicationId（而非全部
 * applications）：无部署行的应用没有任何可折算的动作，回填只会制造无意义的
 * 全 0 事件（且 eventType 语义上必须是真实动作，制造空事件即污染 /events 读面）。
 *
 * 「一条事件都没有」判定 = NOT EXISTS 该应用的任一事件行（任意 eventType——
 * 含 stop/remove 等非计数事件，与 buildDeployCountMap 的 legacy 判定同口径）。
 * 注意这是**应用级**判定：有任一事件的应用整体走事件聚合，其历史行不折算
 * （折算了反而引入双计——这是本迁移刻意保留的边界，见 down 注释与 spec）。
 *
 * ## 合成行标注方案：detail.backfill = true（不改 schema）
 *
 * 事件表已有 jsonb detail 列（"短事实快照，标量事实"），合成行写入
 * detail = { backfill: true, source: "app_deployments" }——不加新列：
 *  - down 靠 detail->>'backfill' = 'true' 精确定位合成行，不误删真实事件；
 *  - /events 读面按 detail 原样透出，运维可直接区分合成与真实事件；
 *  - 加列（如 isSynthetic BOOLEAN）需动实体 + 建列 + 全读面评估，而该事实
 *    只在 down/审计两个场景被消费，jsonb 标注是成本最低且不破坏 append-only
 *    表结构的方案（先例：detail 已承载 approvalRequired/runMode 等标量事实）。
 *
 * ## 列还原口径（不可还原的字段按表约束给合法默认）
 *
 * - applicationId/deploymentId/executorId/executorAddress/deployedVersion：
 *   从行原样还原（deployedVersion 为 NULL 的行也折算——deploy_created 计数
 *   语义是"动作次数"，与聚合读面 deployedVersion IS NOT NULL 的分组口径正交）。
 * - eventType = 'deploy_created'：行存在即至少一次创建动作的下界事实。
 * - triggerType/operator：行上若已有（FEAT-20，迁移 1790000000004 之后落）
 *   原样还原；旧行无则 NULL（列均 nullable，不虚构）。
 * - createdAt = 行 createdAt：动作时刻的最近似还原（行复用下 createdAt 是行
 *   首次创建时刻，早于最近动作但方向正确；列 NOT NULL，给合法值）。
 * - detail：如上标注 backfill。绝不放 env（事件表无掩码读面，QA1 同源约束）。
 *
 * ## 大表性能：id 游标分批 INSERT
 *
 * 仓库既有回填迁移（1790000000008/0058）都是单条集合 UPDATE、量级百级，无
 * 分批先例；本迁移按 **id 游标分批**（每批 1000 行，keyset pagination）：
 *  - 每批一条 INSERT ... SELECT（服务端聚合，无应用层行搬运）；
 *  - WHERE d."id" > $cursor ORDER BY d."id" LIMIT $size 走主键索引，深翻页
 *    不退化（OFFSET 翻页在百万行表上每批都全表重扫）；
 *  - 批间不持长事务（queryRunner.query 逐条自动提交语句），锁窗口小。
 *
 * ## 幂等
 *
 * NOT EXISTS 判定天然幂等：应用一旦有任何事件（含本迁移合成的），后续重放
 * 不再命中，重复执行不重复回填。down 反向只删 detail 标注的合成行。
 */
export class BackfillAppDeploymentEvents1790000000064 implements MigrationInterface {
  name = "BackfillAppDeploymentEvents1790000000064";

  /** 每批折算的 app_deployments 行数（对齐 RELEASES_SYNTHETIC_SCAN_PAGE_SIZE 的千级批口径）。 */
  private static readonly BATCH_SIZE = 1000;

  public async up(queryRunner: QueryRunner): Promise<void> {
    let cursor: string | null = null;
    // keyset 分批：先取当前批的行 id，再按行 INSERT ... SELECT。批次边界上
    // 新部署产生的行要么已在前批折算、要么在本批 NOT EXISTS 排除，无重无漏。
    for (;;) {
      const batch: Array<{ id: string }> = await queryRunner.query(
        `
        SELECT d."id"
        FROM "app_deployments" d
        WHERE d."id" > $1
        ORDER BY d."id"
        LIMIT $2
      `,
        [cursor, BackfillAppDeploymentEvents1790000000064.BATCH_SIZE],
      );
      if (batch.length === 0) break;

      await queryRunner.query(
        `
        INSERT INTO "app_deployment_events" (
          "id", "applicationId", "deploymentId", "executorId", "executorAddress",
          "eventType", "deployedVersion", "triggerType", "operator", "detail", "createdAt"
        )
        SELECT
          gen_random_uuid(),
          d."applicationId",
          d."id",
          d."executorId",
          d."executorAddress",
          'deploy_created',
          d."deployedVersion",
          d."triggerType",
          d."operator",
          '{"backfill": true, "source": "app_deployments"}'::jsonb,
          d."createdAt"
        FROM "app_deployments" d
        WHERE d."id" > $1
          AND NOT EXISTS (
            SELECT 1
            FROM "app_deployment_events" e
            WHERE e."applicationId" = d."applicationId"
          )
        ORDER BY d."id"
        LIMIT $2
      `,
        [cursor, BackfillAppDeploymentEvents1790000000064.BATCH_SIZE],
      );

      cursor = batch[batch.length - 1].id;
      if (batch.length < BackfillAppDeploymentEvents1790000000064.BATCH_SIZE)
        break;
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 只删本迁移合成的行（detail 标注精确定位），真实事件一行不动。
    await queryRunner.query(`
      DELETE FROM "app_deployment_events"
      WHERE "detail"->>'backfill' = 'true'
    `);
  }
}
