import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import {
  TaskExecution,
  ExecutionStatus,
} from "../entities/task-execution.entity";
import { S3LogStorage } from "../log-storage/s3-log-storage";
import { DEFAULT_LOG_RETENTION_DAYS } from "./log-retention-cleanup.service";

/** 每日 03:35 对象回收（6 段 cron；与 DB 日志行清理 03:30 / 产物清理 03:45
 *  错峰——独立 cron 入口互不阻塞，单边慢/失败不影响另两边） */
export const S3_LOG_OBJECT_RETENTION_CRON = "0 35 3 * * *";
/** 单批最大处理执行行数：限制单轮 SELECT 窗口与 S3 突发删除速率 */
export const S3_LOG_OBJECT_BATCH_SIZE = 200;
/** 单次 pass 最大轮数（200 × 50 = 每晚至多回收 1 万个对象；余量交下一轮 cron） */
export const S3_LOG_OBJECT_MAX_ROUNDS = 50;

/**
 * 终态集合：仅终态执行的日志对象可回收。PENDING/RUNNING 的日志仍会被
 * 回调/回填链路续写（storeLogLines 以 executionId 确定性复用对象键），
 * 提前删对象会让在途执行丢日志。
 */
export const TERMINAL_EXECUTION_STATUSES: ExecutionStatus[] = [
  ExecutionStatus.SUCCESS,
  ExecutionStatus.FAILED,
  ExecutionStatus.TIMEOUT,
  ExecutionStatus.KILLED,
  ExecutionStatus.CANCELLED,
];

/**
 * WIKI-LOG-S3GC（wiki page-47 风险 6，也是 log-retention-cleanup.service
 * 头注自标的"后续专门任务"）：S3 完整日志对象的保留期回收。
 *
 * 背景：LOG_STORAGE_DRIVER=s3 时完整日志外置为 MinIO/S3 gzip 对象
 * （log-storage/s3-log-storage.ts，execution-logs/<execId>.log.gz），且 S3
 * 成功路径下 execution_log_lines **不写 DB 行**——DB 侧行清理
 * （log-retention-cleanup.service）对这部分执行是空转，对象存储侧若不
 * 回收则随历史执行无限累积。过期信号只能来自 task_executions：
 * `logStorage='s3'` 且 `logObjectKey` 非空、status 属终态集合、终态时间早于
 * 保留期截止（logRetention.days，与 DB 行清理同源配置）。终态时间用
 * `COALESCE(endTime, createdAt)`：endTime 是执行终态落库的时间列（domain
 * event 的 finishedAt 即由它派生），终态行理论必有值；NULL 回退 createdAt
 * 仅为保证异常行的回收进度不永久卡死（createdAt 非空 @CreateDateColumn）。
 *
 * 单轮 pass：keyset 分页（ORDER BY id + id > 游标）批量取候选 → 逐行
 * `S3LogStorage.remove(logObjectKey)` → 成功后**带守卫**清指针
 * （`SET logObjectKey = NULL WHERE id = ? AND logObjectKey = ?`，防并发
 * 重复删/误清——指针若已被并发实例改写则守卫不命中，对象幂等删过即达成，
 * 指针留给下一轮自然收敛）。游标无条件前进：remove 失败的行也不在本
 * pass 内空转重访（下轮 cron 再试）。
 *
 * 幂等与 fail-open：S3/MinIO 对不存在键的 DELETE 返回成功（204）语义，
 * removeObject 不做先 stat 后删（与 getObject/statObject 不同，无 NoSuchKey
 * 抛点），对象已删时重跑 remove 不抛错——无需调用方吞 NotFound；remove/
 * 清指针失败仅记 warn 跳过该行（指针保留=下轮还能找到对象），单行失败
 * 不阻断其余行；整段 pass 异常与 handleDailyCleanup 同姿态——记 error
 * 不抛出，等下一轮 cron。
 *
 * 启用判定：复用 S3LogStorage.fromConfig（logStorage.driver==='s3' 且
 * endpoint 非空），非 s3 驱动整段 no-op；解析结果进程内单例缓存
 * （TaskService.resolveS3Storage 同款惰性模式，MinIO Client 构造无 I/O）。
 *
 * 查询代价说明：task_executions 无 logStorage 索引（status 有单列索引），
 * 本查询为低频（每日一轮）全表过滤 + LIMIT 批量，代价可接受；历史行增长
 * 到需要时再补部分索引（WHERE logStorage='s3' AND logObjectKey IS NOT NULL），
 * 本任务零迁移。
 *
 * 注册方式：TaskModule providers 装配；@Cron 由 SchedulerModule 中的
 * ScheduleModule.forRoot() 通过全局 DiscoveryService 扫描注册。
 */
@Injectable()
export class S3LogObjectRetentionService {
  private readonly logger = new Logger(S3LogObjectRetentionService.name);
  private s3Storage: S3LogStorage | null = null;
  private s3StorageResolved = false;

  constructor(
    @InjectRepository(TaskExecution)
    private readonly execRepo: Repository<TaskExecution>,
    private readonly configService: ConfigService,
  ) {}

