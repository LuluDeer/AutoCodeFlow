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
// OBS3-02：工具指标 label 的有界化（未知名字 → "unknown"）
import { AGENT_TOOL_BY_NAME } from "../tools/tool-registry";
import { AgentNotifyService } from "./agent-notify.service";
import {
  AGENT_APPROVAL_TTL_MS,
  AgentApprovalsService,
} from "./agent-approvals.service";
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

/**
 * PK-19 续：waiting_input 会话的**总**等待上限（30 天）。
 *
 * 审批单已有 7 天 TTL；但 waiting_input 还包含「等待澄清」等人工输入面——
 * 它们没有 TTL 时同样会永久挂着。30 天是「这条会话已经没人管了」的保守线：
 * 到期收敛为 failed 并写明原因（用户可重新发起），而不是永远占着列表。
 */
export const STALE_WAITING_INPUT_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

/** 陈旧 running 收敛时的 errorMessage（如实指明发生了什么 + 恢复路径）。 */
export const STALE_RUNNING_MESSAGE =
  "会话执行中断（admin-api 进程重启/崩溃，超过 30 分钟无任何步进）——" +
  "会话数据完好，可在排查后经 resume 重建上下文继续";

/**
 * appendStep 的 seq 冲突重试上限（含首次）。
 *
 * 3 次足够：并发窗口来自「清扫+恢复」这类一次性交错，重算 MAX(seq) 后第二次
 * 基本必成；无限重试会在真正的死锁/约束错误上变成挂起。
 */
const APPEND_STEP_MAX_RETRIES = 3;

