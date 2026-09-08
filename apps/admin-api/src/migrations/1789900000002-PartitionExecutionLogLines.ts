import { MigrationInterface, QueryRunner } from "typeorm";
import {
  partitionNameFor,
  partitionRangeFor,
} from "../modules/task/log-retention/log-partition.util";

/**
 * ARCH-22「execution_log_lines 按日分区」——schema 改造为
 * PARTITION BY RANGE (createdAt)，清理路径由每日分批 DELETE 升级为
 * ALTER TABLE ... DETACH PARTITION（分区化后 DELETE 仅在 fallback 开关下使用）。
 *
 * ## 为什么 PK 必须改联合
 * PG 分区表要求所有唯一约束（含 PK）必须包含分区键 createdAt。本表现 PK
 * 为 id 单列（SERIAL，InitialSchema 1717473142678），必须改造成 (id, createdAt)
 * 联合主键。全库核对：execution_log_lines 的 id 无外部消费方——task_executions
 * 无指向本表的 FK（1717473142679 只加 task_executions→tasks），代码读路径
 * 只按 executionId/lineNumber/level 过滤，写路径 delete 按 executionId
 * （task.service storeLogLines），唯一按 id 定位的消费方是清理服务的
 * `id IN (SELECT id ...)` fallback 子查询（同表内自引用，联合 PK 下
 * 语义不变）。因此联合 PK 改造零破坏。
 *
 * ## 迁移形态（全幂等、可重入、失败可续跑）
 * 用 pg_class.relkind 判定当前状态，DO 块按状态推进（部分执行后重跑
 * migration:run 自动续走剩余步骤）：
 *
 * - 状态 A：表存在且 relkind='p'（已是分区父表）→ 无操作（新库直建分区
 *   即此状态；重跑迁移幂等）。
 * - 状态 B：普通表存在（relkind='r'）→ 存量库在线搬迁，四步全在**事务外
 *   的守卫式 SQL** 中（TypeORM 迁移默认包事务，PG DDL 可回滚，但第 3 步
 *   INSERT..SELECT 大表耗时长——守卫式推进保证中断后重跑续行，不重复搬迁）：
 *   1. RENAME execution_log_lines → execution_log_lines_legacy（ACCESS
 *      EXCLUSIVE 瞬时持有，元数据操作，无数据拷贝）；
 *   2. 建分区父表 execution_log_lines（同列 + 联合 PK + 分区索引）——
 *      **常规索引代替原 (id, lineNumber) 复合等五个索引的逐个搬移**：
 *      只建读取路径实际消费的三索引（见下），legacy 五索引不搬迁
 *      （legacy 表只读不写，仅作人工回退源）；
 *   3. INSERT INTO execution_log_lines SELECT ... FROM legacy（一次性；
 *      联合 PK ON CONFLICT DO NOTHING 使重跑天然幂等不重复插）；
 *      DEFAULT nextval 复用 legacy 的既有序列，id 连续性保持；
 *   4. **不 DROP legacy**——保留为人工回退源（验收「每步可回滚」），
 *      人工清理步骤见 docs/operations.md「分区表运维」段。
 * - 状态 C：表不存在（全新库）→ 直接建分区父表（新库直建分区），
 *   并预建 today-1 ~ today+7 的日分区（明天必达：凌晨 00:00 前后写入
 *   的行需要落当日/次日分区；-1 天兜底时钟偏差）。
 *
 * 迁移内不建无界 DEFAULT 分区：默认分区会吞掉未覆盖日期的写入（如
 * 预建 job 停摆后的未来日期），DETACH 清理路径将无法按日剥离——宁可
 * 让预建 job 停摆时的写入显式报错（有 fallback 日志告警）也不留隐蔽
 * 的不可清理堆积。每日预建由 LogRetentionCleanupService.ensureUpcomingPartitions
 * 在同一 cron 内执行（今天+1..+7）。
 *
 * ## S3 驱动注记（侦察确认）
 * LOG_STORAGE_DRIVER=s3 且上传成功时 storeLogLines **不写 DB 行**
 * （task.service.ts S3 成功路径 return 前仅 delete + update 指针），
 * DB 行量随 S3 采用率下降；分区化对 S3 用户仍安全（表常空、分区空），
 * 因此不为 S3 用户提供跳过 schema 改造的分支——统一 schema、清理服务
 * 按分区存在性自动选路径。
 */
