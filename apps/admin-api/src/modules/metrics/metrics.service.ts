import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Task } from '../task/entities/task.entity';
import { TaskExecution, ExecutionStatus } from '../task/entities/task-execution.entity';
import { Executor, ExecutorStatus } from '../executor/entities/executor.entity';

@Injectable()
export class MetricsService {
  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution) private execRepo: Repository<TaskExecution>,
    @InjectRepository(Executor) private executorRepo: Repository<Executor>,
  ) {}

  async getSummary() {
    const [totalTasks, totalExecutors, onlineExecutors] = await Promise.all([
      this.taskRepo.count(),
      this.executorRepo.count(),
      this.executorRepo.count({ where: { status: ExecutorStatus.ONLINE } }),
    ]);

    const execStats = await this.execRepo
      .createQueryBuilder('e')
      .select('e.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('e.status')
      .getRawMany();

    const statMap: Record<string, number> = {};
    for (const row of execStats) statMap[row.status] = parseInt(row.count, 10);

    const total = Object.values(statMap).reduce((a, b) => a + b, 0);
    const success = statMap[ExecutionStatus.SUCCESS] ?? 0;
    const failed = statMap[ExecutionStatus.FAILED] ?? 0;
    const running = statMap[ExecutionStatus.RUNNING] ?? 0;

    const avgDuration = await this.execRepo
      .createQueryBuilder('e')
      .select('AVG(e.duration)', 'avg')
      .where('e.status = :s', { s: ExecutionStatus.SUCCESS })
      .getRawOne();

    return {
      totalTasks,
      totalExecutors,
      onlineExecutors,
      executions: { total, success, failed, running },
      successRate: total > 0 ? Math.round((success / total) * 10000) / 100 : 0,
      avgDurationMs: Math.round(parseFloat(avgDuration?.avg ?? '0')),
    };
  }

  /** 最近 N 天每天的执行次数（成功 vs 失败） */
  async getDailyTrend(days = 7) {
    const rows = await this.execRepo
      .createQueryBuilder('e')
      .select("DATE_TRUNC('day', e.createdAt)", 'day')
      .addSelect('e.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where("e.createdAt >= NOW() - INTERVAL :days * INTERVAL '1 day'", { days })
      .groupBy("DATE_TRUNC('day', e.createdAt), e.status")
      .orderBy("DATE_TRUNC('day', e.createdAt)", 'ASC')
      .getRawMany();

    // 聚合成 { date, success, failed } 格式
    const map = new Map<string, { date: string; success: number; failed: number }>();
    for (const row of rows) {
      const date = new Date(row.day).toISOString().slice(0, 10);
      if (!map.has(date)) map.set(date, { date, success: 0, failed: 0 });
      const entry = map.get(date)!;
      if (row.status === ExecutionStatus.SUCCESS) entry.success += parseInt(row.count, 10);
      if (row.status === ExecutionStatus.FAILED) entry.failed += parseInt(row.count, 10);
    }
    return Array.from(map.values());
  }

  /** 各执行器当前状态及负载 */
  async getExecutorStats() {
    const executors = await this.executorRepo.find({ order: { appName: 'ASC' } });
    return executors.map(e => ({
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

  /** 最近失败的执行记录（top 10） */
  async getRecentFailures() {
    return this.execRepo.find({
      where: { status: ExecutionStatus.FAILED },
      order: { createdAt: 'DESC' },
      take: 10,
      select: ['id', 'taskId', 'taskName', 'errorMessage', 'createdAt', 'duration'],
    });
  }
}
