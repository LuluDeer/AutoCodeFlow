/**
 * R16（2026-11-05）：心跳的 `runningTaskCount` 采纳规则（纯判定，无 IO）。
 *
 * ## 缺陷（真机两连接复现 20/20 轮）
 *
 * 心跳是**客户端快照覆盖写**（`executor-heartbeat-report.collaborator.ts:192-210` 只做范围校验），
 * 派发是**原子 `+1` 带容量谓词**（`executor-dispatch-slot.collaborator.ts:105-118`）。
 * 心跳从 `findOne` 到 `repo.update` 之间隔着若干 await；窗口内落地的派发占坑会被覆盖写抹掉
 * ⇒ 计数被改小 ⇒ `runningTaskCount < max` 放行超额 ⇒ **超卖**。
 *
 * ## 规则
 *
 * `采用值 = max(客户端上报值, 服务端在途占坑数)`，其中在途 = 该执行器名下**非终态**执行行
 * （`pending` / `running` / `waiting`，见 `task/execution-terminal.ts:45-49` 的 OPEN 集合）。
 *
 * · **取大**而不是丢弃客户端值：客户端值是执行器对自身占用的唯一自述（它还跑着中心端不知道的
 *   子进程/本地任务），服务端执行行只覆盖"中心端派出去的那些"。
 * · **取大**仍能降计数：执行终态化后服务端在途数随之下降 ⇒ 下一轮心跳可把计数拉回真实值，
 *   不会出现"计数只增不降"的饥饿态（I2）。
 */
export function resolveHeartbeatRunningTaskCount(input: {
  reported: number;
  serverInFlight: number;
}): { value: number; clamped: boolean } {
  const reported = Number.isFinite(input.reported) ? input.reported : 0;
  const inFlight = Number.isFinite(input.serverInFlight) ? input.serverInFlight : 0;
  if (inFlight > reported) return { value: inFlight, clamped: true };
  return { value: reported, clamped: false };
}

/**
 * R109（ADR-037）：**非终态（OPEN）执行状态集合** —— 计数下限的判定面。
 *
 * 与 `task/execution-terminal.ts` 的 OPEN 集合同义（pending / running / waiting）。
 * 写在这里而不是 import 那边：本模块必须**保持零 import**（见文件头），
 * 因为仓外的真机判据（`scripts/heartbeat-dispatch-race-selftest.mjs`）会用
 * `--experimental-strip-types` **直接 import 本文件**，任何相对导入都可能解析失败。
 * 一致性由单测钉住（与 execution-terminal 的 OPEN 集合逐字相同）。
 */
export const RUNNING_TASK_COUNT_OPEN_STATUSES = [
  "pending",
  "running",
  "waiting",
] as const;

/** `buildRunningTaskCountFloorExpr` 的入参。 */
export interface RunningTaskCountFloorExprInput {
  /**
   * 「客户端上报值」这一侧。
   *
   * · `number` ⇒ 按字面量内联（生产路径：上报值已过整数范围校验）
   * · `string` ⇒ **原样当作 SQL 片段**注入（仓外判据用 `":snap"` 这类 psql 变量，
   *   或某列名）。⚠️ 必须是**可信片段**（调用方自己构造），不得来自用户输入。
   */
  reported: number | string;
  /** 外层行的相关引用（默认 `executors.id`；仓外判据可传 `'<executorId>'` 字面量）。 */
  outerRef?: string;
  /** 执行行表名（默认 `task_executions`）。 */
  executionsTable?: string;
  /** OPEN 状态集合（默认 `RUNNING_TASK_COUNT_OPEN_STATUSES`）。 */
  statuses?: readonly string[];
}

/**
 * R109（ADR-037）：**计数下限表达式的唯一事实源**（零依赖、纯字符串构造）。
 *
 * 返回一段可用于 `SET "runningTaskCount" = <这里>` 的 SQL 表达式：
 *
 * ```text
 * GREATEST(<reported>, (SELECT count(*) FROM <executionsTable> t
 *            WHERE t."executorId" = <outerRef> AND t.status IN ('pending','running','waiting')))
 * ```
 *
 * ## 为什么必须是**共享产物**（而不是产品里写一份、判据里写一份）
 *
 * 真机判据要能证明「产品确实用原子下限写库」。若判据自己另写一份 SQL（哪怕逐字相同），
 * 它证明的只是「那份 SQL 正确」，**产品改了它不会变红**——那不是 oracle，是同义反复
 * （R108 的实测教训：产品修复后判据仍 exit 1，因为判据的**写入**用的是自己的 SQL）。
 * ⇒ 抽取本函数：产品与判据**物理同源**，改这里两边同时变。
 *
 * ## 语义（两条不变量，缺一不可）
 *
 * · **不改小**：下限取**本次写入时刻**的非终态行数（实时子查询）⇒ 并发占坑对应的
 *   执行行总是先于占坑已存在并已提交（ADR-037 §1.2）⇒ 覆盖写不可能低于真实占用。
 * · **不饥饿**：子查询每次求值 ⇒ 执行终态化后行数下降 ⇒ 计数可被拉回真实值。
 *   反例是「读占坑数（= `runningTaskCount` 现值）」这种**自引用**下限：心跳将永远
 *   无法降计数，重启后计数陈旧即永久饥饿（ADR-037 §4.1）。
 */
export function buildRunningTaskCountFloorExpr(
  input: RunningTaskCountFloorExprInput,
): string {
  const reported =
    typeof input.reported === "number" ? String(Math.trunc(input.reported)) : input.reported;
  const outerRef = input.outerRef ?? "executors.id";
  const table = input.executionsTable ?? "task_executions";
  const statuses = input.statuses ?? RUNNING_TASK_COUNT_OPEN_STATUSES;
  const statusList = statuses.map((s) => `'${s}'`).join(",");
  return (
    `GREATEST(${reported}, (SELECT count(*) FROM ${table} t ` +
    `WHERE t."executorId" = ${outerRef} AND t.status IN (${statusList})))`
  );
}
