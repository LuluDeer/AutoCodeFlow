import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { Cron, CronExpression } from "@nestjs/schedule";
import * as nodeCron from "node-cron";
import {
  Task,
  TaskStatus,
  TaskTriggerType,
  BlockStrategy,
  MisfireStrategy,
} from "../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../task/entities/task-execution.entity";
import { RedisLockService } from "../../common/services/redis-lock.service";

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  // fixed_rate timers
  private timers = new Map<string, NodeJS.Timeout>();
  // cron tasks
  private cronTasks = new Map<string, nodeCron.ScheduledTask>();
  // B-04: Track whether a fixed_rate task is currently executing to prevent re-entry
  private runningTasks = new Map<string, boolean>();

  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectQueue("task-queue") private queue: Queue,
    private redisLockService: RedisLockService,
  ) {}

  async onModuleInit() {
    await this.reload();
    await this.checkMisfires();
    await this.recoverStaleExecutions();
  }

  /** Detect misfires on startup and compensate according to policy */
  async checkMisfires() {
    const tasks = await this.taskRepo.find({
      where: { status: TaskStatus.ACTIVE },
    });
    const now = Date.now();
    for (const task of tasks) {
      if (!task.lastTriggerTime) continue;
      const gap = now - task.lastTriggerTime.getTime();
      const threshold =
        task.triggerType === TaskTriggerType.FIXED_RATE
          ? (task.fixedRate || 60) * 2000
          : 2 * 60 * 1000;
      if (gap > threshold) {
        if (task.misfireStrategy === MisfireStrategy.FIRE_ONCE) {
          this.logger.warn(`Misfire detected for "${task.name}", firing once`);
          await this.enqueue(task, "misfire");
        } else {
          this.logger.warn(
            `Misfire detected for "${task.name}", strategy=IGNORE`,
          );
        }
      }
    }
  }

  /**
   * REC-01: Periodically find executions stuck in RUNNING (e.g. from a crash)
   * and mark them FAILED so the UI never shows permanently-running tasks.
   * Runs on startup and every 10 minutes thereafter.
   *
   * Timeout logic:
   * - If the associated task has a timeout > 0, use that as the stale threshold.
   * - Otherwise fall back to a 1-hour global grace window.
   */
  @Cron('0 */10 * * * *')
  async recoverStaleExecutions() {
    const runningExecs = await this.execRepo.find({
      where: { status: ExecutionStatus.RUNNING },
      relations: ['task'],
    });
    if (!runningExecs.length) return;

    const now = Date.now();
    const DEFAULT_STALE_MS = 60 * 60 * 1000; // 1-hour fallback
    let recovered = 0;
    for (const exec of runningExecs) {
      const anchor = exec.startTime ?? exec.createdAt;
      if (!anchor) continue;

      // Prefer per-task timeout (seconds → ms); fall back to global default
      const taskTimeoutSec = (exec as any).task?.timeout;
      const staleMs =
        taskTimeoutSec && taskTimeoutSec > 0
          ? taskTimeoutSec * 1000
          : DEFAULT_STALE_MS;

      if (now - anchor.getTime() > staleMs) {
        exec.status = ExecutionStatus.FAILED;
        exec.endTime = new Date();
        exec.errorMessage =
          taskTimeoutSec && taskTimeoutSec > 0
            ? `Execution timed out after ${taskTimeoutSec}s`
            : 'Execution did not complete (recovered on node restart)';
        await this.execRepo.save(exec);
        recovered++;
        this.logger.warn(
          `REC-01: execution ${exec.id} (task=${exec.taskId}) timed out after ${staleMs / 1000}s`,
        );
      }
    }
    if (recovered > 0) {
      this.logger.warn(`REC-01: recovered ${recovered} stale RUNNING execution(s)`);
    }
  }

  onModuleDestroy() {
    this.timers.forEach((t) => clearInterval(t));
    this.cronTasks.forEach((t) => t.stop());
  }

  /** Re-scan active tasks every minute and register any unscheduled tasks */
  @Cron(CronExpression.EVERY_MINUTE)
  async reload() {
    const tasks = await this.taskRepo.find({
      where: { status: TaskStatus.ACTIVE },
    });
    const activeIds = new Set(tasks.map((t) => t.id));

    // BUG-01: Stop and clean up timers for tasks that are no longer active
    // This prevents memory leaks from accumulating inactive task references
    for (const id of this.timers.keys()) {
      if (!activeIds.has(id)) this.stop(id);
    }
    for (const id of this.cronTasks.keys()) {
      if (!activeIds.has(id)) this.stop(id);
    }

    // BUG-01: Clean up running tasks map for tasks that are no longer active
    for (const id of this.runningTasks.keys()) {
      if (!activeIds.has(id)) this.runningTasks.delete(id);
    }

    for (const t of tasks) {
      if (
        t.triggerType === TaskTriggerType.FIXED_RATE &&
        t.fixedRate &&
        !this.timers.has(t.id)
      ) {
        const taskId = t.id;
        const timer = setInterval(async () => {
          // B-04: Skip if previous execution is still running to prevent re-entry
          if (this.runningTasks.get(taskId)) {
            this.logger.warn(
              `Fixed_rate task "${t.name}" still running, skipping trigger`,
            );
            return;
          }
          this.runningTasks.set(taskId, true);
          try {
            const latest = await this.taskRepo.findOne({
              where: { id: taskId, status: TaskStatus.ACTIVE },
            });
            if (latest) await this.enqueue(latest, "fixed_rate");
          } finally {
            this.runningTasks.delete(taskId);
          }
        }, t.fixedRate * 1000);
        this.timers.set(t.id, timer);
        this.logger.log(
          `Scheduled fixed_rate task "${t.name}" every ${t.fixedRate}s`,
        );
      }

      if (
        t.triggerType === TaskTriggerType.CRON &&
        t.cronExpression &&
        !this.cronTasks.has(t.id)
      ) {
        if (!nodeCron.validate(t.cronExpression)) {
          this.logger.warn(
            `Invalid cron expression for task "${t.name}": ${t.cronExpression}`,
          );
          continue;
        }
        // N8: re-fetch task at trigger time to avoid stale closure snapshot
        const taskId = t.id;
        const cronTask = nodeCron.schedule(t.cronExpression, async () => {
          const latest = await this.taskRepo.findOne({
            where: { id: taskId, status: TaskStatus.ACTIVE },
          });
          if (latest) await this.enqueue(latest, "cron");
        });
        this.cronTasks.set(t.id, cronTask);
        this.logger.log(
          `Scheduled cron task "${t.name}" with expression: ${t.cronExpression}`,
        );
      }
    }
  }

  async enqueue(task: Task, triggerType: string) {
    const minIntervalMs =
      task.triggerType === TaskTriggerType.FIXED_RATE && task.fixedRate
        ? task.fixedRate * 1000
        : 5_000;

    const lock = await this.redisLockService.acquireLock(
      `task:trigger:${task.id}`,
      minIntervalMs,
    );
    if (!lock) {
      this.logger.debug(
        `Task "${task.name}" recently triggered by another instance, skip`,
      );
      return null;
    }

    try {
      const taskRecord = await this.taskRepo.findOne({
        where: { id: task.id, status: TaskStatus.ACTIVE },
      });
      if (!taskRecord) {
        this.logger.debug(`Task "${task.name}" is no longer active, skip`);
        return null;
      }

      if (task.blockStrategy === BlockStrategy.DISCARD) {
        const running = await this.execRepo.findOne({
          where: { taskId: task.id, status: ExecutionStatus.RUNNING },
        });
        if (running) {
          this.logger.warn(
            `Task "${task.name}" is RUNNING (blockStrategy=DISCARD), skip trigger`,
          );
          return null;
        }
      }

      if (task.blockStrategy === BlockStrategy.COVER_EARLY) {
        const running = await this.execRepo.findOne({
          where: { taskId: task.id, status: ExecutionStatus.RUNNING },
        });
        if (running) {
          this.logger.warn(
            `Task "${task.name}" is RUNNING (blockStrategy=COVER_EARLY), cancelling running execution ${running.id}`,
          );
          running.status = ExecutionStatus.CANCELLED;
          running.errorMessage = "Task was covered by new trigger";
          running.endTime = new Date();
          await this.execRepo.save(running);
        }
      }

      const exec = await this.execRepo.save(
        this.execRepo.create({
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: task.params,
          triggerType,
          taskVersion: task.currentVersion,
        }),
      );

      const queueOptions = {
        attempts: Math.max(1, task.maxRetry ?? 1),
        backoff:
          task.retryDelay > 0
            ? {
                type: "exponential" as const,
                delay: task.retryDelay * 1000,
              }
            : undefined,
        priority: task.priority,
      };
      await this.queue.add(
        "execute",
        { executionId: exec.id, task },
        queueOptions,
      );
      return exec;
    } finally {
      await lock.release();
    }
  }

  /** Stop and remove all schedules for the given task */
  stop(taskId: string) {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(taskId);
    }

    const cronTask = this.cronTasks.get(taskId);
    if (cronTask) {
      cronTask.stop();
      this.cronTasks.delete(taskId);
    }

    this.runningTasks.delete(taskId);
  }

  /** Register scheduling for a single task; call after TaskService update to avoid waiting for the next reload */
  async scheduleOne(task: Task) {
    this.stop(task.id);

    if (task.triggerType === TaskTriggerType.FIXED_RATE && task.fixedRate) {
      const taskId = task.id;
      const timer = setInterval(async () => {
        // B-04: Prevent re-entry
        if (this.runningTasks.get(taskId)) {
          this.logger.warn(
            `Fixed_rate task "${task.name}" still running, skipping trigger`,
          );
          return;
        }
        this.runningTasks.set(taskId, true);
        try {
          const latest = await this.taskRepo.findOne({
            where: { id: taskId, status: TaskStatus.ACTIVE },
          });
          if (latest) await this.enqueue(latest, "fixed_rate");
        } finally {
          this.runningTasks.delete(taskId);
        }
      }, task.fixedRate * 1000);
      this.timers.set(task.id, timer);
      this.logger.log(
        `Re-scheduled fixed_rate task "${task.name}" every ${task.fixedRate}s`,
      );
    }

    if (task.triggerType === TaskTriggerType.CRON && task.cronExpression) {
      if (!nodeCron.validate(task.cronExpression)) {
        this.logger.warn(
          `Invalid cron expression for task "${task.name}": ${task.cronExpression}`,
        );
        return;
      }
      // N8: re-fetch task at trigger time to avoid stale closure snapshot
      const taskId = task.id;
      const cronTask = nodeCron.schedule(task.cronExpression, async () => {
        const latest = await this.taskRepo.findOne({
          where: { id: taskId, status: TaskStatus.ACTIVE },
        });
        if (latest) await this.enqueue(latest, "cron");
      });
      this.cronTasks.set(task.id, cronTask);
      this.logger.log(
        `Re-scheduled cron task "${task.name}" with expression: ${task.cronExpression}`,
      );
    }
  }

  /** Get scheduler runtime statistics */
  getStats() {
    return {
      healthy: true, // Scheduler is considered healthy if it's not crashed
      activeTimers: this.timers.size,
      activeCronTasks: this.cronTasks.size,
      runningTaskCount: this.runningTasks.size,
      totalScheduledTasks: this.timers.size + this.cronTasks.size,
      uptime: process.uptime(),
    };
  }
}
