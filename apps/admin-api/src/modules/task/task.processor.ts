import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, Inject, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, DataSource } from "typeorm";
import { Job, Queue } from "bullmq";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "./entities/task-execution.entity";
import { ExecutionLogLine } from "./entities/execution-log-line.entity";
import { Task } from "./entities/task.entity";
import { ExecutorService } from "../executor/executor.service";
import { AiService } from "../ai/ai.service";
import { NotificationService } from "../notification/notification.service";
import { AuditService } from "../audit/audit.service";
import { TaskService } from "./task.service";

@Processor("task-queue")
export class TaskProcessor extends WorkerHost {
  private readonly logger = new Logger(TaskProcessor.name);

  constructor(
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(ExecutionLogLine)
    private logLineRepo: Repository<ExecutionLogLine>,
    private executorService: ExecutorService,
    private aiService: AiService,
    private notificationService: NotificationService,
    private configService: ConfigService,
    private auditService: AuditService,
    @Inject(forwardRef(() => TaskService)) private taskService: TaskService,
    @InjectQueue("task-queue") private taskQueue: Queue,
    private dataSource: DataSource,
  ) {
    super();
  }

  // LOG-01: structured log-line persistence now lives in TaskService
  // (storeLogLines / backfillFullLogsFromExecutor), invoked from
  // handleCallback so it runs for every completed execution.

  async process(job: Job<{ executionId: string }>) {
    return this.handle(job);
  }

