import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, Inject, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { Job, Queue, UnrecoverableError } from "bullmq";
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

// PERF-P3a: worker 并发 1→5，消除队头阻塞（一个慢 dispatch HTTP 不再卡住
// 整条队列）。安全性依据：执行器容量闸门在 dispatch 内由 DB 原子操作保证
// （executor.service selectLeastLoaded + 条件 UPDATE 占坑），worker 并发
// 只是并行化派发，不会超卖执行器槽位。注意 @nestjs/bullmq v11 中
// concurrency 必须走第二参数 NestWorkerOptions（单对象形式仅支持
// name/scope/configKey，多余键会被静默丢弃）。
@Processor("task-queue", { concurrency: 5 })
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
      exec.endTime = new Date();
      exec.duration = 0;
      await this.execRepo.save(exec);
      return;
    }

    // P0: claim the execution atomically. A KILLED/CANCELLED execution (e.g.
    // killed while still queued) must never be revived by a worker; FAILED is
    // still claimable because BullMQ retries run through here again (the
    // shared recovery retry pattern in executor.service.scheduleRetryAfterRecovery
    // — used by both the executor-restart path and the P2 stale-sweep
    // re-enqueue — also creates a fresh PENDING row, but the legacy retry
    // semantics that let a FAILED row be re-dispatched must remain intact — do
    // not drop FAILED from this list).
    //
    // CONSISTENCY-01: RUNNING is deliberately NOT claimable. A stalled BullMQ
    // job (worker crash / lost lock) is redelivered and re-runs handle() while
    // the DB row is still RUNNING from the first claim. Previously a second
    // claim would re-flip RUNNING→RUNNING and dispatch the same executionId to
    // — possibly — a different executor, so the old executor kept running
    // unaware: two live copies of one execution, doubled side effects, and the
    // duration/startTime rewritten by whichever callback arrived first. With
    // RUNNING excluded, the redelivered job's claim affects 0 rows and the
    // processor returns idle (no second dispatch). Zombie RUNNING rows left by
    // a genuinely dead executor are converged by the existing stale sweep
    // (SchedulerService.recoverStaleExecutions) — the two recovery paths keep
    // their separate responsibilities.
    const startTime = new Date();
    const claimed = await this.execRepo
      .createQueryBuilder()
      .update(TaskExecution)
      .set({ status: ExecutionStatus.RUNNING, startTime })
      .where("id = :id", { id: executionId })
      .andWhere("status IN (:...claimable)", {
        claimable: [ExecutionStatus.PENDING, ExecutionStatus.FAILED],
      })
      .execute();
    if (!claimed.affected) {
      this.logger.warn(
        `Execution ${executionId} reached a terminal state before dispatch, skipping`,
      );
      return;
    }
    exec.status = ExecutionStatus.RUNNING;
    exec.startTime = startTime;

    try {
      // Broadcast mode: dispatch to all online executors
      // Single mode: dispatch to the executor with lowest load
      const isBroadcast = task.executeMode === "broadcast";
      const rawResult = isBroadcast
        ? await this.executorService.dispatchBroadcast(task, exec)
        : await this.executorService.dispatch(task, exec);
      // Persist the dispatch target immediately so the callback path can
      // verify the reporting executor and release its slot, even if this
      // worker's final save loses the race with a fast callback.
      if (!isBroadcast && exec.executorAddress) {
        await this.execRepo.update(exec.id, {
          executorAddress: exec.executorAddress,
        });
      }
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
      // P2: align with the callback path — a TIMEOUT reason must produce
      // TIMEOUT status, not FAILED.
      exec.status =
        exec.failureReason === ExecutionFailureReason.TIMEOUT
          ? ExecutionStatus.TIMEOUT
          : ExecutionStatus.FAILED;
      exec.logs = errStack;
      // P2: AI analysis and failure notifications fire only on the final
      // attempt — otherwise every retry spams alarms.
      const isLastAttempt =
        (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
      if (isLastAttempt) {
        try {
          exec.aiAnalysis = await this.aiService.analyzeFailure(
            task,
            exec.logs,
          );
        } catch (aiErr: unknown) {
          const aiErrMsg =
            aiErr instanceof Error ? aiErr.message : String(aiErr);
          this.logger.warn(
            `AI analysis failed for task ${task.id}: ${aiErrMsg}`,
          );
        }
      }
      this.logger.error(`Task ${task.id} failed: ${errMsg}`);
      if (isLastAttempt) {
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
      }
      // Q1: rethrow so BullMQ retries apply — except dispatch timeouts: the
      // executor may still be running the task, so a retry would dispatch the
      // same executionId to a second executor (double dispatch).
      if (exec.failureReason === ExecutionFailureReason.TIMEOUT) {
        throw new UnrecoverableError(errMsg);
      }
      // RETRY-01: honor `task.retryableErrors` — when the user configured a
      // non-empty allow-list, only failures whose message (primary) or
      // classified reason (secondary) match one of the entries are retried;
      // anything else is converted to UnrecoverableError so BullMQ stops
      // burning the full attempt budget on an error the user explicitly chose
      // not to retry. null/undefined/[] keeps the legacy retry-everything
      // behavior (backward compatible).
      const retryableErrors = Array.isArray(task.retryableErrors)
        ? task.retryableErrors.filter(
            (p) => typeof p === "string" && p.trim() !== "",
          )
        : [];
      if (retryableErrors.length > 0) {
        const haystack = `${exec.errorMessage ?? ""}\n${exec.failureReason ?? ""}`.toLowerCase();
        const matched = retryableErrors.some((p) =>
          haystack.includes(p.trim().toLowerCase()),
        );
        if (!matched) {
          throw new UnrecoverableError(
            `${errMsg} (failure not in retryableErrors allow-list)`,
          );
        }
      }
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

      // P0: persist only worker-owned fields via a conditional update — a
      // concurrent callback or kill may have already written a terminal
      // state, which the worker must never overwrite. Built once so the
      // repair path below reuses the exact same guarded patch (REPAIR-01).
      const ownedPatch: Partial<TaskExecution> = {
        status: exec.status,
        ...(exec.executorAddress !== undefined
          ? { executorAddress: exec.executorAddress }
          : {}),
        ...(exec.result !== undefined ? { result: exec.result } : {}),
        ...(exec.logs !== undefined ? { logs: exec.logs } : {}),
        ...(exec.errorMessage !== undefined
          ? { errorMessage: exec.errorMessage }
          : {}),
        ...(exec.failureReason !== undefined
          ? { failureReason: exec.failureReason }
          : {}),
        ...(exec.aiAnalysis !== undefined ? { aiAnalysis: exec.aiAnalysis } : {}),
        ...(exec.endTime ? { endTime: exec.endTime } : {}),
        ...(exec.duration !== undefined ? { duration: exec.duration } : {}),
      };

      try {
        await queryRunner.manager
          .createQueryBuilder()
          .update(TaskExecution)
          .set(ownedPatch)
          .where("id = :id", { id: exec.id })
          .andWhere("status IN (:...writable)", {
            writable: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING],
          })
          .execute();
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
            // REPAIR-01: use the same conditional UPDATE as the primary write
            // instead of findOne→check→save — the check/save pair had a TOCTOU
            // window (a callback could flip the row to a terminal state between
            // them) and save() ran through @VersionColumn optimistic locking,
            // which threw an exception and got swallowed when it lost that
            // race. The `status IN (pending, running)` guard plus an affected
            // check makes the repair atomic and can never clobber a terminal
            // state written concurrently.
            const repaired = await repairRunner.manager
              .createQueryBuilder()
              .update(TaskExecution)
              .set(ownedPatch)
              .where("id = :id", { id: exec.id })
              .andWhere("status IN (:...writable)", {
                writable: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING],
              })
              .execute();
            if (repaired.affected) {
              this.logger.log(
                `Repaired execution ${exec.id} state after transaction failure`,
              );
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

      // R4-P0: dependency fan-out moved to TaskService.handleCallback — the
      // worker's in-memory exec.status is only ever RUNNING/FAILED/TIMEOUT
      // here (SUCCESS is written exclusively by the callback's conditional
      // UPDATE), so the former `exec.status === SUCCESS` trigger in this
      // finally block was dead code and dependency chains never fired.
    }
  }
}
