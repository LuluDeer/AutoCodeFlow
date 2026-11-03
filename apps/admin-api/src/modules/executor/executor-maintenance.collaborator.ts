import { Logger } from "@nestjs/common";
import type { Repository } from "typeorm";
import { cappedBatchedDelete } from "../../common/utils/capped-batched-delete.util";
import { S3LogStorage } from "../task/log-storage/s3-log-storage";
import type { ExecutorMetricsHistory } from "./entities/executor-metrics-history.entity";
import type { ExecutorRetentionConfigReader } from "./executor-maintenance.types";

/**
 * 执行器域的**维护（retention）纯逻辑**协作者（T1-B2-X5 第一片）。
 *
 * ## ⚠️ 边界：`@Cron` 与 `leaderGate` **不在这里**
 *
 * 本簇有 5 个 `@Cron` 入口（`detectLostExecutions` / `cleanupOldRecords` /
 * `cleanupMetricsHistory` / `markStaleOffline` / `cleanupOfflineExecutors`），
 * **全部留在 Facade**（`ExecutorService`）。三条理由（实测）：
 *
 * 1. **`@Cron` 是 Nest 生命周期装饰器**，只能挂在**被容器实例化并注册的
 *    provider** 上（`@nestjs/schedule` 只扫描容器内 provider 的元数据）。本类是
 *    `new` 出来的普通对象（非 provider）⇒ 在这里挂 `@Cron` **不会生效**，
 *    且失效是**静默的**（不会报错，只是永不触发）。
 * 2. **`leaderGate` 门禁的位置本身是一条不变量**：Facade 源码注释写明「门禁必须
 *    留在 `@Cron` 方法体内」，挪到调用链外层会让**非 Leader 实例仍注册定时器
 *    并空转**。搬走门禁等于把这条不变量从"读得到"变成"散落在两处"。
 * 3. `scripts/check-cron-guard.mjs` 这类守卫按**形态**扫描 `@Cron` 方法体；
 *    结构一挪就可能失配 —— **守卫类不变量被结构调整破坏，比结构没拆更糟**。
 *
 * ⇒ 本类只收「清理做什么、怎么算保留期、怎么分批删」这些**纯逻辑**；
 * 「谁被调度、谁是 Leader」留在 Facade。
 *
 * ## self-call 禁令（B2 起对本仓所有协作者生效）
 *
 * 本类**不得**直接调用自身的方法来完成一次外部可见的动作（例如内部直调
 * `this.cleanupExpiredMetricsHistory()`）。原因：Facade 转发层同时是
 * **spy 拦截面** —— 既有 spec 用 `jest.spyOn(service, "cleanupOldTaskExecutions")`
 * 断言「确实走了这个方法」。若协作者内部直调自己的同名方法，spy 装在 Facade
 * 上就拦不到，**既有的实现级断言会静默失效**（不是报错，是悄悄不生效）。
 *
 * 纯私有计算（如 `resolveMetricsRetentionDays` 内部算 cutoff）不受此限。
 */

/** `cappedBatchedDelete` 的批大小（与 Facade 的静态常量同源）。 */
export const METRICS_RETENTION_BATCH_SIZE = 5000;

/** 指标历史默认保留天数（对齐 `logRetention.days` 的缺省）。 */
export const DEFAULT_METRICS_RETENTION_DAYS = 30;

/** 离线执行器台账默认保留天数。 */
export const DEFAULT_EXECUTOR_RETENTION_DAYS = 7;

/** 运行期配置键（中台「系统设置 → 系统配置」可改）。 */
export const EXECUTOR_RETENTION_CONFIG_KEY = "executor.retentionDays";

/** 协作者依赖（全部最小面）。 */
export interface ExecutorMaintenanceDeps {
  /** 指标历史仓库（只用于分批 DELETE）。 */
  metricsHistoryRepo: Repository<ExecutorMetricsHistory>;
  /** ConfigService（只用到 `get`）。 */
  configService: {
    get<T = unknown>(key: string): T | undefined;
  };
  /** 运行期配置读取（system_configs；Facade 的 systemConfigService，可缺席）。 */
  systemConfig: ExecutorRetentionConfigReader | null;
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
}

