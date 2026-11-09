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
  queueStallReason,
  type QueueStallReason,
  type QueueStallSnapshot,
} from "./agent-queue-stall-check";

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
   * 是否**读不到观测量**（某个 BullMQ 调用抛错）。
   *
   * ⚠️ 这个字段是**防假事实**的：若某个计数读失败而我们仍返回 `stalled: false`，
   * 运营会以为「队列正常」⇒ **静默的谎报**。⇒ 读失败时必须**显式**标出来，
   * 由调用方（前端）显示「未知」而不是「正常」。
   */
  degraded: boolean;
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
  async inspect(): Promise<QueueStallReport> {
    let degraded = false;
    const read = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (err: unknown) {
        degraded = true;
        this.logger.warn(
          `Queue observation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return fallback;
      }
    };

    const [waiting, delayed, prioritized, active, workers, paused] =
      await Promise.all([
        read(() => this.queue.getWaitingCount(), 0),
        read(() => this.queue.getDelayedCount(), 0),
        read(() => this.queue.getPrioritizedCount(), 0),
        read(() => this.queue.getActiveCount(), 0),
        read(() => this.queue.getWorkersCount(), 0),
        read(() => this.queue.isPaused(), false),
      ]);

    const snapshot: QueueStallSnapshot = {
      waiting,
      delayed,
      prioritized,
      active,
      workers,
      paused,
    };
    const stalled = isQueueStalled(snapshot);
    return {
      stalled,
      reason: stalled ? queueStallReason(snapshot) : null,
      pendingJobs: pendingJobCount(snapshot),
      snapshot,
      degraded,
    };
  }
}
