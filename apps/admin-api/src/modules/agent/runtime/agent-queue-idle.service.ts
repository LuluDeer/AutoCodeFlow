/**
 * R207：「队列空转」（queue idle-stuck）的**接线层**。
 *
 * 判据本身（纯函数、已测）在 `agent-queue-idle-check.ts`；完整推导见
 * `docs/observability/agent-queue-idle-criterion.md`。本文件只做**三件事**：
 * ① 从 BullMQ 读出「最老 waiting job + waiting 计数 + 消费者结构性事实」；
 * ② 从**配置**推导阈值（不写魔法数，R403）；
 * ③ 交给纯函数判定，并把「依据」一并返回。
 *
 * ## 为什么单独一个 service（与 R202/R205 同款理由）
 *
 * ① `agent-session.service.ts` 在 `check:size-caps` 的基线**顶格**
 *    （`nonCommentLines` 1087/1087）⇒ 加任何东西都破顶；
 * ② 职责不同：这是「**问队列**」，而 session service 刻意不依赖队列。
 *
 * ## 与「队列停摆」（R204/R205）**严格互补**（R399 的强制步骤）
 *
 * | 判据 | 覆盖 |
 * |---|---|
 * | 队列停摆（R205） | 有活排队 + **结构上没人能消费**（`workers === 0` / 被暂停） |
 * | **队列空转（本条）** | **worker 在册、队列没被暂停**，却不再消费新 job |
 *
 * ⇒ 判定顺序上**先问停摆**：若已经停摆，本条**让位**（`suppressedBy: "queue-stall"`），
 * 否则同一个现象会同时点亮两个徽标 —— 运营的注意力是稀缺资源。
 *
 * ## 只告警不处置
 *
 * 自动处置（重入队 / 杀 worker）在「worker 只是心跳过期、其实还在干活」时会
 * **造成真实损害**（重复执行）⇒ 人的动作是：**查 worker 进程 / Redis 连接**。
 */
import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";

import { AGENT_QUEUE_CONCURRENCY, AGENT_QUEUE_NAME } from "./agent.processor";
import { isQueueStalled } from "./agent-queue-stall-check";
import {
  DEFAULT_OBSERVATION_TIMEOUT_MS,
  withObservationTimeout,
} from "./observation-timeout.util";
import {
  deriveIdleThreshold,
  evaluateQueueIdle,
  type IdleThresholdBasis,
  type WaitingJobProbe,
} from "./agent-queue-idle-check";

/** 一次观测的结果（**依据齐全**：运营要能回答「这个数哪来的」）。 */
export interface QueueIdleReport {
  /** 是否「空转」。⚠️ `degraded` 为 true 时**恒为 false**（不完整 ⇒ 不断言）。 */
  idleStuck: boolean;
  /** 最老 waiting job 的年龄（毫秒）；无 job 或读失败时为 0。 */
  oldestAgeMs: number;
  /** 判定用的阈值（毫秒）与**推导依据**。 */
  thresholdMs: number;
  basis: IdleThresholdBasis;
  /** 当前 `waiting` 计数（读失败时为 0 且 `degraded` 为 true）。 */
  waitingCount: number;
  /** 最老 job 是否「曾开始过又回到 waiting」。 */
  retried: boolean;
  /**
   * 本条判据**让位**给别的判据时说明成因（目前只有「已停摆」一种）。
   * `null` = 本判据是这一格的**最终结论**。
   */
  suppressedBy: "queue-stall" | null;
  /**
   * 是否**读不到**观测量（`getWaiting` / `getWaitingCount` / `getWorkersCount` /
   * `isPaused` 任一抛错）。
   *
   * ⚠️ 防假事实：读失败时若返回 `idleStuck: false` 而不置 `degraded`，
   * 运营会以为「队列在正常消费」⇒ **静默的谎报**。⇒ 前端必须据此显示「未知」。
   */
  degraded: boolean;
}

@Injectable()
export class AgentQueueIdleService {
  private readonly logger = new Logger(AgentQueueIdleService.name);

