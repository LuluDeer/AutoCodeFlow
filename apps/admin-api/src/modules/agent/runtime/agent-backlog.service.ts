/**
 * R202：「调度积压」（backlogged）的**接线层**。
 *
 * 判据本身（纯函数、已测）在 `agent-backlog-check.ts`；完整推导见
 * `docs/observability/agent-backlog-criterion.md`。本文件只做**三件事**：
 * ① 取 `pending` 会话的 id（**有上限**）；
 * ② 逐个问队列「这个 id 的 job 还在不在」（`queue.getJob`，因为 `jobId === session.id`）；
 * ③ 交给纯函数判定，返回积压的 id 列表。
 *
 * ## 为什么单独一个 service（不挂在 `AgentSessionService` 上）
 *
 * ① `agent-session.service.ts` 在 `check:size-caps` 的**逐文件只减不增**基线上**顶格**
 *    （`nonCommentLines` 1087/1087）⇒ 加任何东西都会破顶；
 * ② 职责本来就不同：那边是「会话的读写」，这边是「**与队列对账**」——
 *    它需要 `@InjectQueue`，而 session service 刻意**不**依赖队列（它是纯数据层）。
 *
 * ## 为什么**不**挂在 `list()` 上（R386）
 *
 * 既有多个用例断言「`agentApi.list` / `sessions.list` 被调了几次」。把「积压对账」混进
 * `list()` 会**静默打乱那些计数断言**（R198 实测过：3 个前端用例从绿变红）。
 * ⇒ 独立方法 / 独立端点 ⇒ 调用计数才有意义。
 */
import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import type { Queue } from "bullmq";
import { Repository } from "typeorm";

import { AgentSession } from "../entities/agent-session.entity";
import { AGENT_QUEUE_NAME } from "./agent.processor";
import {
  classifyJobState,
  pickBacklogged,
  type PendingSessionProbe,
} from "./agent-backlog-check";
import {
  DEFAULT_OBSERVATION_BUDGET_MS,
  ObservationBudget,
  withObservationTimeout,
} from "./observation-timeout.util";
import { autoResumeJobId, manualResumeJobId } from "./agent-job-options";

/**
 * 一次最多对账多少条 `pending` 会话。
 *
 * 为什么要有上限：每条要一次 `queue.getJob`（一次 Redis 往返）。`pending` 会话**本应**很少
 * （正常几秒内就被消费），但**一旦积压起来就是无限多** ⇒ 不设上限会把一次 GET 变成
 * 几千次 Redis 往返。取 **200**：
 * · 远大于「正常 pending 数」（个位数）；
 * · 又小到一次请求的 Redis 开销可接受。
 * 与 `sweepStaleRunning` 的 `take: 1000` 同款纪律（**扫描类操作必须有上限**）。
 */
export const BACKLOG_PROBE_LIMIT = 200;

export interface BacklogReport {
  /** 判定为「积压」的会话 id。 */
  sessionIds: string[];
  /** 积压条数（= `sessionIds.length`，单独列出便于前端直接用）。 */
  count: number;
  /** 本次**实际对账**了多少条 pending 会话（诊断用：为 0 说明没有 pending）。 */
  probed: number;
  /**
   * 是否**因为上限而截断**（pending 会话数 > `BACKLOG_PROBE_LIMIT`）。
   *
   * ⚠️ 这个字段是**防假事实**的：若截断了却不说，运营看到 `count = 3` 会以为
   * 「一共就 3 条积压」，而实际可能有 500 条。⇒ 宁可显式说「只查了前 200 条」。
   */
  truncated: boolean;
}

@Injectable()
export class AgentBacklogService {
  private readonly logger = new Logger(AgentBacklogService.name);

  /**
   * R213：整次请求的探测总预算（判据文档 §6）。单测可覆写。
   *
   * 为什么是**字段**而不是直接读常量：串行探测的最坏情况是 200 × 2 次往返，
   * 必须整次请求共享一个 deadline；而单测要把它压到毫秒级（否则每条用例真等 8s）。
   */
  readonly observationBudgetMs: number = DEFAULT_OBSERVATION_BUDGET_MS;

  constructor(
    @InjectRepository(AgentSession)
    private readonly sessions: Repository<AgentSession>,
    @InjectQueue(AGENT_QUEUE_NAME)
    private readonly queue: Queue,
  ) {}

