/**
 * R205：「队列停摆」（queue stall）的**接线层**。
 *
 * 判据本身（纯函数、已测）在 `agent-queue-stall-check.ts`；完整推导见
 * `docs/observability/agent-queue-stall-criterion.md`。本文件只做**两件事**：
 * ① 从 BullMQ 读出**六个观测量**；② 交给纯函数判定。
 *
 * ## 为什么单独一个 service
 *
 * 与 R202 的 `AgentBacklogService` 同款：`agent-session.service.ts` 在
 * `check:size-caps` 的**逐文件只减不增**基线上**顶格**（`nonCommentLines` 1087/1087）
 * ⇒ 加任何东西都会破顶；且本 service 是**唯一**需要「队列观测」的组件。
 *
 * ## 六个观测量各自回答什么（判据文档 §2/§3）
 *
 * | 观测量 | 读法 | 作用 |
 * |---|---|---|
 * | `waiting` | `getWaitingCount()` | 在队列里等着的 |
 * | `delayed` | `getDelayedCount()` | 延迟投递的（GAP-3 自动续跑） |
 * | `prioritized` | `getPrioritizedCount()` | 带优先级排队的 |
 * | `active` | `getActiveCount()` | **正在被处理**的 |
 * | `workers` | `getWorkersCount()` | **worker 注册表**里的数量（结构性信号） |
 * | `paused` | `isPaused()` | 队列被**人为暂停** |
 *
 * ⚠️ **`workers` 用 `getWorkersCount()` 而不是 `getWorkers().length`**：
 * 前者直接给数；后者要拉**整个注册表**（含每个 worker 的 id）再数长度 ——
 * 在 worker 很多时是**无谓的传输**。⚠️ 且 `getWorkers()` 的注释明确写着
 * 「**workers that are available to process jobs**」—— 语义上与我们要问的
 * 「有没有人在这场子里干活」**一致**，但计数接口更省。
 */
import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";

import { AGENT_QUEUE_NAME } from "./agent.processor";
import {
  isQueueStalled,
  pendingJobCount,
  type QueueStallReason,
  type QueueStallSnapshot,
} from "./agent-queue-stall-check";
import {
  DEFAULT_OBSERVATION_TIMEOUT_MS,
  withObservationTimeout,
} from "./observation-timeout.util";

export interface QueueStallReport {
  /** 是否停摆。 */
  stalled: boolean;
  /** 成因（`paused` / `no-worker`）；**不**停摆时为 `null`。 */
  reason: QueueStallReason | null;
  /** 在排队等消费的 job 数（`waiting + delayed + prioritized`，**不含 `active`**）。 */
  pendingJobs: number;
  /** 观测量快照（供前端展示/诊断；字段与判据文档 §3 一致）。 */
  snapshot: QueueStallSnapshot;
  /**
   * 是否有**可能导致误报**的观测失败（`active` / `workers` / `paused` 之一读失败）。
   *
   * ⚠️ R211 语义**收窄**（原先「任一个观测量读失败」都置 true）：六个观测量对结论的影响
   * **方向相反** —— 计数类（`waiting`/`delayed`/`prioritized`）读失败只会让
   * `pendingJobs` 变小（**更难**判停摆 ⇒ 漏报）；而 `active`/`workers`/`paused` 读失败
   * 会让判定**更容易**成立（误报）。混在同一个布尔里，前端没法据它决定「该不该紧张」。
   * ⇒ 本字段只表示「**结论可能错报**」⇒ 前端显示「未知」，既不敢报也**不敢说正常**。
   * 可能导致**漏报**的失败请看 `degradedCounts`。
   */
  degraded: boolean;
  /**
   * 是否有**可能导致漏报**的计数类观测失败（`waiting` / `delayed` / `prioritized`）。
   *
   * ⚠️ 它**不改变结论**（宁可漏报，不制造假警）：只在**已报停摆**时用来补一句
   * 「在排队数可能不止这些」。
   */
  degradedCounts: boolean;
  /**
   * `workers` 是否**读到了**（R211）。
   *
   * ⚠️ 这就是「`workers === 0`」与「`workers` 未知」**同形**问题的解药：
   * `workersKnown === false` 时，`snapshot.workers` 里的 `0` **不是事实**，只是回落值
   * ⇒ 调用方**不得**据此认为「没有 worker」。
   */
  workersKnown: boolean;
}

@Injectable()
export class AgentQueueStallService {
  private readonly logger = new Logger(AgentQueueStallService.name);

  constructor(
    @InjectQueue(AGENT_QUEUE_NAME)
    private readonly queue: Queue,
  ) {}

  /**
   * 读一次队列观测并判定是否停摆。
   *
   * ⚠️ **单个观测量读失败 ⇒ 该量按「未知」处理并把 `degraded` 置 true**，
   * **不**把整个判定当作「没停摆」——理由同上（`degraded` 会让前端显示「未知」）。
   * 但**不**因为一个计数读失败就断言「停摆」（那会是**误报**，代价更大）。
   */
  /**
   * R213：观测调用上界（判据文档 §3.1）。默认值的推导见
   * `DEFAULT_OBSERVATION_TIMEOUT_MS` 的注释（connectTimeout 的一半）。
   */
  private readonly observationTimeoutMs = DEFAULT_OBSERVATION_TIMEOUT_MS;