export class PartitionExecutionLogLines1789900000002 implements MigrationInterface {
  name = "PartitionExecutionLogLines1789900000002";

  /** 预建分区窗口：today-1 ~ today+7（含端点） */
  private static readonly PRECREATE_OFFSET_DAYS = [-1, 0, 1, 2, 3, 4, 5, 6, 7];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 步骤 0（状态判定 + 状态 C 新库直建 / 状态 B 存量搬迁）——
    // 全部守卫式 DO 块，任何一步完成后重跑都从下一步继续。
    await queryRunner.query(`
      DO $$
      DECLARE
        v_relkind "char";
        v_legacy_exists boolean;
      BEGIN
        SELECT c.relkind INTO v_relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema()
           AND c.relname = 'execution_log_lines';

        SELECT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema()
           AND c.relname = 'execution_log_lines_legacy'
        ) INTO v_legacy_exists;

        IF v_relkind = 'p' THEN
          -- 已是分区父表：无操作（幂等重入点）
          RAISE NOTICE 'ARCH-22: execution_log_lines already partitioned, skipping';
        ELSIF v_relkind = 'r' AND NOT v_legacy_exists THEN
          -- 存量库在线搬迁（步骤 1~3）；legacy 不 DROP（人工回退源）
          RAISE NOTICE 'ARCH-22: migrating existing execution_log_lines to partitioned';

          -- 步骤 1：rename 原表为 legacy（瞬时元数据操作）
          ALTER TABLE "execution_log_lines" RENAME TO "execution_log_lines_legacy";

          -- 步骤 2：建分区父表（同列 + 联合 PK + 分区索引）。
          -- 索引只搬读取路径消费的三个（executionId,lineNumber /
          -- executionId,level,lineNumber / createdAt）；原 legacy 上
          -- idx_execution_log_lines_execution_id、idx_..._line_number、
          -- IDX_execution_log_lines_executionId_lineNumber 语义被前两者
          -- 覆盖，不重复建。PK 含分区键（PG 硬约束）。
          CREATE TABLE "execution_log_lines" (
            "id" SERIAL NOT NULL,
            "executionId" VARCHAR NOT NULL,
            "lineNumber" INTEGER NOT NULL,
            "content" TEXT NOT NULL,
            "level" VARCHAR(8),
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT "PK_execution_log_lines" PRIMARY KEY ("id", "createdAt")
          ) PARTITION BY RANGE ("createdAt");

          CREATE INDEX IF NOT EXISTS "IDX_execution_log_lines_execId_lineNumber"
            ON "execution_log_lines" ("executionId", "lineNumber");
          CREATE INDEX IF NOT EXISTS "IDX_execution_log_lines_execId_level_lineNumber"
            ON "execution_log_lines" ("executionId", "level", "lineNumber");
          CREATE INDEX IF NOT EXISTS "idx_execution_log_lines_createdAt"
            ON "execution_log_lines" ("createdAt");

          -- 步骤 3：存量数据搬迁（一次性 INSERT..SELECT；重跑时联合 PK
          -- ON CONFLICT DO NOTHING 保证不重复插——但本块整体只在
          -- rename 完成后的首次进入，重跑走 relkind='p' 分支不会到达这里）
          INSERT INTO "execution_log_lines" ("id", "executionId", "lineNumber", "content", "level", "createdAt")
          SELECT "id", "executionId", "lineNumber", "content", "level", "createdAt"
            FROM "execution_log_lines_legacy"
          ON CONFLICT DO NOTHING;

          -- 序列对齐：nextval 复用 legacy 既有序列（父表 SERIAL 引用同名
          -- 序列 execution_log_lines_id_seq——rename 表不改序列名），显式
          -- setval 推进到 max(id) 防新插入与 legacy 已发号冲突。
          PERFORM setval('execution_log_lines_id_seq',
            GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "execution_log_lines_legacy"), 1));
        ELSE
          -- 表不存在（全新库）或 legacy 已存在但主表缺失的中间态：
          -- 建分区父表（新库直建分区；中间态由下方 COPY 补齐数据）
          RAISE NOTICE 'ARCH-22: creating partitioned execution_log_lines (fresh or resume)';

          CREATE TABLE IF NOT EXISTS "execution_log_lines" (
            "id" SERIAL NOT NULL,
            "executionId" VARCHAR NOT NULL,
            "lineNumber" INTEGER NOT NULL,
            "content" TEXT NOT NULL,
            "level" VARCHAR(8),
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT "PK_execution_log_lines" PRIMARY KEY ("id", "createdAt")
          ) PARTITION BY RANGE ("createdAt");

          CREATE INDEX IF NOT EXISTS "IDX_execution_log_lines_execId_lineNumber"
            ON "execution_log_lines" ("executionId", "lineNumber");
          CREATE INDEX IF NOT EXISTS "IDX_execution_log_lines_execId_level_lineNumber"
            ON "execution_log_lines" ("executionId", "level", "lineNumber");
          CREATE INDEX IF NOT EXISTS "idx_execution_log_lines_createdAt"
            ON "execution_log_lines" ("createdAt");

          -- 中间态续跑：legacy 有数据且父表刚建成（搬迁步骤曾中断于
          -- 步骤 3 之前）→ 补搬迁
          IF v_legacy_exists THEN
            INSERT INTO "execution_log_lines" ("id", "executionId", "lineNumber", "content", "level", "createdAt")
            SELECT "id", "executionId", "lineNumber", "content", "level", "createdAt"
              FROM "execution_log_lines_legacy"
            ON CONFLICT DO NOTHING;
            PERFORM setval('execution_log_lines_id_seq',
              GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "execution_log_lines_legacy"), 1));
          END IF;
        END IF;
      END
      $$;
    `);

