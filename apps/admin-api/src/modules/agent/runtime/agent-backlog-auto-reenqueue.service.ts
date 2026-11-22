/**
 * R216：**自动补入队**（backlog auto re-enqueue）—— 「积压」会话的自动修复。
 *
 * 判据见 `docs/observability/backlog-auto-reenqueue-criterion.md`。
 *
 * ## 为什么这条与其余五条判据不同（它们都只告警不处置）
 *
 * 「积压」的定义是：会话 `pending` 但队列里**没有任何指向它的 job** ⇒ 它**永远不会被执行**，
 * 而且**没有任何东西会自己修复它**（`sweepStaleRunning` 只扫 `running`；GAP-3 只处理
 * `waiting_input`；唯一的修复路径是人点徽标手工重新入队）。⇒ 夜间无人值守时，
 * 一批 `queue.add` 失败的会话会一直躺着。
 *
 * ## 副作用怎么被封顶（这是本服务存在的意义）
 *
 * | 约束 | 做法 |
 * |---|---|
 * | 最多补 **1** 次 | `claimBacklogReenqueue` 的条件写（`count < 1`，落库） |
 * | 多副本只有一个赢家 | 同上的 CAS（`affected > 0`） |
 * | 重复 add 无害 | `jobId = session.id`（与首跑同形态 ⇒ BullMQ 幂等，且**积压判据能直接查到**） |
 * | 不碰会话状态 | **只** `queue.add`，不改 `status`/预算/审批 |
 * | 扫描有上限 | 复用 `BACKLOG_PROBE_LIMIT`（一次最多 200 条） |
 * | 观测有上界 | 复用 R213 的 `withObservationTimeout` |
 * | 失败不重试 | **先 CAS 后 add**（add 失败则计数已 +1 ⇒ 少补，判据 §5.1） |
 *
 * ## 为什么**不**复用 `POST /sessions/:id/resume`
 *
 * 那条路径有一串**人工动作语义**的闸门（`succeeded`/`aborted` 拒绝、`running` 409、
 * pending 审批拒绝、`budget_exceeded` 拒绝）。自动补只需要「`pending` 且无 job」这一个前提
 * （判据已保证），混进那 5 个 if 会让「为什么自动补失败」变得难回答。
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";

import { LeaderGateService } from "../../../common/leader-gate/leader-gate.service";
import { AGENT_QUEUE_NAME, type AgentJobData } from "./agent.processor";
import { AgentBacklogService } from "./agent-backlog.service";
import { AgentBacklogReenqueueClaim } from "./agent-backlog-reenqueue-claim";

/** 一次自动补最多补多少条（与 `BACKLOG_PROBE_LIMIT` 同口径：扫描类操作必须有上限）。 */
export const BACKLOG_AUTO_REENQUEUE_LIMIT = 200;

/** 每个会话最多自动补几次（判据 §3.2：上限 1 ⇒ 补了还积压就交给人）。 */
export const BACKLOG_AUTO_REENQUEUE_MAX_PER_SESSION = 1;

export interface BacklogAutoReenqueueReport {
  /** 本次判定为积压的会话数（= 候选数）。 */
  candidates: number;
  /** 赢得 CAS 额度并**尝试**入队的条数。 */
  attempted: number;
  /** 入队成功的条数。 */
  enqueued: number;
  /**
   * 入队失败的条数。
   *
   * ⚠️ **这些会话的计数已经 +1**（先 CAS 后 add）⇒ 它们**不会再**被自动补。
   * 这是刻意的（漏报优于多补），但必须**可见** —— 否则「自动补悄悄少补了几条」
   * 没人知道（本仓主导缺陷类：读失败/失败被渲染成「正常」）。
   */
  failed: number;
  /** 事件是否被 leader 门禁挡下（多副本时只有 leader 执行）。 */
  skipped?: "not-leader";
}

@Injectable()
export class AgentBacklogAutoReenqueueService {
  private readonly logger = new Logger(AgentBacklogAutoReenqueueService.name);

  constructor(
    private readonly backlog: AgentBacklogService,
    private readonly claimer: AgentBacklogReenqueueClaim,
    @InjectQueue(AGENT_QUEUE_NAME)
    private readonly queue: Queue<AgentJobData>,
    /**
     * Leader 门禁（多副本下只有 leader 跑维护扫描）。
     *
     * ⚠️ `@Optional()`：既有单测装配本服务时不带它 ⇒ 缺席时**默认执行**
     * （与 `AgentSessionService` 的 `leaderGate` 同款口径：`this.leaderGate && !isLeader`）。
     */
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
  ) {}

