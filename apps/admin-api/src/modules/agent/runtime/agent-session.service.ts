import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { In, LessThan, Not, Repository } from "typeorm";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../../common/errors/app-error";
import {
  AgentSession,
  AgentSessionKind,
  AgentSessionStatus,
  AGENT_TERMINAL_STATUSES,
  type AgentBudget,
} from "../entities/agent-session.entity";
import { AgentStep, type AgentStepRole } from "../entities/agent-step.entity";
import {
  AgentToolCall,
  type AgentToolCallStatus,
  type AgentToolTier,
} from "../entities/agent-tool-call.entity";
import { AgentBudgetService } from "./agent-budget.service";
import { AgentNotifyService } from "./agent-notify.service";
import { recordRuntime } from "../../metrics/runtime-metrics-entry";
import { LeaderGateService } from "../../../common/leader-gate/leader-gate.service";

/**
 * P2：会话生命周期与持久化。
 *
 * 本服务是推理循环的**唯一持久化入口**——AgentRuntimeService 不直接碰
 * repository。这样做的理由：steps 的 seq 分配必须原子（唯一约束），
 * 且「每步写完后同步累加会话用量」两者若分散在两个服务里，很容易出现
 * 用量与 steps 不一致（用量少了 → 预算闸门失效 → 会话跑飞）。
 * 收敛到一处，累加与写入在同一方法内，不会漂移。
 */

/**
 * B-4：token 计数收敛——上游（AI provider）返回的 usage 可能是字符串或
 * 畸形值，进 SQL 表达式前必须收敛为有限正数，否则 `"totalTokensIn" + ${raw}`
 * 是一个可注入面（raw = "1; DROP TABLE agent_sessions--"）。
 * 非有限/非正数一律按 0 记。
 */
export function safeTokenCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 陈旧 running 判死阈值（GAP-2）：30 分钟无任何落库步进即视为持有者已死。
 * 心跳 = updatedAt（appendStep/recordToolCall/markRunning 都刷新它），
 * 最长合法静默窗口 ≈ 单轮重试 8s×3 + 工具批 10×60s ≈ 11 分钟，取 30 分钟
 * 留足裕量（对齐 detectStuckDeployments 的 DEPLOYING 口径）。
 */
export const STALE_RUNNING_TIMEOUT_MS = 30 * 60_000;

/** 陈旧 running 收敛时的 errorMessage（如实指明发生了什么 + 恢复路径）。 */
export const STALE_RUNNING_MESSAGE =
  "会话执行中断（admin-api 进程重启/崩溃，超过 30 分钟无任何步进）——" +
  "会话数据完好，可在排查后经 resume 重建上下文继续";

/** 创建会话的输入。 */
export interface CreateSessionInput {
  kind: AgentSessionKind;
  triggerSource: string;
  title?: string;
  parentSessionId?: string | null;
  context?: Record<string, unknown> | null;
  scope?: Record<string, unknown> | null;
  /** 不传则用 resolveBudget() 的默认/配置值。 */
  budget?: AgentBudget;
}

/** 追加一步的输入。 */
export interface AppendStepInput {
  role: AgentStepRole;
  content?: string | null;
  reasoning?: string | null;
  toolCallsJson?: unknown[] | null;
  toolCallId?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  provider?: string | null;
  model?: string | null;
  summary?: string | null;
}

/** 记录一次工具调用的输入。 */
export interface RecordToolCallInput {
  sessionId: string;
  stepId?: string | null;
  /** 模型给的 tool_call id（重放时唯一的关联键，见实体注释）。 */
  toolCallId?: string | null;
  toolName: string;
  tier: AgentToolTier;
  args?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  resultTruncated?: boolean;
  status: AgentToolCallStatus;
  errorMessage?: string | null;
  approvalId?: string | null;
  durationMs?: number;
}

@Injectable()
export class AgentSessionService {
  private readonly logger = new Logger(AgentSessionService.name);