  /**
   * R215：找出**指向该会话**的 job（不限首跑）。
   *
   * ## 为什么要多查两个 id（这是一处**真实的误报路径**）
   *
   * 判据原先只查 `getJob(session.id)`，因为首跑用的是 `jobId: session.id`
   * （`agent-trigger.service.ts:352`/`:520`）。但本仓**还有两条 resume 路径**用**别的** id：
   * `manualResumeJobId`（人工/审批恢复 ⇒ `resume-<id>`）与 `autoResumeJobId`
   * （LLM 瞬时错误 ⇒ `auto-resume-<id>`）。
   *
   * ⇒ 一条「审批通过、正在正常排队等消费」的会话，`getJob(session.id)` 查不到 ⇒
   * **被误判成积压** ⇒ 运营按提示「重新入队」⇒ **同一会话跑两遍（双份副作用）**。
   *
   * ## 为什么是「有限枚举」而不是「扫全队列」
   *
   * 按 `job.data.sessionId` 扫全队列是 **O(n) 全表扫**，且 `getJobs()` 有单次上限 ⇒ 会漏。
   * ⇒ 只查**三个已知形态**（首跑 / 人工恢复 / 自动续跑）：
   * ① 绝大多数命中第 1 个，**零额外往返**；②③ 只在 resume 过的会话上多两次。
   *
   * ⚠️ 前两个形态是 `R215` 起**可枚举**的前提：旧写法 `${id}:resume:${Date.now()}` 里的时间戳
   * **不可枚举** ⇒ 那时这个缺陷**没法在判据侧修**，只能改 jobId 本身（已改）。
   */
  private async findSessionJob(
    sessionId: string,
    timeoutMs: number,
  ): Promise<{ getState: () => Promise<string> } | undefined> {
    // 顺序即优先级：首跑最常见 ⇒ 放第一个，命中即返回（零额外往返）。
    for (const candidateId of [
      sessionId,
      manualResumeJobId(sessionId),
      autoResumeJobId(sessionId),
    ]) {
      const job = await withObservationTimeout(
        `backlog.getJob(${candidateId})`,
        () => this.queue.getJob(candidateId),
        timeoutMs,
      );
      if (job) return job as unknown as { getState: () => Promise<string> };
    }
    return undefined;
  }

  /**
   * 对账一次：返回当前**永远不会被执行**的 `pending` 会话。
   *
   * 判据：`pending` 且 `queue.getJob(session.id)` 查不到（`missing`）或已终结（`finished`）。
   * 完整边界见判据文档 §4（含「队列停摆**不是**积压，是另一个判据」）。
   */
  async findBacklogged(): Promise<BacklogReport> {
    // 多取 1 条用来判「是否截断」（不用另发一次 COUNT：那会多一次全表扫描）。
    const rows = await this.sessions.find({
      where: { status: "pending" },
      select: { id: true },
      order: { createdAt: "ASC" }, // 最老的优先：真积压的通常是最老的那些
      take: BACKLOG_PROBE_LIMIT + 1,
    });
    const truncated = rows.length > BACKLOG_PROBE_LIMIT;
    const probed = truncated ? rows.slice(0, BACKLOG_PROBE_LIMIT) : rows;

    /**
     * R213：**整次请求的总预算**（不是逐调用 5s）。
     *
     * ⚠️ 为什么必须这样：本循环是**串行**的，每个 session **两次往返**
     * （`getJob` + `getState`）⇒ 最坏 200 × 2 = **400 次串行**。若每个调用各给 5s，
     * 最坏 2000s ⇒ **等于没修**（判据文档 §6 已实测确认这一点）。
     * ⇒ 用总预算，超了就**停止探测**并返回已得的部分（`truncated: true`）。
     */
    // ⚠️ 用实例字段而不是直接读常量：单测要把它压到毫秒级（否则每条用例都要真等 8s，
    //   那会让整个 agent 套件慢到没人愿意跑 —— 「测试慢」最终等于「测试不跑」）。
    const budget = new ObservationBudget(this.observationBudgetMs, Date.now());
    const probes: PendingSessionProbe[] = [];
    /** 是否因为**预算耗尽**而提前停止（与 `truncated` 同义：都表示「没查完」）。 */
    let budgetExhausted = false;
    for (const { id } of probed) {
      // 每次迭代前先看预算：已经超了就别再发新请求（那只会让请求更慢）。
      if (budget.expired()) {
        budgetExhausted = true;
        break;
      }
      let jobState: PendingSessionProbe["jobState"];
      try {
        // 单次上界取 `min(单调用上界, 剩余预算)` —— 否则后段仍可能超出总预算。
        const slice = budget.sliceMs();
        const job = await this.findSessionJob(id, slice);
        jobState = classifyJobState(
          job
            ? await withObservationTimeout(
                `backlog.getState(${id})`,
                () => job.getState(),
                budget.sliceMs(),
              )
            : undefined,
        );
      } catch (err: unknown) {
        // ⚠️ 对账失败**不能**当成「积压」也不能当成「没积压」——
        //   两者都是假事实。跳过这一条（保守：不当积压），并记日志。
        //   为什么偏向「不当积压」：误报会让运营不再看这个徽标（见判据文档 §3.2）。
        this.logger.warn(
          `Backlog probe failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      probes.push({ sessionId: id, jobState });
    }

    const sessionIds = pickBacklogged(probes);
    return {
      sessionIds,
      count: sessionIds.length,
      probed: probed.length,
      // ⚠️ **截断必须可见**（R395 的纪律）：预算耗尽也是「没查完」的一种，
      //   若只说「count=3」，运营会以为「一共就 3 条积压」。
      truncated: truncated || budgetExhausted,
    };
  }
}