  /**
   * cron 入口（每 10 分钟，与 `handleStaleRunningSweep` **同频但错开相位**）。
   *
   * ⚠️ 为什么错开：两者都做「扫描 + 修复」，同时跑会让**同一条会话**在极短窗口内
   * 被两条路径同时判定（虽然 CAS 会挡住，但日志会交错、排查变难）。
   * 这里取 `5` 分（`sweepStaleRunning` 取 `0` 分）⇒ 相隔 5 分钟。
   *
   * ⚠️ 为什么 `pending` 的修复**不该**更频繁：积压本身就是「异常态」，
   * 每 10 分钟一次的修复窗口已远快于「人发现它」的速度；更频繁只会增加
   * 与 `queue.add` 失败面的接触次数。
   */
  @Cron("0 5,15,25,35,45,55 * * * *")
  async handleBacklogAutoReenqueue(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    await this.runCronBody();
  }

  /**
   * cron 的**函数体**（与 `handleBacklogAutoReenqueue` 分开的**唯一**目的：可测）。
   *
   * ⚠️ 为什么不直接把 `@Cron` 方法当测试入口：那样每个用例都要构造 `LeaderGateService`
   * 并断言「门禁被调用」—— 而本文件要测的是**日志三态**，与门禁无关。
   * 拆开后：`@Cron` 方法只负责「门禁 → 调用函数体」，函数体负责「跑 + 打日志」。
   * ⇒ 谁都没有被绕开：门禁仍在 `@Cron` 路径上。
   */
  async runCronBody(): Promise<void> {
    try {
      const r = await this.runOnce();
      /**
       * 日志的**三态**（不是「有事/没事」两态）：
       *
       * | 情形 | 含义 | 日志 |
       * |---|---|---|
       * | `candidates === 0` | 真的没有积压 | **不打**（每 10 分钟一条「什么都没发生」会淹掉日志） |
       * | `candidates > 0 && attempted > 0` | 正常补了 | `log` |
       * | **`candidates > 0 && attempted === 0`** | **有积压但一条都补不动**（均已补过 / 状态已变） | **`warn`** |
       *
       * ⚠️ 第三态是 R217 真机发现的**可观测性缺陷**：原实现只看 `attempted > 0`，
       * 把它和第一态一起静默 ⇒ 「积压一直存在、自动补却帮不上忙」这件事**没有任何信号**，
       * 运营只能看到徽标上的数字一直不变、却不知道为什么。
       * 这正是本仓主导缺陷类（「有问题」被渲染成「什么都没发生」）的又一形态。
       */
      if (r.candidates === 0) return;
      if (r.attempted > 0) {
        this.logger.log(
          `Backlog auto re-enqueue: candidates=${r.candidates} attempted=${r.attempted} ` +
            `enqueued=${r.enqueued} failed=${r.failed}`,
        );
      } else {
        this.logger.warn(
          `Backlog auto re-enqueue: candidates=${r.candidates} but attempted=0 ` +
            `—— 这些会话**已补过或状态已变**，自动补帮不上忙，需要人工介入`,
        );
      }
    } catch (err: unknown) {
      // ⚠️ 不吞成「正常」：自动修复失败必须可见（与其它维护任务同款）。
      this.logger.error(
        `Agent backlog auto re-enqueue failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 跑一次自动补。
   *
   * ⚠️ **不做任何「先读后判」的状态判断** —— 额度一律走 CAS（`claimBacklogReenqueue`），
   * 因为「读的时候还有额度」与「写的时候还有额度」之间隔着别的事。
   */
  async runOnce(): Promise<BacklogAutoReenqueueReport> {
    // ① 复用既有判据（R201/R215 已修误报）—— **不复制一份「怎么算积压」**，
    //    否则两条判定会漂移（这正是 R215 修的那个 bug 的形态）。
    const report = await this.backlog.findBacklogged();
    const ids = report.sessionIds.slice(0, BACKLOG_AUTO_REENQUEUE_LIMIT);

    let attempted = 0;
    let enqueued = 0;
    let failed = 0;

    for (const sessionId of ids) {
      // ② CAS 领额度：多副本只有一个赢家；非 pending / 已补过的**如实让位**。
      const won = await this.claimer.claim(
        sessionId,
        BACKLOG_AUTO_REENQUEUE_MAX_PER_SESSION,
      );
      if (!won) continue;
      attempted += 1;

      // ③ 入队。⚠️ `jobId = session.id`：
      //    · 与**首跑同形态** ⇒ 积压判据（`getJob(session.id)`）下轮能直接查到它（R215 的教训）；
      //    · BullMQ 对相同 id 的 add 是**幂等 no-op** ⇒ 即使与首跑撞 id 也无害。
      try {
        await this.queue.add(
          "run",
          { sessionId, reason: "backlog:auto-requeue" },
          { jobId: sessionId, attempts: 1 },
        );
        enqueued += 1;
        this.logger.log(
          `Backlog auto re-enqueue: session=${sessionId}（首次自动补，最多 1 次）`,
        );
      } catch (err: unknown) {
        failed += 1;
        // ⚠️ 不重试、不回滚计数：见判据 §5.1（少补优于多补）。
        //    但必须**如实记日志** —— 这些会话此后只能靠人工。
        this.logger.warn(
          `Backlog auto re-enqueue FAILED (额度已消耗，此后需人工): session=${sessionId} — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      candidates: ids.length,
      attempted,
      enqueued,
      failed,
    };
  }
}
