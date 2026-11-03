/**
 * T2-B4 第二刀 · 回调处理与终态事件协作者（文件头注释块，见下 ALLOW）。
 *
 * ALLOW: handleCallback 606 行系从 task.service.ts 原样迁入（搬迁非新增），内部重写属独立任务
 */
import { Logger } from "@nestjs/common";
import type { DataSource, Repository } from "typeorm";

import { Task } from "./entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
  ExecutionRetryKind,
} from "./entities/task-execution.entity";
import { ExecutionArtifactRow } from "../artifacts/entities/execution-artifact.entity";
import { classifyFailure } from "../../common/failure-classification/failure-patterns";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import { AiAnalysisService } from "../ai/ai-analysis.service";
import { In } from "typeorm";
// A1: 终态跃迁（条件 UPDATE + RETURNING + 驱动兜底）的单一入口。
import { transitionToTerminal } from "./execution-terminal";
// CORE-04: 超时策略归一化（运行态兜底）。
import { normalizeTimeoutAction } from "./timeout-policy.util";
// 可观测性：运行时计数器埋点（模块级纯内存自增，无模块环）。
import { recordRuntime } from "../metrics/runtime-metrics-entry";
import { RedisLockService } from "../../common/services/redis-lock.service";
// T2-B4 收尾：截断标记的**唯一事实源**（收尾前两份逐字相同的副本）。
import { LOG_TRUNCATION_MARKER } from "./log-truncation-marker.util";

/**
 * T2-B4 第二刀：**回调处理与终态事件**协作者。
 *
 * ## 这一刀搬了什么（6 个方法）
 *
 * | 成员 | 原位置 | 为什么搬 |
 * |---|---|---|
 * | `handleCallback` | `task.service.ts:5473-6128`（656 行） | 回调簇主体；**本仓最大的单方法之一** |
 * | `emitTerminalEvent` | `:5268-5308` | 终态事件发布（`handleCallback` 的第 4 步） |
 * | `syncArtifactIndexRows` | `:5441-5471` | 产物索引同步（`handleCallback` 的第 3 步；**含自己的 transaction**） |
 * | `autoAnalyzeCallbackFailure` | `:5242-5266` | 失败自动分析（**仅** `handleCallback` 调用） |
 * | `inferFailureReason` | `:1058-1064` | 失败归因（**仅** `handleCallback` 调用） |
 *
 * ## ⚠️ 四步链必须同一 owner（本刀的核心不变量）
 *
 * `handleCallback` 内的这条链**整体**在本类内（四个**调用点**都在这里）：
 * `winner（终态条件 UPDATE + affected 判定） → deps.releaseSlot()
 *  → syncArtifactIndexRows → emitTerminalEvent`
 *
 * 若拆散 ⇒「**终态已落库但槽位没释放**」⇒ 执行器**永久满载**
 * （`releaseExecutorSlot` 只在它内部被调用）。
 *
 * ⚠️ 第 2 步 `deps.releaseSlot()` 是**注入回调**（实现在 Facade），但**调用点**
 * 在本类 ⇒ 顺序不变量不受影响。不变量要守的是「**执行顺序**」，不是「实现位置」——
 * 实现之所以留 Facade，是因为它有两个调用者 + 既有 spec 直接断言它（见下表）。
 *
 * ## 注入面（**窄签名**，不把 `this` 整体传进来）
 *
 * 每个注入回调只给**最小签名**——Facade 只是换了个名字就失去意义，
 * 所以这里绝不放 `TaskService` 引用。
 *
 * | 成员 | 留 Facade 的理由 | 谁在用它 |
 * |---|---|---|
 * | `releaseSlot`（= Facade 的 `releaseExecutorSlot`） | **两个硬理由**：①**多调用者**——本簇 `handleCallback` + Facade 的 `killExecution`；②**既有 spec 直接断言它**（`execution-attempt-seq.spec.ts:623` `expect(service["releaseExecutorSlot"]).toHaveBeenCalledWith(...)`）⇒ 搬进本类会让该断言**变红**（实测），而"Facade 转发 + 本类自调自己的"会让它**假过**（更危险） | `handleCallback`（3 处，经 `deps.releaseSlot`）+ `killExecution` |
 * | `storeLogLines` | **日志簇**（下一刀单独搬）；且它**含自己的 transaction** | `handleCallback`（:6110）+ 日志簇内部 |
 * | `persistCallbackLogsIfMissing` | **日志簇**；只被 `handleCallback` 调，内部只调日志簇方法 | `handleCallback`（:5880） |
 * | `backfillFullLogsFromExecutor` | **被既有 spec spy**：`task.service.spec.ts:5751` / `:5796` 打的是 **Facade 的 private**（`jest.spyOn(service as any, "backfillFullLogsFromExecutor")`）⇒ **搬走不会让测试变红，而是让测试假过**（静默失效比红危险） | `handleCallback`（:6095）+ 日志簇内部 |
 * | `hasStreamedLogLines` | **日志簇** | `handleCallback`（:6108）+ 日志簇内部 |
 * | `publishExecutionWake` | **多调用者**：`trigger`（:3309）/ `rollback`（:4176）/ `killExecution`（:6510）都调它 | `handleCallback`（:5984）+ 那三处 |
 * | `triggerDependentTasks` | **依赖扇出簇**（版本/依赖簇，下一刀） | `handleCallback`（:5934 / :6081） |
 *
 * ## ⚠️ `emitTerminalEvent` 的发布失败语义（**原样保持**）
 *
 * 领域事件发布**绝不改变主链结果**：总线自身契约即 fail-open（emit 永不外抛），
 * 方法内那圈 `try/catch` 是**第二道保险丝**——「发布事件」这一步在任何意外
 * 实现下也不改变主链。本刀**逐字保留**这两层防护。
 *
 * ## 体量（`check-size-caps`）
 *
 * `handleCallback` 函数体 606 行 > 阈值 300。**这是搬迁不是新增**：它在
 * `task.service.ts` 里就是 656 行（当时的基线条目按含它计过），本刀只是把它
 * 移到单一职责协作者里，**没有**在这一刀重写回调逻辑——重写该方法的内部结构
 * 属独立任务（需单独评估幂等 / 世代判定 / 事件时序的回归风险）。
 * 用 `ALLOW` 而非基线条目：基线条目数有 97 上限（防「把所有大文件都签字」），
 * 而本项是**纯位置迁移**，不应占用那个额度。
 *
 *
 * ## self-call 禁令
 *
 * 协作者内部**不得**直调自己的 **public** 方法（Facade 转发层是 spy 拦截面，
 * 内部 self-call 会让既有实现级断言**静默失效**）。
 * 本簇的内部互调一律指向 **private** 方法：
 * `handleCallback` → `emitTerminalEvent` / `syncArtifactIndexRows` /
 * `autoAnalyzeCallbackFailure` / `inferFailureReason`（均 private）；
 * `releaseSlot` 走**注入回调**（不在本类，故无 self-call 风险）。
 */

