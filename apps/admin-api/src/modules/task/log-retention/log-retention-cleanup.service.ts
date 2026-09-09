import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import {
  partitionNameFor,
  partitionRangeFor,
  parsePartitionUpperBound,
} from "./log-partition.util";

/** 默认日志保留天数（可经 LOG_RETENTION_DAYS 覆盖） */
export const DEFAULT_LOG_RETENTION_DAYS = 30;
/** 单批最大删除行数：限制单条 DELETE 的锁持有范围，防止长事务锁表 */
export const LOG_RETENTION_BATCH_SIZE = 5000;
/** 每日 03:30 清理（6 段 cron，与 scheduler 模块风格一致） */
export const LOG_RETENTION_CRON = "0 30 3 * * *";

/** ARCH-22: 功能开关默认值——分区清理/预建路径默认开启 */
export const DEFAULT_LOG_PARTITION_ENABLED = true;

/**
 * DB-002 + ARCH-22: execution_log_lines 的保留期清理。
 *
 * 双路径（按运行库 schema 自动选择，见 cleanupExpiredLines）：
 * - **分区库（主路径，ARCH-22）**：表为 PARTITION BY RANGE (createdAt)，
 *   超期分区走 `ALTER TABLE ... DETACH PARTITION`——O(1) 元数据操作替代
 *   逐行 DELETE（大表 VACUUM 压力消除，验收 10× 时长目标的来源），detach
 *   后立即 DROP detached 表（简单、空间即刻归还；如需先归档可人工在
 *   DROP 前接管，见 docs/operations.md「分区表运维」段）。
 *   另每日预建未来 7 天分区（ensureUpcomingPartitions）——迁移只预建当下
 *   窗口，长期滚动由本 job 保证；未覆盖日期的写入会显式报错（无 DEFAULT
 *   分区，设计决策见迁移 1789900000002 头注），预建 job 停摆在日志可见。
 * - **legacy 普通表（fallback）**：保留期分批 DELETE 原样保留——覆盖
 *   未跑分区迁移的库、LOG_PARTITION_ENABLED=false 的用户、以及 S3 驱动
 *   用户（S3 成功路径 DB 不写行，DELETE 批次空转即停，代价可忽略）。
 *   LOG_PARTITION_ENABLED 只影响**运行期清理路径选择**，不影响 schema
 *   （迁移恒建分区表）——开关回 true 后无需再跑迁移。
 *
 * 范围说明：本服务只清理数据库行。LOG_STORAGE_DRIVER=s3 时完整日志对象
 * 外置到 MinIO/S3（log-storage/s3-log-storage.ts，execution-logs/*.log.gz），
 * 外置对象不属于本服务的清理范围，应由对象存储的 bucket lifecycle 策略
 * 或后续专门任务处理，否则 S3 侧仍会无限累积。
 *
 * 注册方式：由 TaskModule providers 装配；@Cron 由 SchedulerModule 中的
 * ScheduleModule.forRoot() 通过全局 DiscoveryService 扫描注册。
 */
@Injectable()
export class LogRetentionCleanupService {
  private readonly logger = new Logger(LogRetentionCleanupService.name);

  constructor(
    @InjectRepository(ExecutionLogLine)
    private readonly logLineRepo: Repository<ExecutionLogLine>,
    // ARCH-27: 保留期配置经 ConfigService 读取（configuration.ts
    // logRetention.days + Joi LOG_RETENTION_DAYS），取代直读 process.env。
    private readonly configService: ConfigService,
  ) {}