  /** 每日定时入口；回收失败只记日志，等下一轮 cron 重试，不影响主流程 */
  @Cron(S3_LOG_OBJECT_RETENTION_CRON)
  async handleDailyObjectCleanup(): Promise<void> {
    try {
      const removed = await this.cleanupExpiredObjects();
      if (removed > 0) {
        this.logger.log(`WIKI-LOG-S3GC: 回收 ${removed} 个过期 S3 日志对象`);
      }
    } catch (err) {
      this.logger.error(
        `WIKI-LOG-S3GC: S3 日志对象回收失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 回收终态且超过保留期的 S3 日志对象，返回成功 remove 的对象数。
   * now 可注入便于测试。keyset 分页保证每个候选在单次 pass 内至多访问
   * 一次；每轮批量 S3_LOG_OBJECT_BATCH_SIZE、至多 S3_LOG_OBJECT_MAX_ROUNDS
   * 轮（达上限时剩余候选留给下一轮 cron，日志可见）。
   */
  async cleanupExpiredObjects(now: Date = new Date()): Promise<number> {
    const s3 = this.resolveS3Storage();
    // 非 s3 驱动（driver=db，或 s3 但 endpoint 未配）：整段 no-op
    if (!s3) return 0;

    const retentionDays = this.resolveRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

    let reclaimed = 0;
    let afterId: string | null = null;
    for (let round = 1; round <= S3_LOG_OBJECT_MAX_ROUNDS; round++) {
      const batch = await this.selectExpiredBatch(cutoff, afterId);
      if (batch.length === 0) return reclaimed;
      for (const row of batch) {
        const key = row.logObjectKey;
        // 查询条件已过滤 logObjectKey IS NOT NULL；此处仅作类型收窄防御
        if (!key) continue;
        afterId = row.id;
        try {
          await s3.remove(key);
        } catch (err) {
          // fail-open：删不掉就跳过，指针保留 = 下轮 cron 仍能定位该对象
          this.logger.warn(
            `WIKI-LOG-S3GC: S3 对象删除失败，跳过 execution ${row.id}（${key}）: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        try {
          // 守卫清指针：仅当指针仍指刚删的对象才清（防并发重复删/误清）
          await this.execRepo.update(
            { id: row.id, logObjectKey: key },
            { logObjectKey: null },
          );
        } catch (err) {
          // 清指针失败不致错删：对象已回收，下轮 remove 幂等成功后再补清
          this.logger.warn(
            `WIKI-LOG-S3GC: 清空 logObjectKey 失败（execution ${row.id}，指针留待下轮）: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        reclaimed++;
      }
      if (batch.length < S3_LOG_OBJECT_BATCH_SIZE) return reclaimed;
    }
    this.logger.warn(
      `WIKI-LOG-S3GC: 单次回收达轮数上限 ${S3_LOG_OBJECT_MAX_ROUNDS}，剩余候选等下一轮 cron`,
    );
    return reclaimed;
  }

  /**
   * 取一批候选行（仅 id + logObjectKey 两列）：s3 指针 + 终态 + 终态时间
   * 早于截止。afterId 非空时追加 keyset 游标（首轮无游标——task_executions.id
   * 是 uuid，空串不是合法 uuid 字面量，不能作哨兵值）。
   */
  private selectExpiredBatch(
    cutoff: Date,
    afterId: string | null,
  ): Promise<TaskExecution[]> {
    const qb = this.execRepo
      .createQueryBuilder("e")
      .select(["e.id", "e.logObjectKey"])
      .where("e.logStorage = :logStorage", { logStorage: "s3" })
      .andWhere("e.logObjectKey IS NOT NULL")
      .andWhere("e.status IN (:...terminalStatuses)", {
        terminalStatuses: TERMINAL_EXECUTION_STATUSES,
      })
      .andWhere("COALESCE(e.endTime, e.createdAt) < :cutoff", { cutoff })
      .orderBy("e.id", "ASC")
      .take(S3_LOG_OBJECT_BATCH_SIZE);
    if (afterId !== null) {
      qb.andWhere("e.id > :afterId", { afterId });
    }
    return qb.getMany();
  }

  /** 惰性解析可选 S3 后端（TaskService.resolveS3Storage 同款：进程内单例） */
  private resolveS3Storage(): S3LogStorage | null {
    if (!this.s3StorageResolved) {
      this.s3Storage = S3LogStorage.fromConfig(this.configService);
      this.s3StorageResolved = true;
    }
    return this.s3Storage;
  }

  /**
   * 解析保留期：与 LogRetentionCleanupService.resolveRetentionDays 同源同款
   * （logRetention.days，ARCH-27 收口；防御性回退默认值，默认常量直接复用
   * 该服务导出，避免第二份真值）。默认 30 天。
   */
  private resolveRetentionDays(): number {
    const parsed = this.configService.get<number>("logRetention.days");
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    const rawValue = this.configService.get<string>("LOG_RETENTION_DAYS");
    if (rawValue !== undefined) {
      this.logger.warn(
        `WIKI-LOG-S3GC: 非法的 LOG_RETENTION_DAYS="${rawValue}"，回退默认 ${DEFAULT_LOG_RETENTION_DAYS} 天`,
      );
    }
    return DEFAULT_LOG_RETENTION_DAYS;
  }
}
