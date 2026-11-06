import { Logger } from "@nestjs/common";
import type { EntityManager, Repository } from "typeorm";
import { Executor, ExecutorStatus } from "./entities/executor.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";

/**
 * T1-B3b：**占坑与补偿**协作者（派发槽位面的唯一 owner）。
 *
 * ## ⚠️ 为什么「占坑」与「补偿」必须在**同一个 owner**
 *
 * 派发路径的槽位纪律是「**占坑用单条条件 UPDATE 原子、失败再补偿**」：
 *   · 占坑：`claimExecutorSlotForExecution` —— 单条 UPDATE 内复查容量与在线状态；
 *   · 补偿：`compensateClaimedSlot` —— 派发失败（HTTP 报错 / pull 入队失败）时
 *     把 `runningTaskCount` 减 1 **并**清掉挂组执行在占坑事务里落的占用标记。
 *
 * 这两半若分属两个 owner，会出现两种**静默错误**：
 *   ① 「占坑了但补偿没回滚」⇒ 执行器计数虚高 ⇒ 派发闸门**欠派**（机队看着满、
 *     实际空转）；
 *   ② 「补偿了但占坑还在」⇒ 计数虚低 ⇒ **超派**（超出执行器真实容量）。
 *
 * ⇒ 本类把两者放在**同一实例**上，并让 Facade 的补偿调用点**只经本类**。
 * 变异测试（见 `__tests__/executor-dispatch-slot.collaborator.spec.ts` 的
 * 「同 owner 不变量」段）会拆掉这一点并断言用例转红。
 *
 * ## 事务不得跨协作者拆
 *
 * `claimExecutorSlotForExecution` 的挂组路径开事务，内含 4 条 `manager.query`
 * 与**固定锁序（组 → 执行器）防死锁**。整段留在本类的一个方法里，
 * 锁序注释原样保留（改顺序 = 引入死锁，不是「清理代码」）。
 *
 * ## 补偿写**不在事务内**
 *
 * 补偿是**失败路径**的尽力回滚：单条条件 UPDATE，条件带地址防误清
 * （重试路径已换候选时不动新标记）。它不进事务——失败发生在事务**之外**
 * （HTTP 请求阶段），此时没有可加入的事务；靠「条件 UPDATE 原子」保证
 * 幂等与不误伤。
 */

/** 互斥组仓库的最小面（只用到 `findOne`）。 */
export interface DispatchMutexGroupReader {
  findOne(options: { where: { id: string } }): Promise<{
    id: string;
    name: string;
    maxConcurrentPerDevice: number;
    scope?: string;
  } | null>;
}

/** 事务管理器（`repo.manager`）。 */
export interface DispatchSlotDataSource {
  transaction<T>(
    runInTransaction: (manager: EntityManager) => Promise<T>,
  ): Promise<T>;
}

/** 协作者依赖（全部最小面）。 */
export interface ExecutorDispatchSlotDeps {
  /** 执行器仓库（占坑的单条 UPDATE + 补偿的减槽 UPDATE）。 */
  repo: Repository<Executor>;
  /** 执行行仓库（补偿时清互斥占用标记）。 */
  execRepo: Repository<TaskExecution>;
  /** 互斥组仓库（可缺席 ⇒ 降级为无组语义）。 */
  mutexGroupRepo: DispatchMutexGroupReader | null;
  /** 数据源（`repo.manager` 的宿主；事务入口）。 */
  dataSource: DispatchSlotDataSource;
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
}

/** 占坑结果三态。 */
export type DispatchSlotClaimOutcome = "claimed" | "unavailable" | "mutex_full";

export class ExecutorDispatchSlot {
  private readonly repo: Repository<Executor>;
  private readonly execRepo: Repository<TaskExecution>;
  private readonly mutexGroupRepo: DispatchMutexGroupReader | null;
  private readonly dataSource: DispatchSlotDataSource;
  private readonly logger: Logger;

  constructor(deps: ExecutorDispatchSlotDeps) {
    this.repo = deps.repo;
    this.execRepo = deps.execRepo;
    this.mutexGroupRepo = deps.mutexGroupRepo;
    this.dataSource = deps.dataSource;
    this.logger = deps.logger;
  }

