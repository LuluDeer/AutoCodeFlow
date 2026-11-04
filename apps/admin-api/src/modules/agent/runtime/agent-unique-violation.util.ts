/**
 * agent 域的 **PG 23505 按约束名归因**（R9）。
 *
 * ## 为什么 agent 域需要「按约束名」而不是通用的「任何 23505 都算」
 *
 * 通用判据 `common/utils/pg-unique-violation.util.ts` 回答的是
 * 「**这是不是一个唯一冲突**」。agent 域的 4 条路径需要的却是更强的问题：
 * 「**这是不是「我这条路径自己的那个」唯一冲突**」。
 *
 * 把两者混为一谈的后果是**误判方向相反**（R5 实测结论）：
 *
 * | 路径 | 误判成「我的冲突」的后果 |
 * |---|---|
 * | ③ 申请幂等（`agent-approvals.service.ts` `request`） | **返回一个错的既有单** ⇒ **静默的错误归因**（调用方以为命中了幂等，其实是一张无关的单） |
 * | ④ 会话级授权派生（`deriveSessionGrant`） | **给一张本不该续期的授权续期** ⇒ **安全后果更重**（免审窗口被错误延长） |
 * | ①② `appendStep` / `appendEvents` | 白烧最多 2 次重试（**有界**，见下） |
 *
 * ⇒ 前两条是**正确性/安全**问题，不是性能问题 ⇒ 必须按约束名归因。
 *
 * ## 目标约束（实测名字，来自 migration，不是猜的）
 *
 * | 路径 | 表 | 唯一索引名 | 出处 |
 * |---|---|---|---|
 * | ① `appendStep` | `agent_steps` | `idx_agent_steps_sessionId_seq`（`sessionId`, `seq`） | migration `1790000000040` |
 * | ② `appendEvents` | `agent_events` | `uq_agent_events_sessionId_seq`（`sessionId`, `seq`） | migration `1790000000089` |
 * | ③④ 审批 | `agent_approvals` | `UQ_agent_approvals_approvalKey`（`approvalKey`） | migration `1790000000067` |
 *
 * ⚠️ 三者都是 **`CREATE UNIQUE INDEX`**（不是表级 `UNIQUE CONSTRAINT`）。PG 对
 * 「唯一**索引**」冲突同样会在错误响应里给出索引名 ⇒ `constraint` 字段可得
 * （依据：`pg-protocol` 的 `parseErrorMessage` 把响应的 `n` 字段赋给
 * `message.constraint`；TypeORM 的 `QueryFailedError` 用
 * `ObjectUtils.assign(this, driverError)`（`Object.getOwnPropertyNames`）把
 * 这些属性**拷到错误对象顶层**）⇒ 顶层与 `driverError` 两处都读得到。
 *
 * ## ⚠️ 「拿不到约束名」时的处理：**保持现状**（不是保守选择，是刻意的）
 *
 * **实测事实**：本仓现有的 agent 域 spec 全部用
 * `Object.assign(new Error("dup"), { code: "23505" })` 构造冲突错误 ——
 * **没有 `constraint` 字段**。也就是说「拿不到约束名」不是假想形态。
 *
 * 归因结果因此是**四态**（`target` / `other-constraint` / `unknown` / `not-unique`），
 * 各调用点对 `unknown` **维持原行为**：
 *   · 若把 `unknown` 当「不是我的冲突」⇒ 真实的 seq 冲突会被立刻外抛
 *     ⇒ **退回到「会话卡在 running 等 30 分钟清扫」那个已修掉的 bug**。
 *   · 若把 `unknown` 当「是我的冲突」⇒ 与**今日行为完全一致** ⇒ 无回归。
 * ⇒ 取后者，并**如实声明**：`unknown` 这一支**没有变严**（它无从判断）。
 * 真正的收窄发生在 `other-constraint`（约束名**读得到且不是我的**）——
 * 这正是 R5 指出的「别的唯一冲突被静默吞掉」那一类。
 *
 * ## ⚠️ 不读 `cause`，也不放宽 `code` 的读法
 *
 * · `code` **只读顶层**（TypeORM 已把驱动错误属性拷到顶层）。**不**回落到
 *   `driverError.code` —— 那是通用 util 的**更宽松**语义，本域**刻意不采用**
 *   （放宽会扩大上面那两处误判面）。
 * · **不**读 `err.cause`：TypeORM 的 `QueryFailedError` 不链 `cause`，加它属
 *   无从验证的推测（`app-deployment` 那份读 `cause` 是因为它另有调用形态）。
 */