  constructor(
    @InjectRepository(AgentSession)
    private readonly sessions: Repository<AgentSession>,
    @InjectRepository(AgentStep)
    private readonly steps: Repository<AgentStep>,
    @InjectRepository(AgentToolCall)
    private readonly toolCalls: Repository<AgentToolCall>,
    private readonly budgetService: AgentBudgetService,
    private readonly notify: AgentNotifyService,
    // ARCH-31 §5: 多实例下 cron 维护任务仅 Leader 执行（@Optional——既有
    // 单测直接 new 装配时 gate 缺席 → null → 门禁不生效，先例同 retention）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
  ) {}

  /**
   * cron 入口（每 10 分钟）：Leader 门禁 + sweepStaleRunning。
   * 与 AgentSessionRetentionService.handleDailyCleanup / detectStuckDeployments
   * 同一门禁纪律——多副本下只有 Leader 做维护扫描。
   */
  @Cron("0 */10 * * * *")
  async handleStaleRunningSweep(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      await this.sweepStaleRunning();
    } catch (err) {
      this.logger.error(
        `Agent stale-running sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 创建与查询 ──────────────────────────────────────────────────

  async create(input: CreateSessionInput): Promise<AgentSession> {
    const session = this.sessions.create({
      kind: input.kind,
      status: "pending",
      title: input.title ?? null,
      triggerSource: input.triggerSource,
      parentSessionId: input.parentSessionId ?? null,
      contextJson: input.context ?? null,
      // 作用域缺省为空对象而非 null：闸门统一按「有 scope 且为空 = 不可操作
      // 任何资源」处理，比 null（表示"未指定，按不限处理"）更安全。
      scopeJson: input.scope ?? {},
      budgetJson: input.budget ?? this.budgetService.resolveBudget(),
      totalSteps: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalToolCalls: 0,
    });
    const saved = await this.sessions.save(session);
    this.logger.log(
      `Agent session created: id=${saved.id} kind=${saved.kind} trigger=${saved.triggerSource}`,
    );
    return saved;
  }

  async findById(id: string): Promise<AgentSession | null> {
    return this.sessions.findOne({ where: { id } });
  }

  async requireById(id: string): Promise<AgentSession> {
    const s = await this.findById(id);
    if (!s)
      throw new AppError("AGENT_SESSION_NOT_FOUND", {
        sessionId: id,
      });
    return s;
  }

  async list(options: {
    kind?: AgentSessionKind;
    status?: AgentSessionStatus;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: AgentSession[]; total: number }> {
    // NaN 守卫（R3 后端遗留）：HTTP 层 parseInt("abc")=NaN 会穿透下面的
    // Math.max/Math.min 钳制（Math.max(1, NaN)=NaN），NaN 直达 skip/take
    // 炸 500。与前端深链非法值回落默认的既有口径（R2-C URL-SYNC-01）对齐：
    // 非有限数（NaN/±Infinity）一律视同未传、回落 1/20，而不是 400——
    // 400 会改变「非法深链安全回落」契约。钳制本身维持原状（page≥1、
    // pageSize∈[1,100]）。
    // F-54（UIAUDIT 后端轮 P3-1）：page 补上限 10000——对齐 NETOPT-3④ 的
    // PageQueryDto 口径（与 events 先例 2ea869fc 一致）：无封顶的 page 生成
    // 深 OFFSET + getManyAndCount 全量 COUNT，可钉满连接池（ADMIN-only 小表，
    // 风险低，属标准统一而非堵洞）。仍在 clamp 内做（不引 DTO）以保持本端点
    // 「非法值安全回落、绝不 400」的契约——语义是「超限视同翻到最深一页内的
    // 最后一屏」而非报错。
    const rawPage = options.page;
    const rawPageSize = options.pageSize;
    const page = Math.min(
      10000,
      Math.max(
        1,
        typeof rawPage === "number" && Number.isFinite(rawPage) ? rawPage : 1,
      ),
    );
    const pageSize = Math.min(
      100,
      Math.max(
        1,
        typeof rawPageSize === "number" && Number.isFinite(rawPageSize)
          ? rawPageSize
          : 20,
      ),
    );

    const qb = this.sessions.createQueryBuilder("s");
    if (options.kind) qb.andWhere("s.kind = :kind", { kind: options.kind });
    if (options.status)
      qb.andWhere("s.status = :status", { status: options.status });
    qb.orderBy("s.createdAt", "DESC")
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /** 子会话（P6 澄清链）。 */
  async findChildren(parentSessionId: string): Promise<AgentSession[]> {
    return this.sessions.find({
      where: { parentSessionId },
      order: { createdAt: "ASC" },
    });
  }

  /** 会话的全部步骤（按 seq 升序）——重建 messages 的唯一数据源。 */
  async listSteps(sessionId: string): Promise<AgentStep[]> {
    return this.steps.find({
      where: { sessionId },
      order: { seq: "ASC" },
    });
  }

  async listToolCalls(sessionId: string): Promise<AgentToolCall[]> {
    return this.toolCalls.find({
      where: { sessionId },
      order: { createdAt: "ASC" },
    });
  }

  /**
   * 按审批单键回写工具调用行的终态（实施轮 #14）。
   *
   * 为什么需要：审批单被 deny 之后，`agent_tool_calls` 里那一行会永远停在
   * `awaiting_approval`——台账因此无法区分「没人处理」与「明确被拒」，
   * 会话详情页也一直显示挂起。条件写钉住 `awaiting_approval`：只改还没走完
   * 的那一行，已执行/已拒绝的行不被二次覆盖。
   *
   * @returns 受影响行数（0 = 没有处于该状态的调用行，不是错误）
   */
  async settleToolCallByApprovalId(
    approvalId: string,
    status: Extract<AgentToolCallStatus, "denied" | "error">,
    errorMessage: string,
  ): Promise<number> {
    const res = await this.toolCalls.update(
      { approvalId, status: "awaiting_approval" },
      { status, errorMessage },
    );
    return res.affected ?? 0;
  }

  // ── 状态迁移 ────────────────────────────────────────────────────

  /**
   * 标记会话开始运行。
   * startedAt 只在第一次置位（resume 不重置）——否则墙钟预算会被反复续命，
   * 「单会话 30 分钟上限」形同虚设。
   *
   * @returns CAS 是否赢得执行凭据（affected > 0）。**调用方必须消费它**：
   * 输掉 CAS = 会话已被另一个 worker 置 running（重复 resume 入队 / 定时
   * 扫描撞上在跑会话）或已收敛终态——输家不得进入推理循环（GAP-1：此前
   * affected 被丢弃，输家照跑，B-8 声称的双跑守卫实际不成立）。
   */
  async markRunning(id: string): Promise<boolean> {
    // B-8：CAS 双保险——只有「非 running 且未终态」的会话能被置 running。
    // ① 双 worker 领到同一会话（重复入队的残余窗口）时只有一方真正置态；
    // ② 防住把终态会话拉回 running 的状态机倒退。
    const res = await this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({
        status: "running",
        waitingFor: null,
        ...((await this.needsStartedAt(id)) ? { startedAt: new Date() } : {}),
      })
      .where(
        "id = :id AND status <> 'running' AND status NOT IN (:...terminal)",
        {
          id,
          terminal: AGENT_TERMINAL_STATUSES,
        },
      )
      .execute();
    return (res.affected ?? 0) > 0;
  }

  private async needsStartedAt(id: string): Promise<boolean> {
    const s = await this.sessions.findOne({
      where: { id },
      select: { id: true, startedAt: true },
    });
    return !s?.startedAt;
  }

  /**
   * 挂起到 waiting_input。
   * **不设 finishedAt**——它不是终态，只是等外部输入。
   */
  async markWaiting(id: string, waitingFor: string): Promise<void> {
    // R36（ADR-026）：进入 waiting_input 同样是状态迁移——若此刻会话已被 finish
    // 收敛到终态（runtime 判定失败与「等输入」几乎同时），无条件写会**把终态翻回
    // waiting_input**：会话永远不再收敛，其后的恢复路径全部按「还在等输入」处理。
    // 条件写命中 0 就什么都不做（让位给已经写出终态的那一方）。
    const marked = await this.sessions.update(
      { id, status: Not(In(AGENT_TERMINAL_STATUSES)) },
      { status: "waiting_input", waitingFor },
    );
    if (!marked.affected) {
      this.logger.debug(
        `markWaiting(${id}) skipped — the session is already terminal`,
      );
    }
  }

  /**
   * 收敛到终态并写指标。
   * 幂等：已是终态则直接返回（重复 resume 不应重复计数或覆盖结论）。
   */
  async finish(
    id: string,
    status: Exclude<
      AgentSessionStatus,
      "pending" | "running" | "waiting_input"
    >,
    options: {
      result?: Record<string, unknown> | null;
      summary?: string | null;
      errorMessage?: string | null;
    } = {},
  ): Promise<void> {
    const session = await this.sessions.findOne({ where: { id } });
    if (!session) return;
    if (AGENT_TERMINAL_STATUSES.includes(session.status)) {
      this.logger.debug(
        `finish(${id}) ignored — already terminal (${session.status})`,
      );
      return;
    }

    // R36（ADR-026）：把上面的「已是终态则返回」从**读时判断**升级为**条件写**。
    //
    // 旧实现是先 findOne 看快照、再 update({id})——两个并发的 finish（runtime 的
    // succeeded 与 controller 的 abort 撞在一起）都能通过快照判断，于是：
    //   ① 后到者覆盖先到者的 status/resultJson/summary（终态结论被改写）；
    //   ② 两次都走到下面的 notify.sessionFinished ⇒ **用户收到两条终态通知**
    //      （注释里明确写着「上面的守卫同时防住了重复通知」，而那条守卫并不成立）；
    //   ③ 指标 autoflow_agent_sessions_total 被计两次，看板会话数偏高。
    // 改成条件写后，命中 0 说明别人先收敛了这个会话——让位即可，这才是真的幂等。
    const finished = await this.sessions.update(
      { id, status: Not(In(AGENT_TERMINAL_STATUSES)) },
      {
        status,
        finishedAt: new Date(),
        waitingFor: null,
        resultJson: options.result ?? session.resultJson,
        summary: options.summary ?? session.summary,
        errorMessage: options.errorMessage ?? null,
      },
    );
    if (!finished.affected) {
      this.logger.debug(
        `finish(${id}) lost the race — another writer already terminalized it`,
      );
      return;
    }

    recordRuntime("autoflow_agent_sessions_total", {
      kind: session.kind,
      status,
    });
    this.logger.log(
      `Agent session finished: id=${id} status=${status} steps=${session.totalSteps} tokens=${session.totalTokensIn + session.totalTokensOut}`,
    );

    // P4 通知：finish 是终态唯一收敛点，在这里通知一次即覆盖全部路径
    // （runtime 的 succeeded/failed/budget_exceeded、controller 的 abort），
    // 且上面的「已是终态则提前返回」守卫同时防住了重复通知。
    // 传**更新后**的快照——静默语义读的是新 summary，不是旧值。
    await this.notify.sessionFinished({
      ...session,
      status,
      finishedAt: new Date(),
      waitingFor: null,
      resultJson: options.result ?? session.resultJson,
      summary: options.summary ?? session.summary,
      errorMessage: options.errorMessage ?? null,
    });
  }

  // ── 步骤与工具调用（用量累加与写入同点，不会漂移）──────────────

  /**
   * 追加一步。
   *
   * seq 分配：`MAX(seq)+1` 在同一事务内完成（唯一约束兜底并发）。
   * 会话是单 worker 串行推进的，并发只可能出现在「人工 resume 撞上定时
   * 扫描」——唯一约束会让后者失败并重试，不会产生重复 seq。
   */
  async appendStep(
    sessionId: string,
    input: AppendStepInput,
  ): Promise<AgentStep> {
    // B-4：token 计数在进 SQL 表达式前收敛为有限正数（见 safeTokenCount）。
    const tokensIn = safeTokenCount(input.tokensIn);
    const tokensOut = safeTokenCount(input.tokensOut);
    return this.sessions.manager.transaction(async (em) => {
      const row = await em
        .createQueryBuilder(AgentStep, "s")
        .select("COALESCE(MAX(s.seq), 0)", "maxSeq")
        .where("s.sessionId = :sessionId", { sessionId })
        .getRawOne<{ maxSeq: number }>();
      const nextSeq = Number(row?.maxSeq ?? 0) + 1;

      const step = em.create(AgentStep, {
        sessionId,
        seq: nextSeq,
        role: input.role,
        content: input.content ?? null,
        reasoning: input.reasoning ?? null,
        toolCallsJson: input.toolCallsJson ?? null,
        toolCallId: input.toolCallId ?? null,
        tokensIn,
        tokensOut,
        latencyMs: input.latencyMs ?? 0,
        provider: input.provider ?? null,
        model: input.model ?? null,
        summary: input.summary ?? null,
      });
      const saved = await em.save(step);

      // 用量累加与 step 写入同事务——分开写会出现「步数涨了用量没涨」
      // 的窗口，而预算闸门正是读用量。这一步是闸门可靠性的基础。
      // B-4：tokens 经 safeTokenCount 收敛后才是有限数——原样拼接上游
      // 字符串可注入原生 SQL。
      await em
        .createQueryBuilder()
        .update(AgentSession)
        .set({
          totalSteps: () => '"totalSteps" + 1',
          totalTokensIn: () => `"totalTokensIn" + ${tokensIn}`,
          totalTokensOut: () => `"totalTokensOut" + ${tokensOut}`,
        })
        .where("id = :id", { id: sessionId })
        .execute();

      // 令牌指标（成本归因）
      if (tokensIn > 0) {
        recordRuntime("autoflow_agent_tokens_total", {
          provider: input.provider ?? "unknown",
          model: input.model ?? "unknown",
          direction: "in",
        });
      }
      if (tokensOut > 0) {
        recordRuntime("autoflow_agent_tokens_total", {
          provider: input.provider ?? "unknown",
          model: input.model ?? "unknown",
          direction: "out",
        });
      }

      return saved;
    });
  }

  /**
   * 记录一次工具调用。
   *
   * 无论成功/被拒/待审批都调用本方法——**被拒的尝试同样有价值**
   * （安全信号 + scope 调参依据），不能只在内存丢弃。
   */
  async recordToolCall(input: RecordToolCallInput): Promise<AgentToolCall> {
    const row = this.toolCalls.create({
      sessionId: input.sessionId,
      stepId: input.stepId ?? null,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName,
      tier: input.tier,
      argsJson: input.args ?? null,
      resultJson: input.result ?? null,
      resultTruncated: input.resultTruncated ?? false,
      status: input.status,
      errorMessage: input.errorMessage ?? null,
      approvalId: input.approvalId ?? null,
      durationMs: input.durationMs ?? 0,
    });
    const saved = await this.toolCalls.save(row);

    await this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({ totalToolCalls: () => '"totalToolCalls" + 1' })
      .where("id = :id", { id: input.sessionId })
      .execute();

    recordRuntime("autoflow_agent_tool_calls_total", {
      tool: input.toolName,
      tier: input.tier,
      status: input.status,
    });

    return saved;
  }

  /** 会话当前用量（喂给预算闸门）。 */
  async getUsage(session: AgentSession): Promise<{
    steps: number;
    tokensIn: number;
    tokensOut: number;
    toolCalls: number;
    startedAt: Date | null;
  }> {
    // 直接从 DB 重读而非用入参的内存副本——闸门判定必须基于**已落库**的
    // 真实用量（内存副本可能落后于刚写入的 step）。
    const fresh = await this.sessions.findOne({
      where: { id: session.id },
      select: {
        id: true,
        totalSteps: true,
        totalTokensIn: true,
        totalTokensOut: true,
        totalToolCalls: true,
        startedAt: true,
      },
    });
    return {
      steps: fresh?.totalSteps ?? 0,
      tokensIn: fresh?.totalTokensIn ?? 0,
      tokensOut: fresh?.totalTokensOut ?? 0,
      toolCalls: fresh?.totalToolCalls ?? 0,
      startedAt: fresh?.startedAt ?? null,
    };
  }

  // ── 陈旧 running 清扫（GAP-2：崩溃后僵尸 running 的恢复语义）──────

  /**
   * 收敛陈旧 running 会话为 failed（数据完好，可经 resume 重建上下文）。
   *
   * ## 为什么必须有
   * run() 中途 admin-api 崩溃/重启 → 会话永久停在 running：B-8 的 resume
   * 409 只拦「非 running」调用方，而没有任何机制把 running 收敛——
   * steps 与 tool_calls 数据完好、可完整重建上下文，状态机却锁死，只能改库。
   *
   * ## 心跳语义（零新列）
   * `updatedAt`（@UpdateDateColumn）即天然租约：运行中的会话每轮推理都
   * appendStep / recordToolCall（≥每 2-3 分钟一次），每次都自动刷新它。
   * 阈值 30 分钟（对齐 detectStuckDeployments 的 DEPLOYING 判死口径）：
   * 单轮 LLM 重试最坏 ~8s×3 + 工具批 ~10×60s ≈ 11 分钟，30 分钟已高于
   * 任何合法无步进窗口。
   *
   * ## 收敛为 failed 而不是直接重入队
   * 崩溃瞬间的执行位置未知（可能停在工具副作用中途）——盲目 resume 有
   * 双份副作用风险（GAP-1 的 fence 只保证单 worker，不保证「上次执行到
   * 哪」可续）。如实判 failed + errorMessage 指明可 resume：管理员或自动
   * 链路按需 resume（重建上下文后模型看到事实状态，重新规划未完成的
   * 副作用），与桌面端「崩溃重领整单重跑」同一保守取向。
   */
  async sweepStaleRunning(now: Date = new Date()): Promise<string[]> {
    const staleBefore = new Date(now.getTime() - STALE_RUNNING_TIMEOUT_MS);
    const stale = await this.sessions.find({
      where: { status: "running", updatedAt: LessThan(staleBefore) },
      select: { id: true },
      take: 1000,
    });
    const swept: string[] = [];
    for (const { id } of stale) {
      // 条件写：仍 running 才收敛——与运行中的 finish 竞态时让位
      // （心跳刚刷新的行 updatedAt 已离开谓词，这层是双保险）。
      const res = await this.sessions.update(
        { id, status: "running" },
        {
          status: "failed",
          finishedAt: now,
          waitingFor: null,
          errorMessage: STALE_RUNNING_MESSAGE,
        },
      );
      if ((res.affected ?? 0) > 0) swept.push(id);
    }
    if (swept.length > 0) {
      this.logger.warn(
        `Agent stale-running sweep: ${swept.length} session(s) converged to failed ` +
          `(no progress for >${Math.round(STALE_RUNNING_TIMEOUT_MS / 60_000)}min) — resumable via resume API`,
      );
    }
    return swept;
  }
}
