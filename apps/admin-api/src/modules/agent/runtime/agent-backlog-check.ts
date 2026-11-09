/**
 * R201：「调度积压」（backlogged）判据的**纯函数**实现。
 *
 * 判据（完整推导见 `docs/observability/agent-backlog-criterion.md`）：
 * > **backlogged = 状态是 `pending`，且队列里**查不到**该会话对应的 job。**
 *
 * ## 为什么是纯函数（不含 BullMQ 依赖）
 *
 * 判据的核心是**一个可测的决策**：「给定 pending 会话的 id 列表 + 每个 id 的 job 状态，
 * 哪些属于积压」。把它抽成纯函数 ⇒ ① 不需要真队列就能测 ② 接线层（controller/service）
 * 只负责「取数据 + 调本函数」，**判据本身不会被接线细节污染**。
 *
 * ## 为什么**不用**时间阈值（本判据最容易被写错的地方）
 *
 * · ❌ **`createdAt`**：`reopenForResume()` 把终态会话重开为 `pending` 时**不动 `createdAt`**
 *   ⇒ 一个 3 小时前创建、**刚刚 resume** 的会话会被**立刻**误判成「积压 3 小时」。
 * · ❌ **`updatedAt` / 任何纯时间阈值**：`AGENT_QUEUE_CONCURRENCY = 2`
 *   ⇒ 一次批量触发 20 个会话时，其余 18 个**合法地**等在队列里（每个跑 5 分钟则第 20 个等 45 分钟）
 *   ⇒ 任何阈值都会把**正常排队**报成积压 ⇒ 运营看到一片红，**下次就不看了**。
 * ⇒ **只能查队列**（`jobId === session.id`，见 `agent-trigger.service.ts:352`/`:520`）。
 *
 * ⚠️ 与 stalled（卡住）**恰好相反**：那边**必须避开** `updatedAt`（维护写会污染），
 * 这边**不能用** `createdAt`。⇒ 同一个「时间列」在两个判据里一个是陷阱、一个是必需。
 */

/** 一条 `pending` 会话在队列里的「job 状态」。 */
export type PendingJobState =
  /** 队列里查不到这个 id 的 job（从来没入队，或已被清理）。 */
  | "missing"
  /** job 还在排队 / 延迟 / 执行中 —— **合法排队，不是积压**。 */
  | "present"
  /** job 已 `completed` / `failed`，而会话**仍是** `pending` ⇒ 永远不会再被消费。 */
  | "finished";

export interface PendingSessionProbe {
  /** 会话 id（同时也是 `jobId` —— 本判据的前提，见文档 §7）。 */
  sessionId: string;
  jobState: PendingJobState;
}

/** 单个探针是否属于「调度积压」。 */
export function isBacklogged(probe: PendingSessionProbe): boolean {
  // `present` = job 在队列里（waiting/delayed/active）⇒ 合法排队，**不是**积压。
  // `missing` = 从来没入队（`queue.add` 失败）⇒ 永远不会跑。
  // `finished` = job 已终结但会话仍 pending ⇒ 也不会再被消费。
  return probe.jobState === "missing" || probe.jobState === "finished";
}

/**
 * 从一批探针里挑出积压的会话 id。
 *
 * ⚠️ 调用方**必须**保证 `probes` 里每一条的状态确实是 `pending`
 * （本函数不查库，只看队列侧的事实）—— 这是「纯函数」的代价，也是它的清晰之处。
 */
export function pickBacklogged(
  probes: readonly PendingSessionProbe[],
): string[] {
  return probes.filter(isBacklogged).map((p) => p.sessionId);
}

/**
 * 把 BullMQ 的原始 job 状态映射成本判据的闭集。
 *
 * 为什么要闭集而不是直接用字符串：BullMQ 的状态集合里 `unknown` 之类会让判据**静默偏向**某一侧；
 * 这里显式列出**每一个**可能值，未知值归 `present`（**保守**：不报积压）。
 *
 * **保守方向的选择理由**：误报（把合法排队说成积压）会让运营**不再看这个徽标**；
 * 漏报（把真积压漏掉）只是回到「没有判据」的现状。⇒ **漏报优于误报**。
 */
export function classifyJobState(
  raw: string | null | undefined,
): PendingJobState {
  if (raw === null || raw === undefined) return "missing";
  switch (raw) {
    case "waiting":
    case "delayed":
    case "active":
    case "waiting-children":
    case "prioritized":
      return "present";
    case "completed":
    case "failed":
      return "finished";
    default:
      // 未知状态（BullMQ 新增了状态 / 拼写变化）⇒ **保守当"在队列里"**，不报积压。
      return "present";
  }
}
