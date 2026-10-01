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
// A1: 开放态/终态常量的单一事实源（此前本文件抄了三份字面量）。
import {
  isTerminalStatus,
  OPEN_EXECUTION_STATUSES,
  transitionOneToTerminal,
} from "./execution-terminal";
import { ExecutionLogLine } from "./entities/execution-log-line.entity";
import { Task } from "./entities/task.entity";
import { ExecutorService } from "../executor/executor.service";
// ARCH-30: AI 分析直调迁出——processor 经 AiAnalysisService 调用（封装
// 重试 + autoflow_ai_analysis_total 指标 + fail-open 降级），不再直连 AiService。
import { AiAnalysisService } from "../ai/ai-analysis.service";
// R-20（DEEP_REVIEW 0ef3bbe）: NotificationService / AuditService 注入已移除——
// BUG-21 把直调迁出到 notification 模块 ExecutionEventsListener 后，本类对二者
// 的引用归零（grep notificationService\. / auditService\. 0 命中），属死依赖与
// 遗留模块耦合。终态事件改由 taskService.publishTerminalEventForDispatch 经
// 事件总线统一发布。
import { TaskService, INTERPRETER_UNAVAILABLE_PATTERN } from "./task.service";
// MUTEX-01：互斥阻塞错误前缀（dispatch 抛出，processor 分类链最前面识别）。
import { MUTEX_WAIT_TOKEN } from "./execution-mutex";
// FEAT-22 方案 A v1：strict 部署约束的排队 token——与 MUTEX_WAIT_TOKEN 同位
// 识别（见下方 catch 内注释），置 WAITING 不烧重试预算。
import { DEPLOYMENT_WAIT_TOKEN } from "./execution-deployment-wait";

/**
 * MUTEX-01 P3：「无可用/在线执行器」消息族（executor.service dispatch /
 * dispatchBroadcast 空候选集的既有文案）。`No available executor ...` 在
 * 下方分类链落 EXECUTOR_OFFLINE，但 `No online executors ...` 落 UNKNOWN
 * ——互斥回队判定必须两族都收，否则整机队下线时被唤醒的 WAITING 执行仍会
 * 烧重试预算（分类链本身的归因不在本修复范围）。
 */
