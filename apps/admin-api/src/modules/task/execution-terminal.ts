import { EntityManager, Repository } from "typeorm";
import {
  ExecutionStatus,
  TaskExecution,
} from "./entities/task-execution.entity";

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

/** 打开态：允许推进到终态的起始状态集合（终态保护门的单一事实源）。 */
export const OPEN_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  ExecutionStatus.PENDING,
  ExecutionStatus.RUNNING,
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

export interface TerminalTransitionInput {
  /** 待推进到终态的执行 id（批量）。空数组直接短路，不发 SQL。 */
  ids: string[];
  /** 要写入的终态字段，必须含 `status` 且该 status 必须是终态。 */
  patch: Record<string, unknown> & { status: ExecutionStatus };
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
  const { ids, patch, from, addressSnapshot, manager } = input;

  if (!ids || ids.length === 0) {
    return { rows: [], affected: 0, transitioned: false };
  }
  if (!isTerminalStatus(patch.status)) {
    // 防御：非终态混进来说明调用方语义错了（终态门只对终态有意义）。
    // 早抛而不是悄悄放行，避免「条件 UPDATE 用错门槛」变成静默丢更新。
    throw new Error(
      `transitionToTerminal: patch.status must be terminal, got "${patch.status}"`,
    );
  }

  const gate = (
    from && from.length > 0 ? from : OPEN_EXECUTION_STATUSES
  ).slice();
  const qb = (manager ?? repo).createQueryBuilder();

  const result = await qb
    .update(TaskExecution)
    .set(patch as Record<string, unknown>)
    .where('"id" IN (:...ids) AND "status" IN (:...gate)', {
      ids,
      gate,
    })
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
