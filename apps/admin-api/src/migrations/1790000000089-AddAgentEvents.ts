import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * S7-G1（第一阶段：只写不读）：Agent 会话**取证型事件日志**表。
 *
 * ## 它解决什么
 * `agent_tool_calls.status` 是**就地更新**的（`in_flight` → `ok`/`error`），
 * `agent_sessions.stateChangedAt`（迁移 0083）只有**一个**时间戳——「这行变成
 * `in_flight` 之后、变成 `error` 之前，模型看到了什么」在数据面无从回答。
 * 本表按「一行一事件 + 会话内单调 seq」记录事实序列，是「当时到底发生了什么」
 * 的唯一完备载体。
 *
 * ## 为什么只建表、不建读取路径
 * 我们**不做** Temporal 式「重算型 replay」：Agent 的步骤夹着 LLM 调用（同
 * prompt 不同答案）与带副作用的工具（再跑一次就再写一次文件）。重放不成立于
 * 「被重放的代码是确定性的」，而我们的不是。取证用途与能否重算无关，所以本阶段
 * 只写（`rebuildMessages` 的读路径**不动**，仍是快照重建）；投影/读取留待下阶段，
 * 届时要先证明新投影与快照重建**逐条一致**再切换，避免两套真相源并存漂移。
 *
 * ## 为什么不抄 Temporal 的两条不变量（另外两条已落实）
 * 落实的两条在写入侧（`AgentSessionService.appendEvents`）：① 同批 `seq` 连续
 * （单语句 `MAX(seq)+ord` 分配，构造上不可能跳号）；② 超批量上限**整批拒**，
 * 不许部分写入（单语句/单事务，先判批量再动 DB）。
 * 刻意**不抄**的两条：
 * · **同批版本一致**：那是分片（RangeID）语义——批次必须落在同一历史分片，版本
 *   号用于发现分片分裂/迁移期的事件错位。我们是**单库单表**，没有分片可分裂，
 *   这个列只能是恒等常量（永真断言 = 零保护，且每次写入白带一个字段）；
 * · **`node_id` = 首批事件 ID**：那是**重放锚点**（回放起点/指纹对齐）。不做
 *   重放 ⇒ 没有消费方；留下它就变成「没人读的列」，而本仓对「加了列 ≠ 有了
 *   能力」已有教训（0083 的 `stateChangedAt`）。
 *
 * ## 为什么 `id` 是 uuid（而不是 bigserial）
 * 事件的真身份是 `(sessionId, seq)`；`id` 只是单条事件的句柄。uuid 与同域
 * `agent_steps` / `agent_sessions` 一致，且不会把「全库事件总量」编码进一个
 * 外部可见的 id 里（跨会话的事件数不应被推断出来）。
 *
 * ## 为什么 `kind` 不加 CHECK
 * 闭集在代码侧（`AGENT_EVENT_KINDS`，写入口唯一）收敛。DB 侧 CHECK 会让「补记
 * 一种新事实」必须配一张迁移，而取证表的正当演化恰恰是「后来又发现该记什么」。
 *
 * ## 为什么是 metadata-only（新表无存量）
 * 建表不触碰任何既有行：没有 `ALTER TABLE ... ADD COLUMN`、没有回填、没有
 * `CREATE INDEX CONCURRENTLY` 的必要（CONCURRENTLY 是给**已有大表**建索引用的，
 * 这里的索引与表同时诞生，锁只落在这张新表上）。故无需分批、无需 `statement_timeout`
 * 豁免。幂等：全部 `IF NOT EXISTS`，重复执行与 revert 重放无副作用。
 *
 * ## 回滚的代价（必须知道）
 * down 会删掉**全部**取证事件：已经发生的「模型当时看到什么」（prompt 指纹）、
 * 工具状态迁移序列将不可恢复。会话本身、steps、tool_calls 全不受影响——它们才是
 * 会话继续跑/被复盘的主数据，所以回滚**不影响受理**，只影响**事后取证**。这正是
 * 「只写不读」的另一个好处：本表没有任何读方持有它，删掉不会改变系统行为。
 *
 * ## 保留期
 * 必须有清理路径（否则就是一张永不清理的新表；会话行永不删除，ON DELETE CASCADE
 * 等于没有）。接在 `agent-session-retention.service.ts` 的 B-10 日内 cron 上：
 * `cleanupExpiredEvents` 只清**终态会话**的超期事件。
 */
export class AddAgentEvents1790000000089 implements MigrationInterface {
  name = "AddAgentEvents1790000000089";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sessionId" uuid NOT NULL,
        "seq" integer NOT NULL,
        "kind" varchar(32) NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_agent_events" PRIMARY KEY ("id"),
        -- ON DELETE CASCADE 只是**安全网**（会话被真删时事件一起走），不是保留期
        -- 手段：本仓的会话行永不删除（保留期只清 steps/tool_calls/approvals），
        -- 所以「清理」必须另有出口，见 cleanupExpiredEvents。
        CONSTRAINT "FK_agent_events_sessionId" FOREIGN KEY ("sessionId")
          REFERENCES "agent_sessions"("id") ON DELETE CASCADE
      )
    `);
    // 「同 seq 不许写两行」的硬闸：并发两次 append 撞在同一 seq 时，输的一方
    // 拿到 23505 后按 `MAX(seq)` 重算重试（见 appendEvents），绝不会写重复。
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_events_sessionId_seq"
      ON "agent_events" ("sessionId", "seq")
    `);
    // 保留期清理的唯一挑选条件（DELETE ... WHERE "createdAt" < cutoff）
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_events_createdAt"
      ON "agent_events" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 显式拆索引（PG 会随表级联删除，但写出来让意图与 up 一一对应）
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_agent_events_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_agent_events_sessionId_seq"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_events"`);
  }
}