const NO_EXECUTOR_AVAILABLE_RE = /no (available|online) executor/i;

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
    private configService: ConfigService,
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
      // A1: 走统一终态门（execution 仍在 PENDING，未 claim）
      await transitionOneToTerminal(this.execRepo, {
        id: exec.id,
        patch: {
          status: ExecutionStatus.FAILED,
          errorMessage: `Task ${exec.taskId} not found`,
          failureReason: ExecutionFailureReason.UNKNOWN,
          endTime: new Date(),
          duration: 0,
        },
        from: [ExecutionStatus.PENDING],
      });
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
    // MUTEX-01: WAITING is claimable — the 15s wake sweep (scheduler) flips a
    // mutex-queued execution back to PENDING and re-enqueues it; between the
    // flip and the job run the row is PENDING, but a wake job that raced a
    // concurrent wake (sweep runs on one leader only) or a manual re-trigger
    // path must still be able to claim a row that stayed WAITING. Waiting time
    // does not poison startTime: the claim re-writes it on every claim.
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
        claimable: [
          ExecutionStatus.PENDING,
          ExecutionStatus.FAILED,
          ExecutionStatus.WAITING,
        ],
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
      // E-P2-R5: executorAddress 不再在此处单独 update（不在事务内，与终态写
      // 之间存在 TOCTOU/非原子窗口）。它并入 finally 的 ownedPatch（下方已有
      // `exec.executorAddress !== undefined` 条件判断），与状态/结果同事务落库。
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
      // MUTEX-01：互斥阻塞 —— 必须排在分类链**最前面**（与 interpreter token
      // 同款先例：`[mutex_wait]` 前缀识别先于正则链，否则会被
      // `/executor.*(offline|unavailable)/` 之类规则误吞）。
      //
      // 语义：所有候选设备的同组占用已满 → 执行进入显式排队态 WAITING，当前
      // job **正常结束**（提前 return，不 rethrow）——① worker 槽位立即释放，
      // 不让排队执行占着 5 路并发；② 不烧 BullMQ 重试预算（attempts 一次都没
      // 消耗，唤醒后全新 job 带完整预算）；③ 失败分类/日志/AI 分析/终态事件/
      // 通知全链路都不触发（这不是失败，是调度等待）。唤醒由 scheduler 的
      // 15s leader cron 把 WAITING 条件翻回 PENDING 并重新入队。
      //
      // finally 仍会执行：WAITING 非终态，走 ownedPatch 的条件 UPDATE（open 态
      // 门，RUNNING→WAITING 命中）落库，pendingTerminalEvent 恒为 null。
      if (errMsg.startsWith(MUTEX_WAIT_TOKEN)) {
        exec.status = ExecutionStatus.WAITING;
        exec.failureReason = null;
        exec.errorMessage = errMsg.slice(MUTEX_WAIT_TOKEN.length);
        this.logger.log(
          `Execution ${executionId} queued (mutex wait): task "${task.name}" waiting for a free slot in its mutex group`,
        );
        return;
      }
      // FEAT-22 方案 A v1：strict 部署约束排队——与互斥 token 完全同策、同位
      // （必须在正则分类链之前，否则「部署约束设备离线」的文案会被
      // EXECUTOR_OFFLINE 规则误吞成可重试失败，烧光预算后落 FAILED）。语义：
      // 任务关联应用的部署设备集合当前全部不可派发（离线/满载/被过滤），
      // strict 承诺「不换机」→ 显式排队态 WAITING，等 scheduler 既有 10s
      // WAITING sweep 唤醒重派（对全部 WAITING 无条件重试，天然覆盖本路径）。
      // 逃逸出口见 execution-deployment-wait.ts 头注（删部署行 / 切回 prefer）。
      if (errMsg.startsWith(DEPLOYMENT_WAIT_TOKEN)) {
        exec.status = ExecutionStatus.WAITING;
        exec.failureReason = null;
        exec.errorMessage = errMsg.slice(DEPLOYMENT_WAIT_TOKEN.length);
        this.logger.log(
          `Execution ${executionId} queued (deployment constraint wait): task "${task.name}" waiting for a deployable device in its app's deployment set`,
        );
        return;
      }
      exec.errorMessage = errMsg;
      const failureText = `${errMsg}\n${errStack}`;
      // python_task_multiversion（WS2 · CONTRACT §2.5 / D14）：解释器不可获取
      // 必须排在分类链**最前面**（与 task.service.ts 的 inferFailureReason 第一条
      // 规则同源、同一份 INTERPRETER_UNAVAILABLE_PATTERN，F-01 消除两处漂移）。
      //
      // 为什么必须先于下方 EXECUTOR_OFFLINE 规则：failInterpreterUnavailable
      // （executor.service.ts）抛出的消息以 `[interpreter_unavailable]` token 开头，
      // 而堆栈含 `ExecutorService.failInterpreterUnavailable`——`/executor.*
      // (offline|unavailable)/i` 会从 `ExecutorService...Unavailable` 命中并把本类
      // 失败误判成 EXECUTOR_OFFLINE，后果是：① D14 明确 interpreter_unavailable
      // 不进默认重试集，误判后却触发重试（解释器不会凭空出现，白白烧重试预算）；
      // ② failureReason 记成 executor_offline，误导运维排查方向（以为是执行器
      // 离线，实际是解释器缺失）。同时必须先于 timeout 规则：解释器下载失败
      // 的真实文案天然含 "timeout"（`interpreter download timeout ...`），
      // 先跑 timeout 规则会吞成 TIMEOUT（处置方向完全不同）。
      exec.failureReason = INTERPRETER_UNAVAILABLE_PATTERN.test(
        failureText.toLowerCase(),
      )
        ? ExecutionFailureReason.INTERPRETER_UNAVAILABLE
        : // P0-4（UX-AUDIT-2026-09-21）：应用已被删除 → 必须排在 PACKAGE_FETCH
          // 规则**之前**。此前该错误落 UNKNOWN（消息是 `Cannot resolve
          // packageUrl ... application <uuid> not found`，不含 package fetch/
          // download package 等关键词），用户看到「未知原因，去翻执行日志」——
          // 而原因是 100% 已知且可行动的（引用了一个已被删除的应用）。
          /cannot resolve packageurl|application\s+\S+\s+not found/i.test(
              failureText,
            )
          ? ExecutionFailureReason.APPLICATION_MISSING
          : /timeout|timed out|etimedout|execution timed/i.test(failureText)
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
      // MUTEX-01 P3：互斥排队的执行在 dispatch 因「无可用/离线执行器」失败时，
      // 与组满（MutexWaitError）路径同策——不进 BullMQ 失败重试链，回到
      // WAITING 由唤醒 sweep 每 10s 重试。理由：这类失败是"现在派不出去"
      // 而非"必然失败"，执行器恢复/组容量释放后同一执行就能派出去；走重试
      // 链会烧光预算后落 failed，把一个可自愈的排队问题误判成死（审计确认：
      // 组满路径正确回 WAITING，离线路径却进重试链，两者语义不一致）。
      // 判定 = failureReason 落 EXECUTOR_OFFLINE，或消息命中无执行器文案族
      // （后者在分类链落 UNKNOWN，见 NO_EXECUTOR_AVAILABLE_RE 注释）。
      // timeout / interpreter_unavailable / 应用缺失等分类在此**之前**已定，
      // 不受影响（dispatch 超时仍走 UnrecoverableError 防二次派发）。
      // 防无限循环：每次回队都有本日志；唤醒 sweep 每轮日志 woken/跳过数。
      if (
        exec.mutexGroupId &&
        (exec.failureReason === ExecutionFailureReason.EXECUTOR_OFFLINE ||
          NO_EXECUTOR_AVAILABLE_RE.test(errMsg))
      ) {
        exec.status = ExecutionStatus.WAITING;
        exec.failureReason = null;
        exec.errorMessage = errMsg;
        this.logger.log(
          `Execution ${executionId} queued (no executor available): task "${task.name}" dispatch failed without an online executor — back to WAITING for the mutex wake sweep`,
        );
        return;
      }
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
      // python_task_multiversion（WS2 · CONTRACT §2.5 / D14）：interpreter_unavailable
      // 与 TIMEOUT 同为**不可重试**——解释器缓存缺失是环境/声明问题（处置：预填
      // 缓存卷、修镜像、改声明版本或等执行器补装），重试只会再次派发再次失败，
      // 白白烧掉 maxRetry 预算。与上方分类链修复（F-01）配套：此前误判成
      // EXECUTOR_OFFLINE 会漏过本门禁走进默认重试一切路径。
      if (
        exec.failureReason === ExecutionFailureReason.INTERPRETER_UNAVAILABLE
      ) {
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
      // P0-4（UX-AUDIT-2026-09-21）：**必然失败**的分类不得烧重试预算。
      //
      // `retryableErrors` 留空 = 全部可重试（向后兼容的宽松默认），于是
      // `application_missing`（任务引用的应用已被删除）会每次调度都把整个重试
      // 预算烧在一个**结构上不可能成功**的派发上——应用不会自己回来，重试只是
      // 把必然失败重复 N 次并延后暴露。这与既有 interpreter_unavailable 的处置
      // 同策（环境/配置类失败，重试无益），但那条靠"不在可选列表里"实现，而这里
      // 默认集是"全量"，故必须显式排除。
      //
      // 注意**只排除**这一类：`never_dispatched`（队列超时/执行器未取件）刻意
      // 保留重试——执行器可能恰好恢复，重试有真实价值（其 runbook 也如此建议）。
      const inherentNonRetryable: readonly ExecutionFailureReason[] = [
        ExecutionFailureReason.APPLICATION_MISSING,
      ];
      if (
        inherentNonRetryable.includes(
          exec.failureReason as ExecutionFailureReason,
        )
      ) {
        throw new UnrecoverableError(
          `${errMsg} (failure is structurally unrecoverable — retrying cannot succeed)`,
        );
      }
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
      if (isTerminalStatus(exec.status)) {
        exec.endTime = new Date();
        // ERR-02: null guard to prevent NaN when startTime is not set
        exec.duration = exec.startTime
          ? exec.endTime.getTime() - exec.startTime.getTime()
          : 0;
      }

      // BUG-02: Use transaction to ensure atomic state update
      // This prevents inconsistent state if database save fails
      const queryRunner = this.dataSource.createQueryRunner();
      // R-13（DEEP_REVIEW 0ef3bbe）: connect/startTransaction 此前在 try 之外。
      // 失败时 ① queryRunner 从不 release → 连接泄漏；② 在 finally 内抛出的新
      // 异常会替换（覆盖）触发本 finally 的原始 dispatch 错误，丢失上下文。现将
      // 连接/开事务包入 try：失败即 best-effort 释放连接并记日志，不再向外抛新
      // 异常——保留原始错误（与既有 ERR-01「原始错误不被掩盖」契约一致）。
      let txReady = false;
      try {
        await queryRunner.connect();
        await queryRunner.startTransaction();
        txReady = true;
      } catch (setupErr) {
        this.logger.error(
          `R-13: failed to connect/start transaction for execution ${exec.id}; connection released`,
          setupErr,
        );
        await queryRunner.release().catch(() => undefined);
      }

      if (txReady) {
        // P0: persist only worker-owned fields via a conditional update — a
        // concurrent callback or kill may have already written a terminal
        // state, which the worker must never overwrite. Built once so the
        // repair path below reuses the exact same guarded patch (REPAIR-01).
        const ownedPatch: Partial<TaskExecution> = {
          status: exec.status,
          ...(exec.executorAddress !== undefined
            ? { executorAddress: exec.executorAddress }
            : {}),
          // FEAT-22 配套观测：dispatch 阶段解析的应用包/版本留痕（仅 zip 渠道
          // 会赋值；未赋值 = 字段 undefined = 不进 patch，存量列保持 NULL）。
          ...(exec.resolvedPackageUrl !== undefined
            ? { resolvedPackageUrl: exec.resolvedPackageUrl }
            : {}),
          ...(exec.resolvedPackageVersion !== undefined
            ? { resolvedPackageVersion: exec.resolvedPackageVersion }
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
          // A1: 终态写走统一入口（RETURNING + 兜底归一化）；非终态（RUNNING
          // 持久化）保持原有条件 UPDATE——transitionOneToTerminal 要求终态 status。
          let writeAffected = 0;
          if (isTerminalStatus(exec.status)) {
            const result = await transitionOneToTerminal(queryRunner.manager, {
              id: exec.id,
              patch: { ...ownedPatch, status: exec.status },
            });
            writeAffected = result.affected;
          } else {
            const persisted = await queryRunner.manager
              .createQueryBuilder()
              .update(TaskExecution)
              .set(ownedPatch)
              .where("id = :id", { id: exec.id })
              .andWhere("status IN (:...writable)", {
                writable: [...OPEN_EXECUTION_STATUSES],
              })
              .execute();
            writeAffected = persisted.affected ?? 0;
          }
          if (writeAffected) terminalPersisted = true;
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
            // R-13: 与主 runner 同型——connect/startTransaction 包入 try，失败即释放
            // 连接（否则泄漏），再抛给外层 repairAttemptErr 兜底。
            let repairReady = false;
            try {
              await repairRunner.connect();
              await repairRunner.startTransaction();
              repairReady = true;
            } catch (setupErr) {
              await repairRunner.release().catch(() => undefined);
              throw setupErr;
            }

            if (repairReady)
              try {
                // REPAIR-01: use the same conditional UPDATE as the primary write
                // instead of findOne→check→save — the check/save pair had a TOCTOU
                // window (a callback could flip the row to a terminal state between
                // them) and save() ran through @VersionColumn optimistic locking,
                // which threw an exception and got swallowed when it lost that
                // race. The `status IN (pending, running)` guard plus an affected
                // check makes the repair atomic and can never clobber a terminal
                // state written concurrently.
                // A1: 终态写走统一入口；非终态保持原有条件 UPDATE。
                let repairAffected = 0;
                if (isTerminalStatus(exec.status)) {
                  const result = await transitionOneToTerminal(
                    repairRunner.manager,
                    {
                      id: exec.id,
                      patch: { ...ownedPatch, status: exec.status },
                    },
                  );
                  repairAffected = result.affected;
                } else {
                  const repaired = await repairRunner.manager
                    .createQueryBuilder()
                    .update(TaskExecution)
                    .set(ownedPatch)
                    .where("id = :id", { id: exec.id })
                    .andWhere("status IN (:...writable)", {
                      writable: [...OPEN_EXECUTION_STATUSES],
                    })
                    .execute();
                  repairAffected = repaired.affected ?? 0;
                }
                if (repairAffected) {
                  terminalPersisted = true;
                  // E-P2-R2: 事务失败后的修复成功属异常路径，用 warn 突出（原 log
                  // 在常规日志级别下不显眼，运维会错过「主写失败已自愈」信号）。
                  this.logger.warn(
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
      } // end if (txReady) — R-13: connect/startTransaction 失败时跳过持久化

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
        // FIX-4.2: 派发失败终态已落库 → 唤醒 webhook wait 等待方（best-effort，
        // 与事件发布同属落库后的旁路副作用；轮询兜底仍在）。
        try {
          this.taskService.publishExecutionWake(exec.id);
        } catch {
          /* publishExecutionWake 内部已吞异常，此处再兜一道 */
        }
      }
    }
  }
}
