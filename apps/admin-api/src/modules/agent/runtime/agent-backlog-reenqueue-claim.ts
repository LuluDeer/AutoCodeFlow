/**
 * R216：**「积压」自动补入队的额度领取**（CAS 单赢家）。
 *
 * 判据见 `docs/observability/backlog-auto-reenqueue-criterion.md` §3.1 / §5.1。
 *
 * ## 为什么单独一个协作者（而不是挂在 `AgentSessionService` 上）
 *
 * `agent-session.service.ts` 在 `check:size-caps` 的**逐文件只减不增**基线上已顶格
 * （实测 1102 非注释行 vs 基线 1087）⇒ 新增任何方法都会破顶。
 * ⇒ 按本仓既有做法（R380/R397/R202 的 `AgentBacklogService` 同款）**外提成独立协作者**。
 *
 * ## 为什么是「条件写」而不是「先读后判」
 *
 * 与 `claimAutoResume`（GAP-3）**同一条纪律**：多个 admin-api 副本可能同时判定同一批
 * 会话为积压（各自跑 cron），读时判断会让每个副本都补一条 ⇒ 同一条会话被补 N 次。
 * `backlogReenqueueCount < :limit` 保证**只有一个赢家**（ADR-026 条件写）。
 *
 * ## 为什么谓词里还带 `status = :pending`
 *
 * 积压判据的前提就是 `pending`，但**判定与 CAS 之间有时间窗**：判定之后、CAS 之前，
 * 会话可能已被人工 abort 或别的路径推进成 `running`。⇒ 用 `status = :pending`
 * 让命中 0 行时**如实让位**，而不是给一个已在跑的会话补一条 job。
 *
 * ## 为什么与 `autoResumeCount` **分列**
 *
 * 语义完全不同：前者是「`pending` 但队列里没有 job」（**永远不会跑**），后者是
 * 「LLM 瞬时错误导致 `waiting_input`」（会跑，只是要等）。共用一个计数会让
 * 「自动续跑用掉了额度」把自动补也一起禁掉（或反之）。
 */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { AgentSession } from "../entities/agent-session.entity";

@Injectable()
export class AgentBacklogReenqueueClaim {
  constructor(
    @InjectRepository(AgentSession)
    private readonly sessions: Repository<AgentSession>,
  ) {}

  /**
   * 领取「本会话的自动补入队额度」。
   *
   * @returns 是否赢得本次资格（`affected > 0`）。
   *
   * ⚠️ **调用方必须在 CAS 之后才 `queue.add`**（判据 §5.1）：若 add 失败，计数已 +1
   * ⇒ **少补**（漏报）。**漏报比多补安全** —— 与 R210/R212 的「误报代价 > 漏报代价」
   * 同一条纪律。反过来（先 add 后 CAS）会让两个副本各 add 一条，而 CAS 只拦住其中一个
   * ⇒ 计数与事实不符。
   */
  async claim(id: string, max = 1): Promise<boolean> {
    const limit = Number.isInteger(max) && max > 0 ? max : 1;
    const res = await this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({
        backlogReenqueueCount: () => `"backlogReenqueueCount" + 1`,
      })
      .where(
        `id = :id AND "backlogReenqueueCount" < :limit AND status = :pending`,
        { id, limit, pending: "pending" },
      )
      .execute();
    return (res.affected ?? 0) > 0;
  }
}
