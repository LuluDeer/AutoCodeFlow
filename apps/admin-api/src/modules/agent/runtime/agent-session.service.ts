import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
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

/**
 * P2：会话生命周期与持久化。
 *
 * 本服务是推理循环的**唯一持久化入口**——AgentRuntimeService 不直接碰
 * repository。这样做的理由：steps 的 seq 分配必须原子（唯一约束），
 * 且「每步写完后同步累加会话用量」两者若分散在两个服务里，很容易出现
 * 用量与 steps 不一致（用量少了 → 预算闸门失效 → 会话跑飞）。
 * 收敛到一处，累加与写入在同一方法内，不会漂移。
 */

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
  ) {}

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
    if (!s) throw new NotFoundException(`Agent session ${id} not found`);
    return s;
  }

  async list(options: {
    kind?: AgentSessionKind;
    status?: AgentSessionStatus;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: AgentSession[]; total: number }> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));

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

  // ── 状态迁移 ────────────────────────────────────────────────────

  /**
   * 标记会话开始运行。
   * startedAt 只在第一次置位（resume 不重置）——否则墙钟预算会被反复续命，
   * 「单会话 30 分钟上限」形同虚设。
   */
  async markRunning(id: string): Promise<void> {
    await this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({
        status: "running",
        waitingFor: null,
        ...((await this.needsStartedAt(id)) ? { startedAt: new Date() } : {}),
      })
      .where("id = :id", { id })
      .execute();
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
    await this.sessions.update({ id }, { status: "waiting_input", waitingFor });
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

    await this.sessions.update(
      { id },
      {
        status,
        finishedAt: new Date(),
        waitingFor: null,
        resultJson: options.result ?? session.resultJson,
        summary: options.summary ?? session.summary,
        errorMessage: options.errorMessage ?? null,
      },
    );

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
        tokensIn: input.tokensIn ?? 0,
        tokensOut: input.tokensOut ?? 0,
        latencyMs: input.latencyMs ?? 0,
        provider: input.provider ?? null,
        model: input.model ?? null,
        summary: input.summary ?? null,
      });
      const saved = await em.save(step);

      // 用量累加与 step 写入同事务——分开写会出现「步数涨了用量没涨」
      // 的窗口，而预算闸门正是读用量。这一步是闸门可靠性的基础。
      await em
        .createQueryBuilder()
        .update(AgentSession)
        .set({
          totalSteps: () => '"totalSteps" + 1',
          totalTokensIn: () => `"totalTokensIn" + ${input.tokensIn ?? 0}`,
          totalTokensOut: () => `"totalTokensOut" + ${input.tokensOut ?? 0}`,
        })
        .where("id = :id", { id: sessionId })
        .execute();

      // 令牌指标（成本归因）
      if ((input.tokensIn ?? 0) > 0) {
        recordRuntime("autoflow_agent_tokens_total", {
          provider: input.provider ?? "unknown",
          model: input.model ?? "unknown",
          direction: "in",
        });
      }
      if ((input.tokensOut ?? 0) > 0) {
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
}