  constructor(
    @InjectQueue(AGENT_QUEUE_NAME)
    private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  /**
   * 读一次队列观测并判定是否「空转」。
   *
   * ⚠️ **单个观测量读失败 ⇒ `degraded: true` 且不断言**（既不报「空转」也不报
   * 「正常」）—— 两者都是**假事实**，而「误报会让运营不再看徽标」。
   */
  async inspect(): Promise<QueueIdleReport> {
    let degraded = false;
    /**
     * R213：观测调用上界（判据文档 §3.1）。默认值推导见
     * `DEFAULT_OBSERVATION_TIMEOUT_MS`（connectTimeout 的一半）。
     */
    const timeoutMs = DEFAULT_OBSERVATION_TIMEOUT_MS;
    let seq = 0;
    const read = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        // R213：**超时与读失败走完全相同的路径** —— 端点必须在有限时间内给出答案，
        //   哪怕答案是「不知道」（否则 Redis 卡住时这里会**挂死**，R212 实测）。
        //   标签用序号而非观测量名：本服务的读取顺序与 `Promise.all` 解构绑定，
        //   加名字反而要与解构顺序各维护一份（漂移源）。
        return await withObservationTimeout(
          `queue-idle.#${++seq}`,
          fn,
          timeoutMs,
        );
      } catch (err: unknown) {
        degraded = true;
        this.logger.warn(
          `Queue idle observation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return fallback;
      }
    };

    const [waitingCount, oldestJobs, workers, paused, active] =
      await Promise.all([
        read(() => this.queue.getWaitingCount(), 0),
        // ⚠️ `getWaiting(0, 1)` 的 `end` 是**闭区间** ⇒ 取到 2 个；我们只要最老的
        //   第一个（⚠️ `wait` 是 **LIST**，不是 ZSET —— 表头 = **最早入队**的那个；
        //   真机 R207 实测，见 `agent-queue-idle-check.ts` 头注的修正框）。
        read(
          async () =>
            (await this.queue.getWaiting(0, 1)) as unknown as unknown[],
          [] as unknown[],
        ),
        read(() => this.queue.getWorkersCount(), 0),
        read(() => this.queue.isPaused(), false),
        read(() => this.queue.getActiveCount(), 0),
      ]);

    const oldest = pickOldestProbe(oldestJobs);
    const basis = deriveIdleThreshold({
      wallClockMs: this.readPositive("agent.budget.wallClockMs", 0),
      concurrency: AGENT_QUEUE_CONCURRENCY,
      // 「一拍」：执行器心跳间隔（仓里已有的量）——用于吸收「派发往返 + 墙钟判定
      // 在每轮开头」造成的**无上界但很小**的超时量。**不是**保守系数。
      tickMs: this.readPositive("executor.heartbeatInterval", 0),
    });

    const verdict = evaluateQueueIdle({
      waitingCount,
      oldest,
      thresholdMs: basis.thresholdMs,
    });

    // ① 停摆优先：有活 + 结构上没人消费 ⇒ 那是「队列停摆」那一格，本条让位。
    //    ⚠️ 复用 R205 的判据本体（**不复制一份条件**，否则两条判据会漂移）；
    //    `active` 用**真实值**（不停摆判据默认开 `requireIdleWorker`）——
    //    「有人在干活 + 最老的 job 很老」恰恰是本判据要报的形态（worker 在处理
    //    一个永远跑不完的 job，队列不再前进），不该被停摆判据吞掉。
    const stalledHere = isQueueStalled(
      {
        waiting: waitingCount,
        delayed: 0,
        prioritized: 0,
        active,
        workers,
        paused,
      },
      { requireIdleWorker: true },
    );

    // ② 读失败 ⇒ 不断言（`degraded` 交给前端显示「未知」）。
    const idleStuck = degraded ? false : verdict.idleStuck && !stalledHere;

    return {
      idleStuck,
      oldestAgeMs: verdict.oldestAgeMs,
      thresholdMs: basis.thresholdMs,
      basis,
      waitingCount,
      retried: verdict.retried,
      suppressedBy: !degraded && stalledHere ? "queue-stall" : null,
      degraded,
    };
  }

  /**
   * 读一个**正数**配置；缺失/非法 ⇒ 返回 `fallback`（本仓 `readInt` 的同款口径）。
   *
   * ⚠️ 不在这里塞默认值：阈值推导的「配错 ⇒ 0 ⇒ 不判定」是判据的一部分，
   * 在这里偷偷兜底会把「配置坏了」伪装成「判定正常」。
   */
  private readPositive(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
}

/**
 * 从 `getWaiting()` 的结果里取出**最老**的那个 job 的观测面。
 *
 * 抽成**纯函数**的两个理由：
 * ① `getWaiting` 返回的是 BullMQ `Job` 实例（重对象），而判据只需要 3 个字段；
 * ② 「取第一个」这个动作本身是判据的一部分（依赖 `wait` 是**插入序 LIST**、表头=最早入队）——
 *    它必须能被单测钉住，否则上游哪天改了排序方向，判据会**静默失效**。
 */
export function pickOldestProbe(jobs: unknown[]): WaitingJobProbe | null {
  const first = jobs[0] as
    | { id?: unknown; timestamp?: unknown; attemptsStarted?: unknown }
    | undefined;
  if (!first) return null;
  const ts = Number(first.timestamp);
  // 没有可用的入队时间 ⇒ 当作「读不到」（返回 null ⇒ 判据层不判定），
  // **不要**用 `Date.now()` 顶替：那会让年龄恒为 0 ⇒ 永远判「正常」。
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const started = Number(first.attemptsStarted);
  return {
    id: String(first.id ?? ""),
    timestamp: ts,
    attemptsStarted: Number.isFinite(started) && started >= 0 ? started : 0,
  };
}
