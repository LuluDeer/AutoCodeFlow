import { EntityManager, Repository } from "typeorm";
import {
  ExecutionStatus,
  TaskExecution,
} from "./entities/task-execution.entity";
// 第二轮审计（A4 · 指标漏报）：执行结果计数下沉到本统一终态入口。
// runtime-metrics-entry 是模块级进程内计数表（运行时值导入，无模块环——
// 与 agent 模块经 recordRuntime 埋点的既有先例同款）。
import { recordRuntime } from "../metrics/runtime-metrics-entry";

/**
 * A1（DEEP_REVIEW 0ef3bbe §七）：执行状态机收口——终态跃迁的单一入口。
 *
 * 背景（评审 §七 A1）：`status IN (pending,running)` 的条件 UPDATE + RETURNING
 * 语义此前在 6 处各自手写，且**互相不一致**：
 *
 * | 调用点                        | 状态门槛                      | RETURNING | affected>0 而 raw 空时 |
 * |-------------------------------|-------------------------------|-----------|-------------------------|
 * | executor.service 丢失执行扫描 | `status = RUNNING`            | **无**    | n/a（用快照地址）       |
 * | scheduler 批量恢复            | `status IN (open)`            | 有        | **无兜底 → 漏释放**     |
 * | scheduler PENDING 超时        | `status = PENDING`            | 有(id)    | n/a                     |
 * | scheduler COVER_EARLY         | `status IN (open)`            | 有        | **有兜底（快照）**      |
 * | task.service 回调落库         | `status IN (…)` **硬编码数组** | 有        | 走「重复回调」分支       |
 * | task.service kill             | `status IN (…)` **硬编码数组** | 有        | 抛「已终态」            |
 *
 * 三类后果：① 常量漂移——`OPEN_EXECUTION_STATUSES` 早就存在，task.service 两处
 * 却各写一份字面量，将来加状态必漏改（PK-01 同型）；② 驱动差异下 RETURNING 可能
 * 不返回行（`affected>0` 但 `raw` 为空），只有 COVER_EARLY 一处有兜底，批量恢复
 * 那条会静默漏释放执行器槽位；③ 丢失执行扫描没有 RETURNING，用的是请求前快照的
 * executorAddress——而该地址在 dispatch HTTP 返回后才落库，秒级完成的执行其快照
 * 仍为 null，用它释放会 no-op 使 runningTaskCount **永久虚高**（task.service 回调
 * 路径的注释已自证这个坑，但扫描路径仍在踩）。
 *
 * 形态选择：这里用**纯函数**而不是 Nest service（评审原稿写作
 * `ExecutionTerminalService.transitionToTerminal`）。理由：它无状态、只依赖传入的
 * Repository/EntityManager，做成 service 会让 executor 模块为了一个工具函数去
 * import task 模块，凭空引入循环依赖面（ARCH-24 已因 DI 环挂死过一次）。
 */

/** 打开态：允许推进到终态的起始状态集合（终态保护门的单一事实源）。
 *
 * MUTEX-01：WAITING（互斥排队态）属于打开态——人工 kill/取消与 COVER_EARLY
 * （新触发覆盖旧执行）必须能终结一条还在排队的执行；它不是终态，也绝不能被
 * 任何终态写路径挡在门外。 */
export const OPEN_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  ExecutionStatus.PENDING,
  ExecutionStatus.RUNNING,
  ExecutionStatus.WAITING,
];

/** 终态集合：已收敛、不可再被任何写路径改写的状态。 */
export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  ExecutionStatus.SUCCESS,
  ExecutionStatus.FAILED,
  ExecutionStatus.TIMEOUT,
  ExecutionStatus.KILLED,
  ExecutionStatus.CANCELLED,
];

/** True when the status is one of the terminal states. */
export function isTerminalStatus(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.includes(status);
}

export interface TerminalTransitionRow {
  id: string;
  /** 库中实际的 executorAddress（RETURNING 取回，覆盖 dispatch 落库窗口）。 */
  executorAddress: string | null;
}

