import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  Repository,
  SelectQueryBuilder,
  MoreThanOrEqual,
  Between,
  Or,
  IsNull,
  In,
} from "typeorm";
import { ConfigService } from "@nestjs/config";
import { Task } from "../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
  FAILED_EXECUTION_STATUSES,
} from "../task/entities/task-execution.entity";
import { Executor, ExecutorStatus } from "../executor/entities/executor.entity";
import { ExecutionReport } from "./entities/execution-report.entity";
import { SchedulerService } from "../scheduler/scheduler.service";
import { EventLoopLagService } from "../../common/metrics/event-loop-lag.service";
import { DEFAULT_PROJECT_ID } from "../project/project.entity";

@Injectable()
export class MetricsService {
  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectRepository(Executor) private executorRepo: Repository<Executor>,
    @InjectRepository(ExecutionReport)
    private reportRepo: Repository<ExecutionReport>,
    // R4-§5.5: 调度计数器/队列深度由 SchedulerService 进程内维护，
    // MetricsModule 引入 SchedulerModule 读取（无模块环：无任何模块
    // 反向依赖 MetricsModule）。
    @Inject(forwardRef(() => SchedulerService))
    private schedulerService: SchedulerService,
    // INCIDENT-2026-10-28（P1-2）：事件循环阻塞监控。10-28 那次冻结在应用侧
    // 零数据留存，时间线全靠 nginx/PG/redis 三条外部证据反推——本服务补上
    // 这个盲区。
    private readonly eventLoopLag: EventLoopLagService,
    // ARCH-27: 进程标识（hostname）经 ConfigService 读取（configuration.ts
    // app.hostname，OS/容器注入），取代直读 process.env.HOSTNAME。
    private readonly configService: ConfigService,
  ) {}

  /** NETOPT-1④: getSummary 执行聚合的时间窗（天），取舍见 getSummary 内注 */
  private static readonly AGGREGATION_WINDOW_DAYS = 30;

  /**
   * P1-2：任务域项目过滤 where（任务仓库直查用）。
   * `"default"` = 未分配（projectId IS NULL）+ 默认项目；省略 = 全部项目。
   * 与任务列表 / 执行列表同一套口径。
   */
  private projectTaskWhere(projectId?: string): Record<string, unknown> {
    if (!projectId) return {};
    if (projectId === "default") {
      return { projectId: Or(IsNull(), In([DEFAULT_PROJECT_ID])) };
    }
    return { projectId };
  }

  /** 执行聚合 QB 关联 tasks 表——执行行自身不冗余 projectId，经 taskId 派生。 */
  private joinTaskForProject(qb: SelectQueryBuilder<TaskExecution>): void {
    qb.leftJoin("tasks", "t", "t.id = e.taskId");
  }

  private applyProjectFilter(
    qb: SelectQueryBuilder<TaskExecution>,
    projectId?: string,
  ): void {
    if (!projectId) return;
    if (projectId === "default") {
      qb.andWhere("(t.projectId IS NULL OR t.projectId = :defaultPid)", {
        defaultPid: DEFAULT_PROJECT_ID,
      });
    } else {
      qb.andWhere("t.projectId = :projectId", { projectId });
    }
  }

  /** 今日执行次数；无项目上下文时保持原 repo.count 路径（查询形状不变）。 */
  private async countTodayRuns(
    todayStart: Date,
    projectId?: string,
  ): Promise<number> {
    if (!projectId) {
      return this.execRepo.count({
        where: { createdAt: MoreThanOrEqual(todayStart) },
      });
    }
    const qb = this.execRepo
      .createQueryBuilder("e")
      .leftJoin("tasks", "t", "t.id = e.taskId")
      .where("e.createdAt >= :todayStart", { todayStart });
    this.applyProjectFilter(qb, projectId);
    return qb.getCount();
  }

  async getSummary(projectId?: string) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // NETOPT-1④: 聚合时间界——task_executions 虽有 90 天 retention，但峰值
    // 行数下全表 GROUP BY / AVG 仍随历史线性变慢（dashboard 首屏高频路径）。
    // 两处执行聚合收敛到「近 30 天」窗口：successRate/avgDuration 语义从
    // 「全历史」改为「近 30 天」（与 getDailyTrend 默认 7 天、generateReport
    // 单日窗口同族，均属运营近况视图；totalTasks/执行器计数不受影响）。
    // 用 TypeORM 参数绑定（Date 对象）而非原生 interval 字面量，保持引擎无关。
    const windowStart = new Date(
      Date.now() - MetricsService.AGGREGATION_WINDOW_DAYS * 86_400_000,
    );

    // P1-2：执行器计数（totalExecutors/onlineExecutors）是机队全局口径——
    // Executor 实体不带项目归属，无法按项目切分；选中具体项目时前端须对这两项
    // 显式标注「全局口径」，不能把全局机队数当成项目数。
    const [totalTasks, totalExecutors, onlineExecutors, todayRuns] =
      await Promise.all([
        this.taskRepo.count({ where: this.projectTaskWhere(projectId) }),
        this.executorRepo.count(),
        this.executorRepo.count({ where: { status: ExecutorStatus.ONLINE } }),
        this.countTodayRuns(todayStart, projectId),
      ]);

    const statsQb = this.execRepo
      .createQueryBuilder("e")
      .select("e.status", "status")
      .addSelect("COUNT(*)", "count")
      .where("e.createdAt >= :windowStart", { windowStart });
    if (projectId) this.joinTaskForProject(statsQb);
    this.applyProjectFilter(statsQb, projectId);
    const execStats = await statsQb.groupBy("e.status").getRawMany();

    const statMap: Record<string, number> = {};
    for (const row of execStats) statMap[row.status] = parseInt(row.count, 10);

    const total = Object.values(statMap).reduce((a, b) => a + b, 0);
    const success = statMap[ExecutionStatus.SUCCESS] ?? 0;
    // R280（失败口径统一）：failed = FAILED 桶 + TIMEOUT 桶。
    // 不能只数 FAILED——同一个 timeout 语义分叉落两个桶：回调上报落 TIMEOUT、
    // stale sweep 定案落 FAILED+failureReason=TIMEOUT（见
    // FAILED_EXECUTION_STATUSES 的注释）。两桶相加才是告警口径
    // （alerts.yml status=~"failed|timeout"）下的完整失败数。
    // `timeout` 键由上面的 groupBy("e.status") 天然产出，无需额外查询。
    const failed =
      (statMap[ExecutionStatus.FAILED] ?? 0) +
      (statMap[ExecutionStatus.TIMEOUT] ?? 0);
    const running = statMap[ExecutionStatus.RUNNING] ?? 0;

    const avgQb = this.execRepo
      .createQueryBuilder("e")
      .select("AVG(e.duration)", "avg")
      .where("e.status = :s", { s: ExecutionStatus.SUCCESS })
      .andWhere("e.createdAt >= :windowStart", { windowStart });
    if (projectId) this.joinTaskForProject(avgQb);
    this.applyProjectFilter(avgQb, projectId);
    const avgDuration = await avgQb.getRawOne();

    return {
      totalTasks,
      todayRuns,
      totalExecutors,
      onlineExecutors,
      executions: { total, success, failed, running },
      successRate: total > 0 ? Math.round((success / total) * 10000) / 100 : 0,
      avgDurationMs: Math.round(parseFloat(avgDuration?.avg ?? "0")),
    };
  }

  /** Execution count per day for the last N days (success vs failed) */
  async getDailyTrend(days = 7, projectId?: string) {
    const trendQb = this.execRepo
      .createQueryBuilder("e")
      .select("DATE_TRUNC('day', e.createdAt)", "day")
      .addSelect("e.status", "status")
      .addSelect("COUNT(*)", "count")
      .where("e.createdAt >= NOW() - CAST(:days || ' days' AS INTERVAL)", {
        days,
      });
    if (projectId) this.joinTaskForProject(trendQb);
    this.applyProjectFilter(trendQb, projectId);
    const rows = await trendQb
      .groupBy("DATE_TRUNC('day', e.createdAt), e.status")
      .orderBy("DATE_TRUNC('day', e.createdAt)", "ASC")
      .getRawMany();

    // Aggregate into { date, success, failed, timeout } format.
    // A-10（审计趋势口径）：TIMEOUT 必须透出——alerts.yml 的执行失败告警
    // （AUTOFLOW_EXECUTION_FAILURE_RATE_HIGH / _STORM）口径为
    // status=~"failed|timeout"，前端失败曲线若不含 TIMEOUT 会系统性低于告警
    // 口径（超时风暴时曲线平稳、告警齐鸣）。SQL 已按 status 分组（TIMEOUT 行
    // 本就返回），此前只在前端聚合侧被丢弃；CANCELLED/KILLED 仍不在告警口径
    // 内，维持丢弃。
    const map = new Map<
      string,
      { date: string; success: number; failed: number; timeout: number }
    >();
    for (const row of rows) {
      const date = new Date(row.day).toISOString().slice(0, 10);
      if (!map.has(date))
        map.set(date, { date, success: 0, failed: 0, timeout: 0 });
      const entry = map.get(date)!;
      if (row.status === ExecutionStatus.SUCCESS)
        entry.success += parseInt(row.count, 10);
      if (row.status === ExecutionStatus.FAILED)
        entry.failed += parseInt(row.count, 10);
      if (row.status === ExecutionStatus.TIMEOUT)
        entry.timeout += parseInt(row.count, 10);
    }
    return Array.from(map.values());
  }

  /**
   * Current status and load for each executor.
   *
   * rt-4（第 3 轮运行时审计）：显式投影——此前是无 select 的全表 `find()`，
   * `Executor` 全列（含 tokenHash 等凭据列）被物化后只取 8 个字段。该查询
   * 由 `/metrics/stream` 每条连接每 3s 触发，千台机队 × 每拍 × 每连接时是
   * 纯浪费（也把凭据列带进了不必经手的内存路径）。
   */
  async getExecutorStats() {
    const executors = await this.executorRepo.find({
      order: { appName: "ASC" },
      select: {
        id: true,
        appName: true,
        address: true,
        status: true,
        cpuUsage: true,
        memUsage: true,
        runningTaskCount: true,
        lastHeartbeat: true,
      },
    });
    return executors.map((e) => ({
      id: e.id,
      appName: e.appName,
      address: e.address,
      status: e.status,
      cpuUsage: e.cpuUsage,
      memUsage: e.memUsage,
      runningTaskCount: e.runningTaskCount,
      lastHeartbeat: e.lastHeartbeat,
    }));
  }

  /** Most recent failed execution records (top 10) */
  async getRecentFailures(projectId?: string) {
    // 无项目上下文：保持原 repo.find 路径（查询形状与既有 spec 逐字一致）。
    if (!projectId) {
      return this.execRepo.find({
        // R280：失败 = FAILED ∪ TIMEOUT（唯一事实源见实体常量）。此前只查
        // FAILED，超时风暴时趋势曲线在涨而「最近失败」说没有，同屏自相矛盾。
        where: { status: In([...FAILED_EXECUTION_STATUSES]) },
        order: { createdAt: "DESC" },
        take: 10,
        select: {
          id: true,
          taskId: true,
          taskName: true,
          errorMessage: true,
          failureReason: true,
          // 改动2（可观测性补齐）：透出回调上报的原始退出码，失败溯源不再
          // 只有推断出的 failureReason。
          exitCode: true,
          createdAt: true,
          duration: true,
        },
      });
    }
    const qb = this.execRepo
      .createQueryBuilder("e")
      .select([
        "e.id",
        "e.taskId",
        "e.taskName",
        "e.errorMessage",
        "e.failureReason",
        "e.exitCode",
        "e.createdAt",
        "e.duration",
      ])
      .leftJoin("tasks", "t", "t.id = e.taskId")
      // R280：同上——两条分支必须同口径，否则带 projectId 的页面继续漏超时。
      .where("e.status IN (:...failedStatuses)", {
        failedStatuses: [...FAILED_EXECUTION_STATUSES],
      });
    this.applyProjectFilter(qb, projectId);
    return qb.orderBy("e.createdAt", "DESC").take(10).getMany();
  }

  /** Generate execution report for a specific date */
  async generateReport(date: Date): Promise<ExecutionReport> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // S8（迁移 1790000000091）：日报只统计**真实尝试**，合成行一律排除。
    //
    // `synthetic=true` 是 G2 为「因上游失败而没跑」的下游补的可见性记录——**从未
    // 执行**（无 startTime/exitCode/logs）。若计入，`cancelledCount` 会把「没跑」
    // 记成「跑过一次又取消了」，日报读上去像是调度器在频繁覆盖执行，而真实原因在
    // 上游失败。它留在执行列表里（可见性是其全部价值），但不属于任何执行统计。
    const stats = await this.execRepo
      .createQueryBuilder("e")
      .select("e.status", "status")
      .addSelect("COUNT(*)", "count")
      .where("e.createdAt >= :start", { start: startOfDay })
      .andWhere("e.createdAt <= :end", { end: endOfDay })
      .andWhere("e.synthetic = false")
      .groupBy("e.status")
      .getRawMany();

    const durationStats = await this.execRepo
      .createQueryBuilder("e")
      .select("AVG(e.duration)", "avg")
      .addSelect("MAX(e.duration)", "max")
      .addSelect("MIN(e.duration)", "min")
      .where("e.createdAt >= :start", { start: startOfDay })
      .andWhere("e.createdAt <= :end", { end: endOfDay })
      .andWhere("e.status = :status", { status: ExecutionStatus.SUCCESS })
      .andWhere("e.duration IS NOT NULL")
      .getRawOne();

    const statMap: Record<string, number> = {};
    for (const row of stats) {
      statMap[row.status] = parseInt(row.count, 10);
    }

    const report = this.reportRepo.create({
      triggerDay: startOfDay,
      runningCount: statMap[ExecutionStatus.RUNNING] ?? 0,
      successCount: statMap[ExecutionStatus.SUCCESS] ?? 0,
      failCount: statMap[ExecutionStatus.FAILED] ?? 0,
      timeoutCount: statMap[ExecutionStatus.TIMEOUT] ?? 0,
      cancelledCount: statMap[ExecutionStatus.CANCELLED] ?? 0,
      avgDurationMs: parseFloat(durationStats?.avg || "0"),
      maxDurationMs: parseFloat(durationStats?.max || "0"),
      minDurationMs: parseFloat(durationStats?.min || "0"),
    });

    return this.reportRepo.save(report);
  }

  /** Get execution reports for a date range */
  async getReports(startDate: Date, endDate: Date): Promise<ExecutionReport[]> {
    // BUG-FIX: use Between so both bounds are applied; a plain spread would overwrite the first condition
    return this.reportRepo.find({
      where: {
        triggerDay: Between(startDate, endDate),
      },
      order: { triggerDay: "ASC" },
    });
  }

  /** Get today's execution report (generate if not exists) */
  async getTodayReport(): Promise<ExecutionReport> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let report = await this.reportRepo.findOne({
      where: { triggerDay: today },
    });
    if (!report) {
      try {
        report = await this.generateReport(today);
      } catch (err: unknown) {
        // NETOPT-1⑤: 并发首访竞态——两请求同日同时 findOne 落空后各自
        // generateReport→save，败者撞 triggerDay 唯一索引（SQLSTATE 23505）
        // 直接 500。此处识别唯一冲突后重读一次返回赢家已写入的行（改动最小，
        // 免去 upsert 对 create()/save() 返回形态的扰动）；重读仍无行则原样
        // 上抛。TypeORM 会把驱动错误包一层，code 可能在本体/driverError/cause
        // 上，逐一探测。
        const code = (e: unknown): string | undefined => {
          if (!e || typeof e !== "object") return undefined;
          const anyErr = e as {
            code?: string;
            driverError?: { code?: string };
            cause?: { code?: string };
          };
          return anyErr.code ?? anyErr.driverError?.code ?? anyErr.cause?.code;
        };
        if (code(err) !== "23505") throw err;
        report = await this.reportRepo.findOne({
          where: { triggerDay: today },
        });
        if (!report) throw err;
      }
    }
    return report;
  }

  /** Get execution reports for the last N days */
  async getRecentReports(days: number): Promise<ExecutionReport[]> {
    const endDate = new Date();
    endDate.setHours(0, 0, 0, 0);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    startDate.setHours(0, 0, 0, 0);

    return this.getReports(startDate, endDate);
  }

  /**
   * R4-§5.5 可观测性：调度健康快照。
   * 聚合 SchedulerService 的进程内计数器（tick 次数/耗时、trigger
   * claimed/skipped/failed、依赖扇出计数）与 BullMQ 队列深度
   * （waiting/active/delayed）。零新依赖：不引入 prom-client
   * （package.json 中不存在），由抓取方按 instance 聚合。
   */
  async getSchedulerMetrics() {
    const metrics = await this.schedulerService.getSchedulerMetrics();
    return {
      ...metrics,
      scheduler: this.schedulerService.getStats(),
      // P1-2：事件循环阻塞（process 级，与 Leader 身份无关，follower 也有值）
      eventLoop: this.eventLoopLag.getSnapshot(),
      instance: {
        pid: process.pid,
        // ARCH-27: 经 ConfigService 读 app.hostname（OS/容器注入的进程标识，
        // 未配置时回退空串，Windows 开发环境 HOSTNAME 可能不存在）。
        hostname: this.configService.get<string>("app.hostname") ?? "",
      },
    };
  }
}