export class ExecutorMaintenance {
  private readonly metricsHistoryRepo: Repository<ExecutorMetricsHistory>;
  private readonly configService: ExecutorMaintenanceDeps["configService"];
  private readonly systemConfig: ExecutorRetentionConfigReader | null;
  private readonly logger: Logger;
  /**
   * 惰性解析的 S3 日志后端（`fromConfig` 是进程内单例语义，缓存于本实例）。
   *
   * 为什么缓存挂在协作者而不是 Facade：它是**本类私有的一次性解析结果**，
   * 不参与任何外部可观测语义（无 spec 断言它）。迁移前后行为等价：
   * 解析一次、结果复用、非 s3 驱动恒返回 null。
   */
  private s3LogStorage: S3LogStorage | null = null;
  private s3LogStorageResolved = false;

  constructor(deps: ExecutorMaintenanceDeps) {
    this.metricsHistoryRepo = deps.metricsHistoryRepo;
    this.configService = deps.configService;
    this.systemConfig = deps.systemConfig;
    this.logger = deps.logger;
  }

  /**
   * NETOPT-8①: 惰性解析可选 S3 日志后端（`S3LogObjectRetentionService` /
   * `TaskService.resolveS3Storage` 同款）。非 s3 驱动返回 null，
   * retention 走既有直删路径。
   */
  resolveS3LogStorage(): S3LogStorage | null {
    if (!this.s3LogStorageResolved) {
      this.s3LogStorage = S3LogStorage.fromConfig(
        this.configService as never,
      );
      this.s3LogStorageResolved = true;
    }
    return this.s3LogStorage;
  }

  /**
   * R-09: 解析指标历史保留期（复用 `logRetention.days`，对齐
   * `artifacts-retention` 口径）。非法值（非数字 / ≤0 / NaN）一律回落 30。
   *
   * ⚠️ **刻意 private**：它是**纯私有计算**（只服务本类的
   * `cleanupExpiredMetricsHistory`，外部无 spy 依赖）⇒ 若做成 public，本类
   * 内部调用它就成了 self-call，会被 `check-collaborator-self-call.mjs` 拦下。
   * 判据的意图正是把这类「纯计算」与「外部可见动作」分开。
   */
  private resolveMetricsRetentionDays(): number {
    const parsed = this.configService.get<number>("logRetention.days");
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return DEFAULT_METRICS_RETENTION_DAYS;
  }

  /**
   * 2026-10-23：离线执行器台账保留天数。
   *
   * 读取顺序：`system_configs.executor.retentionDays`（运行期可改、即时生效）
   * → 常量 7。非法值（非数字 / ≤0 / NaN）一律回落常量——这是**不可逆删除**
   * 的判定参数，宁可保守也不要因为一个脏配置把台账清空。
   * 读配置失败（键不存在 / 服务暂不可用）静默回落，不让清理 cron 挂掉。
   */
  async resolveExecutorRetentionDays(): Promise<number> {
    try {
      const row = await this.systemConfig?.findOne(
        EXECUTOR_RETENTION_CONFIG_KEY,
      );
      const parsed = Number.parseInt(row?.value ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch {
      // 未配置 / 读取失败：回落默认值
    }
    return DEFAULT_EXECUTOR_RETENTION_DAYS;
  }

  /**
   * R-09: 删除 `createdAt` 早于保留期截止的指标历史行，返回清理总行数。
   *
   * `now` 可注入以便测试（既有 spec 依赖这一点）。分批 DELETE 对齐
   * `log-retention-cleanup` 的 `cleanupExpiredLinesByDelete` 模式；
   * NETOPT-8④: 循环收口走公共 `cappedBatchedDelete`（LOG-RETENTION-01
   * 轮数/墙钟双闸，防 affected 恒满批时无界循环 OOM）。
   */
  async cleanupExpiredMetricsHistory(now: Date = new Date()): Promise<number> {
    const retentionDays = this.resolveMetricsRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    return cappedBatchedDelete({
      batchSize: METRICS_RETENTION_BATCH_SIZE,
      logLabel: "R-09",
      logger: this.logger,
      executeBatch: async () => {
        const result = await this.metricsHistoryRepo
          .createQueryBuilder()
          .delete()
          .where(
            `"id" IN (
              SELECT "victim"."id" FROM "executor_metrics_history" "victim"
              WHERE "victim"."createdAt" < :cutoff
              ORDER BY "victim"."id"
              LIMIT :batchSize
            )`,
            { cutoff, batchSize: METRICS_RETENTION_BATCH_SIZE },
          )
          .execute();
        return result.affected ?? 0;
      },
    });
  }
}