  /**
   * 为一次派发**占坑**（槽位 + 互斥占用标记）。
   *
   * 三个结果：
   *   · `claimed` —— 占坑成功；
   *   · `unavailable` —— 该候选已离线或已满（换下一个候选）；
   *   · `mutex_full` —— 该候选所在的互斥组占用已满（排队等待，不烧重试预算）。
   *
   * 无组执行走原有单条 UPDATE（默认人群零行为变化、零事务开销）；
   * 挂组执行在事务内加「同设备×同组占用 < 组内并发数」闸。
   */
  async claimExecutorSlotForExecution(
    candidate: Executor,
    execution: TaskExecution,
  ): Promise<DispatchSlotClaimOutcome> {
    const legacyClaim = async (): Promise<"claimed" | "unavailable"> => {
      const maxConcurrent = candidate.maxConcurrentTasks ?? Infinity;
      // 原子占坑：容量与在线状态在同一条 UPDATE 内复查（无需版本谓词）
      const result = await this.repo
        .createQueryBuilder()
        .update(Executor)
        .set({ runningTaskCount: () => '"runningTaskCount" + 1' })
        .where("id = :id", { id: candidate.id })
        .andWhere("status = :status", { status: ExecutorStatus.ONLINE })
        .andWhere(
          // R124（ADR-038 步骤 3）：容量 = 单播占坑 + 广播占坑 ⇒ 谓词读两列之和。
          // 广播占坑在独立列（`broadcastReservedCount`），因为广播只有一行执行记录、
          // 对 ADR-037 的行数下限不可见（ADR-038 §1.2）。
          maxConcurrent === Infinity
            ? "1=1"
            : '(runningTaskCount + COALESCE("broadcastReservedCount", 0)) < :max',
          maxConcurrent === Infinity ? {} : { max: maxConcurrent },
        )
        .execute();
      return result.affected && result.affected > 0 ? "claimed" : "unavailable";
    };

    if (!execution.mutexGroupId) return legacyClaim();

    if (!this.mutexGroupRepo) {
      // 单测/极简装配未提供仓库：互斥约束无法求值，降级为不参与互斥（与
      // 组被删同向——宁可不约束，不可派不出去）。
      this.logger.warn(
        `MUTEX-01: MutexGroup 仓库未装配，执行 ${execution.id} 本次派发不参与互斥`,
      );
      return legacyClaim();
    }

    const group = await this.mutexGroupRepo.findOne({
      where: { id: execution.mutexGroupId },
    });
    if (!group) {
      this.logger.warn(
        `MUTEX-01: 执行 ${execution.id} 的互斥组 ${execution.mutexGroupId} 已不存在，` +
          `本次派发不参与互斥（组删除后快照执行按无组语义走完）`,
      );
      return legacyClaim();
    }

    // N-15：组作用域——device=单点互斥（同设备×同组，存量行为）；
    // global=全局互斥（组内跨设备串行，单点登录顶号类场景）。
    const isGlobal = group.scope === "global";

    return this.dataSource.transaction(async (manager) => {
      // 0) 全局档：组行锁先于执行器行锁（固定锁序 组→执行器 防死锁）。
      //    跨设备派发的竞争者在组行锁上串行化——设备档靠同设备 executors 行
      //    锁关闭竞态，全局档的竞争者派往不同设备、行锁互不相干，必须用组行
      //    锁串行化，占用计数读到的才必含先到者已提交的标记。
      if (isGlobal) {
        await manager.query(
          `SELECT "id" FROM "mutex_groups" WHERE "id" = $1 FOR UPDATE`,
          [execution.mutexGroupId],
        );
      }

      // 1) 行锁串行化：同设备的并发派发在此排队，锁内读到的占用状态必含
      //    先到者已提交的标记（竞态关闭的关键，见方法头注）。
      const lockRows: Array<{
        address: string;
        status: string;
        runningTaskCount: number;
        broadcastReservedCount: number | null;
        maxConcurrentTasks: number | null;
      }> = await manager.query(
        `SELECT "address", "status"::text AS "status", "runningTaskCount",
                "broadcastReservedCount", "maxConcurrentTasks"
         FROM "executors" WHERE "id" = $1 FOR UPDATE`,
        [candidate.id],
      );
      const row = lockRows[0];
      if (!row || row.status !== ExecutorStatus.ONLINE) return "unavailable";
      const maxConcurrent = row.maxConcurrentTasks ?? Infinity;
      // R124（ADR-038 步骤 3）：锁内比较同样读**两列之和**（与默认路径同口径）。
      const occupied =
        row.runningTaskCount + (row.broadcastReservedCount ?? 0);
      if (occupied >= maxConcurrent) return "unavailable";

      // 2) 组占用闸：device 档=同设备 × 同组（部分索引
      //    idx_task_executions_group_occupancy 服务）；global 档=同组跨设备
      //    （组维度部分索引 idx_task_executions_group_occupancy_global 服务）。
      //    global 档 maxConcurrentPerDevice 语义升级为组内全平台并发数。
      //    global 档必须排除执行自身行：本执行在 dispatch 前已被 claim 为
      //    RUNNING（executorAddress 未落），不带设备条件的计数会把自己数进
      //    去 → maxConcurrentPerDevice=1 时自己等自己（2026-10-02 双执行器
      //    e2e 实证；设备档靠地址谓词天然自排除）。
      const occRows: Array<{ count: number }> = isGlobal
        ? await manager.query(
            `SELECT COUNT(*)::int AS count FROM "task_executions"
             WHERE "mutexGroupId" = $1 AND "status" = 'running' AND "id" <> $2`,
            [execution.mutexGroupId, execution.id],
          )
        : await manager.query(
            `SELECT COUNT(*)::int AS count FROM "task_executions"
             WHERE "executorAddress" = $1 AND "mutexGroupId" = $2 AND "status" = 'running'`,
            [row.address, execution.mutexGroupId],
          );
      if ((occRows[0]?.count ?? 0) >= group.maxConcurrentPerDevice) {
        return "mutex_full";
      }

      // 3) 占用标记 + 槽位增量同事务落库：与容量增量原子共生，回滚同生共死。
      //    条件 status='running' 与 processor 的 claim 一致（本执行在 dispatch
      //    前必已被 claim 为 RUNNING；条件兜底防异常装配下的幽灵标记）。
      await manager.query(
        `UPDATE "task_executions" SET "executorAddress" = $1
         WHERE "id" = $2 AND "status" = 'running'`,
        [row.address, execution.id],
      );
      await manager.query(
        `UPDATE "executors" SET "runningTaskCount" = "runningTaskCount" + 1 WHERE "id" = $1`,
        [candidate.id],
      );
      this.logger.debug(
        `MUTEX-01: 执行 ${execution.id}（组 ${group.name}${isGlobal ? "，全局互斥" : ""}）占坑 ${row.address} ` +
          `（组占用 ${occRows[0]?.count ?? 0}+1/${group.maxConcurrentPerDevice}${isGlobal ? "，全平台" : "/设备"}）`,
      );
      return "claimed";
    });
  }

