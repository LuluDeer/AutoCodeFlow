import { Process, Processor } from '@nestjs/bull';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource, QueryRunner } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { TaskExecution, ExecutionStatus } from './entities/task-execution.entity';
import { ExecutionLogLine } from './entities/execution-log-line.entity';
import { Task } from './entities/task.entity';
import { ExecutorService } from '../executor/executor.service';
import { AiService } from '../ai/ai.service';
import { NotificationService } from '../notification/notification.service';
import { AuditService } from '../audit/audit.service';
import { TaskService } from './task.service';

@Processor('task-queue')
export class TaskProcessor {
  private readonly logger = new Logger(TaskProcessor.name);

  constructor(
    @InjectRepository(TaskExecution) private execRepo: Repository<TaskExecution>,
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(ExecutionLogLine) private logLineRepo: Repository<ExecutionLogLine>,
    private executorService: ExecutorService,
    private aiService: AiService,
    private notificationService: NotificationService,
    private configService: ConfigService,
    private auditService: AuditService,
    @Inject(forwardRef(() => TaskService)) private taskService: TaskService,
    @InjectQueue('task-queue') private taskQueue: Queue,
    private dataSource: DataSource,
  ) {}

  /**
   * Fetch log lines from executor's /api/logs/{executionId} endpoint and
   * persist them as ExecutionLogLine rows for structured querying.
   */
  private async fetchAndStoreLogLines(exec: TaskExecution, executorAddress: string): Promise<void> {
    if (!executorAddress) return;
    try {
      // N9: use ConfigService instead of direct process.env access
      const token = this.configService.get<string>('executor.sharedToken') ?? '';
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const { default: axios } = await import('axios');
      const url = this.executorService.getExecutorUrl(executorAddress, `api/logs/${exec.id}`);
      const resp = await axios.get(url, { headers, timeout: 15000 });
      const lines: string[] = resp.data?.lines ?? [];
      if (lines.length === 0) return;
      // Delete stale lines first (idempotent on retry)
      await this.logLineRepo.delete({ executionId: exec.id });
      const entities = lines.map((content, idx) =>
        this.logLineRepo.create({ executionId: exec.id, lineNumber: idx, content }),
      );

      // PERF-02: Adaptive batch size based on entity count
      // Start with 500, increase for small batches, decrease for large batches
      let chunkSize = 500;
      if (entities.length < 100) {
        chunkSize = entities.length; // Small batch: insert all at once
      } else if (entities.length > 10000) {
        chunkSize = 200; // Large batch: smaller chunks to avoid memory issues
      } else if (entities.length > 5000) {
        chunkSize = 300; // Medium-large batch
      }

      // Measure insertion time and adjust chunk size dynamically
      const startTime = Date.now();
      for (let i = 0; i < entities.length; i += chunkSize) {
        const chunk = entities.slice(i, i + chunkSize);
        const chunkStart = Date.now();
        await this.logLineRepo.save(chunk);
        const chunkDuration = Date.now() - chunkStart;

        // If this chunk took too long, reduce chunk size for next iteration
        if (chunkDuration > 1000 && chunkSize > 100) {
          chunkSize = Math.max(100, Math.floor(chunkSize * 0.8));
          this.logger.debug(`Reduced chunk size to ${chunkSize} due to slow insertion (${chunkDuration}ms)`);
        }
        // If chunk was very fast, try increasing chunk size
        else if (chunkDuration < 100 && chunkSize < 1000) {
          chunkSize = Math.min(1000, Math.floor(chunkSize * 1.2));
        }
      }

      const totalDuration = Date.now() - startTime;
      this.logger.log(`Stored ${entities.length} log lines for execution ${exec.id} in ${totalDuration}ms (final chunk size: ${chunkSize})`);
    } catch (err: unknown) {
      // Non-fatal: log but do not fail the execution record
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch log lines for ${exec.id}: ${message}`);
    }
  }

  @Process('execute')
  async handle(job: Job<{ executionId: string }>) {
    const { executionId } = job.data;
    const exec = await this.execRepo.findOne({ where: { id: executionId } });
    if (!exec) return;

    // 从数据库查询最新 task，避免使用队列中可能过期的序列化对象
    const task = await this.taskRepo.findOne({ where: { id: exec.taskId } });
    if (!task) {
      this.logger.error(`Task ${exec.taskId} not found for execution ${executionId}`);
      exec.status = ExecutionStatus.FAILED;
      exec.errorMessage = `Task ${exec.taskId} not found`;
      await this.execRepo.save(exec);
      return;
    }

    exec.status = ExecutionStatus.RUNNING;
    exec.startTime = new Date();
    await this.execRepo.save(exec);

    try {
      const result = await this.executorService.dispatch(task, exec);
      exec.status = ExecutionStatus.SUCCESS;
      exec.result = result;
      exec.logs = result?.logs || '';
      // Fetch and store structured log lines from executor
      await this.fetchAndStoreLogLines(exec, result?.executorAddress ?? exec.executorAddress);
    } catch (err) {
      exec.status = ExecutionStatus.FAILED;
      exec.errorMessage = err.message;
      exec.logs = err.stack || err.message;
      try {
        exec.aiAnalysis = await this.aiService.analyzeFailure(task, exec.logs);
      } catch {}
      this.logger.error(`Task ${task.id} failed: ${err.message}`);
      try {
        await this.notificationService.notifyFailureWithConfig(task.name, exec.id, err.message, exec.aiAnalysis, task.alarmEmail, task.alarmChannels);
      } catch (notifyErr) {
        // B-08: record notification failure to audit log so it is not silently discarded
        this.logger.error(`Notification failed for execution ${exec.id}: ${notifyErr.message}`);
        try {
          await this.auditService.log({
            action: 'NOTIFICATION_FAILED',
            resource: 'task_execution',
            resourceId: exec.id,
            detail: { task: task.name, error: notifyErr.message },
          });
        } catch { /* audit is best-effort */ }
      }
      // Q1: rethrow so BullMQ sees the job as failed and applies maxRetry attempts
      throw err;
    } finally {
      exec.endTime = new Date();
      // ERR-02: null guard to prevent NaN when startTime is not set
      exec.duration = exec.startTime
        ? exec.endTime.getTime() - exec.startTime.getTime()
        : 0;

      // BUG-02: Use transaction to ensure atomic state update
      // This prevents inconsistent state if database save fails
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        await queryRunner.manager.save(exec);
        await queryRunner.commitTransaction();
        this.logger.debug(`Successfully saved execution ${exec.id} final state in transaction`);
      } catch (saveErr) {
        await queryRunner.rollbackTransaction();
        this.logger.error(`Failed to save execution ${exec.id} final state, transaction rolled back`, saveErr);

        // Attempt to repair state in a separate transaction
        try {
          const repairRunner = this.dataSource.createQueryRunner();
          await repairRunner.connect();
          await repairRunner.startTransaction();

          try {
            // Re-fetch the execution to get current state
            const currentExec = await repairRunner.manager.findOne(TaskExecution, { where: { id: exec.id } });
            if (currentExec) {
              // Only update if the execution is still in RUNNING state
              if (currentExec.status === ExecutionStatus.RUNNING) {
                currentExec.status = exec.status;
                currentExec.endTime = exec.endTime;
                currentExec.duration = exec.duration;
                currentExec.result = exec.result;
                currentExec.logs = exec.logs;
                currentExec.errorMessage = exec.errorMessage;
                currentExec.aiAnalysis = exec.aiAnalysis;
                await repairRunner.manager.save(currentExec);
                this.logger.log(`Repaired execution ${exec.id} state after transaction failure`);
              }
            }
            await repairRunner.commitTransaction();
          } catch (repairErr) {
            await repairRunner.rollbackTransaction();
            this.logger.error(`Failed to repair execution ${exec.id} state`, repairErr);
          } finally {
            await repairRunner.release();
          }
        } catch (repairAttemptErr) {
          this.logger.error(`Failed to attempt repair for execution ${exec.id}`, repairAttemptErr);
        }
      } finally {
        await queryRunner.release();
      }

      // Trigger dependent tasks after successful execution
      if (exec.status === ExecutionStatus.SUCCESS) {
        await this.triggerDependentTasks(exec.taskId);
      }
    }
  }

  /**
   * Check and trigger tasks that depend on the completed task.
   */
  private async triggerDependentTasks(completedTaskId: string) {
    try {
      // Find all tasks that have dependencies on the completed task
      const dependentTasks = await this.taskRepo
        .createQueryBuilder('t')
        .where("EXISTS (SELECT 1 FROM jsonb_each(t.dependencies) WHERE value = :taskId)", { taskId: completedTaskId })
        .getMany();

      for (const task of dependentTasks) {
        // Check if all dependencies are satisfied
        const canTrigger = await this.checkDependencies(task);
        if (canTrigger) {
          this.logger.log(`All dependencies satisfied for task ${task.id}, triggering`);
          await this.taskService.trigger(task.id, {});
        }
      }
    } catch (err) {
      this.logger.error(`Failed to trigger dependent tasks: ${err.message}`);
    }
  }

  /**
   * Check if all dependencies of a task have completed successfully.
   */
  private async checkDependencies(task: Task): Promise<boolean> {
    if (!task.dependencies || Object.keys(task.dependencies).length === 0) {
      return true;
    }

    const dependencyIds = Object.values(task.dependencies);
    if (dependencyIds.length === 0) return true;

    const recentExecutions = await this.execRepo.find({
      where: { taskId: In(dependencyIds as string[]) },
      order: { createdAt: 'DESC' },
    });

    // Group by taskId and get the most recent execution for each
    const latestByTask = new Map<string, TaskExecution>();
    for (const exec of recentExecutions) {
      if (!latestByTask.has(exec.taskId)) {
        latestByTask.set(exec.taskId, exec);
      }
    }

    // Check if all dependencies have successful executions
    for (const depId of dependencyIds) {
      const latestExec = latestByTask.get(depId as string);
      if (!latestExec || latestExec.status !== ExecutionStatus.SUCCESS) {
        return false;
      }
    }

    return true;
  }
}