  async inspect(): Promise<QueueStallReport> {
    /**
     * 两个**方向相反**的失败位（R211）：
     * · `degraded`      —— 可能**误报**（`active` / `workers` / `paused` 读失败）；
     * · `degradedCounts` —— 可能**漏报**（计数类读失败）。
     * 分开的理由见 `QueueStallReport.degraded` 的注释与判据文档 §3.5。
     */
    let degraded = false;
    let degradedCounts = false;
    /** `workers` 这个观测量是否读失败（决定能不能用它判停摆，见下面的注释）。 */
    let workersUnknown = false;
    const read = async <T>(
      /** 诊断标签（进日志；**不要**含凭据）。 */
      label: string,
      fn: () => Promise<T>,
      fallback: T,
      /**
       * 该观测量读失败时记到哪个方向：
       * · `"verdict"` ⇒ 可能**误报**（参与判定的结构性量）；
       * · `"counts"`  ⇒ 可能**漏报**（只影响 `pendingJobs` 大小）。
       */
      direction: "verdict" | "counts" = "verdict",
      /** 该观测量读失败时是否要额外标记（目前只有 `workers` 用）。 */
      markUnknown?: () => void,
    ): Promise<T> => {
      try {
        // R213：**超时与读失败走完全相同的路径**（判据 §3.2）——
        //   观测端点必须在有限时间内给出答案，哪怕答案是「不知道」。
        return await withObservationTimeout(
          `queue-stall.${label}`,
          fn,
          this.observationTimeoutMs,
        );
      } catch (err: unknown) {
        if (direction === "counts") degradedCounts = true;
        else degraded = true;
        markUnknown?.();
        this.logger.warn(
          `Queue observation failed (${direction}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return fallback;
      }
    };

    const [waiting, delayed, prioritized, active, workers, paused] =
      await Promise.all([
        // 计数类：读失败只会让 `pendingJobs` 变小 ⇒ 可能**漏报**（不影响「误报」位）。
        read("waiting", () => this.queue.getWaitingCount(), 0, "counts"),
        read("delayed", () => this.queue.getDelayedCount(), 0, "counts"),
        read(
          "prioritized",
          () => this.queue.getPrioritizedCount(),
          0,
          "counts",
        ),
        // 结构性量：参与判定 ⇒ 读失败可能**误报**。
        read("active", () => this.queue.getActiveCount(), 0, "verdict"),
        read(
          "workers",
          () => this.queue.getWorkersCount(),
          0,
          "verdict",
          () => {
            workersUnknown = true;
          },
        ),
        read("paused", () => this.queue.isPaused(), false, "verdict"),
      ]);

    const snapshot: QueueStallSnapshot = {
      waiting,
      delayed,
      prioritized,
      active,
      workers,
      paused,
    };
    /**
     * R210：**「读不到」不得被当成「确有其事」**。
     *
     * `workers` 是 `stall` 的**结构性判据**（§3.2）；它读失败时会回落成 `0`
     * ⇒ 若照此判定，一次 Redis 抖动就能把「不知道」报成「**停摆**」。
     * 这是本仓主导缺陷类（「没读到」被渲染成「有问题」）在**告警方向**上的镜像 ——
     * 代价同样大：误报会让运营不再看这个徽标。
     *
     * ⚠️ 但**不能**简单地「degraded 就一律不报」：`paused` 是**独立的强证据**
     * （人为显式状态，不依赖 worker 观测）⇒ 只要 `paused` 读到了且为 `true`、
     * 且有活排队，停摆就**成立**，与 `workers` 读没读到无关。
     * ⇒ 判定分两路：`paused` 单独成立；`workers` 那一路要求**它自己读到了**。
     */
    const workersKnown = !workersUnknown;
    const stalled =
      (paused && pendingJobCount(snapshot) > 0) ||
      (workersKnown && isQueueStalled(snapshot));
    /**
     * ⚠️ `reason` **不能**复用 `queueStallReason(snapshot)`：它内部会再调一次
     * `isQueueStalled`，而后者对 `workers === 0` 的判定**不区分**「真的是 0」与
     * 「读失败回落成 0」⇒ 在 `paused` 那一路成立、`workers` 读失败时，
     * 它会因为 `workersUnknown` 之外的形态差异给出 `no-worker`（**错误归因**：
     * 明明是「暂停」，却让人去查进程）。
     * ⇒ 这里按**已确认的证据**归因：`paused` 优先（它是显式状态），否则才是 `no-worker`。
     */
    const reason: QueueStallReason | null = !stalled
      ? null
      : paused
        ? "paused"
        : "no-worker";
    return {
      stalled,
      reason,
      pendingJobs: pendingJobCount(snapshot),
      snapshot,
      degraded,
      degradedCounts,
      workersKnown: !workersUnknown,
    };
  }
}