  /** 每日定时入口；清理失败只记日志，等下一轮 cron 重试，不影响主流程 */
  @Cron(LOG_RETENTION_CRON)
  async handleDailyCleanup(): Promise<void> {
    try {
      const deleted = await this.cleanupExpiredLines();
      if (deleted > 0) {
        this.logger.log(`DB-002: 清理 ${deleted} 行过期执行日志`);
      }
    } catch (err) {
      this.logger.error(
        `DB-002: 日志保留期清理失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // ARCH-22: 分区预建独立兜底——清理失败不阻断预建（明天分区必须存在）
    if (this.partitionPathEnabled()) {
      try {
        await this.ensureUpcomingPartitions();
      } catch (err) {
        this.logger.error(
          `ARCH-22: 预建未来分区失败: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * ARCH-22: 分区清理路径开关（logPartition.enabled，env
   * LOG_PARTITION_ENABLED，默认 true）。false 时即使库已分区化，
   * 清理仍走 legacy DELETE 批处理路径（rollback 出口）。
   */
  private partitionPathEnabled(): boolean {
    const enabled = this.configService.get<boolean | undefined>(
      "logPartition.enabled",
    );
    if (typeof enabled === "boolean") return enabled;
    // 防御性回退（Joi 已保证 string 合法；测试桩可能未注册该键）
    const raw = this.configService.get<string>("LOG_PARTITION_ENABLED");
    if (raw !== undefined) return raw !== "false";
    return DEFAULT_LOG_PARTITION_ENABLED;
  }

  /**
   * 清理 createdAt 早于保留期截止时间的日志行，返回清理总行数。
   *
   * - 分区库：逐个 DETACH 上界 ≤ cutoff 的分区后 DROP，行数取
   * pg_class.reltuples 估算值（元数据操作无精确行数；返回值仅用于日志）；
   * - legacy 普通表：分批 DELETE（`id IN (SELECT id ... LIMIT 批大小)`），
   *   循环直至单批影响行数小于批大小，避免长事务锁表；定时任务可能
   *   多实例同时运行，按同一条件删除幂等无副作用。
   */
  async cleanupExpiredLines(now: Date = new Date()): Promise<number> {
    const retentionDays = this.resolveRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

    if (await this.isPartitionedTable()) {
      if (!this.partitionPathEnabled()) {
        // 开关关闭的分区库：分区行不能用逐行 DELETE 清理吗？可以，但
        // 分区化初衷就是免 DELETE——开关语义是「回退旧行为」，旧行为在
        // 分区表上同样正确（DELETE 跨分区逐行删，PK 索引在分区键内仍有效）。
        return this.cleanupExpiredLinesByDelete(cutoff);
      }
      return this.cleanupExpiredPartitions(cutoff, now);
    }
    return this.cleanupExpiredLinesByDelete(cutoff);
  }

  /** ARCH-22 主路径：DETACH + DROP 超期分区，返回清理行数（估算） */
  private async cleanupExpiredPartitions(
    cutoff: Date,
    now: Date,
  ): Promise<number> {
    let totalRemoved = 0;
    const partitions = await this.listPartitions();
    for (const p of partitions) {
      const upper = parsePartitionUpperBound(p.bound);
      // 边界不可解析的分区（人工建的非常规边界）：跳过并在日志点名，
      // 绝不误删
      if (!upper) {
        this.logger.warn(
          `ARCH-22: 分区 ${p.name} 边界不可解析（${p.bound}），跳过清理`,
        );
        continue;
      }
      // 分区容纳 [lower, upper)：上界 ≤ cutoff ⇒ 全部分区行均超期，
      // 可整体剥离。边界不可判定（upper > cutoff 但行已超期）属于
      // 单日粒度内的正常延迟，等下一轮 cron。
      if (upper.getTime() > cutoff.getTime()) continue;
      // 安全闸：绝不 detach 未来日期分区（时钟回拨保护）——上界晚于
      // 当前时刻的分区不可能全部超期
      if (upper.getTime() > now.getTime()) continue;

      const rows = Number.isFinite(p.approxRows) ? p.approxRows : 0;
      // DETACH：PG14+ 瞬时元数据操作；并发查询经分区路由不在结果集内
      await this.logLineRepo.query(
        `ALTER TABLE "execution_log_lines" DETACH PARTITION "${p.name}"`,
      );
      // detach 后立即 DROP（决策记录：简单、空间即刻归还；需归档的
      // 场景由 DBA 在告警窗口内人工接管，operations.md 有步骤）
      await this.logLineRepo.query(`DROP TABLE IF EXISTS "${p.name}"`);
      totalRemoved += rows;
      this.logger.log(
        `ARCH-22: 分区 ${p.name} 已超期，DETACH+DROP（估算 ${rows} 行）`,
      );
    }
    return totalRemoved;
  }

  /** ARCH-22: 预建今天+1..+7 的日分区，只建缺失的（幂等可重入） */
  async ensureUpcomingPartitions(now: Date = new Date()): Promise<string[]> {
    if (!(await this.isPartitionedTable())) return [];
    const existing = new Set((await this.listPartitions()).map((p) => p.name));
    const created: string[] = [];
    for (let offset = 1; offset <= 7; offset++) {
      const day = new Date(now.getTime() + offset * 86_400_000);
      const name = partitionNameFor(day);
      if (existing.has(name)) continue;
      const { from, to } = partitionRangeFor(day);
      // IF NOT EXISTS 双保险（多实例 cron 并发时的竞态窗口）
      await this.logLineRepo.query(
        `CREATE TABLE IF NOT EXISTS "${name}"
           PARTITION OF "execution_log_lines"
           FOR VALUES FROM ('${from} 00:00:00') TO ('${to} 00:00:00')`,
      );
      created.push(name);
    }
    if (created.length > 0) {
      this.logger.log(
        `ARCH-22: 未来分区预建 ${created.length} 个（${created.join(", ")}）`,
      );
    }
    return created;
  }

  /** 判定运行库中 execution_log_lines 是否已分区化（relkind='p'） */
  private async isPartitionedTable(): Promise<boolean> {
    const rows: { relkind: string }[] = (await this.logLineRepo.query(
      `SELECT c.relkind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = 'execution_log_lines'`,
    )) as { relkind: string }[];
    return rows.length > 0 && rows[0].relkind === "p";
  }

  /** 枚举 execution_log_lines 的直接子分区（名 + 边界表达式 + 估算行数） */
  private async listPartitions(): Promise<
    { name: string; bound: string; approxRows: number }[]
  > {
    const rows: { name: string; bound: string; approxRows: string | null }[] =
      (await this.logLineRepo.query(
        `SELECT c.relname AS name,
                pg_get_expr(c.relpartbound, c.oid) AS bound,
                c.reltuples::bigint::text AS "approxRows"
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_inherits i ON i.inhrelid = c.oid
          WHERE i.inhparent = '"execution_log_lines"'::regclass
            AND n.nspname = current_schema()
          ORDER BY c.relname`,
      )) as { name: string; bound: string; approxRows: string | null }[];
    return rows.map((r) => {
      const parsed = parseInt(r.approxRows ?? "0", 10);
      return {
        name: r.name,
        bound: r.bound,
        approxRows: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
      };
    });
  }

  /**
   * legacy fallback：分批 DELETE（ARCH-22 前的既有行为，逐行保留）。
   * 分区表上同样可用（开关回退路径），PK (id, createdAt) 不影响
   * `id IN (...)` 子查询语义。
   */
  private async cleanupExpiredLinesByDelete(cutoff: Date): Promise<number> {
    let totalDeleted = 0;
    let batchDeleted = 0;
    do {
      const result = await this.logLineRepo
        .createQueryBuilder()
        .delete()
        .where(
          `"id" IN (
            SELECT "victim"."id" FROM "execution_log_lines" "victim"
            WHERE "victim"."createdAt" < :cutoff
            ORDER BY "victim"."id"
            LIMIT :batchSize
          )`,
          { cutoff, batchSize: LOG_RETENTION_BATCH_SIZE },
        )
        .execute();
      batchDeleted = result.affected ?? 0;
      totalDeleted += batchDeleted;
      if (batchDeleted > 0) {
        this.logger.debug(
          `DB-002: 本批清理 ${batchDeleted} 行（截止 ${cutoff.toISOString()}）`,
        );
      }
    } while (batchDeleted >= LOG_RETENTION_BATCH_SIZE);

    return totalDeleted;
  }

  /**
   * 解析保留期：经 ConfigService 读 logRetention.days（ARCH-27 收口）。
   * Joi 保证 LOG_RETENTION_DAYS 是 >=1 的整数，正常路径不会走回退；
   * 保留防御性回退（非数字 / <= 0）以兼容跳过 Joi 校验的测试场景。
   */
  private resolveRetentionDays(): number {
    const parsed = this.configService.get<number>("logRetention.days");
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    const rawValue = this.configService.get<string>("LOG_RETENTION_DAYS");
    if (rawValue !== undefined) {
      this.logger.warn(
        `DB-002: 非法的 LOG_RETENTION_DAYS="${rawValue}"，回退默认 ${DEFAULT_LOG_RETENTION_DAYS} 天`,
      );
    }
    return DEFAULT_LOG_RETENTION_DAYS;
  }
}
