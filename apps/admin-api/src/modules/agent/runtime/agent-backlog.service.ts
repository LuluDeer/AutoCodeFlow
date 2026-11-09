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

  constructor(
    @InjectRepository(AgentSession)
    private readonly sessions: Repository<AgentSession>,
    @InjectQueue(AGENT_QUEUE_NAME)
    private readonly queue: Queue,
  ) {}

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

    const probes: PendingSessionProbe[] = [];
    for (const { id } of probed) {
      let jobState: PendingSessionProbe["jobState"];
      try {
        // `jobId === session.id`（`agent-trigger.service.ts:352`/`:520`）⇒ 可直接按 id 查。
        const job = await this.queue.getJob(id);
        jobState = classifyJobState(job ? await job.getState() : undefined);
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
      truncated,
    };
  }
}
