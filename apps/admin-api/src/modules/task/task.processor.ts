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
import { Task, TaskStatus } from "./entities/task.entity";
import { ExecutorService } from "../executor/executor.service";
// 技术债 A 组（2026-10-01）·按原版本重放：钉定快照 → 派发体覆盖（纯函数，
// 与派发体白名单同一文件保证不漂移；纯 util import 不引入模块环）。
import { applyPinnedVersionSnapshot } from "../executor/dispatch-task-payload.util";
// ARCH-30: AI 分析直调迁出——processor 经 AiAnalysisService 调用（封装
// 重试 + autoflow_ai_analysis_total 指标 + fail-open 降级），不再直连 AiService。
import { AiAnalysisService } from "../ai/ai-analysis.service";
// R-20（DEEP_REVIEW 0ef3bbe）: NotificationService / AuditService 注入已移除——
// BUG-21 把直调迁出到 notification 模块 ExecutionEventsListener 后，本类对二者
// 的引用归零（grep notificationService\. / auditService\. 0 命中），属死依赖与
// 遗留模块耦合。终态事件改由 taskService.publishTerminalEventForDispatch 经
// 事件总线统一发布。
import {
  TaskService,
  INTERPRETER_UNAVAILABLE_PATTERN,
  EXECUTOR_OFFLINE_PATTERN,
} from "./task.service";
// LANG-ERR-01：用户可见失败抛稳定码 + 参数（文案由前端按用户语言翻译）。
import { AppError } from "../../common/errors/app-error";
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

/**
 * EXP-01 / S4-C3：`sandbox_unavailable` 的派发路径判据——与两侧执行器的沙箱
 * 分类器（node `prepareFailureReason`、python `_refine_failure_reason`）同源，
 * 英中并列（存量未升级执行器发英文、中文化后的文案发中文，两侧独立发版，
 * 滚动升级必然新旧并存，与 LANG-ZH-01 的口径一致）。
 *
 * 主路径其实不靠本规则：执行器在**执行期** fail-closed 时，经回调结构化上报
 * `failureReason=sandbox_unavailable`，回调路径直接采信 `cb.failureReason`
 * （见 task.service 的回调终态写入）。本规则服务的是**派发失败路径**——旧执行器
 * 的 prepare 失败曾以同步 HTTP 错误反馈（node execute.ts 自述「原实现经 HTTP 500
 * 反馈，现已 accepted」），以及被包装过的异常文案。没有这条，`bwrap` /
 * `TASK_SANDBOX` 文案会落到 UNKNOWN，而 UNKNOWN 在默认口径下**可重试**，于是
 * 下方那条「环境类失败不烧重试预算」的门禁永远不会触发。
 *
 * 位置：紧接 TIMEOUT 之后、EXECUTOR_OFFLINE 之前。理由与上方 INTERPRETER 规则
 * 同类——沙箱失败文案常带 `unavailable`，而调用栈里又带 `ExecutorService...`，
 * 会被 `/executor.*(offline|unavailable)/` 先命中并误判成「执行器离线」（可重试、
 * 且把排障方向带向执行器连通性，而真实处置是装 bwrap / 放开 user ns / 取消
 * TASK_SANDBOX）。放在 TIMEOUT 之后是刻意的保守：既有 TIMEOUT 文案的分类桶
 * 零变化（TIMEOUT 本就走不可重试门禁，改判只会让归因漂移）。
 *
 * 判据为什么**不写成 `/sandbox/i` 或 `\bsandbox\b`**（主会话复核收紧，2026-10-31）：
 * 本规则的输入是 `failureText = errMsg + "\n" + errStack`，而 `\bsandbox\b` 会命中
 * **栈里的模块路径**（`.../sandbox.ts:12` 这类，`.` 是词边界）。一次瞬时的派发失败
 * 若恰好从名字带 sandbox 的模块抛出，就会被判成「环境类不可重试」——方向上是
 * 把**可恢复**的失败拒掉，比漏判更贵（静默少一次重试 = 静默少一次成功）。
 * 故只认能指认「任务沙箱这一件事」的令牌：结构化 token、环境变量名、
 * 英文整词短语、二进制名、中文词。**若将来新增沙箱类文案，先确认它带这些令牌**。
 */