/**
 * S3-C5（P0 · 数据丢失档）：**「不得覆盖更新工作」判据**（可选门禁）。
 *
 * ## 它挡的是哪一次覆盖
 *
 * `recoverStaleExecutions` 把「看起来卡住」的 RUNNING 执行判死，并在此基础上
 * 兑现重试预算（`scheduleRetryAfterRecovery` → 新 PENDING 执行 + kill 原进程）。
 * 若那条执行其实已经被重试/新触发产生了**更新的 run**（`createdAt >= 本行`），
 * 这次收尾会用旧快照（旧参数/旧包/旧 retryCount）再跑一遍同一批副作用，把新
 * run 已经落下的成果覆盖掉。被调研项目 paperclip 的
 * `preserved-result-finalization.ts:5-25` 用五重护栏挡住同一件事（leaseOwner 为空、
 * issue 未被别的 run 占用、不存在 `createdAt >= run.createdAt` 的更新 run、
 * 结果已 accepted、该 generation 未被处理过）。本仓的对应形态：
 *
 * | paperclip 护栏 | 本仓判据（SQL 位置） |
 * |---|---|
 * | `coordinator.leaseOwner` 必须为空 | **G-LEASE**：`execution_finalizations` 里不存在「别的持有者 + 未过期」的租约（WHERE 子查询） |
 * | `phase === "terminal_failure"` / 终态已落 | **G-TERMINAL**：`"status" IN (:...gate)`（原有 winner 门，未改） |
 * | `issue.executionRunId/checkoutRunId` 为空 | **G-OCCUPIED**：同任务不存在另一条打开态执行（WHERE 子查询） |
 * | 不存在 `createdAt >= run.createdAt` 的更新 run | **G-NEWER**：同任务不存在 `createdAt >= 本行` 的另一条执行（WHERE 子查询） |
 * | `recoveryHistory` 无该 generationId | **G-ONCE**：`attempt` 自增 + `recoveryHistory` 追加由 DB 在同一事务内完成（见 scheduler 的 upsert），winner 语义即「恰好一次」 |
 *
 * ## 为什么判据必须在 WHERE 里（而不是先 SELECT 再 UPDATE）
 *
 * 「是否存在更新的执行」这件事**只能由 DB 在写的那一瞬间原子求值**：先读后写之间
 * 有一个窗口，另一个触发/重试恰好在这个窗口里 `INSERT` 出新执行，读到的「无更新
 * run」在写入时已经过期——这正是本缺陷要消灭的竞态。放进同一条 `UPDATE ... WHERE`
 * 后，谓词与状态写在同一个快照上求值，多副本下也成立（不依赖任何进程内状态）。
 *
 * ## 只可能「让不该写的写入变成 no-op」
 *
 * 本判据只往 WHERE 上追加合取项，**收窄**命中集：它绝不可能让两个写入者都成功，
 * 也不可能改变 winner 语义（`status IN (:...gate)` 与 RETURNING 判定原样不动）。
 * 被拒绝的行不会出现在 `rows` 里，调用方据此不会释放执行器槽位、不会兑现重试。
 */
export interface FinalizationGuardInput {
  /**
   * 本次收尾的持有者（`<hostname>:<pid>`）。只用于 G-LEASE 的「租约归我」豁免
   * ——自己上一次收尾留下的租约不该挡住自己。
   */
  leaseOwner: string;
  /**
   * 是否启用「不得覆盖更新工作」判据（对应 env 开关 `STALE_FINALIZATION_GUARD_ENABLED`，
   * 默认开）。false = 只留 G-LEASE/G-TERMINAL，回到引入前的收尾行为
   * （规格给的回退形态：收尾记录只做记录、不做门禁）。
   */
  guardNewerWork: boolean;
}

export interface TerminalTransitionInput {
  /** 待推进到终态的执行 id（批量）。空数组直接短路，不发 SQL。 */
  ids: string[];
  /** 要写入的终态字段，必须含 `status` 且该 status 必须是终态。 */
  patch: Record<string, unknown> & { status: ExecutionStatus };
  /**
   * S3-C5：可选的「不得覆盖更新工作」门禁（见 FinalizationGuardInput）。
   * 不传 = 行为与引入前逐字节一致（kill / 回调 / 其他恢复路径不受影响）。
   */
  finalizationGuard?: FinalizationGuardInput;
  /**
   * 允许的起始状态集合。默认 `OPEN_EXECUTION_STATUSES`。
   * 仅当某路径确实只允许从单一状态跃迁时才显式传入（如 PENDING 超时回收）。
   */
  from?: readonly ExecutionStatus[];
  /**
   * id → executorAddress 的请求前快照。**槽位释放类调用方必须传**：
   * 部分驱动在 UPDATE 命中时也不返回 RETURNING 行，此时用它兜底，避免漏释放。
   */
  addressSnapshot?:
    ReadonlyMap<string, string | null> | Record<string, string | null>;
  /** 事务内复用：传入事务的 EntityManager 而非 Repository。 */
  manager?: EntityManager;
}

