import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Task } from '../task/entities/task.entity';
import { Executor } from '../executor/entities/executor.entity';
import { TaskExecution, ExecutionStatus } from '../task/entities/task-execution.entity';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class HealthService {
  private redisClient: RedisClientType;

  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(Executor) private executorRepo: Repository<Executor>,
    @InjectRepository(TaskExecution) private execRepo: Repository<TaskExecution>,
    @InjectQueue('task-queue') private taskQueue: Queue,
  ) {
    this.redisClient = createClient({
      url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`,
    });
  }

  async checkDatabase(): Promise<{ status: 'healthy' | 'unhealthy'; details?: string }> {
    try {
      await this.taskRepo.query('SELECT 1');
      return { status: 'healthy' };
    } catch (error) {
      return { status: 'unhealthy', details: error.message };
    }
  }

  async checkRedis(): Promise<{ status: 'healthy' | 'unhealthy'; details?: string }> {
    try {
      if (!this.redisClient.isReady) {
        await this.redisClient.connect();
      }
      await this.redisClient.ping();
      return { status: 'healthy' };
    } catch (error) {
      return { status: 'unhealthy', details: error.message };
    }
  }

  async checkQueue(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; details?: string; size?: number }> {
    try {
      const [waiting, active, delayed, failed] = await Promise.all([
        this.taskQueue.getWaitingCount(),
        this.taskQueue.getActiveCount(),
        this.taskQueue.getDelayedCount(),
        this.taskQueue.getFailedCount(),
      ]);

      const total = waiting + active + delayed + failed;
      const hasIssues = failed > 100 || delayed > 500 || waiting > 1000;

      return {
        status: hasIssues ? 'degraded' : 'healthy',
        size: total,
        details: hasIssues ? `High queue backlog: waiting=${waiting}, active=${active}, delayed=${delayed}, failed=${failed}` : undefined,
      };
    } catch (error) {
      return { status: 'unhealthy', details: error.message };
    }
  }

  async checkExecutors(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; onlineCount: number; totalCount: number; details?: string }> {
    const executors = await this.executorRepo.find();
    const onlineCount = executors.filter(e => e.status === 'online').length;
    const totalCount = executors.length;

    if (totalCount === 0) {
      return { status: 'degraded', onlineCount: 0, totalCount: 0, details: 'No executors registered' };
    }

    if (onlineCount === 0) {
      return { status: 'unhealthy', onlineCount: 0, totalCount, details: 'All executors are offline' };
    }

    const onlineRatio = onlineCount / totalCount;
    if (onlineRatio < 0.5) {
      return { status: 'degraded', onlineCount, totalCount, details: `Only ${Math.round(onlineRatio * 100)}% of executors are online` };
    }

    return { status: 'healthy', onlineCount, totalCount };
  }

  async checkTasks(): Promise<{ status: 'healthy' | 'degraded'; activeCount: number; totalCount: number; runningCount: number }> {
    const [tasks, runningExecutions] = await Promise.all([
      this.taskRepo.find(),
      this.execRepo.count({ where: { status: ExecutionStatus.RUNNING } }),
    ]);

    const activeCount = tasks.filter(t => t.status === 'active').length;
    const totalCount = tasks.length;

    return {
      status: 'healthy',
      activeCount,
      totalCount,
      runningCount,
    };
  }

  async checkScheduler(): Promise<{ status: 'healthy' | 'unhealthy'; details?: string }> {
    try {
      const jobs = await this.taskQueue.getJobs(['waiting', 'active']);
      return { status: 'healthy', details: `Scheduler is running, ${jobs.length} jobs in queue` };
    } catch (error) {
      return { status: 'unhealthy', details: error.message };
    }
  }

  async getFullHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: string;
    services: {
      database: { status: 'healthy' | 'unhealthy'; details?: string };
      redis: { status: 'healthy' | 'unhealthy'; details?: string };
      queue: { status: 'healthy' | 'degraded' | 'unhealthy'; details?: string; size?: number };
      executors: { status: 'healthy' | 'degraded' | 'unhealthy'; onlineCount: number; totalCount: number; details?: string };
      scheduler: { status: 'healthy' | 'unhealthy'; details?: string };
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
      status: 'healthy' | 'degraded' | 'unhealthy';
      message?: string;
    }>;
  }> {
    const [db, redis, queue, executors, tasks, scheduler] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkQueue(),
      this.checkExecutors(),
      this.checkTasks(),
      this.checkScheduler(),
    ]);

    const components = [
      { name: 'database', status: db.status as 'healthy' | 'degraded' | 'unhealthy', message: db.details },
      { name: 'redis', status: redis.status as 'healthy' | 'degraded' | 'unhealthy', message: redis.details },
      { name: 'queue', status: queue.status, message: queue.details },
      { name: 'executors', status: executors.status, message: executors.details },
      { name: 'scheduler', status: scheduler.status as 'healthy' | 'degraded' | 'unhealthy', message: scheduler.details },
    ];

    const hasUnhealthy = components.some(c => c.status === 'unhealthy');
    const hasDegraded = components.some(c => c.status === 'degraded');

    const overallStatus = hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy';

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      services: {
        database: db,
        redis,
        queue,
        executors,
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

  async getLiveness(): Promise<{ status: 'healthy' }> {
    return { status: 'healthy' };
  }

  async getReadiness(): Promise<{
    status: 'ready' | 'not_ready';
    timestamp: string;
    checks: Array<{ name: string; status: 'pass' | 'fail' }>;
  }> {
    const [db, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);

    const checks = [
      { name: 'database', status: db.status === 'healthy' ? 'pass' : 'fail' },
      { name: 'redis', status: redis.status === 'healthy' ? 'pass' : 'fail' },
    ];

    return {
      status: checks.every(c => c.status === 'pass') ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