  async handle(job: Job<{ executionId: string }>) {
    const { executionId } = job.data;
    const exec = await this.execRepo.findOne({ where: { id: executionId } });
    if (!exec) return;

    // Fetch latest task from DB to avoid stale serialized object from queue
    const task = await this.taskRepo.findOne({ where: { id: exec.taskId } });
    if (!task) {
      this.logger.error(
        `Task ${exec.taskId} not found for execution ${executionId}`,
      );
      exec.status = ExecutionStatus.FAILED;
      exec.errorMessage = `Task ${exec.taskId} not found`;
      exec.failureReason = ExecutionFailureReason.UNKNOWN;
      await this.execRepo.save(exec);
      return;
    }

    exec.status = ExecutionStatus.RUNNING;
    exec.startTime = new Date();
    await this.execRepo.save(exec);

    try {
      // Broadcast mode: dispatch to all online executors
      // Single mode: dispatch to the executor with lowest load
      const isBroadcast = task.executeMode === "broadcast";
      const rawResult = isBroadcast
        ? await this.executorService.dispatchBroadcast(task, exec)
        : await this.executorService.dispatch(task, exec);
      // Dispatch success only means the executor accepted the task. The actual
      // result is reported asynchronously via /executions/callback.
      exec.status = ExecutionStatus.RUNNING;
      exec.result = isBroadcast
        ? {
            broadcast: true,
            acceptedExecutorCount: rawResult.length,
            acceptedResults: rawResult,
          }
        : rawResult;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack =
        err instanceof Error ? err.stack || err.message : String(err);
      exec.status = ExecutionStatus.FAILED;
      exec.errorMessage = errMsg;
      const failureText = `${errMsg}\n${errStack}`;
      exec.failureReason = /timeout|timed out|etimedout|execution timed/i.test(
        failureText,
      )
        ? ExecutionFailureReason.TIMEOUT
        : /no available executor|executor.*(offline|unavailable)|econnrefused|enotfound|network error|socket hang up/i.test(
              failureText,
            )
          ? ExecutionFailureReason.EXECUTOR_OFFLINE
          : /git clone|package fetch|pull package|download package|npm install|pip install|requirements|dependency/i.test(
                failureText,
              )
            ? ExecutionFailureReason.PACKAGE_FETCH_FAILED
            : /traceback|syntaxerror|referenceerror|typeerror|uncaught|exception|command failed|exit code/i.test(
                  failureText,
                )
              ? ExecutionFailureReason.SCRIPT_ERROR
              : ExecutionFailureReason.UNKNOWN;
      exec.logs = errStack;
      try {
        exec.aiAnalysis = await this.aiService.analyzeFailure(task, exec.logs);
      } catch (aiErr: unknown) {
        const aiErrMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
        this.logger.warn(`AI analysis failed for task ${task.id}: ${aiErrMsg}`);
      }
      this.logger.error(`Task ${task.id} failed: ${errMsg}`);
      try {
        await this.notificationService.notifyFailureWithConfig(
          task.name,
          exec.id,
          errMsg,
          exec.aiAnalysis,
          task.alarmEmail,
          task.alarmChannels,
        );
      } catch (notifyErr: unknown) {
        // B-08: record notification failure to audit log so it is not silently discarded
        const notifyErrMsg =
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
        this.logger.error(
          `Notification failed for execution ${exec.id}: ${notifyErrMsg}`,
        );
        try {
          await this.auditService.log({
            action: "NOTIFICATION_FAILED",
            resource: "task_execution",
            resourceId: exec.id,
            detail: { task: task.name, error: notifyErrMsg },
          });
        } catch {
          /* audit is best-effort */
        }
      }
      // Q1: rethrow so BullMQ sees the job as failed and applies maxRetry attempts
      throw err;
    } finally {
      const isTerminal = [
        ExecutionStatus.SUCCESS,
        ExecutionStatus.FAILED,
        ExecutionStatus.TIMEOUT,
        ExecutionStatus.KILLED,
        ExecutionStatus.CANCELLED,
      ].includes(exec.status);
      if (isTerminal) {
        exec.endTime = new Date();
        // ERR-02: null guard to prevent NaN when startTime is not set
        exec.duration = exec.startTime
          ? exec.endTime.getTime() - exec.startTime.getTime()
          : 0;
      }

      // BUG-02: Use transaction to ensure atomic state update
      // This prevents inconsistent state if database save fails
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        await queryRunner.manager.save(exec);
        await queryRunner.commitTransaction();
        this.logger.debug(
          `Successfully saved execution ${exec.id} final state in transaction`,
        );
      } catch (saveErr) {
        await queryRunner.rollbackTransaction();
        this.logger.error(
          `Failed to save execution ${exec.id} final state, transaction rolled back`,
          saveErr,
        );

        // Attempt to repair state in a separate transaction
        try {
          const repairRunner = this.dataSource.createQueryRunner();
          await repairRunner.connect();
          await repairRunner.startTransaction();

          try {
            // Re-fetch the execution to get current state
            const currentExec = await repairRunner.manager.findOne(
              TaskExecution,
              { where: { id: exec.id } },
            );
            if (currentExec) {
              // Only update if the execution is still in RUNNING state
              if (currentExec.status === ExecutionStatus.RUNNING) {
                currentExec.status = exec.status;
                currentExec.endTime = exec.endTime;
                currentExec.duration = exec.duration;
                currentExec.result = exec.result;
                currentExec.logs = exec.logs;
                currentExec.errorMessage = exec.errorMessage;
                currentExec.failureReason = exec.failureReason;
                currentExec.aiAnalysis = exec.aiAnalysis;
                await repairRunner.manager.save(currentExec);
                this.logger.log(
                  `Repaired execution ${exec.id} state after transaction failure`,
                );
              }
            }
            await repairRunner.commitTransaction();
          } catch (repairErr) {
            await repairRunner.rollbackTransaction();
            this.logger.error(
              `Failed to repair execution ${exec.id} state`,
              repairErr,
            );
          } finally {
            await repairRunner.release();
          }
        } catch (repairAttemptErr) {
          this.logger.error(
            `Failed to attempt repair for execution ${exec.id}`,
            repairAttemptErr,
          );
        }
      } finally {
        await queryRunner.release();
      }

      // Trigger dependent tasks after successful execution
      if ((exec.status as ExecutionStatus) === ExecutionStatus.SUCCESS) {
        await this.triggerDependentTasks(exec.taskId);
      }
    }
  }

  /**
   * Check and trigger tasks that depend on the completed task.
   */
  private async triggerDependentTasks(completedTaskId: string) {
    try {
      // Find all tasks that have any dependencies set, then filter in-process.
      // Using application-layer filtering avoids JSONB-specific SQL that breaks
      // on non-PostgreSQL engines and is simpler to reason about.
      const allTasksWithDeps = await this.taskRepo
        .createQueryBuilder("t")
        .where("t.dependencies IS NOT NULL")
        .getMany();

      // Keep only tasks that list completedTaskId as one of their dependency values
      const dependentTasks = allTasksWithDeps.filter(
        (t) =>
          t.dependencies &&
          Object.values(t.dependencies).includes(completedTaskId),
      );

      for (const task of dependentTasks) {
        // Check if all dependencies are satisfied
        const canTrigger = await this.checkDependencies(task);
        if (canTrigger) {
          this.logger.log(
            `All dependencies satisfied for task ${task.id}, triggering`,
          );
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
      order: { createdAt: "DESC" },
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
