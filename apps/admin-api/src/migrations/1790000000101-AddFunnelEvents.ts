import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R302 / TTFV 阶段2：`funnel_events` —— 首次成功漏斗的最小事实表。
 *
 * ## 为什么 append-only
 *
 * TTFV 要回答「同一个 install 从安装完成到首个任务成功花了多久」。这是按时间排列的事实序列：
 * 安装时刻与首成时刻一旦落库就不再改写，才有可复算的中位数与转化率。表上因此没有
 * `updatedAt`，写入服务只有 append 一条路径；修正口径靠新增带新 `dedupe_key` 的事件，
 * 而不是回写旧行。
 *
 * ## 为什么 `dedupe_key` 唯一
 *
 * 埋点触发点分布在多副本与重试路径上（例如终态 winner 判定前后的重复投递）。唯一约束把
 * 「同一业务事实只算一次」从进程内 Set 提升到数据库层：并发、重启、多实例都收敛到一行。
 * 写入侧用 `INSERT ... ON CONFLICT DO NOTHING`，`dedupe_key` 是幂等身份，重复投递被静默吸收。
 *
 * ## 为什么新建表而非复用 `agent_events`
 *
 * `agent_events` 的身份是 `(sessionId, seq)`，服务于 Agent 会话取证；TTFV 的身份是
 * `install_id`，跨会话、跨任务，且与 opt-in 维度对齐。把两种身份塞进一张表会让
 * `seq` 失去单调递增语义，也会让清理策略互相拖拽。新建窄表只存事件名、时间、哈希与去重键，
 * 不存凭据或正文（方案 §6）。
 *
 * ## 索引
 *
 * - `idx_funnel_events_install_id_event_name`：§4.3 阶段2 SQL 的两次 JOIN 形态就是
 *   `install_id + event_name`，复合索引与谓词同序；
 * - `uq_funnel_events_dedupe_key`：幂等硬闸，同时服务按 key 的重复检查。
 *
 * 新表无存量行，`IF NOT EXISTS` 让重放无副作用；`down()` 逆序 DROP 索引与表。
 */
export class AddFunnelEvents1790000000101 implements MigrationInterface {
  name = "AddFunnelEvents1790000000101";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "funnel_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "install_id" character varying(128) NOT NULL,
        "event_name" character varying(64) NOT NULL,
        "task_id_hash" character varying(128) NULL,
        "execution_id_hash" character varying(128) NULL,
        "ts" TIMESTAMP WITH TIME ZONE NOT NULL,
        "dedupe_key" character varying(255) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_funnel_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_funnel_events_install_id_event_name"
        ON "funnel_events" ("install_id", "event_name")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_funnel_events_dedupe_key"
        ON "funnel_events" ("dedupe_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_funnel_events_dedupe_key"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_funnel_events_install_id_event_name"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "funnel_events"`);
  }
}
