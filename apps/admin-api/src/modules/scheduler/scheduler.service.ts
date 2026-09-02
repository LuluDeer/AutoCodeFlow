import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
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
  ExecutionFailureReason,
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
  // Prevent reload() and scheduleOne() from registering the same task concurrently.
  private schedulingTasks = new Set<string>();

  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectQueue("task-queue") private queue: Queue,
    private redisLockService: RedisLockService,
    private dataSource: DataSource,
  ) {}

  private getCronOptions(task: Task): { timezone: string } | undefined {
    const timezone = task.timezone?.trim();
    if (!timezone) return undefined;

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(
        new Date(),
      );
      return { timezone };
    } catch {
      this.logger.warn(
        `Invalid timezone for task "${task.name}": ${timezone}; scheduling with server default timezone`,
      );
      return undefined;
    }
  }

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
  @Cron("0 */10 * * * *")
  async recoverStaleExecutions() {
    const runningExecs = await this.execRepo.find({
      where: { status: ExecutionStatus.RUNNING },
    });

    const now = Date.now();
    const DEFAULT_STALE_MS = 60 * 60 * 1000; // 1-hour fallback
    let recovered = 0;

    // Get all unique taskIds and fetch their timeouts
    const taskIds = [...new Set(runningExecs.map((e) => e.taskId))];
    const tasks =
      taskIds.length > 0 ? await this.taskRepo.findBy({ id: In(taskIds) }) : [];
    const taskTimeouts = new Map<string, number>();
    for (const t of tasks) {
      if (t.timeout && t.timeout > 0) {
        taskTimeouts.set(t.id, t.timeout);
      }
    }

    for (const exec of runningExecs) {
      const anchor = exec.startTime ?? exec.createdAt;
      if (!anchor) continue;

      // Prefer per-task timeout (seconds → ms); fall back to global default
      const taskTimeoutSec = taskTimeouts.get(exec.taskId);
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
            : "Execution did not complete (recovered on node restart)";
        exec.failureReason =
          taskTimeoutSec && taskTimeoutSec > 0
            ? ExecutionFailureReason.TIMEOUT
            : ExecutionFailureReason.UNKNOWN;
        await this.execRepo.save(exec);
        await this.releaseExecutorSlot(exec.executorAddress);
        recovered++;
        this.logger.warn(
          `REC-01: execution ${exec.id} (task=${exec.taskId}) timed out after ${staleMs / 1000}s`,
        );
      }
    }
    // P1: sweep PENDING executions never picked up by a worker (queue lost
    // the job / Redis flushed) — after a grace window mark them FAILED.
    const stalePending = await this.execRepo.find({
      where: { status: ExecutionStatus.PENDING },
    });
    const PENDING_GRACE_MS = 10 * 60 * 1000;
    for (const exec of stalePending) {
      if (
        exec.createdAt &&
        now - exec.createdAt.getTime() > PENDING_GRACE_MS
      ) {
        await this.execRepo.update(exec.id, {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          errorMessage:
            "Execution was never dispatched by the queue (recovered by stale sweep)",
          failureReason: ExecutionFailureReason.UNKNOWN,
        });
        recovered++;
        this.logger.warn(
          `REC-01: pending execution ${exec.id} (task=${exec.taskId}) never dispatched, marked FAILED`,
        );
      }
    }

    if (recovered > 0) {
      this.logger.warn(
        `REC-01: recovered ${recovered} stale execution(s)`,
      );
    }
  }

  private async releaseExecutorSlot(address?: string | null): Promise<void> {
    if (!address) return;
    await this.dataSource
      .createQueryBuilder()
      .update("executors")
      .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
      .where("address = :addr", { addr: address })
      .execute();
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

    for (const task of tasks) {
      if (this.timers.has(task.id) || this.cronTasks.has(task.id)) continue;
      await this.scheduleOne(task);
    }
  }

  async enqueue(task: Task, triggerType: string) {
    // R-P0-007: Dynamically calculate lock TTL based on task timeout
    // Use max(task.timeout * 1000, minIntervalMs) to prevent premature lock release
    const minIntervalMs =
      task.triggerType === TaskTriggerType.FIXED_RATE && task.fixedRate
        ? task.fixedRate * 1000
        : 5_000;
    const taskTimeoutMs = (task.timeout || 300) * 1000;
    const lockTTL = Math.max(taskTimeoutMs, minIntervalMs);

    const lock = await this.redisLockService.acquireLock(
      `task:trigger:${task.id}`,
      lockTTL,
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
          await this.releaseExecutorSlot(running.executorAddress);
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
      try {
        await this.queue.add(
          "execute",
          { executionId: exec.id, task },
          queueOptions,
        );
      } catch (err: unknown) {
        // P1: compensate the committed PENDING row so it cannot hang forever
        const message = err instanceof Error ? err.message : String(err);
        await this.execRepo.update(exec.id, {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          errorMessage: `Failed to enqueue execution: ${message}`,
          failureReason: ExecutionFailureReason.UNKNOWN,
        });
        this.logger.error(
          `Failed to enqueue execution ${exec.id}: ${message}`,
        );
        return null;
      }
      // P1: record the trigger time so checkMisfires() has data to work
      // with (this column was previously never written, leaving misfire
      // compensation dead code).
      await this.taskRepo.update(task.id, {
        lastTriggerTime: new Date(),
      });
      return exec;
    } finally {
      // P1: deliberately do NOT release the dedup lock — its TTL is the
      // dedup window across instances. Releasing it milliseconds after
      // acquisition made it useless against clock skew between instances.
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
    if (this.schedulingTasks.has(task.id)) return;
    this.schedulingTasks.add(task.id);
    try {
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
      const cronTask = nodeCron.schedule(
        task.cronExpression,
        async () => {
          const latest = await this.taskRepo.findOne({
            where: { id: taskId, status: TaskStatus.ACTIVE },
          });
          if (latest) await this.enqueue(latest, "cron");
        },
        this.getCronOptions(task),
      );
      this.cronTasks.set(task.id, cronTask);
        this.logger.log(
          `Re-scheduled cron task "${task.name}" with expression: ${task.cronExpression}`,
        );
      }
    } finally {
      this.schedulingTasks.delete(task.id);
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