const SANDBOX_UNAVAILABLE_PATTERN =
  /sandbox_unavailable|task_sandbox|task sandbox|sandbox (?:is )?(?:unavailable|not available|disabled|missing)|bwrap|沙箱/i;

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

  /**
   * G3（迁移 1790000000092）：从 claim 的 `RETURNING` 结果里读回**本次**自增后的
   * `attemptSeq`。
   *
   * 为什么可能读不到：`UPDATE ... RETURNING` 在 TypeORM 里落在 `result.raw`，PG
   * 回的是行数组，但**部分驱动不返回行**（task.service 的终态写为此有专门的
   * 「驱动未返回行」兜底注释），单测替身也常只回 `{affected}`。此时**紧随一次
   * SELECT** 取当前值——即任务说明里点明的「RETURNING 或紧随一次 SELECT」。
   *
   * 仍读不到（列不存在 / 替身未建模该列）返回 `null` 而不是 0：0 是**第一回合**
   * 的合法取值，编造 0 会把「不知道」伪装成一个确定事实。
   */
  private async readClaimedAttemptSeq(
    executionId: string,
    raw: unknown,
  ): Promise<number | null> {
    const asInt = (v: unknown): number | null => {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      return typeof n === "number" && Number.isInteger(n) ? n : null;
    };

    const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const n = asInt((item as Record<string, unknown>).attemptSeq);
      if (n !== null) return n;
    }

    try {
      const fresh = await this.execRepo.findOne({
        where: { id: executionId },
        // TypeORM 1.x 已移除 FindOptionsSelect 的字符串数组形态（见
        // execution-list-projection.ts 同款注记），find 选项统一走对象形态。
        select: { attemptSeq: true },
      });
      return asInt(fresh?.attemptSeq);
    } catch {
      // 读回是**旁路**：拿不到世代不影响派发主链（与既有 executorAddress
      // 落库窗口同姿态——诊断信息缺失，不阻断执行）。
      return null;
    }
  }

  // LOG-01: structured log-line persistence now lives in TaskService
  // (storeLogLines / backfillFullLogsFromExecutor), invoked from
  // handleCallback so it runs for every completed execution.

  async process(job: Job<{ executionId: string }>) {
    return this.handle(job);
  }

  async handle(job: Job<{ executionId: string; pinnedVersionId?: string }>) {
    const { executionId, pinnedVersionId } = job.data;
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
    // B-11（调度域审计）：非 ACTIVE（PAUSED/软删）任务的未派发排队执行
    // （PENDING/WAITING）不 claim——PAUSED 任务的在途排队不再被唤醒派发
    // （与 scheduler 唤醒 sweep 的 ACTIVE 闸同源，双保险）：
    // - WAITING 行保持原状，resume 落 ACTIVE 后由唤醒 sweep 正常唤醒；
    // - PENDING 行不被静默派发，由 stale PENDING sweep（never_dispatched）
    //   兜底收敛，避免「暂停了任务、排队执行仍开跑」。
    // FAILED 行刻意不受此门约束：BullMQ 重试与恢复重试（executor-restart /
    // stale sweep / kill_retry）消费的是已发生失败的执行，不属于「新触发」，
    // 任务暂停不应吞掉重试预算（重试照常派发）。
    // 竞态注记：task 状态读自 claim 前快照，与 claim 之间存在 TOCTOU——
    // 与唤醒 sweep 的闸门一致按「尽力拦截」处理，不为此加锁。
    if (
      task.status !== TaskStatus.ACTIVE &&
      (exec.status === ExecutionStatus.PENDING ||
        exec.status === ExecutionStatus.WAITING)
    ) {
      this.logger.warn(
        `Execution ${executionId} of task ${task.id} (status=${task.status}) is queued but the task is not ACTIVE — skipping dispatch (B-11)`,
      );
      return;
    }
    const claimed = await this.execRepo
      .createQueryBuilder()
      .update(TaskExecution)
      .set({
        status: ExecutionStatus.RUNNING,
        startTime,
        // G3（迁移 1790000000092）：**尝试世代**在 DB 侧自增。
        //
        // 为什么是函数式赋值（`SET "attemptSeq" = "attemptSeq" + 1`）而不是
        // 「先读出来 +1 再写回」：并发两个 worker 同时 claim 同一行时，读改写
        // 会双双读到 0、双双写 1（「两回合」被压成同一世代，世代维度当场失效）；
        // DB 侧自增让**命中者恰好自增一次**，而「只有一个命中」由下面那条
        // `status IN (:...claimable)` 谓词保证（RUNNING 不可 claim，
        // 见上方 CONSISTENCY-01 注释）——谓词与自增在同一条 UPDATE 里求值，
        // 不依赖任何进程内状态，多副本下也成立。
        attemptSeq: () => '"attemptSeq" + 1',
      })
      .where("id = :id", { id: executionId })
      .andWhere("status IN (:...claimable)", {
        claimable: [
          ExecutionStatus.PENDING,
          ExecutionStatus.FAILED,
          ExecutionStatus.WAITING,
        ],
      })
      // RETURNING 取回**本次**的世代（自增后的值）。取回而不是「读到值 +1」：
      // 后者在并发 claim 下会算出别人的世代。
      .returning(["attemptSeq"])
      .execute();
    if (!claimed.affected) {
      this.logger.warn(
        `Execution ${executionId} reached a terminal state before dispatch, skipping`,
      );
      return;
    }
    exec.status = ExecutionStatus.RUNNING;
    exec.startTime = startTime;
    // G3：本次 claim 的尝试世代。消费面（当前）＝结构化日志 + 内存视图；
    // 「随派发下传 / 回调回传」需要执行器协议承载，不在本批足迹内（见
    // execution-terminal.ts 的 expectedAttemptSeq 注释）。
    const claimedAttemptSeq = await this.readClaimedAttemptSeq(
      executionId,
      claimed.raw,
    );
    if (claimedAttemptSeq !== null) exec.attemptSeq = claimedAttemptSeq;
    this.logger.debug(
      `Execution ${executionId} claimed as attempt #${
        claimedAttemptSeq ?? "?"
      } (task "${task.name}")`,
    );
    // G3 补口（遗留②）：**派发失败路径**的终态写也要带本次 claim 的世代。
    //
    // 这里终结的是「我自己刚 claim 的**这一回合**」：dispatch 抛错（执行器离线 /
    // 无匹配执行器 / 派发超时 / 钉定版本行被删……）后，本 worker 在 finally 里把
    // 行写成 FAILED / TIMEOUT。而从 claim 到这次终态写之间隔着多次 await（dispatch
    // 的 HTTP 往返、最后一次尝试时 AI 分析的 LLM 往返，可达秒级），期间该行完全
    // 可能被**重新 claim**（FAILED 可 claim——BullMQ 重试与唤醒 sweep 都会重新入队，
    // 见上方 claim 注释）。旧 worker 的这次写入若只带状态门，会照常命中（status
    // 仍是 running）并把**新回合**的行提前写成失败：新一代执行被上一代的派发失败
    // 连坐，且随后的新回合回调会因行已终态而全部落空。带上世代后，这条写在 DB
    // 侧与状态门**同一条 UPDATE** 里原子求值，旧世代必然不命中，收尾权归新回合。
    //
    // 值取自本次 claim（`readClaimedAttemptSeq` 的返回值），读不到时传 undefined
    // ——**不编 0、也不传 null**：
    //   · 编 0 是把「不知道」伪装成「第一回合」。claim 已经在库里把世代自增过了
    //     （第一次 claim 后是 1），谓词 `"attemptSeq" = 0` 恒不命中 ⇒ 终态写被
    //     永久静默丢弃，连带着派发失败事件、wake 唤醒都不再发布——比不加谓词糟得多。
    //   · 传 null 同样不行：`transitionToTerminal` 只对 `undefined` 跳过谓词，
    //     null 会拼出 `"attemptSeq" = :expectedAttemptSeq` 而参数为 null，同样恒不命中。
    //   · undefined ⇒ 谓词整段不拼 ⇒ whereSql/params 与引入前逐字节一致（本项的
    //     既有纪律：不传即等价），读不到世代的驱动/存量路径行为零变化。
    const expectedAttemptSeq = claimedAttemptSeq ?? undefined;

    // BUG-21：派发阶段失败的终态事件（最后一次尝试时装配，落库成功后发布）。
    let pendingTerminalEvent: { errorMessage?: string; logs?: string } | null =
      null;
    // 本次尝试是否真的把终态写进了库（affected>0）——事件只对应真实持久化的
    // 终态；被别的写入者抢先终态化时由赢家负责发布。
    let terminalPersisted = false;

    try {
      // 技术债 A 组（2026-10-01）·按原版本重放：job 数据带 pinnedVersionId
      // （trigger 钉定重放写入；BullMQ 重试复用同一 job 数据，故跨重试不丢）。
      // 仅覆盖**派发载荷**的执行相关字段（见 applyPinnedVersionSnapshot）——
      // 调度面（互斥/部署约束/executeMode/params/secrets）仍跟随任务当前配置，
      // 库内任务行零写入。版本行不可删除（VER-DIFF-02 已移除删除面），此处
      // 取不到属异常态（人工删行/down 迁移）：**fail-closed**——宁可执行
      // 失败，也不静默改跑当前配置（那正是本功能要防的「以为重跑的是原版
      // 代码」误判）。放在 claim 之后：抛出走下方既有派发失败链（终态 FAILED
      // + 分类 + 事件），不留悬挂 PENDING 行。
      let dispatchTask: Task = task;
      if (pinnedVersionId) {
        const pinned = await this.taskService
          .getVersion(task.id, pinnedVersionId)
          .catch(() => null);
        if (!pinned) {
          // LANG-ERR-01：抛稳定码而非写死文案。注意下方 catch 的失败分类链读的是
          // `err.message`（渲染后的 zh 兜底），本码的 zh 不含任何分类关键词
          // （timeout / 执行器离线 / 依赖拉取 / 脚本错误），故仍落 UNKNOWN——
          // 与迁移前的英文原文案分类结果一致（已由 processor 分类用例覆盖）。
          throw new AppError("TASK_PINNED_VERSION_GONE", {
            versionId: pinnedVersionId,
            taskId: task.id,
          });
        }
        dispatchTask = applyPinnedVersionSnapshot(
          task,
          pinned.snapshot as Record<string, unknown>,
        );
      }
      // Broadcast mode: dispatch to all online executors
      // Single mode: dispatch to the executor with lowest load
      const isBroadcast = task.executeMode === "broadcast";
      const rawResult = isBroadcast
        ? await this.executorService.dispatchBroadcast(dispatchTask, exec)
        : await this.executorService.dispatch(dispatchTask, exec);
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
          /cannot resolve packageurl|application\s+\S+\s+not found|无法解析\s*packageurl|应用\s*\S*\s*不存在|找不到应用/i.test(
              failureText,
            )
          ? ExecutionFailureReason.APPLICATION_MISSING
          : /timeout|timed out|etimedout|execution timed|超时|执行已超时/i.test(
                failureText,
              )
            ? ExecutionFailureReason.TIMEOUT
            : // EXP-01 / S4-C3：沙箱不可用（判据与理由见模块级
              // SANDBOX_UNAVAILABLE_PATTERN 注释）。必须在 EXECUTOR_OFFLINE
              // 之前——否则文案里的 `unavailable` 会被执行器离线规则吞掉。
              SANDBOX_UNAVAILABLE_PATTERN.test(failureText)
              ? ExecutionFailureReason.SANDBOX_UNAVAILABLE
              : // F-01 同款纪律（LANG-ERR-01 复查补口）：EXECUTOR_OFFLINE 的判据
                // 与 task.service.ts 的 inferFailureReason **共用同一份常量**。
                // 此前这里是自行抄写的一份，且容差（20）短于中台自己产出的 pinned
                // 离线文案（间隔 63）→ pinned 离线被归成 SCRIPT_ERROR（e2e 用例 27
                // 抓到）。详见 EXECUTOR_OFFLINE_PATTERN 的注释。
                EXECUTOR_OFFLINE_PATTERN.test(failureText)
                ? ExecutionFailureReason.EXECUTOR_OFFLINE
                : /git clone|package fetch|pull package|download package|npm install|pip install|requirements|dependency|拉取(?:应用包|依赖|代码)|克隆代码|下载(?:应用包|依赖|包)|依赖安装|安装依赖|代码拉取/i.test(
                      failureText,
                    )
                  ? ExecutionFailureReason.PACKAGE_FETCH_FAILED
                  : /traceback|syntaxerror|referenceerror|typeerror|uncaught|exception|command failed|exit code|脚本(?:错误|异常)|命令执行失败/i.test(
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
      // EXP-01 / S4-C3：`sandbox_unavailable` 与上一条 interpreter_unavailable
      // **同策**——沙箱后端不可用（bwrap 缺失 / 内核或容器禁用非特权 user
      // namespace / 平台不符 / Windows 上配了 TASK_SANDBOX=bwrap）是**执行器
      // 环境侧**的配置问题，与任务代码无关：重试不会让 bwrap 被装上、也不会让
      // 内核放开 user ns，只会把同一份**结构性不可能成功**的派发重复 N 次、
      // 烧光 maxRetry 预算并把真实故障延后暴露（前端 runbook 早已写明「重试
      // 无效」，此处补齐后端行为，消除「前端说得对、后端做得不对」）。
      // 修复动作在执行器环境侧：apt install bubblewrap 后重启执行器，或取消
      // TASK_SANDBOX（详见 failure-runbook 的 sandbox_unavailable 条目）。
      //
      // 位置与解释器门禁同形且**先于** retryableErrors 白名单：即使运维把
      // `sandbox_unavailable` 勾进白名单也仍然不可重试——白名单表达的是「这些
      // 失败值得重试」，而环境类失败不会因重试而自愈（与前端「列在候选中但不进
      // 任何默认值」的口径一致）。保留运维手工重跑这一条既有路径：本门禁只拦
      // 自动重试，不阻止人工重新触发。
      //
      // 后缀中文化（沿用上方 APPLICATION_MISSING 的口径）：`errMsg` 原样保留在
      // **前面**——失败分类链读的是整段 failureText，前缀不变则分类不受影响。
      if (exec.failureReason === ExecutionFailureReason.SANDBOX_UNAVAILABLE) {
        throw new UnrecoverableError(
          `${errMsg}（沙箱不可用——重试无效，修复动作在执行器环境侧，见 failure-runbook）`,
        );
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
          // LANG-ZH-01：后缀中文化。`errMsg` 原样保留在**前面**——失败分类链
          // （task.processor 下方 / task.service.inferFailureReason）读的是整段
          // failureText，前缀 errMsg 不变则分类不受影响；只改后缀是安全的。
          `${errMsg}（结构性不可恢复——重试不会成功）`,
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
            `${errMsg}（失败不在 retryableErrors 白名单内）`,
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
          // ADR-017 阶段 3（**复查补口**）：执行行的**行身份**必须与
          // `executorAddress` 同批落库。
          //
          // 为什么这是必需的而不是锦上添花：阶段 3 把 `uq_executors_address`
          // 收窄为 partial（仅 push 行），pull 模式允许**同地址多行并存**
          // （ADR-017 §5）——此时 `executorAddress` 已不能唯一指代一行。
          // `failRunningExecutionsAfterRestart` 的匹配维度因此改为
          // `executorId = $1 AND status='running'`，而 register/heartbeat
          // **恒**传 `e.id`（非 null）→ 该查询恒走行身份分支。
          //
          // 缺了本行的后果是**静默失效**（不是报错）：该列在全表恒为 NULL，
          // 查询恒命中 0 行 → 执行器重启恢复变成"什么都不做"，遗留 RUNNING
          // 只能等 stale sweep 兜底（failureReason 从 EXECUTOR_RESTART 降级为
          // STALE_RECOVERED，槽位释放与重试兑现各延后一个 sweep 周期）。
          // 即本 ADR 声称修好的那条通路被自己的漏写打回原形。
          //
          // 条件写法与 `executorAddress` 同款：dispatch 通过入参引用把两者写
          // 到执行行（executor.service.dispatch 的
          // `execution.executorId = matched.id`）；广播执行不设该字段
          // （dispatchBroadcast 不挑单一目标），undefined → 不进 patch →
          // 存量/广播行保持 NULL，回落地址匹配（与引入前逐字节一致）。
          ...(exec.executorId !== undefined
            ? { executorId: exec.executorId }
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
            // G3 补口（遗留②）：这里是**派发失败**的终态写，带本次 claim 的世代
            // （理由见上方 `expectedAttemptSeq` 注释）。非终态（RUNNING 持久化）
            // 分支不带——它只把行从「我刚 claim 的打开态」写成 RUNNING，收尾语义
            // 与本项无关，保持原样。
            const result = await transitionOneToTerminal(queryRunner.manager, {
              id: exec.id,
              patch: { ...ownedPatch, status: exec.status },
              expectedAttemptSeq,
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
                  // G3 补口（遗留②）：修复写与主写**同口径**——同一个回合的同一个
                  // 终态，不能因为主事务失败就退回「只带状态门」的宽写（那正是陈旧
                  // worker 改写新回合的最短路径）。expectedAttemptSeq 的取值/不传
                  // 纪律见上方同名常量注释。
                  const result = await transitionOneToTerminal(
                    repairRunner.manager,
                    {
                      id: exec.id,
                      patch: { ...ownedPatch, status: exec.status },
                      expectedAttemptSeq,
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