    // 步骤 4：预建 today-1 ~ today+7 日分区（IF NOT EXISTS 幂等；
    // 清理服务每日 cron 持续预建明天，这里只覆盖迁移当下窗口）
    for (const offset of PartitionExecutionLogLines1789900000002.PRECREATE_OFFSET_DAYS) {
      const day = new Date(Date.now() + offset * 86_400_000);
      const { from, to } = partitionRangeFor(day);
      const name = partitionNameFor(day);
      await queryRunner.query(
        `CREATE TABLE IF NOT EXISTS "${name}"
           PARTITION OF "execution_log_lines"
           FOR VALUES FROM ('${from} 00:00:00') TO ('${to} 00:00:00')`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚：分区父表数据若有则回流 legacy（legacy 不存在时先建普通表），
    // 再 DROP 分区父表。down 供 migration:revert 使用，非在线路径——
    // 大表数据回流耗时长，文档注明建议维护窗口执行。
    await queryRunner.query(`
      DO $$
      DECLARE
        v_relkind "char";
        v_legacy_exists boolean;
      BEGIN
        SELECT c.relkind INTO v_relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema()
           AND c.relname = 'execution_log_lines';

        SELECT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema()
           AND c.relname = 'execution_log_lines_legacy'
        ) INTO v_legacy_exists;

        IF v_relkind = 'p' THEN
          IF NOT v_legacy_exists THEN
            CREATE TABLE "execution_log_lines_legacy" (
              "id" SERIAL PRIMARY KEY,
              "executionId" VARCHAR NOT NULL,
              "lineNumber" INTEGER NOT NULL,
              "content" TEXT NOT NULL,
              "level" VARCHAR(8),
              "createdAt" TIMESTAMP NOT NULL DEFAULT now()
            );
          END IF;
          INSERT INTO "execution_log_lines_legacy" ("id", "executionId", "lineNumber", "content", "level", "createdAt")
          SELECT "id", "executionId", "lineNumber", "content", "level", "createdAt"
            FROM "execution_log_lines"
          ON CONFLICT DO NOTHING;
          DROP TABLE "execution_log_lines";
        END IF;
      END
      $$;
    `);
  }
}
