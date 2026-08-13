import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, MoreThanOrEqual, Between } from "typeorm";
import { Task } from "../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../task/entities/task-execution.entity";
import { Executor, ExecutorStatus } from "../executor/entities/executor.entity";
import { ExecutionReport } from "./entities/execution-report.entity";

@Injectable()
export class MetricsService {
  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectRepository(Executor) private executorRepo: Repository<Executor>,
    @InjectRepository(ExecutionReport)
    private reportRepo: Repository<ExecutionReport>,
  ) {}

  async getSummary() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

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
      report = await this.generateReport(today);
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
}
