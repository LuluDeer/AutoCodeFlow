import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
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
    this.redisClient = createClient({
      url: `redis://${host}:${port}`,
      password: password || undefined,
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
      const jobs = await this.taskQueue.getJobs(["wait", "active"]);
      return {
        status: "healthy",
        details: `Scheduler is running, ${jobs.length} jobs in queue`,
      };
    } catch (error: unknown) {
      return {
        status: "unhealthy",
        details: error instanceof Error ? error.message : String(error),
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
   */
  async getPublicHealth(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    timestamp: string;
  }> {
    const full = await this.getFullHealth();
    return { status: full.status, timestamp: full.timestamp };
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