/** Postgres 唯一约束冲突（23505）。TypeORM 把驱动错误原样抛出。 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { code?: unknown }).code === "23505";
}

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
  /** G4 发起人（`user:<username>` / `system:<cron|event>`；缺省 NULL=未知）。 */
  createdBy?: string | null;
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
    // PK-19：审批单 TTL 收口（@Optional——既有单测直接 new 装配时缺席，
    // 缺席即跳过超时扫描，不影响其它行为）。
    @Optional()
    private readonly approvals: AgentApprovalsService | null = null,
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
      createdBy: input.createdBy ?? null,
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
  /**
   * 批量取会话状态（第 6 轮审计 P2：SOP 澄清兜底扫描的 2×N 点查收敛）。
   * 只投影 id/status——调用方只需要状态，别把 contextJson/resultJson 搬出来。
   */
  async findStatusByIds(
    ids: readonly string[],
  ): Promise<Array<{ id: string; status: string }>> {
    if (ids.length === 0) return [];
    return this.sessions.find({
      where: { id: In([...ids]) },
      select: { id: true, status: true },
    });
  }

  async listSteps(sessionId: string): Promise<AgentStep[]> {
    return this.steps.find({
      where: { sessionId },
      order: { seq: "ASC" },
    });
  }

  /**
   * 按 (sessionId, toolCallId) 取单行（第 6 轮审计 P1：在途台账/幂等判定的读面）。
   * 投影只取判定所需字段，避免把 resultJson 大字段搬进执行热路径。
   */
  async findToolCall(
    sessionId: string,
    toolCallId: string,
  ): Promise<Pick<
    AgentToolCall,
    "status" | "toolName" | "resultJson" | "resultTruncated" | "errorMessage"
  > | null> {
    if (!toolCallId) return null;
    return this.toolCalls.findOne({
      where: { sessionId, toolCallId },
      select: {
        status: true,
        toolName: true,
        resultJson: true,
        resultTruncated: true,
        errorMessage: true,
      },
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
  async markRunning(id: string, expectWaitingFor?: string): Promise<boolean> {
    // B-8：CAS 双保险——只有「非 running 且未终态」的会话能被置 running。
    // ① 双 worker 领到同一会话（重复入队的残余窗口）时只有一方真正置态；
    // ② 防住把终态会话拉回 running 的状态机倒退。
    //
    // RT-3：`expectWaitingFor` 是**唤醒凭据**。delayed job 在 60s 后才执行，
    // 期间会话可能已被人工 resume 并走到「等审批」；不带凭据的唤醒会把
    // waiting_input(审批) 无条件翻成 running，审批门在模型眼里退化成拒绝。
    // 用 `IS NOT DISTINCT FROM` 而不是 `=`：既允许 NULL 语义（存量/手工
    // 路径显式传 undefined 时不加这段谓词），也让 SQL 三值逻辑不误挡。
    const qb = this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({
        status: "running",
        waitingFor: null,
        ...((await this.shouldSetStartedAt(id))
          ? { startedAt: new Date() }
          : {}),
      })
      .where(
        "id = :id AND status <> 'running' AND status NOT IN (:...terminal)",
        {
          id,
          terminal: AGENT_TERMINAL_STATUSES,
        },
      );
    if (expectWaitingFor !== undefined) {
      qb.andWhere('"waitingFor" IS NOT DISTINCT FROM :expect', {
        expect: expectWaitingFor,
      });
    }
    const res = await qb.execute();
    return (res.affected ?? 0) > 0;
  }

  /**
   * 本次启动是否要写 startedAt（= 是否给一个新的墙钟窗口）。
   *
   * 两条触发条件：
   *  ① 从来没有 startedAt（首跑）；
   *  ② **从 waiting_input 恢复**（审批 / 澄清 / 自动续跑）——等待期间人
   *     和外部系统花的时间不该记在 Agent 的工作预算里。此前只在首跑置位，
   *     于是「30 分钟墙钟 + 30 分钟才批准」的审批必然在恢复后第一轮就被
   *     `budget_exceeded` 判死：模型一次没被调用、审批单永久 granted 未消费、
   *     controller 又拒绝恢复 budget_exceeded ⇒ 死局（数据审计 #1）。
   *
   * 为什么不会变成「无限续命」：每次恢复都需要**外部事件**（人工审批、
   * 执行器答复、一次性的自动续跑额度），不是循环自激；成本闸门（steps /
   * tokens / toolCalls）始终按会话累计，不因恢复清零。
   */
  private async shouldSetStartedAt(id: string): Promise<boolean> {
    const s = await this.sessions.findOne({
      where: { id },
      select: { id: true, startedAt: true, status: true },
    });
    if (!s?.startedAt) return true;
    return s.status === "waiting_input";
  }

  /**
   * GAP-3：领取「本会话的自动续跑额度」。
   *
   * 语义 = 「每会话最多自动补跑一次」。用**条件写**而不是「先读后判」：
   * 多个 admin-api 副本可能同时判定同一次 LLM 耗尽（各自的重试循环独立），
   * 读时判断会让每个副本都排一个 delayed job —— provider 抖动就被放大成
   * 重试风暴。`autoResumeCount < max` 保证只有一个赢家，与 GAP-1 的
   * markRunning、ADR-026 的条件写是同一条纪律。
   *
   * 谓词里带「非终态」：若此刻会话已被别的路径收敛（人工 abort、预算触顶），
   * 续跑已经没有意义——命中 0 行即放弃，调用方按普通 failed 收敛。
   *
   * @returns 是否赢得本次自动续跑资格（affected > 0）。
   */
  async claimAutoResume(id: string, max = 1): Promise<boolean> {
    const limit = Number.isInteger(max) && max > 0 ? max : 1;
    const res = await this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({ autoResumeCount: () => `"autoResumeCount" + 1` })
      .where(
        `id = :id AND "autoResumeCount" < :limit AND status NOT IN (:...terminal)`,
        { id, limit, terminal: [...AGENT_TERMINAL_STATUSES] },
      )
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /**
   * 把终态（failed / budget_exceeded）的会话重新打开为 pending，用于显式
   * resume（GAP-6）。
   *
   * ## 为什么需要它
   * `run()` 对终态一律短路让位（幂等的第一道保证），而 `markRunning` 的
   * CAS 又显式排除终态。于是「对 failed 会话点恢复」此前是**静默 no-op**：
   * controller 返回 `{ok:true}`、job 入队、`run()` 立刻以 failed 返回，
   * 什么都没发生——运维看到的是「点了没反应」，而日志里连一条警告都没有。
   *
   * 正确做法是把「重开」显式化成一次条件状态迁移：只有 failed /
   * budget_exceeded 能被重开（succeeded / aborted 的结果已兑现，重跑等于
   * 让状态机倒退），且用条件写防止与并发收敛撞车。
   *
   * ## RT-2：为什么**要**重置 startedAt
   * 旧实现的注释是「墙钟不可通过 resume 续命」，但那条纪律的真正对象是
   * **自动**续命（一个会话被反复 grant 审批无限延长）。对人工 reopen 它
   * 造成了数学上的死路：陈旧 running 清扫阈值 = 出厂墙钟预算 = 30min，
   * 「被清扫」蕴含 elapsed 已 ≥ 30min，于是恢复后第一轮闸门立刻
   * budget_exceeded——GAP-2 写在 errorMessage 里的「可 resume 继续」、
   * sweep 日志里的 resumable、GAP-6 的恢复能力全是空头支票。
   *
   * 重置只发生在**人工显式恢复**这一条路径上（`resume` 端点），且成本闸门
   * 仍然累计：maxSteps / maxTokens / maxToolCalls 都是会话级累加，不因
   * 重开清零。墙钟是「防卡死」的活性闸门，不是计费闸门——给人工重试一个
   * 新窗口是它的正确语义（同 langgraph：恢复是一次新的 run，有自己的超时）。
   * 自动续跑（auto_resume）与审批 grant 都不经过这里，墙钟不会自增。
   *
   * 不清理 errorMessage（重开是「再试一次」不是「抹掉上次失败」；成功终态
   * 会自然覆盖它）。
   *
   * @returns 是否重开成功（false = 状态已变化或不是可重开的状态）。
   */
  async reopenForResume(id: string): Promise<boolean> {
    // 数据审计 #2：steps 已被保留期清理的会话不能重开——rebuildMessages 会
    // 拿到空历史（totalSteps 仍是旧值），模型在「没有过去」的情况下重规划，
    // 把已发生的写操作再做一遍。用 EXISTS 条件写消掉「检查→删除→重开」的
    // 竞态：只要 steps 已经没了（且确实跑过），重开命中 0 行。
    const qb = this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({
        status: "pending",
        waitingFor: null,
        startedAt: new Date(),
        finishedAt: null,
      })
      .where("id = :id AND status IN (:...resumable)", {
        id,
        resumable: ["failed", "budget_exceeded"],
      })
      .andWhere(
        `("totalSteps" = 0 OR EXISTS (
          SELECT 1 FROM "agent_steps" st WHERE st."sessionId" = "agent_sessions"."id"
        ))`,
      );
    const res = await qb.execute();
    if (!res.affected) {
      this.logger.warn(
        `reopenForResume(${id}) skipped — session is not in a resumable terminal state`,
      );
    }
    return (res.affected ?? 0) > 0;
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

    // 数据审计 #3：注释承诺「唯一约束会让后者失败并重试」，但实现此前没有任何
    // 重试——23505 直接逃出 appendStep，而 run() 没有兜住它的 catch，最终被
    // AgentProcessor 的「不重抛」策略吞掉：会话停在 running、没有 worker，
    // 只能等 30 分钟陈旧清扫，且 errorMessage 误报「进程崩溃」。
    //
    // 并发来源是真实存在的：陈旧清扫把会话判 failed → 人工 resume → 旧 worker
    // 的慢工具批刚好结束、继续写 step；或两个副本在 CAS 窗口内交错。重算
    // MAX(seq) 后重试即可收敛（每次事务内读到的 max 已包含对方写入）。
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.appendStepOnce(sessionId, input, tokensIn, tokensOut);
      } catch (err: unknown) {
        if (attempt + 1 >= APPEND_STEP_MAX_RETRIES || !isUniqueViolation(err)) {
          throw err;
        }
        this.logger.warn(
          `appendStep seq conflict (attempt ${attempt + 1}/${APPEND_STEP_MAX_RETRIES}), retrying: session=${sessionId}`,
        );
        // 小幅错开，避免两个 writer 以同一节奏反复撞车
        await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 10));
      }
    }
  }

  /** appendStep 的单次事务体（seq 分配 + step 写入 + 用量累加，同事务）。 */
  private async appendStepOnce(
    sessionId: string,
    input: AppendStepInput,
    tokensIn: number,
    tokensOut: number,
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

      // 令牌指标（成本归因）：第三个参数是**令牌数量**，不是 +1。
      // 少了它这张指标只是「有令牌的步数」，按它算成本会低 2~3 个数量级。
      if (tokensIn > 0) {
        recordRuntime(
          "autoflow_agent_tokens_total",
          {
            provider: input.provider ?? "unknown",
            model: input.model ?? "unknown",
            direction: "in",
          },
          tokensIn,
        );
      }
      if (tokensOut > 0) {
        recordRuntime(
          "autoflow_agent_tokens_total",
          {
            provider: input.provider ?? "unknown",
            model: input.model ?? "unknown",
            direction: "out",
          },
          tokensOut,
        );
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
  /**
   * 就地更新一次已存在的工具调用记录（TOOLS-02 确定性重放）。
   *
   * 为什么需要「更新」而不是再插一行：重放已批准的调用时，模型当时给的
   * `tool_call id` 与台账里那条 `awaiting_approval` 行**相同**；GAP-5 的
   * `(sessionId, toolCallId)` 唯一索引会直接拒绝第二次 insert。就地更新
   * 同时保证「一次调用只对应一行台账」，审计面不会出现一调用两行。
   *
   * **不累加 totalToolCalls**：挂起时那一行已经计过一次（recordToolCall 里
   * 的 SQL 自增）；这里再自增会让「工具调用数」预算凭空多消耗一次。
   *
   * @returns 是否命中（false = 行不存在/已被别的路径更新）。
   */
  async updateToolCallByToolCallId(
    sessionId: string,
    toolCallId: string,
    patch: {
      toolName: string;
      tier: AgentToolTier;
      status: AgentToolCallStatus;
      args?: Record<string, unknown> | null;
      result?: Record<string, unknown> | null;
      resultTruncated?: boolean;
      errorMessage?: string | null;
      durationMs?: number;
    },
  ): Promise<boolean> {
    const res = await this.toolCalls.update(
      { sessionId, toolCallId },
      {
        argsJson: patch.args ?? null,
        resultJson: patch.result ?? null,
        resultTruncated: patch.resultTruncated ?? false,
        status: patch.status,
        errorMessage: patch.errorMessage ?? null,
        durationMs: patch.durationMs ?? 0,
      },
    );
    if (!res.affected) return false;
    recordRuntime("autoflow_agent_tool_calls_total", {
      tool: this.metricToolLabel(patch.toolName),
      tier: patch.tier,
      status: patch.status,
    });
    return true;
  }

  /**
   * OBS3-02（第 3 轮观测审计）：把模型给的工具名收敛成**有界**的指标 label。
   *
   * 指标 label 直接取 `call.function.name` 等于把基数交给模型：每次编一个新
   * 名字就是一个新 series（Prometheus 基数爆炸、渲染内存随会话线性增长）。
   * 注册表里的工具名是闭集，不在其中的一律归并成 "unknown"——审计仍能看到
   * 「有越界调用」，但不会为每个幻觉名字建一条永久 series。
   */
  private metricToolLabel(toolName: string): string {
    return AGENT_TOOL_BY_NAME.has(toolName) ? toolName : "unknown";
  }

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
      tool: this.metricToolLabel(input.toolName),
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
  /**
   * PK-19 续：等待人工输入的会话超时收口（30 天）。
   *
   * 审批面由 `sweepStaleApprovals`（7 天）处理；这里兜住「等待澄清」等其它
   * waiting_input 场景——它们没有 TTL 时同样永久挂起。仍挂在**未过期**审批上的
   * 会话跳过（交给审批 TTL 流程，避免两套规则互相抢）。
   */
  async sweepAbandonedWaitingInput(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_WAITING_INPUT_TIMEOUT_MS);
    const rows = await this.sessions.find({
      where: { status: "waiting_input", updatedAt: LessThan(cutoff) },
      select: { id: true, waitingFor: true },
    });
    let converged = 0;
    for (const row of rows) {
      if (
        row.waitingFor?.startsWith("等待审批") &&
        this.approvals &&
        (await this.approvals.hasPendingForSession(row.id))
      ) {
        continue;
      }
      await this.finish(row.id, "failed", {
        errorMessage:
          "等待输入超时：30 天内无人工输入，会话已收敛。数据完好；如需继续请重新发起。",
      });
      converged += 1;
    }
    if (converged > 0) {
      this.logger.warn(
        `Agent waiting-input sweep: ${converged} abandoned session(s) converged to failed`,
      );
    }
    return converged;
  }

  /**
   * PK-19：审批单超时收口（与 stale-running 同一 cron / 同一 Leader 门禁）。
   *
   * 只处理「pending 超过 TTL」的单：标 expired，并把**仍挂在该审批上**的
   * 会话收敛为 failed。判定三要素缺一不可：
   *   ① 会话仍是 waiting_input（人可能已批准并恢复，不能再覆盖）；
   *   ② waitingFor 是审批（澄清/自动续跑的等待不能被这条扫掉）；
   *   ③ 该会话已无 pending 单（同一批里可能有多张，全部过期才收敛）。
   * 其余情况交给原流程——宁可少收，不可误杀正在等待输入的会话。
   */
  async sweepStaleApprovals(now: Date = new Date()): Promise<number> {
    if (!this.approvals) return 0;
    const cutoff = new Date(now.getTime() - AGENT_APPROVAL_TTL_MS);
    const { expired, sessionIds } = await this.approvals.expireStalePending(
      cutoff,
      now,
    );
    if (expired === 0) return 0;
    let converged = 0;
    for (const sessionId of sessionIds) {
      const session = await this.sessions.findOne({
        where: { id: sessionId },
        select: { id: true, status: true, waitingFor: true },
      });
      if (!session || session.status !== "waiting_input") continue;
      if (!session.waitingFor?.startsWith("等待审批")) continue;
      if (await this.approvals.hasPendingForSession(sessionId)) continue;
      await this.finish(sessionId, "failed", {
        errorMessage:
          "审批超时：7 天内无人工处置，会话已收敛。审批单已标记 expired；" +
          "如需继续，请重新发起（模型会重新申请审批）。",
      });
      converged += 1;
    }
    if (converged > 0) {
      this.logger.warn(
        `Agent approval TTL sweep: ${expired} approval(s) expired, ${converged} session(s) converged to failed`,
      );
    }
    return converged;
  }

  async sweepStaleRunning(now: Date = new Date()): Promise<string[]> {
    const staleBefore = new Date(now.getTime() - STALE_RUNNING_TIMEOUT_MS);
    const stale = await this.sessions.find({
      where: { status: "running", updatedAt: LessThan(staleBefore) },
      select: { id: true, kind: true },
      take: 1000,
    });
    const swept: string[] = [];
    for (const { id, kind } of stale) {
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
      if ((res.affected ?? 0) > 0) {
        swept.push(id);
        // RT-4：清理路径绕开 finish() 时必须自己补上观测面，否则
        // autoflow_agent_sessions_total 与库内事实漂移（看板少计一类终态）。
        recordRuntime("autoflow_agent_sessions_total", {
          kind,
          status: "failed",
        });
      }
    }
    if (swept.length > 0) {
      this.logger.warn(
        `Agent stale-running sweep: ${swept.length} session(s) converged to failed ` +
          `(no progress for >${Math.round(STALE_RUNNING_TIMEOUT_MS / 60_000)}min) — resumable via resume API`,
      );
      // RT-4：一条聚合 ERROR（不是每会话一条）——崩溃中断是最需要人介入的
      // 失败，此前完全不出现在告警渠道里。notify 自身 fail-open，不阻塞清扫。
      await this.notify.staleSweepConverged(
        swept,
        Math.round(STALE_RUNNING_TIMEOUT_MS / 60_000),
      );
    }
    return swept;
  }
}
