import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, MoreThanOrEqual, Between } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { Task } from "../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../task/entities/task-execution.entity";
import { Executor, ExecutorStatus } from "../executor/entities/executor.entity";
import { ExecutionReport } from "./entities/execution-report.entity";
import { SchedulerService } from "../scheduler/scheduler.service";

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
    // ARCH-27: 进程标识（hostname）经 ConfigService 读取（configuration.ts
    // app.hostname，OS/容器注入），取代直读 process.env.HOSTNAME。
    private readonly configService: ConfigService,
  ) {}

  /** NETOPT-1④: getSummary 执行聚合的时间窗（天），取舍见 getSummary 内注 */
  private static readonly AGGREGATION_WINDOW_DAYS = 30;

  async getSummary() {
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

    const [totalTasks, totalExecutors, onlineExecutors, todayRuns] =
      await Promise.all([
        this.taskRepo.count(),
        this.executorRepo.count(),
        this.executorRepo.count({ where: { status: ExecutorStatus.ONLINE } }),
        this.execRepo.count({
          where: { createdAt: MoreThanOrEqual(todayStart) },
        }),
      ]);

    const execStats = await this.execRepo
      .createQueryBuilder("e")
      .select("e.status", "status")
      .addSelect("COUNT(*)", "count")
      .where("e.createdAt >= :windowStart", { windowStart })
      .groupBy("e.status")
      .getRawMany();

    const statMap: Record<string, number> = {};
    for (const row of execStats) statMap[row.status] = parseInt(row.count, 10);

    const total = Object.values(statMap).reduce((a, b) => a + b, 0);
    const success = statMap[ExecutionStatus.SUCCESS] ?? 0;
    const failed = statMap[ExecutionStatus.FAILED] ?? 0;
    const running = statMap[ExecutionStatus.RUNNING] ?? 0;

    const avgDuration = await this.execRepo
      .createQueryBuilder("e")
      .select("AVG(e.duration)", "avg")
      .where("e.status = :s", { s: ExecutionStatus.SUCCESS })
      .andWhere("e.createdAt >= :windowStart", { windowStart })
      .getRawOne();

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
  async getDailyTrend(days = 7) {
    const rows = await this.execRepo
      .createQueryBuilder("e")
      .select("DATE_TRUNC('day', e.createdAt)", "day")
      .addSelect("e.status", "status")
      .addSelect("COUNT(*)", "count")
      .where("e.createdAt >= NOW() - CAST(:days || ' days' AS INTERVAL)", {
        days,
      })
      .groupBy("DATE_TRUNC('day', e.createdAt), e.status")
      .orderBy("DATE_TRUNC('day', e.createdAt)", "ASC")
      .getRawMany();

    // Aggregate into { date, success, failed } format
    const map = new Map<
      string,
      { date: string; success: number; failed: number }
    >();
    for (const row of rows) {
      const date = new Date(row.day).toISOString().slice(0, 10);
      if (!map.has(date)) map.set(date, { date, success: 0, failed: 0 });
      const entry = map.get(date)!;
      if (row.status === ExecutionStatus.SUCCESS)
        entry.success += parseInt(row.count, 10);
      if (row.status === ExecutionStatus.FAILED)
        entry.failed += parseInt(row.count, 10);
    }
    return Array.from(map.values());
  }

  /** Current status and load for each executor */
  async getExecutorStats() {
    const executors = await this.executorRepo.find({
      order: { appName: "ASC" },
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
  async getRecentFailures() {
    return this.execRepo.find({
      where: { status: ExecutionStatus.FAILED },
      order: { createdAt: "DESC" },
      take: 10,
      select: [
        "id",
        "taskId",
        "taskName",
        "errorMessage",
        "failureReason",
        // 改动2（可观测性补齐）：透出回调上报的原始退出码，失败溯源不再
        // 只有推断出的 failureReason。
        "exitCode",
        "createdAt",
        "duration",
      ],
    });
  }

  /** Generate execution report for a specific date */
  async generateReport(date: Date): Promise<ExecutionReport> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const stats = await this.execRepo
      .createQueryBuilder("e")
      .select("e.status", "status")
      .addSelect("COUNT(*)", "count")
      .where("e.createdAt >= :start", { start: startOfDay })
      .andWhere("e.createdAt <= :end", { end: endOfDay })
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
      instance: {
        pid: process.pid,
        // ARCH-27: 经 ConfigService 读 app.hostname（OS/容器注入的进程标识，
        // 未配置时回退空串，Windows 开发环境 HOSTNAME 可能不存在）。
        hostname: this.configService.get<string>("app.hostname") ?? "",
      },
    };
  }
}
