import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as nodeCron from 'node-cron';
import { Task, TaskStatus, TaskTriggerType, BlockStrategy, MisfireStrategy } from '../task/entities/task.entity';
import { TaskExecution, ExecutionStatus } from '../task/entities/task-execution.entity';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  // fixed_rate timers
  private timers = new Map<string, NodeJS.Timeout>();
  // cron tasks
  private cronTasks = new Map<string, nodeCron.ScheduledTask>();
  // B-04: 追踪 fixed_rate 任务是否正在执行，防止重入
  private runningTasks = new Map<string, boolean>();

  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution) private execRepo: Repository<TaskExecution>,
    @InjectQueue('task-queue') private queue: Queue,
  ) {}

  async onModuleInit() {
    await this.reload();
    await this.checkMisfires();
  }

  /** 启动时检测 misfire，按策略补偿执行 */
  async checkMisfires() {
    const tasks = await this.taskRepo.find({ where: { status: TaskStatus.ACTIVE } });
    const now = Date.now();
    for (const task of tasks) {
      if (!task.lastTriggerTime) continue;
      const gap = now - task.lastTriggerTime.getTime();
      const threshold = task.triggerType === TaskTriggerType.FIXED_RATE
        ? (task.fixedRate || 60) * 2000
        : 2 * 60 * 1000;
      if (gap > threshold) {
        if (task.misfireStrategy === MisfireStrategy.FIRE_ONCE) {
          this.logger.warn(`Misfire detected for "${task.name}", firing once`);
          await this.enqueue(task, 'misfire');
        } else {
          this.logger.warn(`Misfire detected for "${task.name}", strategy=IGNORE`);
        }
      }
    }
  }

  onModuleDestroy() {
    this.timers.forEach(t => clearInterval(t));
    this.cronTasks.forEach(t => t.stop());
  }

  /** 每分钟重新扫描活跃任务，注册尚未调度的任务 */
  @Cron(CronExpression.EVERY_MINUTE)
  async reload() {
    const tasks = await this.taskRepo.find({ where: { status: TaskStatus.ACTIVE } });
    const activeIds = new Set(tasks.map(t => t.id));

    // 停止已不在活跃列表中的旧定时器
    for (const id of this.timers.keys()) {
      if (!activeIds.has(id)) this.stop(id);
    }
    for (const id of this.cronTasks.keys()) {
      if (!activeIds.has(id)) this.stop(id);
    }

    for (const t of tasks) {
      if (t.triggerType === TaskTriggerType.FIXED_RATE && t.fixedRate && !this.timers.has(t.id)) {
        const taskId = t.id;
        const timer = setInterval(async () => {
          // B-04: 若上次执行未结束则跳过本次，防止重入
          if (this.runningTasks.get(taskId)) {
            this.logger.warn(`Fixed_rate task "${t.name}" still running, skipping trigger`);
            return;
          }
          this.runningTasks.set(taskId, true);
          try {
            const latest = await this.taskRepo.findOne({ where: { id: taskId, status: TaskStatus.ACTIVE } });
            if (latest) await this.enqueue(latest, 'fixed_rate');
          } finally {
            this.runningTasks.delete(taskId);
          }
        }, t.fixedRate * 1000);
        this.timers.set(t.id, timer);
        this.logger.log(`Scheduled fixed_rate task "${t.name}" every ${t.fixedRate}s`);
      }

      if (t.triggerType === TaskTriggerType.CRON && t.cronExpression && !this.cronTasks.has(t.id)) {
        if (!nodeCron.validate(t.cronExpression)) {
          this.logger.warn(`Invalid cron expression for task "${t.name}": ${t.cronExpression}`);
          continue;
        }
        // N8: re-fetch task at trigger time to avoid stale closure snapshot
        const taskId = t.id;
        const cronTask = nodeCron.schedule(t.cronExpression, async () => {
          const latest = await this.taskRepo.findOne({ where: { id: taskId, status: TaskStatus.ACTIVE } });
          if (latest) await this.enqueue(latest, 'cron');
        });
        this.cronTasks.set(t.id, cronTask);
        this.logger.log(`Scheduled cron task "${t.name}" with expression: ${t.cronExpression}`);
      }
    }
  }

  async enqueue(task: Task, triggerType: string) {
    // 分布式锁：防止多实例重复触发，key 按任务ID + 10s时间窗口
    const lockKey = `lock:schedule:${task.id}:${Math.floor(Date.now() / 10000)}`;
    const client = await (this.queue as any).client;
    const locked = await client.set(lockKey, '1', 'NX', 'PX', 70000);
    if (!locked) {
      this.logger.debug(`Task "${task.name}" lock held by another instance, skip`);
      return null;
    }

    // DISCARD 策略：已有 RUNNING execution 时丢弃本次触发
    if (task.blockStrategy === BlockStrategy.DISCARD) {
      const running = await this.execRepo.findOne({
        where: { taskId: task.id, status: ExecutionStatus.RUNNING },
      });
      if (running) {
        this.logger.warn(`Task "${task.name}" is RUNNING (blockStrategy=DISCARD), skip trigger`);
        return null;
      }
    }
    const exec = await this.execRepo.save(this.execRepo.create({
      taskId: task.id, taskName: task.name,
      status: ExecutionStatus.PENDING, params: task.params,
      triggerType, taskVersion: task.currentVersion,
    }));
    await this.queue.add('execute', { executionId: exec.id, task }, { attempts: task.maxRetry });
    return exec;
  }

  /** 停止并移除指定任务的所有调度 */
  stop(taskId: string) {
    const timer = this.timers.get(taskId);
    if (timer) { clearInterval(timer); this.timers.delete(taskId); }

    const cronTask = this.cronTasks.get(taskId);
    if (cronTask) { cronTask.stop(); this.cronTasks.delete(taskId); }

    this.runningTasks.delete(taskId);
  }

  /** 注册单个任务的调度，供 TaskService update 后精确调用，避免等待下次 reload */
  async scheduleOne(task: Task) {
    this.stop(task.id);

    if (task.triggerType === TaskTriggerType.FIXED_RATE && task.fixedRate) {
      const taskId = task.id;
      const timer = setInterval(async () => {
        // B-04: 防止重入
        if (this.runningTasks.get(taskId)) {
          this.logger.warn(`Fixed_rate task "${task.name}" still running, skipping trigger`);
          return;
        }
        this.runningTasks.set(taskId, true);
        try {
          const latest = await this.taskRepo.findOne({ where: { id: taskId, status: TaskStatus.ACTIVE } });
          if (latest) await this.enqueue(latest, 'fixed_rate');
        } finally {
          this.runningTasks.delete(taskId);
        }
      }, task.fixedRate * 1000);
      this.timers.set(task.id, timer);
      this.logger.log(`Re-scheduled fixed_rate task "${task.name}" every ${task.fixedRate}s`);
    }

    if (task.triggerType === TaskTriggerType.CRON && task.cronExpression) {
      if (!nodeCron.validate(task.cronExpression)) {
        this.logger.warn(`Invalid cron expression for task "${task.name}": ${task.cronExpression}`);
        return;
      }
      // N8: re-fetch task at trigger time to avoid stale closure snapshot
      const taskId = task.id;
      const cronTask = nodeCron.schedule(task.cronExpression, async () => {
        const latest = await this.taskRepo.findOne({ where: { id: taskId, status: TaskStatus.ACTIVE } });
        if (latest) await this.enqueue(latest, 'cron');
      });
      this.cronTasks.set(task.id, cronTask);
      this.logger.log(`Re-scheduled cron task "${task.name}" with expression: ${task.cronExpression}`);
    }
  }
}