/** agent 域三条路径各自的目标唯一索引名（**实测自 migration**）。 */
export const AGENT_UNIQUE_CONSTRAINTS = {
  /** `appendStep`：`agent_steps(sessionId, seq)`。 */
  stepSeq: "idx_agent_steps_sessionId_seq",
  /** `appendEvents`：`agent_events(sessionId, seq)`。 */
  eventSeq: "uq_agent_events_sessionId_seq",
  /**
   * 审批单 `agent_approvals.approvalKey`。
   *
   * ⚠️ 名字以 **migration 为准**（`UQ_agent_approvals_approvalKey`）。实体上是
   * `@Column({ unique: true })`，若哪天有人跑 `synchronize` 让 TypeORM 自己建，
   * 名字会变成 `UQ_<hash>` ⇒ 归因会落到 `unknown`（**保持现状**，不会误判成别的
   * 冲突）。`check-index-drift` 守卫覆盖的是索引集合而非名字，这条风险**未验证**。
   */
  approvalKey: "UQ_agent_approvals_approvalKey",
} as const;

/** 23505 的归因结果（四态，见文件头注）。 */
export type UniqueViolationAttribution =
  /** 23505，且约束名 = 目标 ⇒ **是**本路径要处理的冲突。 */
  | "target"
  /** 23505，但**读不到**约束名 ⇒ 无从判断 ⇒ 调用点**维持原行为**。 */
  | "unknown"
  /** 23505，但约束名**不是**目标 ⇒ **不得**当成本路径的冲突。 */
  | "other-constraint"
  /** 根本不是 23505 ⇒ 与本判据无关。 */
  | "not-unique";

/**
 * 读出错误的唯一约束名（顶层优先，`driverError` 兜底）。
 *
 * @returns 约束名；不是字符串 / 缺失 ⇒ `null`
 */
export function uniqueConstraintNameOf(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    constraint?: unknown;
    driverError?: { constraint?: unknown } | null;
  };
  const fromTop = e.constraint;
  if (typeof fromTop === "string" && fromTop.length > 0) return fromTop;
  const fromDriver = e.driverError?.constraint;
  if (typeof fromDriver === "string" && fromDriver.length > 0) {
    return fromDriver;
  }
  return null;
}

/**
 * 把错误归因到某个目标唯一索引。
 *
 * @param err 捕获到的任意错误
 * @param target 本路径的目标索引名（用 `AGENT_UNIQUE_CONSTRAINTS.*`）
 */
export function attributeUniqueViolation(
  err: unknown,
  target: string,
): UniqueViolationAttribution {
  if (!err || typeof err !== "object") return "not-unique";
  // `code` **只读顶层**（刻意不回落 `driverError.code`，见文件头注）。
  if ((err as { code?: unknown }).code !== "23505") return "not-unique";
  const actual = uniqueConstraintNameOf(err);
  if (actual === null) return "unknown";
  return actual === target ? "target" : "other-constraint";
}

/**
 * 便捷谓词：**是否应当按「本路径自己的唯一冲突」处理**。
 *
 * `target` 与 `unknown` 都返回 `true`（`unknown` 维持现状，见文件头注）；
 * `other-constraint` / `not-unique` 返回 `false`。
 */
export function isOwnUniqueViolation(err: unknown, target: string): boolean {
  const a = attributeUniqueViolation(err, target);
  return a === "target" || a === "unknown";
}