/** 注入回调面（**窄签名**）。 */
export interface ExecutionCallbackDeps {
  /** 执行记录仓库。 */
  execRepo: Repository<TaskExecution>;
  /** 任务仓库。 */
  taskRepo: Repository<Task>;
  /** 产物索引仓库（可空 = 未注册）。 */
  artifactIndexRepo: Repository<ExecutionArtifactRow> | null;
  /** 数据源（`releaseExecutorSlot` 与 `syncArtifactIndexRows` 的事务）。 */
  dataSource: DataSource;
  /** 领域事件总线（可空 = 未装配 ⇒ 不发事件）。 */
  eventBus: DomainEventBus | null;
  /** AI 失败分析（`autoAnalyzeCallbackFailure`）。 */
  aiAnalysisService: AiAnalysisService;
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
  /** Redis 锁服务（可空 = 未装配 ⇒ 不取互斥锁）。 */
  redisLockService: RedisLockService | null;
  /**
   * 执行器服务的**最小面**（终态后的重试恢复调度）。
   *
   * 刻意**不注入整个 `ExecutorService`**——那会让协作者反向依赖 executor 模块
   * （模块环）+ 拿到一堆用不到的能力。既有仓内先例：`executor-dispatch-slot.collaborator`
   * 同款「最小 reader 面」。
   */
  executorService: {
    scheduleRetryAfterRecovery: (
      task: Task,
      execution: TaskExecution,
      fallbackTriggerType?: string,
      retryKind?: ExecutionRetryKind,
    ) => Promise<void>;
  };

  /**
   * 释放执行器槽位（**留 Facade 的理由**：Facade 的 `killExecution` 也调它
   * ⇒ 两个调用者 ⇒ 必须有一个共同入口）。
   */
  releaseSlot: (address?: string | null) => Promise<void>;
  /** 写入日志行（日志簇；含自己的事务）。 */
  storeLogLines: (
    executionId: string,
    logs: string | string[],
    startLineNumber?: number,
    opts?: { append?: boolean },
  ) => Promise<void>;
  /** 回调日志缺失时补写（日志簇）。 */
  persistCallbackLogsIfMissing: (
    execution: TaskExecution,
    cb: {
      executionId: string;
      logs?: string;
      executorAddress?: string;
    },
  ) => Promise<void>;
  /**
   * 从执行器回填完整日志（**留 Facade 的理由**：被既有 spec
   * `task.service.spec.ts:5751` / `:5796` 以 `jest.spyOn(service as any, …)`
   * spy 在 **Facade 的 private** 上 ⇒ 搬走会让那条断言**假过**而非变红）。
   */
  backfillFullLogsFromExecutor: (
    execution: TaskExecution & { executorAddress?: string | null },
    executorAddress: string,
  ) => Promise<boolean>;
  /** 是否已有实时流式日志行（日志簇）。 */
  hasStreamedLogLines: (executionId: string) => Promise<boolean>;
  /**
   * 终态事件发布（**留 Facade 的理由**：既有 spec 有**赋值式覆写**——
   * `execution-attempt-seq.spec.ts:574` 的 `service.emitTerminalEvent = jest.fn()`
   * 打在 Facade 上；若实现搬进本类，那条覆写会**静默失效**（测试仍绿但断言
   * 变弱，比变红危险）；另 `publishTerminalEventForDispatch` 也要用它）。
   */
  emitTerminalEvent: (
    execution: TaskExecution,
    status: ExecutionStatus,
    failureReason: ExecutionFailureReason | null,
    cb: { errorMessage?: string; logs?: string },
    durationMs: number | null,
    finishedAt: Date,
  ) => void;
  /** 终态唤醒（**留 Facade 的理由**：`trigger`/`rollback`/`killExecution` 都调它）。 */
  publishExecutionWake: (executionId: string) => void;
  /** 依赖扇出触发（依赖簇）。 */
  triggerDependentTasks: (
    completedTaskId: string,
    completedExecutionId?: string,
    completedStatus?: ExecutionStatus,
  ) => Promise<void>;
}

export class ExecutionCallback {
  private readonly deps: ExecutionCallbackDeps;

  constructor(deps: ExecutionCallbackDeps) {
    this.deps = deps;
  }