  /**
   * 派发失败时的**槽位补偿**（减计数 + 清互斥占用标记）。
   *
   * ⚠️ 与 `claimExecutorSlotForExecution` **同一 owner**（见类头注）：
   * 「占坑了但补偿没回滚」⇒ 计数虚高 ⇒ 欠派；「补偿了但占坑还在」⇒ 超派。
   *
   * 两步都是**单条条件 UPDATE**、不在事务内：
   *   · 减槽：`GREATEST(count - 1, 0)` 防负；
   *   · 清标记：**条件带地址**（`executorAddress = :addr`）防误清——重试路径
   *     已换候选时不动新标记。
   */
  async compensateClaimedSlot(
    execution: TaskExecution,
    executorId: string,
    executorAddress: string,
  ): Promise<void> {
    // Rollback counter on dispatch failure to avoid leaks
    await this.repo
      .createQueryBuilder()
      .update(Executor)
      .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
      .where("id = :id", { id: executorId })
      .execute();
    // MUTEX-01：挂组执行在占坑事务内已把地址落库为占用标记（status 仍为
    // running）。占坑回滚时必须同步清除标记——占用从执行行推导，不清除
    // 则该执行以「running + 地址」继续占着组位，同组后续派发被幽灵占用
    // 挡住（这是「无第二账本」设计的代价：释放也是对执行行的写）。条件
    // 带地址防误清（重试路径已换候选时不动新标记）。
    if (execution.mutexGroupId) {
      await this.execRepo
        .createQueryBuilder()
        .update(TaskExecution)
        .set({ executorAddress: null })
        .where("id = :id", { id: execution.id })
        .andWhere("executorAddress = :addr", { addr: executorAddress })
        .execute();
    }
  }
}