export interface TerminalTransitionResult {
  /**
   * 真正发生「打开态 → 终态」跃迁的行（唯一 winner 语义）。
   * 并发路径中已被别人终态化的行**不会**出现在这里，因此调用方可以据此
   * 安全地对每行恰好释放一次槽位。
   */
  rows: TerminalTransitionRow[];
  /** 底层 UPDATE 报告的命中行数。 */
  affected: number;
  /** 是否至少有一行发生了跃迁。 */
  transitioned: boolean;
}

function readSnapshot(
  snapshot: TerminalTransitionInput["addressSnapshot"],
  id: string,
): string | null {
  if (!snapshot) return null;
  if (snapshot instanceof Map) return snapshot.get(id) ?? null;
  const v = (snapshot as Record<string, string | null>)[id];
  return v ?? null;
}

/** 归一化不同驱动下 `result.raw` 的形状（数组 / 单对象 / 空）。 */
function normalizeRaw(raw: unknown): TerminalTransitionRow[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: TerminalTransitionRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== "string" && typeof id !== "number") continue;
    const addr = row.executorAddress;
    out.push({
      id: String(id),
      executorAddress: typeof addr === "string" ? addr : null,
    });
  }
  return out;
}

/**
 * 把一批执行**原子地**推进到终态——条件是这些行当前仍处于 `from` 集合内。
 *
 * 所有调用方都必须改走这里，以同时获得三件事：① 统一的终态保护门（常量不再
 * 各自抄写）；② 统一的 RETURNING winner 判定；③ 统一的「驱动未返回行」兜底。
 */