  async handleCallback(
    callbacks: Array<{
      executionId: string;
      status: "success" | "failed";
      exitCode?: number;
      logs?: string;
      errorMessage?: string;
      failureReason?: ExecutionFailureReason;
      durationMs?: number;
      executorAddress?: string;
      /**
       * ADR-017 阶段 3（协议 v6）：执行器自报的稳定安装身份（64 位小写十六
       * 进制）——回调面的**行身份**输入，由控制器解析为行 id 后经
       * `fingerprintExecutorIdByAddress` 传入。缺省（旧执行器/采集失败/SDK
       * 调用方）→ 该级不参与，行为与引入前一致。
       */
      deviceFingerprint?: string;
      /** FEAT-05: 执行产物清单（可选，best-effort，随终态回调上报）。 */
      artifacts?: Array<{ name: string; size: number; sha256: string }>;
      /**
       * python_task_multiversion: 执行器上报的结构化留痕（可选）。
       * 当前承载解释器快照 `{requested, resolved, reason, detail, pool}`，
       * 落库到 `task_executions.result`。旧执行器不发送该字段。
       */
      result?: Record<string, unknown>;
    }>,
    /**
     * ADR-017 阶段 3（复查补口）：地址 → **所持凭据所属行 id** 的映射，由
     * 控制器在令牌校验时推导（`resolveCredentialExecutorId`）。**刻意是独立
     * 参数而非 callback item 字段**：它是服务端推导的事实，若放进回调体就
     * 变成调用方自报——等于把不可伪造的行身份判据交给伪造方。
     *
     * 缺省（未传 / 该地址无匹配行）→ 行身份判据不参与，回落地址相等判据，
     * 行为与引入前逐字节一致。test 与内部调用方不传即零变化。
     */
    credentialExecutorIdByAddress?: Map<string, string | null>,
    /**
     * ADR-017 阶段 3（协议 v6，方案 C）：executionId → **回调自报指纹解析出的
     * 行 id**。
     *
     * 行身份三级阶梯的**第一级**（见 ExecutionCallbackController 注释）。为什么
     * 它比凭据归属行更强：共享令牌不绑定任何行，故第二级在「共享令牌 + 同址
     * 多行」下拿不到行身份——正是本方案要补的缺口。指纹由 v6 执行器上报，
     * 服务端已查库校验其对应行存在（`resolveExecutorIdByFingerprint`）。
     *
     * **按 executionId 分键而非 address**：同批次里可以有两个同址但不同行的
     * 执行（ADR-017 §5），各自上报自己的指纹；按 address 分键会把第二条
     * 判到第一条的行走上，误拒合法回调。
     */
    fingerprintExecutorIdByExecution?: Map<string, string | null>,
  ) {
    const results = [];
    // F-11（本轮审计）: 批量回调 N+1 消除。关键判据：N+1 问题只存在于
    // `callbacks.length >= 2`——单条回调时 findOne 本身就是最优单查询（1 次
    // 往返），保持原路径（行为逐字节不变）；多条回调才升级为一次
    // `find({ where: { id: In(ids) } })` 批量查出后建 Map（100 条 → 1 条查询，
    // 且 Map 天然去重——同一 executionId 重复回调只查一次）。
    // 单条回调的处理语义不变：查不到 execution 仍走各自的结果分类计数
    //（not_found），不影响其他条目。
    let executionById: Map<string, TaskExecution> | null = null;
    if (callbacks.length > 1) {
      executionById = new Map(
        (
          await this.deps.execRepo.find({
            where: { id: In(callbacks.map((cb) => cb.executionId)) },
          })
        ).map((execution) => [execution.id, execution]),
      );
    }
    // NETOPT-1⑥: 循环内逐条 taskRepo.findOne（广播判定 + CORE-04 超时动作）
    // 升级为一次 In() 批查建 Map——多条回调 × 2 个查点最坏 2N 条查询收敛为
    // 1 条（对齐上方 executionById 的 F-11 模式）。单条回调保持原逐条查
    // （1 次往返即最优，行为逐字节不变）。与原 findOne 同不带 withDeleted，
    // 软删除语义一致。
    let taskById: Map<string, Task> | null = null;
    if (executionById) {
      const taskIds = [
        ...new Set(
          [...executionById.values()]
            .map((e) => e.taskId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      taskById = new Map(
        taskIds.length > 0
          ? (await this.deps.taskRepo.find({ where: { id: In(taskIds) } })).map(
              (t) => [t.id, t],
            )
          : [],
      );
    }
    for (const cb of callbacks) {
      try {
        const execution = executionById
          ? executionById.get(cb.executionId)
          : await this.deps.execRepo.findOne({ where: { id: cb.executionId } });
        if (!execution) {
          // 可观测性补齐：callback 业务结果分类计数（not_found）
          recordRuntime("autoflow_callback_business_total", {
            result: "not_found",
          });
          results.push({
            executionId: cb.executionId,
            success: false,
            error: "Execution not found",
          });
          continue;
        }

        // R-16（DEEP_REVIEW 0ef3bbe）：派发落库前窗口守卫——execution 处于
        // PENDING 且 executorAddress 为 null（尚未派发）时拒绝终态回调。
        // 此前任何持有效执行器凭据者可对未派发 execution 回报任意终态
        // （success/failed），导致状态被篡改。RUNNING 但快照 executorAddress
        // 为 null 属 dispatch 落库窗口的合法场景（RETURNING 会取库中实际地址），
        // 不在此拒绝。
        //
        // B-7（调度域审计）：守卫扩展到 WAITING。WAITING（互斥/部署约束
        // 排队）从未派发——executorAddress 恒为 null，却同属打开态：旧守卫
        // 只挡 PENDING，持共享执行器凭据者可把**别家排队中**的执行写成终态
        // （排队执行凭空"成功/失败"，唤醒后又被 dispatch 二次覆盖）。终态
        // 回调只可能来自真实派发，而派发必先经 processor claim（WAITING→
        // RUNNING）——WAITING 行不存在合法的终态回调来源；人工终止/覆盖走
        // killExecution / COVER_EARLY（transitionToTerminal 直写，不经本
        // HTTP 回调面）。
        //
        // 超时耦合注记（N-17）：这个「executorAddress 合法为 null」的窗口由
        // 派发 HTTP 的客户端超时上界约束——executor.service.dispatch（及
        // dispatchBroadcast）对执行器 accept 请求的超时为
        // `((task.timeout || 300) + 10) * 1000` ms，即窗口长度与 task.timeout
        // 成比例。正因长超时任务的派发窗口可以很长（HTTP 还没返回、executor
        // 却可能已接单开跑），本守卫只拒「确实尚未派发」的 PENDING/WAITING、
        // 放行 RUNNING+null——两者以「是否已开始执行」划界，而不是以地址是否
        // 已落库划界。
        if (
          (execution.status === ExecutionStatus.PENDING ||
            execution.status === ExecutionStatus.WAITING) &&
          !execution.executorAddress
        ) {
          recordRuntime("autoflow_callback_business_total", {
            result: "not_dispatched",
          });
          this.deps.logger.warn(
            `R-16/B-7: Rejected terminal callback for execution ${cb.executionId} ` +
              `in status ${execution.status} which has not been dispatched yet (executorAddress is null).`,
          );
          results.push({
            executionId: cb.executionId,
            success: false,
            error: "Execution has not been dispatched yet",
          });
          continue;
        }

        // P1: once an execution has been dispatched to a specific executor,
        // callbacks must come from that address — a missing or different
        // address is rejected (both executor runtimes always send it).
        //
        // ADR-017 阶段 3（复查补口）：**行身份优先**。阶段 3 把
        // `uq_executors_address` 收窄为 partial（仅 push 行），pull 模式允许
        // **同地址多行并存**（ADR-017 §5）——此时「地址相等」不再是「同一台
        // 机器」的证明：两台自报同一地址时本闸恒等，拦不住串台（迁移
        // 1790000000055 的类注释已把这条列为待修面之一）。
        //
        // 修法用**行身份三级阶梯**（优先级从高到低）：
        //   ① 回调自报指纹解析出的行（协议 v6；**独立于令牌类型**，故共享
        //      令牌路径也能拿到行身份——这正是方案 C 要补的缺口）；
        //   ② 调用方所持凭据所属行（per-executor 令牌专有；由控制器服务端
        //      推导后作为独立参数传入）；
        //   ③ 地址相等（唯一行时的 legacy 兜底）。
        // 三级都拿不到行身份 → 只走 ③，行为与引入前逐字节一致。
        //
        // 判据语义：拿到行身份后，要求 `row === execution.executorId`——即
        // 「你自称/自证的那一行，必须就是 dispatcher 派发的那一行」。不一致
        // 即拒（跨行申领别人那行的执行）。执行行无 `executorId`（存量行）时
        // 无从比对，回落 ③。
        const fingerprintRowId =
          fingerprintExecutorIdByExecution?.get(cb.executionId) ?? null;
        const credentialRowId = cb.executorAddress
          ? (credentialExecutorIdByAddress?.get(cb.executorAddress.trim()) ??
            null)
          : null;
        const claimedRowId = fingerprintRowId ?? credentialRowId;
        const claimedBy = fingerprintRowId
          ? "deviceFingerprint"
          : credentialRowId
            ? "per-executor credential"
            : null;
        if (
          execution.executorId &&
          claimedRowId &&
          claimedRowId !== execution.executorId
        ) {
          recordRuntime("autoflow_callback_business_total", {
            result: "executor_identity_mismatch",
          });
          this.deps.logger.warn(
            `ADR-017: Rejected terminal callback for execution ${cb.executionId} — ` +
              `the callback identifies executor row ${claimedRowId} (via ${claimedBy}), ` +
              `but the execution was dispatched to row ${execution.executorId} ` +
              `(address ${execution.executorAddress ?? "-"}).`,
          );
          results.push({
            executionId: cb.executionId,
            success: false,
            error: "Executor identity mismatch",
          });
          continue;
        }
        if (
          execution.executorAddress &&
          cb.executorAddress !== execution.executorAddress
        ) {
          // 可观测性补齐：地址不符与缺地址分别归类计数
          recordRuntime("autoflow_callback_business_total", {
            result: cb.executorAddress
              ? "address_mismatch"
              : "address_mismatch_missing_address",
          });
          results.push({
            executionId: cb.executionId,
            success: false,
            error: cb.executorAddress
              ? "Executor address mismatch"
              : "executorAddress is required for this execution",
          });
          continue;
        }

        // R-06（DEEP_REVIEW 0ef3bbe）: 广播执行的槽位释放。广播 dispatch 对
        // 每个目标执行器 runningTaskCount +1（executor.service.dispatchBroadcast），
        // 但广播执行的 executorAddress 恒为 null（task.processor 仅非广播落库），
        // 下方 winner 分支的 releaseExecutorSlot(winnerAddress) 对 null 早退 no-op。
        // 这里按任务 executeMode 权威判定广播，随后无论本回调是 winner 还是重复回调
        // （affected=0），都按 cb.executorAddress 释放该执行器自己的那一个坑——
        // N 个被接受执行器各回调一次，恰好 -N。非广播执行不走此分支，单播释放
        // 语义（winner-once）不变。
        let isBroadcast = false;
        if (!execution.executorAddress && execution.taskId) {
          // NETOPT-1⑥: 批量路径查 Map，单条路径保持原 findOne（语义不变）
          const taskRow = taskById
            ? (taskById.get(execution.taskId) ?? null)
            : await this.deps.taskRepo.findOne({
                where: { id: execution.taskId },
              });
          isBroadcast = taskRow?.executeMode === "broadcast";
        }

        // P1: atomic terminal transition — the update only lands while the
        // execution is still pending/running, making duplicate callbacks and
        // races with the worker's finally-save harmless. Slot release and log
        // persistence below run exactly once, only for the winner.
        const finishedAt = new Date();
        const patch: Partial<TaskExecution> = {
          endTime: finishedAt,
          duration:
            cb.durationMs ??
            (execution.startTime
              ? finishedAt.getTime() - new Date(execution.startTime).getTime()
              : 0),
        };
        if (cb.status === "success") {
          patch.status = ExecutionStatus.SUCCESS;
          patch.failureReason = null;
        } else {
          const failureReason =
            cb.failureReason ??
            this.inferFailureReason(cb.errorMessage, cb.logs, cb.exitCode);
          patch.status =
            failureReason === ExecutionFailureReason.TIMEOUT
              ? ExecutionStatus.TIMEOUT
              : ExecutionStatus.FAILED;
          patch.failureReason = failureReason;
          if (cb.errorMessage !== undefined) {
            patch.errorMessage = cb.errorMessage;
          }
          // FIX-7.1: 脚本阶段失败的自动 AI 分析——在终态转换**前**触发，
          // 使分析结果同时进终态 patch（一次写库，与 processor 派发失败路径
          // 的 exec.aiAnalysis 同列）与 execution.failed 事件载荷
          // （emitTerminalEvent 读内存 execution.aiAnalysis → 订阅方拿到的
          // 通知与 AI 分析同源）。复用同一开关面：AiAnalysisService
          // fail-open（provider disabled / 内部重试耗尽返回 ""），任何失败
          // 都只跳过分析、绝不阻塞终态落库。回调天然每执行恰一次（winner
          // 语义），无 processor「仅最后一试」要防的重试刷屏问题。
          const failureTask = execution.taskId
            ? taskById
              ? (taskById.get(execution.taskId) ?? null)
              : await this.deps.taskRepo.findOne({
                  where: { id: execution.taskId },
                })
            : null;
          const analysis = await this.autoAnalyzeCallbackFailure(
            failureTask,
            cb,
            failureReason,
          );
          if (analysis) {
            execution.aiAnalysis = analysis;
            patch.aiAnalysis = analysis;
          }
        }
        // 改动2（可观测性补齐）：回调上报的原始退出码入库溯源（终态成败均
        // 适用）。DTO 层已 @IsInt 校验，这里再运行态兜底（handleCallback 还有
        // 内部调用方）：非整数按缺省处理，不写入 patch——绝不把已有值覆盖成 null。
        if (typeof cb.exitCode === "number" && Number.isInteger(cb.exitCode)) {
          patch.exitCode = cb.exitCode;
        }
        if (cb.logs) {
          patch.logs = cb.logs;
        }
        // FEAT-05: 产物清单落库（best-effort）。仅在回调上报非空清单时写入，
        // 绝不在缺省时覆盖成 null——重复/兜底回调不会擦除先前已保存的清单。
        if (Array.isArray(cb.artifacts) && cb.artifacts.length > 0) {
          patch.artifacts = cb.artifacts;
        }
        // python_task_multiversion（FR-12/AC-12a）：执行器上报的结构化留痕
        // （当前是解释器快照 `{requested, resolved, reason, detail, pool}`）。
        //
        // 为什么必须显式透传：回调体走 `ParseArrayPipe({items, whitelist: true})`，
        // 而该 pipe **只带 whitelist、不带 forbidNonWhitelisted**——未被 DTO 声明
        // 的字段会被**静默丢弃**（不报错）。此前 DTO 没有 `result` 字段，于是
        // 执行器辛辛苦苦产出的解释器快照在 admin 边界被无声吃掉，UI 永远拿不到
        // `interpreter_unavailable` 的"请求了哪个版本/池里有什么"，
        // 运维只能看到一个分因、无法定位。DTO 侧已加 `result`（含 4KB/深度约束）。
        //
        // 写入口径与 artifacts 一致：仅上报非空对象时写，**绝不用缺省覆盖成 null**
        // ——重复回调/旧执行器（不带该字段）不得擦除已保存的留痕。
        if (
          cb.result &&
          typeof cb.result === "object" &&
          !Array.isArray(cb.result) &&
          Object.keys(cb.result).length > 0
        ) {
          patch.result = cb.result as Record<string, any>;
        }

        // R-P0-007: Exclude KILLED status to prevent callback from overwriting user-initiated kill
        // 改动4: 携带 RETURNING——用库中实际 executorAddress 决定释放/回填目标。
        // executorAddress 在 dispatch HTTP 返回后才落库（task.processor.ts），
        // 秒级完成的执行其请求前快照 execution.executorAddress 仍为 null，用它
        // 释放会 no-op 使 runningTaskCount 永久虚高；RETURNING 覆盖该落库窗口，
        // 快照仅作 fallback（参照 scheduler.service 的 UPDATE ... RETURNING 模式）。
        // A1: 走统一入口——开放态门槛不再在本文件抄一份字面量（旧实现硬编码
        // [PENDING, RUNNING]，与 scheduler 的 OPEN_EXECUTION_STATUSES 是两份
        // 事实源，加状态必漏改）。
        // 上面 success/非 success 两个分支都已给 patch.status 赋值，此处显式
        // 取出以满足终态入口的类型契约（status 必为终态，入口会再校验一次）。
        const { status: terminalStatus, ...restPatch } =
          patch as Partial<TaskExecution> & { status: ExecutionStatus };
        // G3（迁移 1790000000092）：**尝试世代**校验——本次终态写入只认「这个回合」。
        //
        // 为什么纯状态门不够：终态门只看 `status IN (打开态)`，回答不了「这是第几
        // 回合的开着」。而同一个 executionId 会被重新 claim 成 RUNNING
        //（`task.processor` 的 claim 把 FAILED 也算可 claim——BullMQ 重试复用同一个
        // `{executionId}` job；互斥/部署等待的唤醒同款），于是「上一回合的迟到回调」
        // 与「本回合的正常回调」在 (id, status, executorAddress) 上完全同形。
        //
        // 值取**服务端快照**（本方法开头读到的那一行的 attemptSeq），因为执行器回调
        // 载荷是 `additionalProperties: false` 的封闭 schema——让执行器回传世代要改
        // `packages/executor-protocol` + 重生成 node/python 两侧 schema + 两个执行器
        // 运行时（三处均不在本批足迹内，属架构变更）。规范化成整数才传：替身/存量行
        // 未带该列时得到 undefined ⇒ **不加谓词** ⇒ 与引入前逐字节一致。
        //
        // 保证的是「读行 → 写行」这段窗口（中间隔着广播判定、失败时的 AI 分析 LLM
        // 往返、产物索引落库，可达秒级）：期间若该行被重新 claim（世代自增），旧回合
        // 的结果**不会**落到新回合的行上。**边界如实声明**：迟到回调若在重新 claim
        // **之后**才到达，其快照已是新世代，本条谓词放行——挡那一段必须让回调自带
        // 世代（协议改动）；届时只需把此处换成 `cb.attemptSeq`，谓词与语义不动。
        const snapshotAttemptSeq =
          typeof execution.attemptSeq === "number" &&
          Number.isInteger(execution.attemptSeq)
            ? execution.attemptSeq
            : undefined;
        const updated = await transitionToTerminal(this.deps.execRepo, {
          ids: [cb.executionId],
          patch: { status: terminalStatus, ...restPatch },
          expectedAttemptSeq: snapshotAttemptSeq,
          // 重复回调分支按 cb.executorAddress 释放（广播语义），此处无需快照。
        });

        if (!updated.affected) {
          // Already terminal (duplicate callback): report success without
          // releasing the slot again — the first writer already did.
          // 改动3: 但若回调日志此前没落库（上一次 winner 在 storeLogLines 抛错、
          // 整批重试回到此分支），仍补写日志后再返回，闭合"落库失败→日志永久丢失"。
          const fresh = await this.deps.execRepo.findOne({
            where: { id: cb.executionId },
          });
          // G3：affected=0 现在有**两种**成因，必须分开处置——
          //   ① 行已终态 = 真·重复回调（既有语义：补写缺失日志后按成功上报）；
          //   ② 行**仍开着**但世代已推进 = 迟到回合被世代门禁拒绝（本批新增的拒绝面）。
          // ② 刻意**不**走 ① 的补写日志：那一回合的日志不属于当前回合的行，写进去
          // 会让当前回合的日志视图混入一个已废弃回合的输出（日志是取证面）。
          // 仍按成功上报——执行器重试这条回调永远不可能再命中，重试只是把一批
          // 已死的载荷反复投递（与「重复回调」的上报契约一致）。
          const staleRound =
            snapshotAttemptSeq !== undefined &&
            !!fresh &&
            typeof fresh.attemptSeq === "number" &&
            Number.isInteger(fresh.attemptSeq) &&
            fresh.attemptSeq !== snapshotAttemptSeq;
          if (staleRound) {
            this.deps.logger.warn(
              `G3: discarded a stale-attempt callback for execution ${cb.executionId} — ` +
                `handled against attempt #${snapshotAttemptSeq}, row has advanced to #${fresh?.attemptSeq}; ` +
                `terminal write skipped (affected=0), reported success so the executor stops retrying a dead round`,
            );
          } else if (fresh) {
            await this.deps.persistCallbackLogsIfMissing(fresh, cb);
          }
          // R-06（DEEP_REVIEW 0ef3bbe）: 广播场景下，其余 N-1 个被接受执行器的
          // 回调会落到这里（首个回调已把执行行终态化）。它们各占一坑，必须按各自
          // cb.executorAddress 释放——不能因「已终态」而漏掉。非广播执行此分支
          // 保持零释放（winner 已释放一次）。
          if (isBroadcast && cb.executorAddress) {
            // 第 6 轮审计 P2：同一条回调被**重试**（首次已落库但响应丢失）
            // 会再次落到本分支，同一台执行器被冲销第二次——GREATEST(...,0)
            // 只防负数不防虚低，容量闸看到的负载比实际小，继续超发。用
            // Redis SETNX 按 (executionId, address) 做一次性闸（TTL 10min，
            // 覆盖执行器重试窗）；Redis 不可用 fail-open 释放（宁可少防一次，
            // 不可让槽位永久泄漏）。
            let shouldRelease = true;
            if (this.deps.redisLockService) {
              try {
                shouldRelease = await this.deps.redisLockService.setIfAbsent(
                  `slot-release:${cb.executionId}:${cb.executorAddress}`,
                  10 * 60_000,
                );
              } catch (err: unknown) {
                this.deps.logger.warn(
                  `Slot-release claim unavailable (releasing anyway): ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                shouldRelease = true;
              }
            }
            if (shouldRelease) {
              await this.deps.releaseSlot(cb.executorAddress);
            }
          }
          // 可观测性补齐：重复回调（已终态）业务分类计数；终态结果不计数——
          // 执行结果 series 只在唯一 winner 的 UPDATE 命中处记录。
          recordRuntime("autoflow_callback_business_total", {
            result: "duplicate",
          });
          // NETOPT-3②: 依赖扇出的丢失补偿重放。两条此前永久静默丢扇出的
          // 路径都收敛到这里：① 终态提交后、扇出前进程崩溃（执行器整批重发
          // 落到本分支）；② 扇出 trigger 失败（depsFiredAt 刻意留 NULL）。
          // 判据 = 行已是 SUCCESS 终态 且 depsFiredAt 仍为 NULL（扇出全部
          // 成功时已落标记，不会重放——幂等由标记保证，重放内部的 claim
          // 去重再兜一层并发安全）。标记列是旁路信号，非终态，不触碰 A1
          // 状态机。
          if (
            fresh &&
            fresh.taskId &&
            fresh.status === ExecutionStatus.SUCCESS &&
            !fresh.depsFiredAt
          ) {
            this.deps.logger.warn(
              `NETOPT-3②: duplicate callback for SUCCESS execution ${cb.executionId} with depsFiredAt=NULL — replaying dependency fan-out for task ${fresh.taskId}`,
            );
            await this.deps.triggerDependentTasks(fresh.taskId, fresh.id);
          }
          results.push({ executionId: cb.executionId, success: true });
          continue;
        }

        // ARTIFACTS-INDEX-46（部署模型评审 §4.6）：产物元数据索引双轨写——
        // jsonb 清单已随上方 transitionToTerminal patch 落库，这里在**同一
        // 写点**同步 upsert 关系化新表（execution_artifacts），供
        // GET /artifacts?applicationId=&taskId= 索引查询。三要点：
        //  ① 仅 winner 分支执行（重复回调 affected=0 已 continue，天然幂等
        //    不会重放扇出）；
        //  ② 整替语义（先 delete 后 insert）：回调重报清单时以最新上报为准
        //    （与 jsonb 整列覆盖同款语义），唯一 (executionId,name) 不会撞；
        //  ③ best-effort：新表写失败只 warn 不抛——产物清单本身是 best-effort
        //    （FEAT-05 头注），索引表缺失行只影响新查询端点的完备性，绝不能
        //    反过来阻塞终态主链；两侧短暂不一致由下一次上报/TTL 清理收敛。
        //  ④ 触发条件与 jsonb 写点逐字节同款（非空数组才写）——空清单/缺省
        //    上报在 jsonb 侧不覆盖旧值，索引侧同样不动，两侧恒同宽。
        if (
          this.deps.artifactIndexRepo &&
          Array.isArray(cb.artifacts) &&
          cb.artifacts.length > 0
        ) {
          try {
            await this.syncArtifactIndexRows(
              cb.executionId,
              execution.taskId,
              cb.artifacts,
            );
          } catch (err: unknown) {
            this.deps.logger.warn(
              `ARTIFACTS-INDEX-46: execution ${cb.executionId} 产物索引行同步失败（best-effort，jsonb 主链不受影响）: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }

        // 可观测性补齐：终态条件 UPDATE 命中（winner）——业务受理计数。
        // 第二轮审计（A4）：autoflow_execution_result_total 的记录点已下沉
        // 到 transitionToTerminal 统一终态入口（execution-terminal.ts），
        // 此处不再记录——避免与下沉后的入口双计；同时 kill / 执行器重启 /
        // 扫描回收 / 入队补偿等服务端终态路径在同一入口获得计数。
        recordRuntime("autoflow_callback_business_total", {
          result: "accepted",
        });

        // FIX-4.2: 终态已落库（winner），best-effort 唤醒所有 webhook wait
        // 等待方——发布点在提交之后，唤醒即意味着终态已可见。
        this.deps.publishExecutionWake(cb.executionId);

        // winner 行（RETURNING 结果）为权威：地址/日志持久化都以此为准。
        // A1: 形状归一化（数组/单对象/空 + 驱动不返回行时的快照兜底）已由
        // 统一入口完成，此处不再自己解析 `raw`（旧实现在此重复了一版解析，
        // 且与 scheduler/executor 两处口径不同）。
        const winnerAddress =
          updated.rows[0]?.executorAddress ?? execution.executorAddress;

        // Decrement executor runningTaskCount on task completion (success or
        // failure); exactly once thanks to the conditional update above.
        // 改动4: 优先用 RETURNING 的库中实际地址，快照兜底。
        await this.deps.releaseSlot(winnerAddress);
        // R-06（DEEP_REVIEW 0ef3bbe）: 广播执行的 winnerAddress 恒为 null（上方
        // no-op），本执行器自己占的坑改按其上报地址释放；非广播执行 winnerAddress
        // 已释放，这里跳过。
        if (isBroadcast && cb.executorAddress) {
          await this.deps.releaseSlot(cb.executorAddress);
        }

        // ARCH-21（原「改动1」解耦）：终态事件发布——旧的 FAILED/TIMEOUT
        // 直调告警改为 execution.failed（notification 模块监听器复刻等价
        // 语义），并在 SUCCESS 新增 execution.completed（本轮通知侧刻意不
        // 订阅——旧路径成功本就不发通知；事件为 FEAT-07 出站 webhook 铺路）。
        // 放在依赖 fan-out 与日志持久化之前，与旧直调时机点一致：确保即便
        // 后续步骤抛错被 catch 成 success:false（执行器随后会重试整批），
        // 事件也已发出一次；重试路径在 affected=0 分支不再 emit，恰好保持
        // "每个失败执行一次告警"，与终态条件 UPDATE 的 winner 语义一致。
        this.deps.emitTerminalEvent(
          execution,
          patch.status as ExecutionStatus,
          patch.failureReason ?? null,
          cb,
          patch.duration ?? null,
          finishedAt,
        );

        // CORE-04: 超时终态落定后的动作兑现。执行器回调 failureReason=timeout
        // （自身硬超时树杀后上报）且任务配置了非缺省 timeoutAction 时：
        //  - notify_only：admin 不额外动作（告警已由上方改动1路径发出）——
        //    显式 no-op 分支只是让语义可读；
        //  - kill_retry：按任务既有重试预算 re-enqueue 一次新执行（与
        //    executor-restart / stale sweep 共用 hasRetryBudget +
        //    scheduleRetryAfterRecovery，fail-open：预算耗尽/入队失败仅记日志，
        //    终态已落定不受影响）。kill（缺省/null）走到这里即无追加动作。
        // 放在 winner 分支保证恰好一次（duplicate 回调在 affected=0 提前返回）。
        if (patch.status === ExecutionStatus.TIMEOUT) {
          // NETOPT-1⑥: 批量路径查 Map，单条路径保持原 findOne（语义不变）
          const task = !execution.taskId
            ? null
            : taskById
              ? (taskById.get(execution.taskId) ?? null)
              : await this.deps.taskRepo.findOne({
                  where: { id: execution.taskId },
                });
          const action = normalizeTimeoutAction(task?.timeoutAction);
          if (action === "kill_retry" && task) {
            this.deps.logger.warn(
              `CORE-04: timeout action kill_retry for execution ${execution.id} (task "${task.name}")`,
            );
            try {
              await this.deps.executorService.scheduleRetryAfterRecovery(
                task,
                execution,
                "timeout_retry",
              );
            } catch (retryErr: unknown) {
              const retryMsg =
                retryErr instanceof Error ? retryErr.message : String(retryErr);
              this.deps.logger.warn(
                `CORE-04: kill_retry re-enqueue failed for execution ${execution.id}: ${retryMsg} (terminal state preserved)`,
              );
            }
          }
          // notify_only：无追加 admin 动作——超时告警已发出（改动1 路径），
          // 执行器侧树杀照常发生。此分支显式留空以承载语义。
        }

        // R4-P0: dependency fan-out lives on the unique-winner path. The
        // worker's in-memory status can only be RUNNING/FAILED/TIMEOUT when
        // its finally block runs (SUCCESS is written exclusively by the
        // conditional UPDATE above), so the previous trigger point in
        // TaskProcessor.handle was dead code and dependency chains never
        // fired. Firing here — after affected > 0 and only for
        // status === SUCCESS — makes duplicate callbacks a no-op (they exit
        // at the affected gate above) and keeps the TASK-004 conditional
        // UPDATE semantics: exactly one caller observes the transition.
        // G6：失败边——失败/超时/取消也进入扇出入口，函数内部只挑
        // `runOnUpstreamFailure` 的下游（未声明者仍按「失败不触发」）。
        if (
          patch.status === ExecutionStatus.SUCCESS ||
          patch.status === ExecutionStatus.FAILED ||
          patch.status === ExecutionStatus.TIMEOUT ||
          patch.status === "killed" ||
          patch.status === "cancelled"
        ) {
          // NETOPT-3②: 传执行行 id——扇出全部成功后在该行落 depsFiredAt 标记。
          await this.deps.triggerDependentTasks(
            execution.taskId,
            cb.executionId,
            patch.status as ExecutionStatus,
          );
        }

        // LOG-01: persist structured log lines for pagination/SSE. When the
        // executor truncated the callback payload, pull the full logs from the
        // executor's /api/logs endpoint instead; on failure fall back to the
        // truncated lines so the log viewer keeps working.
        if (cb.logs) {
          let stored = false;
          if (LOG_TRUNCATION_MARKER.test(cb.logs)) {
            stored = await this.deps.backfillFullLogsFromExecutor(
              { ...execution, executorAddress: winnerAddress ?? null },
              winnerAddress ?? "",
            );
          }
          if (!stored) {
            // RT-LOG: 回调日志是**截断**形态（执行器内存只留头尾）而实时流
            // 已经落了行时，不能再用它整体覆盖——否则用户看到的终态日志比
            // 执行过程中更少。其余情形（无既有行、或回调日志未截断）照常
            // 写入，既有 replace 语义不变。判据与 persistCallbackLogsIfMissing
            // 同源（见 hasStreamedLogLines）。
            const keepStreamed =
              LOG_TRUNCATION_MARKER.test(cb.logs) &&
              (await this.deps.hasStreamedLogLines(cb.executionId));
            if (!keepStreamed) {
              await this.deps.storeLogLines(cb.executionId, cb.logs);
            }
          }
        }

        results.push({ executionId: cb.executionId, success: true });
      } catch (error: unknown) {
        // 可观测性补齐：per-item 异常兜底分支（如日志持久化抛错）——业务
        // 分类计 error；执行结果不计数（终态可能已写入，由 winner 处计数）。
        recordRuntime("autoflow_callback_business_total", { result: "error" });
        results.push({
          executionId: cb.executionId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  /**
   * ARTIFACTS-INDEX-46（部署模型评审 §4.6）：终态回调产物清单的关系化同步
   * （execution_artifacts 表写侧，与 task_executions.artifacts jsonb 双轨）。
   *
   * ## 整替语义（幂等 upsert）
   *
   * 回调可能重报清单（执行器重试整批、清单随后补齐），唯一键 (executionId,
   * name) 下「逐条 upsert」会让**上次有、这次没有**的产物残留成幽灵行——与
   * jsonb 侧「整列覆盖」语义不一致。故这里按执行整替：先 delete 该执行全部
   * 索引行、再 insert 本批清单。winner 语义（transitionToTerminal affected=1
   * 才走到这里）保证同一执行至多整替一次；重复回调走 affected=0 分支不会重放。
   *
   * ## applicationId 快照
   *
   * 冗余自任务行 tasks.applicationId（**写时快照**，非 FK 联动）：任务删除后
   * 执行行级联消失（taskId CASCADE），索引行随执行行走；应用删除后 FK SET
   * NULL 保留历史行（见迁移 1790000000065 头注）。任务查不到（已删的极端
   * 竞态）→ null——按应用查不到它，但按任务/执行维度仍完整。
   *
   * ARTIFACTS-INDEX-47（服务层质量巡查·事务边界）：delete+insert 必须在
   * **同一事务**内。winner 语义（transitionToTerminal affected=1 才走到这里）
   * 保证同一执行**至多整替一次**——重复回调 affected=0 直接 continue，执行
   * 已终态化后不会有「下一次上报」补写。若两步写无事务：delete 成功、insert
   * 失败（连接抖动/约束冲突）时该执行的索引行被清空且**永久丢失**（jsonb
   * 主轨仍在，GET /artifacts 对该执行从此恒空，直到 90d retention 级联删）。
   * 包进事务后 best-effort 的前提才真正成立：失败 = 整体没写（原子），
   * 调用点 warn 不炸主链的语义不变。
   *
   * @private 仅由 handleCallback winner 分支调用（调用点已做 best-effort 包裹）。
   */
  private async syncArtifactIndexRows(
    executionId: string,
    taskId: string,
    artifacts: Array<{ name: string; size: number; sha256: string }>,
  ): Promise<void> {
    if (!this.deps.artifactIndexRepo) return;
    // applicationId 快照：任务行可能已删（执行行尚在的窗口极窄，但仍要防御）。
    let applicationId: string | null = null;
    if (taskId) {
      const taskRow = await this.deps.taskRepo.findOne({
        where: { id: taskId },
        select: ["applicationId"] as never,
      });
      applicationId = taskRow?.applicationId ?? null;
    }
    await this.deps.dataSource.transaction(async (manager) => {
      await manager.delete(ExecutionArtifactRow, { executionId });
      if (artifacts.length === 0) return;
      const rows = artifacts.map((a) =>
        this.deps.artifactIndexRepo!.create({
          executionId,
          taskId,
          applicationId,
          name: a.name,
          size: a.size,
          sha256: a.sha256,
        }),
      );
      await manager.insert(ExecutionArtifactRow, rows);
    });
  }

  /**
   * FIX-7.1: 终态回调失败/超时分支的自动 AI 分析（脚本阶段失败）。
   *
   * - 输入与 analyzeExecution 同源：净化日志 + 平台已判定的 failureReason /
   *   exitCode + 任务级 runbook（FIX-6.2 的结构化上下文，AI 结论与运维沉淀
   *   对齐）；task 行不可得（无 taskId / 已删除）时跳过分析返回 ""。
   * - fail-open 双保险：AiAnalysisService.analyzeFailure 内部永不抛错
   *   （ARCH-30 契约），这里的 try/catch 兜住其外的任何意外——分析的任何
   *   失败都只跳过分析，绝不阻塞终态落库（调用点在 transitionToTerminal 前）。
   */
  private async autoAnalyzeCallbackFailure(
    task: Task | null,
    cb: { logs?: string; exitCode?: number },
    failureReason: ExecutionFailureReason,
  ): Promise<string> {
    if (!task) return "";
    try {
      return await this.deps.aiAnalysisService.analyzeFailure(
        { name: task.name, runtime: task.runtime },
        cb.logs ?? "",
        {
          failureReason,
          exitCode: typeof cb.exitCode === "number" ? cb.exitCode : null,
          runbook: task.runbook ?? null,
        },
      );
    } catch (err: unknown) {
      this.deps.logger.warn(
        `FIX-7.1: auto analysis skipped (terminal state unaffected): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "";
    }
  }

  /**
   * 失败归因（**回调路径**）——委托给共享裁决器。
   *
   * ## 为什么不再在这里自带正则链
   *
   * 此前本方法与 `task.processor.ts`（**派发失败路径**）各抄了一份分类正则
   * 链，于是：
   *   · 同一个缺陷要修两遍（LANG-ERR-01 复查时先只修了 service 侧，CI 的
   *     e2e 用例 27 仍红——它走 processor 侧）；
   *   · 两条链的**规则集合还不同**（回调路径缺 `SANDBOX_UNAVAILABLE` 与
   *     `APPLICATION_MISSING` 两条）⇒ 同一条失败文案在两条路径上归因不同。
   *
   * 现在两条路径都调用 `common/failure-classification` 的**同一个**
   * `classifyFailure`，判据与顺序只有一份。
   *
   * 注意本方法只是**兜底**：回调自带 `failureReason` 时优先采信执行器分类
   * （调用点 `cb.failureReason ?? this.inferFailureReason(...)`），本方法服务于
   * 旧执行器与执行器未分类的失败。
   */
  private inferFailureReason(
    errorMessage?: string | null,
    logs?: string | null,
    exitCode?: number,
  ): ExecutionFailureReason {
    return classifyFailure({ errorMessage, logs, exitCode });
  }
}
