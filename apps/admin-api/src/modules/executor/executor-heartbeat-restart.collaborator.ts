import { Logger } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { releaseExecutorSlotByAddress } from "../task/block-strategy-gate";
import type { Executor } from "./entities/executor.entity";
import type { TaskExecution } from "../task/entities/task-execution.entity";

/**
 * T1-B3c：**心跳与重启判定**协作者（纯判定 + 共享 util 转发）。
 *
 * ## 边界：只搬「怎么判」，不搬「判完做什么」
 *
 * 本类收四件**纯判定**的事 + 一件**转发**的事：
 *   ① `parseExecutorStartedAt` —— 时间串解析（非法 → null）；
 *   ② `hasExecutorRestarted` —— 「这次心跳是不是一次重启」；
 *   ③ `resolveRestartBaseline` —— 重启恢复的时间基线（startupId-only 降级）；
 *   ④ `shouldFailAfterRestart` —— 某一行 RUNNING 是否该被终态化；
 *   ⑤ `releaseExecutorSlot` —— 槽位冲销（**委托共享 util**，不改语义）。
 *
 * **不在这里**：终态化 RUNNING 行（`failRunningExecutionsAfterRestart`）——
 * 它要写执行行、批量 UPDATE、重试入队，且与 Facade 的
 * `scheduleRetryAfterRecovery`（task 模块当契约用的 public 方法）耦合 ⇒
 * 留 Facade（见 r5-b3 报告「未搬项」）。
 *
 * ## self-call 禁令
 *
 * 协作者内部**不得**直调自身的 public 方法（Facade 转发层同时是 spy 拦截面）。
 * 本类里 `parseExecutorStartedAt` / `resolveRestartBaseline` 都用**私有**
 * `parseDate` 做解析 ⇒ 不触发 self-call 守卫（`scripts/check-collaborator-self-call.mjs`
 * 只判 public 方法）。
 *
 * ## 为什么 `releaseExecutorSlot` 走 `manager` 而不是 `repo`
 *
 * 既有 spec 钉住「槽位冲销**不触碰** `repo.createQueryBuilder`」
 * （`executor.service.spec.ts:6376`）⇒ 必须走共享 util 的
 * `repo.manager.createQueryBuilder()` 路径。这条是**索引型断言**的依赖，
 * 不可改。
 */

/** 协作者依赖（全部最小面）。 */
export interface ExecutorHeartbeatRestartDeps {
  /**
   * 数据源/事务管理器（**必须是 `repo.manager`**，不是 `repo` 本身）——
   * 槽位冲销走共享 util 的 `manager.createQueryBuilder()` 路径（见类头注）。
   */
  manager: EntityManager;
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
}

export class ExecutorHeartbeatRestart {
  private readonly manager: EntityManager;
  private readonly logger: Logger;

  constructor(deps: ExecutorHeartbeatRestartDeps) {
    this.manager = deps.manager;
    this.logger = deps.logger;
  }

  /**
   * 时间串 → Date（非法/空 → null）。
   *
   * **私有**实现：`parseExecutorStartedAt` 与 `resolveRestartBaseline` 共用它
   * ⇒ 两者的公共面之间不产生 self-call（Facade 转发层是 spy 拦截面）。
   */
  private parseDate(value?: string | Date | null): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /**
   * 解析执行器上报的 `restartedAt`（时间串 → Date；非法 → null）。
   */
  parseExecutorStartedAt(value?: string | Date | null): Date | null {
    return this.parseDate(value);
  }

  /**
   * 「这次心跳/注册是不是一次**重启**」的判定。
   *
   * 两个判据（任一命中即算重启）：
   *   · `startupId` 变了（进程生命换了）；
   *   · 上报的 `restartedAt` 晚于 DB 侧的 `executorStartedAt`。
   */
  hasExecutorRestarted(
    executor: Executor,
    incomingStartedAt: Date | null,
    incomingStartupId: string | null,
  ): boolean {
    if (
      incomingStartupId &&
      executor.executorStartupId &&
      incomingStartupId !== executor.executorStartupId
    ) {
      return true;
    }
    if (
      incomingStartedAt &&
      executor.executorStartedAt &&
      incomingStartedAt.getTime() > executor.executorStartedAt.getTime()
    ) {
      return true;
    }
    return false;
  }

  /**
   * NETOPT-F P2-F1: 重启恢复的时间基线。startupId-only 重启（换了 startupId 但
   * 未上报 restartedAt）时 incomingStartedAt 为 null，而 shouldFailAfterRestart
   * 对 null 基线放行**全部** RUNNING 行——异步恢复会误杀恢复窗口内闸门新派发
   * 的行（startTime >= 重启时刻）。不得静默退化。
   * 早期实现退回 DB 侧旧基线 executorStartedAt（T0）作 onlyStartedBefore，但该
   * 基线实际"零恢复"：T0 那轮已终态化 startTime<T0 的行，当前存活 RUNNING 行
   * startTime 必然 >= T0，严格 < 过滤下一条都不终态化，旧进程死掉的行只能靠
   * stale sweep 回收（不丢任务——计数已清零、闸门不超派——但恢复路径空转）。
   * 修法：基线改取**服务端本次心跳处理时刻 now**——startTime<now 的旧行被
   * 终态化、恢复后新派发（startTime>now）存活；DB 旧基线仅作 warn 展示
   * （日志可审计），不参与判定。
   */
  resolveRestartBaseline(
    address: string,
    incomingStartedAt: Date | null,
    incomingStartupId: string | null,
    dbBaseline: Date | string | null | undefined,
  ): Date {
    if (incomingStartedAt) return incomingStartedAt;
    const db = this.parseDate(dbBaseline);
    const now = new Date();
    this.logger.warn(
      `Executor ${address} restarted with a new startupId=${incomingStartupId} ` +
        `but no restartedAt; using server-side now=${now.toISOString()} as the ` +
        `recovery baseline (startupId-only restart, time baseline degraded; ` +
        `DB executorStartedAt=${
          db ? db.toISOString() : "(null)"
        } was stale). Rows started after this baseline are NOT failed.`,
    );
    return now;
  }

  /**
   * 某一行 RUNNING 是否该被「重启恢复」终态化。
   *
   * 判定：`startTime < onlyStartedBefore`（严格早于重启基线）。
   * 无基线（null）⇒ 全部终态化（存量语义）；无 `startTime` ⇒ 终态化。
   */
  shouldFailAfterRestart(
    execution: TaskExecution,
    onlyStartedBefore?: Date | null,
  ): boolean {
    if (!onlyStartedBefore) return true;
    if (!execution.startTime) return true;
    return execution.startTime.getTime() < onlyStartedBefore.getTime();
  }

  /**
   * ADR-017 阶段 3：`address` 不再是唯一键——同地址多行并存（pull 模式，
   * ADR-017 §5）时 `WHERE address = :address` 会命中多行，一次冲销把**别人的**
   * `runningTaskCount` 也减 1。委托给共享 util（单一事实源，与调度器/触发路径
   * 同规则）：地址命中多行时**保守跳过**而非盲减（失败方向选保守侧——少减一次
   * 只是该执行器被保守少派，多减一次会让别人的计数虚低而被超发打爆）。
   * 单行命中时行为与引入前逐字节一致。
   */
  async releaseExecutorSlot(address?: string | null): Promise<void> {
    await releaseExecutorSlotByAddress(this.manager, address);
  }
}
