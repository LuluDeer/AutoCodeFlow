import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
import { promises as fs } from "node:fs";
import v8 from "node:v8";
import { Task, TaskStatus } from "../task/entities/task.entity";
import { Executor, ExecutorStatus } from "../executor/entities/executor.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../task/entities/task-execution.entity";
import { createClient, RedisClientType } from "redis";

/**
 * getFullHealth 的完整响应结构。
 * WIKI-OPT-1：从方法签名的内联匿名类型抽出为具名接口——tasks 检查
 * 补充 unhealthy/details 分支后 services.tasks 类型需同步扩展，
 * 且 getFullHealth 的短 TTL 缓存需要复用同一类型作缓存载荷。
 */
export interface FullHealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  services: {
    database: { status: "healthy" | "unhealthy"; details?: string };
    redis: { status: "healthy" | "unhealthy"; details?: string };
    queue: {
      status: "healthy" | "degraded" | "unhealthy";
      details?: string;
      size?: number;
    };
    executors: {
      status: "healthy" | "degraded" | "unhealthy";
      onlineCount: number;
      totalCount: number;
      details?: string;
    };
    tasks: {
      status: "healthy" | "degraded" | "unhealthy";
      activeCount: number;
      totalCount: number;
      runningCount: number;
      details?: string;
    };
    scheduler: { status: "healthy" | "unhealthy"; details?: string };
    // PLAN-OBSERVABILITY §5.1（2026-10-17 优化计划轮）：磁盘与堆水位。
    // 此前 /health/detailed 会在容器文件系统 99% 满、V8 堆耗尽时照样报
    // healthy——磁盘写满后新执行的日志/产物写入全部失败，堆耗尽则进程
    // 直接 OOM 崩溃，两者都是"看着绿、其实马上要挂"的形态。
    // 刻意**不**纳入 /health/ready（就绪探针只管核心依赖，磁盘慢不会让
    // 流量需要被摘除；纳入会让一次日志堆积触发全站摘流量）。
    disk: {
      status: "healthy" | "degraded" | "unhealthy";
      details?: string;
      usedPercent?: number;
    };
    memory: {
      status: "healthy" | "degraded" | "unhealthy";
      details?: string;
      heapUsedBytes?: number;
      heapLimitBytes?: number;
      heapUsedPercent?: number;
    };
  };
  metrics: {
    totalTasks: number;
    activeTasks: number;
    runningExecutions: number;
    totalExecutors: number;
    onlineExecutors: number;
    queueSize: number;
  };
  components: Array<{
    name: string;
    status: "healthy" | "degraded" | "unhealthy";
    message?: string;
  }>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private redisClient: RedisClientType;

  // WIKI-OPT-1: 判定阈值配置化（configuration.ts health 节）——队列积压
  // 三项阈值与执行器在线比例下限此前硬编码于 checkQueue/checkExecutors，
  // 默认值与原硬编码保持一致（100/500/1000/0.5），行为不变。
  private readonly queueFailedMax: number;
  private readonly queueDelayedMax: number;
  private readonly queueWaitingMax: number;
  private readonly executorOnlineRatioMin: number;
  // WIKI-OPT-1: getFullHealth 短 TTL 缓存窗口（ms）。默认 0 = 关闭，
  // 行为与未缓存完全一致；>0 时 TTL 窗口内直接返回缓存的整个响应对象
  // （含 timestamp），供探针高频轮询降压。live/ready 探针不缓存。
  private readonly cacheTtlMs: number;
  private fullHealthCache: {
    expiresAt: number;
    payload: FullHealthReport;
  } | null = null;
  // NETOPT-5④: 公开拨测路径的独立短 TTL 缓存（默认 5s，env
  // HEALTH_PUBLIC_CACHE_TTL_MS 可调，0 = 关闭）。getPublicHealth 虽复用
  // getFullHealth，但后者缓存默认关闭（health.cacheTtlMs=0）——公开端点
  // 未鉴权、可被外部监控高频击打，全量计算（DB count×N + Redis ping +
  // 队列统计）每次真跑既浪费又被放大成负载面。只缓存 {status, timestamp}
  // 投影（R-25 语义不变，不暴露任何内部指标），与 getFullHealth 缓存槽
  // 互不影响。
  private readonly publicCacheTtlMs: number;
  private publicHealthCache: {
    expiresAt: number;
    payload: {
      status: "healthy" | "degraded" | "unhealthy";
      timestamp: string;
    };
  } | null = null;
  // PLAN-OBSERVABILITY §5.1：磁盘 / 堆水位阈值（configuration.ts health 节，
  // 默认值与 alert 侧保守起点一致）。
  private readonly diskUsageDegradedPercent: number;
  private readonly diskUsageUnhealthyPercent: number;
  private readonly heapUsedDegradedPercent: number;
  private readonly heapUsedUnhealthyPercent: number;
  // 磁盘检查探测路径（默认进程 cwd——admin-api 的日志与上传产物都落在这里，
  // 是真正会被写满的那块盘，不是 /tmp）。
  private readonly diskCheckPath: string;

  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(Executor) private executorRepo: Repository<Executor>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectQueue("task-queue") private taskQueue: Queue,
    private readonly configService: ConfigService,
  ) {
    const host = this.configService.get<string>("REDIS_HOST", "localhost");
    const port = this.configService.get<number>("REDIS_PORT", 6379);
    const password = this.configService.get<string>("REDIS_PASSWORD");
    // NETOPT-5②: ARCH-005 的 REDIS_TLS 同源透传。此前健康检查专线硬编码
    // 明文 redis://，REDIS_TLS=true 时 ioredis/BullMQ 全走 TLS，唯独本
    // 客户端连明文端口——TLS-only 的 Redis 上 ping 必然失败（健康检查
    // 误报），明文兼容实例上则白白多开一条未加密连接。配置源与语义对齐
    // app.module BullMQ 侧：socket.tls = redis.tls，证书校验跟随
    // redis.tlsRejectUnauthorized（默认 true，自签环境显式置 false）。
    const tlsEnabled = this.configService.get<boolean>("redis.tls") === true;
    this.redisClient = createClient({
      url: `redis://${host}:${port}`,
      password: password || undefined,
      database: this.configService.get<number>("redis.db", 0),
      ...(tlsEnabled
        ? {
            socket: {
              tls: true,
              rejectUnauthorized:
                this.configService.get<boolean>(
                  "redis.tlsRejectUnauthorized",
                ) !== false,
            },
          }
        : {}),
    });

    // ── ARCH-008（杀死进程的根因修复）──────────────────────────────────
    // **必须**注册 error 监听器。node-redis 的 `RedisClient extends EventEmitter`，
    // 而 EventEmitter 在**没有任何 'error' 监听器**时 `emit('error')` 会直接
    // throw —— 底层 socket 一断（Redis 重启 / 网络抖动 / 空闲连接被掐），
    // socket 层的 `emit('error')` 就变成进程级 uncaughtException，冒泡到
    // main.ts 的 `process.on("uncaughtException")` → gracefulFatalShutdown
    // → 10s 硬超时 `process.exit(1)`。**整个 admin-api 实例随之消失**，
    // 直到外部守护（宝塔 nohup 轮询）把它拉起——生产实测造成两次 ~10s 与
    // ~3 分钟的全站 502 黑洞。
    //
    // 本客户端是**全仓唯一**没挂该监听器的 Redis 客户端，而它能杀死进程的
    // 原因在于库不同：另外两处 ioredis 客户端（executor-pull / redis-lock）
    // 是**显式手挂**，BullMQ 的共享连接则是 ioredis 自带 `silentEmit` 保护
    // ——ioredis 在无监听器时只 `console.error` 后返回，**不 throw**；
    // node-redis 没有这层保护。故"同样的疏忽"只有此处致命。
    //
    // 健康检查客户端尤其不该有这个杀伤半径：它只服务 /health 读面，Redis
    // 不可用时应**如实报 unhealthy**（下方 checkRedis 已有 try/catch 兜底），
    // 而不是让整个控制平面退出。
    this.redisClient.on("error", (err: Error) => {
      this.logger.error(`Health-check redis client error: ${err.message}`);
    });

    this.queueFailedMax = this.configService.get<number>(
      "health.queueFailedMax",
      100,
    );
    this.queueDelayedMax = this.configService.get<number>(
      "health.queueDelayedMax",
      500,
    );
    this.queueWaitingMax = this.configService.get<number>(
      "health.queueWaitingMax",
      1000,
    );
    this.executorOnlineRatioMin = this.configService.get<number>(
      "health.executorOnlineRatioMin",
      0.5,
    );
    this.cacheTtlMs = this.configService.get<number>("health.cacheTtlMs", 0);
    // NETOPT-5④: 公开拨测缓存窗口，默认 5s（0 = 关闭），见 publicHealthCache 注释
    this.publicCacheTtlMs = this.configService.get<number>(
      "health.publicCacheTtlMs",
      5_000,
    );
    this.diskUsageDegradedPercent = this.configService.get<number>(
      "health.diskUsageDegradedPercent",
      85,
    );
    this.diskUsageUnhealthyPercent = this.configService.get<number>(
      "health.diskUsageUnhealthyPercent",
      95,
    );
    this.heapUsedDegradedPercent = this.configService.get<number>(
      "health.heapUsedDegradedPercent",
      85,
    );
    this.heapUsedUnhealthyPercent = this.configService.get<number>(
      "health.heapUsedUnhealthyPercent",
      95,
    );
    this.diskCheckPath = this.configService.get<string>(
      "health.diskCheckPath",
      process.cwd(),
    );
  }

  async checkDatabase(): Promise<{
    status: "healthy" | "unhealthy";
    details?: string;
  }> {
    try {
      await this.taskRepo.query("SELECT 1");
      return { status: "healthy" };
    } catch (error: unknown) {
      return {
        status: "unhealthy",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkRedis(): Promise<{
    status: "healthy" | "unhealthy";
    details?: string;
  }> {
    try {
      if (!this.redisClient.isReady) {
        await this.redisClient.connect();
      }
      await this.redisClient.ping();
      return { status: "healthy" };
    } catch (error: unknown) {
      return {
        status: "unhealthy",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkQueue(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    details?: string;
    size?: number;
  }> {
    try {
      const [waiting, active, delayed, failed] = await Promise.all([
        this.taskQueue.getWaitingCount(),
        this.taskQueue.getActiveCount(),
        this.taskQueue.getDelayedCount(),
        this.taskQueue.getFailedCount(),
      ]);

      const total = waiting + active + delayed + failed;
      // WIKI-OPT-1: 阈值改读配置（health.queue*Max），原硬编码
      // failed > 100 || delayed > 500 || waiting > 1000 保持为默认值。
      const hasIssues =
        failed > this.queueFailedMax ||
        delayed > this.queueDelayedMax ||
        waiting > this.queueWaitingMax;

      return {
        status: hasIssues ? "degraded" : "healthy",
        size: total,
        details: hasIssues
          ? `High queue backlog: waiting=${waiting}, active=${active}, delayed=${delayed}, failed=${failed}`
          : undefined,
      };
    } catch (error: unknown) {
      return {
        status: "unhealthy",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkExecutors(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    onlineCount: number;
    totalCount: number;
    details?: string;
  }> {
    // WIKI-OPT-1: 补异常捕获边界——此前本检查无 try/catch，任一 count
    // reject 会击穿 getFullHealth 的 Promise.all（HTTP 500），而非返回带
    // 组件详情的 unhealthy 响应（对齐其余单项检查的行为）。
    try {
      const [onlineCount, totalCount] = await Promise.all([
        this.executorRepo.count({ where: { status: ExecutorStatus.ONLINE } }),
        this.executorRepo.count(),
      ]);

      if (totalCount === 0) {
        return {
          status: "degraded",
          onlineCount: 0,
          totalCount: 0,
          details: "No executors registered",
        };
      }

      if (onlineCount === 0) {
        return {
          status: "unhealthy",
          onlineCount: 0,
          totalCount,
          details: "All executors are offline",
        };
      }

      const onlineRatio = onlineCount / totalCount;
      // WIKI-OPT-1: 在线比例下限改读配置（health.executorOnlineRatioMin），
      // 原硬编码 0.5 保持为默认值。
      if (onlineRatio < this.executorOnlineRatioMin) {
        return {
          status: "degraded",
          onlineCount,
          totalCount,
          details: `Only ${Math.round(onlineRatio * 100)}% of executors are online`,
        };
      }

      return { status: "healthy", onlineCount, totalCount };
    } catch (error: unknown) {
      return {
        status: "unhealthy",
        onlineCount: 0,
        totalCount: 0,
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkTasks(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    activeCount: number;
    totalCount: number;
    runningCount: number;
    details?: string;
  }> {
    // WIKI-OPT-1: 补异常捕获边界——此前本检查无 try/catch，任一 count
    // reject 会击穿 getFullHealth 的 Promise.all（HTTP 500）。失败时计数
    // 归零并附错误详情，status 扩展 unhealthy 分支（类型同步扩展）。
    try {
      const [activeCount, totalCount, runningCount] = await Promise.all([
        this.taskRepo.count({ where: { status: TaskStatus.ACTIVE } }),
        this.taskRepo.count(),
        this.execRepo.count({ where: { status: ExecutionStatus.RUNNING } }),
      ]);

      return {
        status: "healthy",
        activeCount,
        totalCount,
        runningCount,
      };
    } catch (error: unknown) {
      return {
        status: "unhealthy",
        activeCount: 0,
        totalCount: 0,
        runningCount: 0,
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkScheduler(): Promise<{
    status: "healthy" | "unhealthy";
    details?: string;
  }> {
    try {
      // NETOPT-5④: getJobCounts 由 Redis 侧聚合，替代此前 getJobs(["wait",
      // "active"]) 全量物化——积压数千时旧写法逐 job hgetall 只为取个数
      // （scheduler.service.ts getQueueDepth 的既有注释同因）。wait/active
      // 缺键时 BullMQ 返回 0，防 null 相加。
      const counts = await this.taskQueue.getJobCounts("wait", "active");
      const total = Number(counts?.wait ?? 0) + Number(counts?.active ?? 0);
      // 第二轮审计（A7）：此前只读队列计数即报 healthy——只要 Redis 可达就绿，
      // 不含任何调度活性依据（BullMQ worker 全部掉线时照样绿，而此刻入队的
      // 执行永远不会被拾取）。最小可行修法：补 getWorkersCount——worker 注册
      // 在 Redis 的 workers 集合，计数为 0 即为真实故障信号。
      //
      // 取舍（审计项要求注明）：调度循环的 tick 心跳（SchedulerMetricsService
      // 的 lastTickAt）需要 HealthModule 引入 SchedulerModule 依赖 + tick 间隔
      // 阈值配置，耦合与误报面都更大，本轮不取；worker 在位是零耦合、零新配置
      // 的次强信号。残留边界在 details 如实标注：本检查语义是「队列可达性 +
      // worker 在位」，**不含**调度循环 tick 节奏测量。
      const workers = await this.taskQueue.getWorkersCount();
      if (workers === 0) {
        return {
          status: "unhealthy",
          details:
            "No BullMQ worker is connected to task-queue; queued executions will never be picked up " +
            `(wait=${counts?.wait ?? 0}, active=${counts?.active ?? 0})`,
        };
      }
      return {
        status: "healthy",
        details:
          `Scheduler queue reachable, ${workers} worker(s) connected, ${total} jobs in queue ` +
          "(queue + worker reachability only; scheduler tick cadence is not measured here)",
      };
    } catch (error: unknown) {
      return {
        status: "unhealthy",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * PLAN-OBSERVABILITY §5.1：磁盘水位检查。
   *
   * 为什么需要：admin-api 的日志、上传产物、临时下载都写在容器本地盘上，
   * 盘满之后**新执行的日志/产物写入全部失败**，而在此之前所有既有健康
   * 检查（DB/Redis/队列/执行器/调度器）都还是绿的——运维唯一的信号是
   * 执行开始成批 FAILED（AUTOFLOW_EXECUTION_FAILURE_STORM），那时已经
   * 晚了。本检查把"还有多少空间"变成一条可探针化的信号。
   *
   * 实现取舍：用 `fs.promises.statfs`（Node 18.15+ 稳定，Node 24 环境无需
   * 实验标志）读文件系统块统计，而不是引入 `check-disk-space` 依赖——本
   * 模块现有零外部依赖的姿态（只用 node:fs / node:os 等价物）保持不变。
   * statfs 在部分平台/文件系统上可能 ENOSYS，故整体 try/catch：**读不到
   * 水位时报 degraded 并如实标注，而不是报 healthy 假装一切正常**（未知
   * ≠ 健康，这与 AUTOFLOW_EXECUTOR_DISK_USAGE_* 的"旧执行器缺席而非 0"
   * 同一取舍：不臆造数值）。
   */
  async checkDisk(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    details?: string;
    usedPercent?: number;
  }> {
    try {
      const stats = await fs.statfs(this.diskCheckPath);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      // bfree 含 root 保留块，bavail 才是非特权进程真正能写的量。容器内
      // 进程常以非 root 运行（Dockerfile 的 USER appuser），用 bavail 才
      // 反映真实可用空间——用 bfree 会在保留块上系统性低估水位。
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        return {
          status: "degraded",
          details: `Disk usage unreadable for ${this.diskCheckPath} (statfs returned no usable block count)`,
        };
      }
      const usedPercent =
        Math.round(((totalBytes - availableBytes) / totalBytes) * 1000) / 10;
      const usedMb = Math.round((totalBytes - availableBytes) / 1024 / 1024);
      const totalMb = Math.round(totalBytes / 1024 / 1024);

      if (usedPercent >= this.diskUsageUnhealthyPercent) {
        return {
          status: "unhealthy",
          usedPercent,
          details:
            `Disk ${usedPercent}% full at ${this.diskCheckPath} (${usedMb}/${totalMb} MB used, ` +
            `threshold ${this.diskUsageUnhealthyPercent}%); new execution logs/artifacts will fail to write`,
        };
      }
      if (usedPercent >= this.diskUsageDegradedPercent) {
        return {
          status: "degraded",
          usedPercent,
          details:
            `Disk ${usedPercent}% full at ${this.diskCheckPath} (${usedMb}/${totalMb} MB used, ` +
            `degraded threshold ${this.diskUsageDegradedPercent}%)`,
        };
      }
      return { status: "healthy", usedPercent };
    } catch (error: unknown) {
      // 见方法头注：读不到水位 = 未知，不是健康。degraded 而非 unhealthy
      // ——磁盘本身未必有问题，是这项探测不可用，不该把整体判成故障。
      return {
        status: "degraded",
        details: `Disk usage check failed for ${this.diskCheckPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * PLAN-OBSERVABILITY §5.1：V8 堆水位检查。
   *
   * 为什么需要：堆耗尽时进程被 OOM killer 直接带走（没有任何 5xx、没有
   * 优雅关闭日志），健康检查在此之前全绿。用 `process.memoryUsage()`
   * 而非外部 exporter，因为这里要的是**本进程**的堆压力，而
   * `nodejs_heap_size_used_bytes` 只进 Prometheus、不参与健康判定。
   *
   * 分母取 `v8.getHeapStatistics().heap_size_limit`（V8 实际允许的上限，
   * 受 --max-old-space-size 影响），而不是 os.totalmem()——后者是整个
   * 宿主机的内存，容器限 512MB 而宿主 32GB 时用它算比例毫无意义（恒
   * 个位数百分比，永远不会告警）。
   */
  checkMemory(): {
    status: "healthy" | "degraded" | "unhealthy";
    details?: string;
    heapUsedBytes?: number;
    heapLimitBytes?: number;
    heapUsedPercent?: number;
  } {
    try {
      const heapUsedBytes = process.memoryUsage().heapUsed;
      const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
      if (!Number.isFinite(heapLimitBytes) || heapLimitBytes <= 0) {
        return {
          status: "degraded",
          details:
            "Heap limit unreadable (v8.getHeapStatistics().heap_size_limit returned no usable value)",
        };
      }
      const heapUsedPercent =
        Math.round((heapUsedBytes / heapLimitBytes) * 1000) / 10;
      const usedMb = Math.round(heapUsedBytes / 1024 / 1024);
      const limitMb = Math.round(heapLimitBytes / 1024 / 1024);

      if (heapUsedPercent >= this.heapUsedUnhealthyPercent) {
        return {
          status: "unhealthy",
          heapUsedBytes,
          heapLimitBytes,
          heapUsedPercent,
          details:
            `Heap ${heapUsedPercent}% used (${usedMb}/${limitMb} MB, threshold ` +
            `${this.heapUsedUnhealthyPercent}%); OOM kill is imminent`,
        };
      }
      if (heapUsedPercent >= this.heapUsedDegradedPercent) {
        return {
          status: "degraded",
          heapUsedBytes,
          heapLimitBytes,
          heapUsedPercent,
          details:
            `Heap ${heapUsedPercent}% used (${usedMb}/${limitMb} MB, degraded threshold ` +
            `${this.heapUsedDegradedPercent}%)`,
        };
      }
      return {
        status: "healthy",
        heapUsedBytes,
        heapLimitBytes,
        heapUsedPercent,
      };
    } catch (error: unknown) {
      return {
        status: "degraded",
        details: `Heap usage check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * 全量健康检查。WIKI-OPT-1：HEALTH_CACHE_TTL_MS > 0 时在 TTL 窗口内
   * 直接返回缓存的整个响应对象（含 timestamp），降低高频探针对数据库
   * count / 队列统计 / Redis ping 的压力；默认 0 = 关闭，行为与未缓存
   * 完全一致。live/ready 探针（getLiveness/getReadiness）不缓存。
   */
  async getFullHealth(): Promise<FullHealthReport> {
    if (this.cacheTtlMs > 0) {
      const cached = this.fullHealthCache;
      if (cached && Date.now() < cached.expiresAt) {
        return cached.payload;
      }
    }

    const result = await this.computeFullHealth();

    if (this.cacheTtlMs > 0) {
      this.fullHealthCache = {
        expiresAt: Date.now() + this.cacheTtlMs,
        payload: result,
      };
    }

    return result;
  }

  private async computeFullHealth(): Promise<FullHealthReport> {
    const [db, redis, queue, executors, tasks, scheduler] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkQueue(),
      this.checkExecutors(),
      this.checkTasks(),
      this.checkScheduler(),
    ]);
    // PLAN-OBSERVABILITY §5.1：磁盘 / 堆水位。两者都不碰网络与 DB，
    // checkMemory 是同步纯计算，故不并入上面的 Promise.all（保持其语义
    // 为"网络/DB 依赖面"），单独算完后与其余组件一起聚合。
    const disk = await this.checkDisk();
    const memory = this.checkMemory();

    // WIKI-OPT-1: tasks 纳入 components 聚合（此前 6 项检查只聚合 5 项，
    // tasks 缺席导致其异常状态在整体判定中不可见）。
    const components = [
      {
        name: "database",
        status: db.status as "healthy" | "degraded" | "unhealthy",
        message: db.details,
      },
      {
        name: "redis",
        status: redis.status as "healthy" | "degraded" | "unhealthy",
        message: redis.details,
      },
      { name: "queue", status: queue.status, message: queue.details },
      {
        name: "executors",
        status: executors.status,
        message: executors.details,
      },
      { name: "tasks", status: tasks.status, message: tasks.details },
      {
        name: "scheduler",
        status: scheduler.status as "healthy" | "degraded" | "unhealthy",
        message: scheduler.details,
      },
      { name: "disk", status: disk.status, message: disk.details },
      { name: "memory", status: memory.status, message: memory.details },
    ];

    const hasUnhealthy = components.some((c) => c.status === "unhealthy");
    const hasDegraded = components.some((c) => c.status === "degraded");

    const overallStatus = hasUnhealthy
      ? "unhealthy"
      : hasDegraded
        ? "degraded"
        : "healthy";

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      services: {
        database: db,
        redis,
        queue,
        executors,
        tasks,
        scheduler,
        disk,
        memory,
      },
      metrics: {
        totalTasks: tasks.totalCount,
        activeTasks: tasks.activeCount,
        runningExecutions: tasks.runningCount,
        totalExecutors: executors.totalCount,
        onlineExecutors: executors.onlineCount,
        queueSize: queue.size || 0,
      },
      components,
    };
  }

  /**
   * R-25（DEEP_REVIEW 0ef3bbe）：公开健康端点的精简响应——只返回整体
   * status + timestamp，不暴露 executor 在线数、队列深度、任务计数等
   * 内部运维指标。详细指标走需鉴权的 getFullHealth()。
   *
   * NETOPT-5④: 公开路径吃独立短 TTL 缓存（publicCacheTtlMs，默认 5s）——
   * 本端点未鉴权，可被外部监控高频击打；缓存的只是 {status, timestamp}
   * 投影，R-25 的不暴露语义与实时性（5s 窗口）折衷见 publicHealthCache 注释。
   */
  async getPublicHealth(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    timestamp: string;
  }> {
    if (this.publicCacheTtlMs > 0) {
      const cached = this.publicHealthCache;
      if (cached && Date.now() < cached.expiresAt) {
        return cached.payload;
      }
    }

    const full = await this.getFullHealth();
    const payload = { status: full.status, timestamp: full.timestamp };

    if (this.publicCacheTtlMs > 0) {
      this.publicHealthCache = {
        expiresAt: Date.now() + this.publicCacheTtlMs,
        payload,
      };
    }

    return payload;
  }

  async getLiveness(): Promise<{ status: "healthy" }> {
    return { status: "healthy" };
  }

  async getReadiness(): Promise<{
    status: "ready" | "not_ready";
    timestamp: string;
    /** A3: 不就绪时的原因（非空字符串）——运维要能直接从探针响应看出为什么。 */
    reason?: string;
    checks: Array<{ name: string; status: "pass" | "fail" }>;
  }> {
    const [db, redis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const checks: Array<{ name: string; status: "pass" | "fail" }> = [
      { name: "database", status: db.status === "healthy" ? "pass" : "fail" },
      { name: "redis", status: redis.status === "healthy" ? "pass" : "fail" },
    ];

    const failed = checks.filter((c) => c.status === "fail").map((c) => c.name);

    return {
      status: failed.length === 0 ? "ready" : "not_ready",
      timestamp: new Date().toISOString(),
      ...(failed.length > 0
        ? { reason: `Unhealthy dependencies: ${failed.join(", ")}` }
        : {}),
      checks,
    };
  }
}
