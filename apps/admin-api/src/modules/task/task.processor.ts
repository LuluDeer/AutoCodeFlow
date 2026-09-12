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
// ARCH-30: AI 分析直调迁出——processor 经 AiAnalysisService 调用（封装
// 重试 + autoflow_ai_analysis_total 指标 + fail-open 降级），不再直连 AiService。
import { AiAnalysisService } from "../ai/ai-analysis.service";
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
    // 跨 task↔executor 模块环的 provider 注入：模块级 forwardRef 配套。
    @Inject(forwardRef(() => ExecutorService))
    private executorService: ExecutorService,
    private aiAnalysisService: AiAnalysisService,
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

    // BUG-21：派发阶段失败的终态事件（最后一次尝试时装配，落库成功后发布）。
    let pendingTerminalEvent: { errorMessage?: string; logs?: string } | null =
      null;
    // 本次尝试是否真的把终态写进了库（affected>0）——事件只对应真实持久化的
    // 终态；被别的写入者抢先终态化时由赢家负责发布。
    let terminalPersisted = false;

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
        // ARCH-30: AiAnalysisService never throws (fail-open preserved) —
        // it retries once internally, records autoflow_ai_analysis_total,
        // and returns "" on exhaustion instead of raising.
        exec.aiAnalysis = await this.aiAnalysisService.analyzeFailure(
          task,
          exec.logs,
        );
      }
      this.logger.error(`Task ${task.id} failed: ${errMsg}`);
      if (isLastAttempt) {
        // BUG-21（nginx SSE 真机验证暴露）：这里原先**直调**通知，既不发布
        // 领域事件也不复用 ARCH-21 的统一订阅者——于是「派发阶段失败」
        // （执行器离线/无匹配执行器/派发超时，executor 根本没接单）的终态
        // 对 Dashboard 终态流与 FEAT-07 出站 webhook 完全不可见。
        // 现改为：最后尝试的**终态落库成功后**发布 execution.failed 事件，
        // 通知由 notification 模块的 ExecutionEventsListener 统一发出（含
        // NOTIFICATION_FAILED 审计兜底），单一语义出口。
        pendingTerminalEvent = { errorMessage: errMsg, logs: errStack };
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
        const haystack =
          `${exec.errorMessage ?? ""}\n${exec.failureReason ?? ""}`.toLowerCase();
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
        ...(exec.aiAnalysis !== undefined
          ? { aiAnalysis: exec.aiAnalysis }
          : {}),
        ...(exec.endTime ? { endTime: exec.endTime } : {}),
        ...(exec.duration !== undefined ? { duration: exec.duration } : {}),
      };

      try {
        const persisted = await queryRunner.manager
          .createQueryBuilder()
          .update(TaskExecution)
          .set(ownedPatch)
          .where("id = :id", { id: exec.id })
          .andWhere("status IN (:...writable)", {
            writable: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING],
          })
          .execute();
        if (persisted.affected) terminalPersisted = true;
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
              terminalPersisted = true;
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

      // BUG-21: 派发失败的最后一次尝试 → 终态**落库成功之后**发布领域事件
      // （Dashboard 终态流 / 出站 webhook / 通知订阅者三方一致可见）。
      // 落库失败（事务回滚且修复也没成功）时不发——事件必须对应真实持久化
      // 的终态，否则消费者会读到不存在的失败。
      if (pendingTerminalEvent && terminalPersisted) {
        // 事件是旁路：任何意外都不得改变主链结果（尤其不能在 finally 里
        // 抛出而掩盖原始的派发失败异常）。
        try {
          this.taskService.publishTerminalEventForDispatch(
            exec,
            pendingTerminalEvent,
          );
        } catch (emitErr: unknown) {
          this.logger.warn(
            `Failed to publish dispatch-failure event for execution ${exec.id}: ${
              emitErr instanceof Error ? emitErr.message : String(emitErr)
            }`,
          );
        }
      }
    }
  }
}