export async function transitionToTerminal(
  repo: Repository<TaskExecution> | EntityManager,
  input: TerminalTransitionInput,
): Promise<TerminalTransitionResult> {
  const { ids, patch, from, addressSnapshot, manager, finalizationGuard } =
    input;

  if (!ids || ids.length === 0) {
    return { rows: [], affected: 0, transitioned: false };
  }
  if (!isTerminalStatus(patch.status)) {
    // 防御：非终态混进来说明调用方语义错了（终态门只对终态有意义）。
    // 早抛而不是悄悄放行，避免「条件 UPDATE 用错门槛」变成静默丢更新。
    throw new Error(
      `transitionToTerminal：patch.status 必须是终态，实际为 "${patch.status}"`,
    );
  }

  const gate = (
    from && from.length > 0 ? from : OPEN_EXECUTION_STATUSES
  ).slice();
  const qb = (manager ?? repo).createQueryBuilder();

  // 终态门（`status IN (:...gate)`）是 winner 语义的单一事实源，**本改动不碰它**；
  // S3-C5 只在它外围追加**只可能收窄命中集**的 WHERE 谓词（绝不会让第二个写入者
  // 也成功，也不会改变 RETURNING = winner 的判定）。
  let whereSql = '"id" IN (:...ids) AND "status" IN (:...gate)';
  const params: Record<string, unknown> = { ids, gate };

  if (finalizationGuard) {
    // G-LEASE（paperclip「leaseOwner 必须为空」）：不存在**别的持有者**留下的
    // **未过期**租约。租约已过期（上次收尾者崩在半路）或租约本来就是自己的 →
    // 放行——否则一条遗留租约会把这行永久锁死（比漏收尾更糟）。
    whereSql +=
      ` AND NOT EXISTS (SELECT 1 FROM "execution_finalizations" AS "live_lease"` +
      ` WHERE "live_lease"."executionId" = "task_executions"."id"` +
      ` AND "live_lease"."leaseOwner" IS NOT NULL` +
      ` AND "live_lease"."leaseExpiresAt" IS NOT NULL` +
      ` AND "live_lease"."leaseExpiresAt" > :finalizationNow` +
      ` AND "live_lease"."leaseOwner" <> :finalizationLeaseOwner)`;
    params.finalizationNow = new Date();
    params.finalizationLeaseOwner = finalizationGuard.leaseOwner;

    if (finalizationGuard.guardNewerWork) {
      // G-NEWER（paperclip「不存在 createdAt >= run.createdAt 的更新 run」）：
      // 同任务下存在**更新的执行**（含同时刻，取保守方向）即拒绝收尾。这条挡的
      // 就是缺陷本体——旧 run 崩溃 + 新 run 已创建时，不得再用旧快照重跑一遍。
      whereSql +=
        ` AND NOT EXISTS (SELECT 1 FROM "task_executions" AS "newer_run"` +
        ` WHERE "newer_run"."taskId" = "task_executions"."taskId"` +
        ` AND "newer_run"."id" <> "task_executions"."id"` +
        ` AND "newer_run"."createdAt" >= "task_executions"."createdAt")`;
      // G-OCCUPIED（paperclip「issue 未被任何 run 占用」的等价物）：同任务下还有
      // 另一条**打开态**执行（pending/running/waiting）即拒绝——它是活着的在途
      // 工作，本次收尾若兑现重试就会与它双跑。与 G-NEWER 刻意分开：G-NEWER 看
      // 时间线（涵盖已终态的更新成果），G-OCCUPIED 看占用（时间戳打平/更早也挡）。
      whereSql +=
        ` AND NOT EXISTS (SELECT 1 FROM "task_executions" AS "open_run"` +
        ` WHERE "open_run"."taskId" = "task_executions"."taskId"` +
        ` AND "open_run"."id" <> "task_executions"."id"` +
        ` AND "open_run"."status" IN (:...openStatuses))`;
      params.openStatuses = [...OPEN_EXECUTION_STATUSES];
    }
  }

  const result = await qb
    .update(TaskExecution)
    .set(patch as Record<string, unknown>)
    .where(whereSql, params)
    .returning(["id", "executorAddress"])
    .execute();

  const affected = result.affected ?? 0;
  let rows = normalizeRaw(result.raw);

  // 统一兜底：驱动报告了命中却没有 RETURNING 行（PG 之外的驱动/部分版本会
  // 这样），此时无法从结果里读出 winner 是谁，只能退回快照地址。
  //
  // **只在「命中数 == id 数」时兜底**：该等式成立说明这批 id 全部通过了门槛
  // （否则 affected 必然更小），命名是无歧义的。反之 `affected < ids.length`
  // 表示批次里有一部分行已被并发路径终态化，而我们无从得知是哪几条——此时
  // 编造 rows 会把没跃迁的行也算成 winner，导致**超量释放执行器槽位**（比
  // 漏释放更糟：runningTaskCount 被打成负数 → 反复超发任务压垮执行器）。
  // 因此这种情况宁可少释放（与改造前行为一致，不引入新风险），只把 affected
  // 交回调用方用于计数/观测。
  if (rows.length === 0 && affected > 0 && affected === ids.length) {
    rows = ids.map((id) => ({
      id,
      executorAddress: readSnapshot(addressSnapshot, id),
    }));
  }

  // 第二轮审计（A4 · 指标漏报）：autoflow_execution_result_total 原先只在
  // 回调 winner 路径（task.service.handleCallback）记录，手动终止（kill）、
  // 执行器重启恢复、丢失执行/watchdog 扫描、入队失败补偿、COVER_EARLY 取消
  // 等服务端终态全部漏计——结果分布指标系统性偏向「能自己跑完的执行」。
  // 现下沉到本统一终态入口：按 patch.status 分类，且只对**真正发生跃迁的
  // winner 行**计数（rows 即唯一 winner 语义；「命中但驱动未返回行」时造出
  // 的兜底 rows 已由 affected === ids.length 证明全批通过门槛，同为 winner）。
  // 非终态写路径（如 worker 的 RUNNING 持久化条件 UPDATE）不经本入口，天然
  // 不会误计；回调路径的旧记录点已删除，重复回调（affected=0）也到不了这里
  // ——恰好一次计数由 winner 语义保证。
  for (let i = 0; i < rows.length; i++) {
    recordRuntime("autoflow_execution_result_total", { status: patch.status });
  }

  return { rows, affected, transitioned: rows.length > 0 };
}

/** 单执行版本的便捷入口（语义与批量版完全一致）。 */
export async function transitionOneToTerminal(
  repo: Repository<TaskExecution> | EntityManager,
  input: Omit<TerminalTransitionInput, "ids"> & { id: string },
): Promise<TerminalTransitionResult> {
  const { id, ...rest } = input;
  return transitionToTerminal(repo, { ...rest, ids: [id] });
}
