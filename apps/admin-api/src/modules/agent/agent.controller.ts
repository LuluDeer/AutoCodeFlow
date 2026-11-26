import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
  Optional,
} from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { ParseUuidShapePipe } from "../../common/pipes/parse-uuid-shape.pipe";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiOkResponse,
  ApiCreatedResponse,
} from "@nestjs/swagger";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";
import type { Repository } from "typeorm";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import {
  AgentSessionService,
  buildEventBody,
} from "./runtime/agent-session.service";
import { AgentBacklogService } from "./runtime/agent-backlog.service";
import { AgentQueueStallService } from "./runtime/agent-queue-stall.service";
import { AgentQueueIdleService } from "./runtime/agent-queue-idle.service";
import { AgentBudgetService } from "./runtime/agent-budget.service";
import { AgentApprovalsService } from "./runtime/agent-approvals.service";
import { computeApprovalPolicyFingerprint } from "./runtime/agent-approvals.service";
import {
  ApprovalPhraseDto,
  ApprovalPhraseResponseDto,
} from "./dto/approval-phrase.dto";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/interfaces/auth-user.interface";
import { AGENT_QUEUE_NAME, type AgentJobData } from "./runtime/agent.processor";
import { manualResumeJobOptions } from "./runtime/agent-job-options";
import {
  AGENT_SESSION_KINDS,
  type AgentSession,
  type AgentSessionKind,
} from "./entities/agent-session.entity";
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
// ARCH-23 / N-12: Agent HTTP 面响应契约。
import {
  AgentBacklogResponseDto,
  AgentBudgetResponseDto,
  AgentQueueIdleResponseDto,
  AgentQueueStallResponseDto,
  AgentSessionCreateResponseDto,
  AgentSessionDetailResponseDto,
  AgentSessionListResponseDto,
  AgentSessionResumeResponseDto,
} from "./dto/agent-response.dto";
// R278：待办收件箱的服务端聚合（S1）。新 provider，controller 只加两条薄路由。
import { AgentInboxService } from "./runtime/agent-inbox.service";
import {
  AgentInboxCountsResponseDto,
  AgentPendingApprovalsResponseDto,
} from "./dto/agent-inbox.dto";
// R308：TTFV opt-in 授权闭环。依赖全部走模块已有 provider，不新增 module 接线。
import { SystemConfigService } from "../config/config.service";
import { SecretsCryptoService } from "../../common/utils/secret-crypto.util.service";
import {
  TelemetryOptinService,
  TTFV_SYSTEM_GATE_KEY,
} from "./runtime/telemetry-optin.service";
import { Executor } from "../executor/entities/executor.entity";
import { TelemetryOptin } from "./entities/telemetry-optin.entity";
import {
  AgentTelemetryConsentDto,
  AgentTelemetryConsentResultDto,
  AgentTelemetryStatusDto,
} from "./dto/agent-telemetry.dto";
// R325（北极星 business_confirmed）：显式确认端点只加一条薄路由，业务/emit
// 逻辑全在独立 service；此处仅做依赖缺席 503 与 404 映射。
import { AgentExecutionConfirmationService } from "./runtime/agent-execution-confirmation.service";
// R327（北极星双口径看板）：只读读面 service + 响应契约。与 telemetry/status
// 同面（class 级 JwtAuthGuard + ADMIN），不进 metrics 的 @Public 抓取面。
import { NorthStarMetricsService } from "./runtime/north-star-metrics.service";
import { AgentNorthStarResponseDto } from "./dto/agent-north-star.dto";
// N8：waiting_input 期 steer 意图的进程内 inbox（独立 provider，追加在构造末尾）。
import { SteerInboxService } from "./runtime/steer-inbox.service";

/**
 * R279：把 `since` query（ISO-8601）解析成 `Date`；**解析不出 ⇒ `undefined`（不筛）**。
 *
 * 为什么非法值回落「不筛」而不是 400：与 `clampPagination` / `stalled` 的既有口径
 * 一致 —— 非法深链必须安全回落，一个坏 query 不该让整页 500。「不筛」是**旧行为**，
 * 也就是最保守的那个分支（多给行，不少给行）。
 *
 * 为什么在这里解析而不是在 service：`sessions.list` 的入参已是 `Date`，类型收窄的
 * 责任留在 HTTP 边界；service 不掺进字符串解析（它也被 SOP 兜底等内部调用方复用）。
 */
function parseSinceParam(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  // `NaN` 的 Date 直接进 SQL 会把整条查询打成语法错 ⇒ 必须在这里拦掉。
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export class CreateAgentSessionDto {
  @ApiProperty({ enum: AGENT_SESSION_KINDS as unknown as string[] })
  @IsString()
  @IsIn(AGENT_SESSION_KINDS as unknown as string[])
  kind: AgentSessionKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  /**
   * 会话目标/上下文（如涉及的应用、任务、执行器）。交给 Agent 作为输入。
   * 用自由对象而非强类型 DTO：不同 kind 的上下文结构差异很大，拉平会得到
   * 大量可选字段且互相矛盾。
   */
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  /** 作用域约束（设计文档 03 §5.3）。不传 = 空 scope（不可操作任何资源）。 */
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  @IsOptional()
  @IsObject()
  scope?: Record<string, unknown>;
}

/** N8：POST /api/agent/sessions/:id/steer 的请求体。 */
export class AgentSteerDto {
  @ApiProperty({ description: "用户追加的 steer 正文（步边界注入下一轮模型）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  content: string;
}

/**
 * P2：Agent HTTP 面。
 *
 * 权限：**默认全部 ADMIN-only**；GCO §5 仅 `approvals/pending` 与 `inbox/counts`
 * 两个只读端点在方法级放行给普通用户（且按会话归属过滤，见 AgentInboxService）。
 * 理由与既有 ai 模块（N11/R11）一致——AI 配置面
 * 能改出站目标、能烧配额；Agent 更进一步，它能**改系统状态**（P3 之后）。
 * 一个能自主操作生产系统的入口，绝不能对普通用户开放。
 * 全局 RolesGuard 读 `@Roles` 元数据，无需额外 @UseGuards。
 */
@ApiTags("Agent")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller("agent")
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly sessions: AgentSessionService,
    private readonly budget: AgentBudgetService,
    private readonly approvals: AgentApprovalsService,
    @InjectQueue(AGENT_QUEUE_NAME) private readonly queue: Queue<AgentJobData>,
    // G4：四眼原则开关（@Optional——既有单测装配缺席时默认不启用）
    @Optional()
    private readonly config?: ConfigService | null,
    /**
     * R202：积压对账服务。
     *
     * ⚠️ **放在最后且 `@Optional`**：既有 5 个测试文件用**定位参数**装配本 controller
     * （`new AgentController(a, b, c, …)`）⇒ 插在中间会让它们全部错位（实测 13 条用例红）。
     * 生产里 Nest **一定**注入它（是 provider）⇒ 只有测试可能缺席。
     */
    @Optional()
    private readonly backlog?: AgentBacklogService | null,
    /**
     * R205：队列停摆观测服务。
     *
     * ⚠️ **同样放在最后且 `@Optional`**：既有测试文件用**定位参数**装配本 controller
     * （R202 教训：插在中间会让 5 个文件全部错位 ⇒ 13 条用例红）。
     */
    @Optional()
    private readonly queueStall?: AgentQueueStallService | null,
    /**
     * R207：队列空转观测服务。
     *
     * ⚠️ **同样放在最后且 `@Optional`**：既有测试文件用**定位参数**装配本 controller
     * （R202/R205 两次教训：插在中间会让既有文件全部错位）。
     */
    @Optional()
    private readonly queueIdle?: AgentQueueIdleService | null,
    /**
     * R278：待办收件箱的服务端聚合。
     *
     * ⚠️ **同样放在最后且 `@Optional`**（R202/R205/R207 三次教训）：既有 spec 用
     * 定位参数装配本 controller，插在中间会让它们全部错位。缺席 ⇒ 路由显式抛
     * `DEPENDENCY_UNAVAILABLE`（503），绝不回 200 空信封。
     */
    @Optional()
    private readonly inbox?: AgentInboxService | null,
    /**
     * R308：以下依赖必须继续追加在末尾且 `@Optional`。
     * R202/R205/R207/R278 已有 5 次教训：既有 spec 用定位参数装配本 controller，
     * 插在中间会让它们整体错位。生产装配里这些 provider 均存在（AgentModule 已
     * 引入 SystemConfigModule / TaskModule / forFeature(Executor, TelemetryOptin)）；
     * 缺席时相关端点显式 503，绝不回 200 空状态。
     */
    @Optional()
    private readonly systemConfig?: SystemConfigService | null,
    @Optional()
    private readonly telemetryOptin?: TelemetryOptinService | null,
    @Optional()
    private readonly secretsCrypto?: SecretsCryptoService | null,
    @Optional()
    @InjectRepository(Executor)
    private readonly executors?: Repository<Executor> | null,
    @Optional()
    @InjectRepository(TelemetryOptin)
    private readonly optinRows?: Repository<TelemetryOptin> | null,
    /**
     * R325：北极星「被业务确认」显式确认 service。
     *
     * ⚠️ **同样追加在末尾且 `@Optional`**（R202/R205/R207/R278 + R308 教训）：
     * 既有 spec 用定位参数装配本 controller，插在中间会让它们整体错位。
     * 生产装配里 provider 由主 agent 在 AgentModule 统一接线；缺席时端点
     * 显式抛 `DEPENDENCY_UNAVAILABLE`（503），绝不回 200 空信封。
     */
    @Optional()
    private readonly confirmation?: AgentExecutionConfirmationService | null,
    /**
     * R327：北极星双口径周报读面。
     *
     * ⚠️ **同样追加在末尾且 `@Optional`**（R202/R205/R207/R278/R308/R325
     * 教训）：既有 spec 用定位参数装配本 controller，插在中间会让它们整体错位。
     * 生产装配里 provider 由 AgentModule 注册；缺席时端点显式 503，绝不回
     * 200 空信封（「读不到」不能伪装成「没有数据」）。
     */
    @Optional()
    private readonly northStarMetrics?: NorthStarMetricsService | null,
    /**
     * N8：steer inbox provider。
     *
     * ⚠️ **同样追加在末尾且 `@Optional`**（R202/R205/R207/R278/R308/R325/R327
     * 教训）：既有 spec 用定位参数装配本 controller，插在中间会让它们整体错位。
     * 生产装配里 provider 由 AgentModule 注册；缺席时端点显式 503，绝不回
     * 200 空信封。
     */
    @Optional()
    private readonly steerInbox?: SteerInboxService | null,
  ) {}

  @Get("sessions")
  @ApiOperation({ summary: "列出 Agent 会话（最新在前）" })
  // N-12: 裸分页 {items,total}（与 /sop 同形态，无页元数据）。
  @ApiOkResponse({ type: AgentSessionListResponseDto })
  // R292：具名 @Query 运行期全可选；Swagger 默认推断 required:true，逐个显式标注。
  @ApiQuery({ name: "kind", required: false, type: String })
  @ApiQuery({ name: "status", required: false, type: String })
  @ApiQuery({ name: "page", required: false, type: String })
  @ApiQuery({ name: "stalled", required: false, type: String })
  @ApiQuery({ name: "stalledMinutes", required: false, type: String })
  @ApiQuery({ name: "pageSize", required: false, type: String })
  @ApiQuery({ name: "since", required: false, type: String })
  async list(
    @Query("kind") kind?: AgentSessionKind,
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("stalled") stalled?: string,
    @Query("stalledMinutes") stalledMinutes?: string,
    @Query("pageSize") pageSize?: string,
    /**
     * R279：只列 `createdAt >= since` 的会话（ISO-8601），供收件箱的
     * 「Agent 会话失败」小节取窗口内的行数据（`?status=failed&since=<ISO>`）。
     *
     * ⚠️ **缺省 = 不筛 = 旧行为完全不变**：既有调用方（列表页、深链、SOP 兜底）
     * 都不传它，谓词一条不多。非法值/无法解析 ⇒ 同样**不筛**（与 `clampPagination`
     * 的「非法深链安全回落、绝不 400」同一契约），绝不因一个坏 query 让整页 500。
     */
    @Query("since") since?: string,
  ) {
    const result = await this.sessions.list({
      kind,
      status: status as never,
      // R199：只有显式传 `1`/`true` 才开启过滤（其余一律**不过滤**，保持旧行为）。
      stalled:
        stalled === "1" || stalled === "true"
          ? {
              minutes: stalledMinutes
                ? parseInt(stalledMinutes, 10)
                : undefined,
            }
          : undefined,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      since: parseSinceParam(since),
    });
    return result;
  }

  /**
   * R202：**「调度积压」对账**（判据见 `docs/observability/agent-backlog-criterion.md`）。
   *
   * 返回「`pending` 却永远不会被执行」的会话（`queue.add` 失败 / job 已终结）。
   *
   * ## 为什么是**独立端点**而不是给 `list` 加过滤（R386）
   * ① `list` 的**调用计数**是既有多个用例的断言对象 ⇒ 混进「对账」会静默打乱它们
   *    （R198 实测过这个坑：3 个用例从绿变红）；
   * ② 两者的**数据源根本不同**：`list` 查库，本端点要**逐个问队列**（`queue.getJob`）；
   * ③ 本端点是**诊断**语义（对账），不是列表语义 —— 它没有分页、没有 kind 过滤。
   *
   * ⚠️ **`truncated` 字段是防假事实的**：对账有上限（`BACKLOG_PROBE_LIMIT`），
   * 若截断了却不说，运营看到 `count = 3` 会以为「一共就 3 条」，而实际可能有几百条。
   */
  @Get("sessions/backlogged")
  @ApiOperation({
    summary: "列出「调度积压」的会话（pending 但队列里没有对应 job）",
  })
  // R221：补 response schema（此前只有 {"200":{"description":""}}）。
  @ApiOkResponse({ type: AgentBacklogResponseDto })
  async backlogged(): Promise<{
    sessionIds: string[];
    count: number;
    probed: number;
    truncated: boolean;
  }> {
    // ⚠️ 服务缺席（只可能发生在测试装配里）⇒ **显式报不可用**，绝不谎报「0 条积压」
    //   （「没读到」渲染成「没有」是本仓主导缺陷类，见 R188–R201）。
    if (!this.backlog) {
      throw new AppError(ErrorCode.AGENT_BACKLOG_CHECK_UNAVAILABLE, {});
    }
    return this.backlog.findBacklogged();
  }

  /**
   * R205：**队列停摆**观测。
   *
   * 判据见 `docs/observability/agent-queue-stall-criterion.md`。
   *
   * ⚠️ **`degraded` 字段是防假事实的**：结构性观测量（`active`/`workers`/`paused`）读失败时
   * 我们会返回 `stalled: false`（不因一个计数读失败就断言停摆 —— **误报**代价更大），
   * 但**必须**用 `degraded: true` 告诉调用方「这个判定**不完整**」⇒ 前端据此显示「**未知**」。
   *
   * ⚠️ R211：`degraded` 的语义**收窄**为「可能**误报**」。计数类（`waiting`/`delayed`/
   * `prioritized`）读失败只会让 `pendingJobs` 变小（**更难**判停摆 ⇒ 漏报），记在
   * `degradedCounts` —— 它**不改变结论**，只在已报停摆时补「在排队数可能不止这些」。
   * `workersKnown: false` 表示 `workers === 0` **不是事实**（只是回落值）。
   * 三者的方向差异见判据文档 §3.5。
   */
  @Get("sessions/queue-stall")
  @ApiOperation({ summary: "队列是否停摆（有活排队但结构上没人能消费）" })
  // R211：补 response schema —— 此前该端点只有 `{"200":{"description":""}}`，
  // 新增字段在契约面**完全不可见**（前端只能手写类型，且漂移无人发现）。
  @ApiOkResponse({ type: AgentQueueStallResponseDto })
  async inspectQueueStall(): Promise<{
    stalled: boolean;
    reason: string | null;
    pendingJobs: number;
    degraded: boolean;
    degradedCounts: boolean;
    workersKnown: boolean;
  }> {
    if (!this.queueStall) {
      // ⚠️ 服务缺席 ⇒ **显式报不可用**，绝不谎报「队列正常」。
      throw new AppError(ErrorCode.AGENT_QUEUE_STALL_CHECK_UNAVAILABLE, {});
    }
    const r = await this.queueStall.inspect();
    return {
      stalled: r.stalled,
      reason: r.reason,
      pendingJobs: r.pendingJobs,
      // R211：三个位**都要透出**，少一个前端就没法区分「可能误报」/「可能漏报」/「workers 未知」。
      degraded: r.degraded,
      degradedCounts: r.degradedCounts,
      workersKnown: r.workersKnown,
    };
  }

  /**
   * R207：**队列空转**观测（worker 在册却不再消费新 job）。
   *
   * 判据见 `docs/observability/agent-queue-idle-criterion.md`。
   *
   * ⚠️ 与 `sessions/queue-stall` **互补**（不是重复）：停摆问「**有没有人**能消费」，
   * 空转问「**有人、却不再消费**」。⇒ 判定顺序上停摆优先，本端点用
   * `suppressedBy: "queue-stall"` 显式声明让位，避免同一现象点亮两个徽标。
   *
   * ⚠️ **`degraded` + `thresholdMs` + `basis` 都是契约的一部分**：
   * ① 读失败时返回 `idleStuck: false` 是**不完整的判定**，不标出来就等于谎报「正常」；
   * ② 只给阈值不给推导依据，下一次调参就会变成改魔法数（R403）。
   */
  @Get("sessions/queue-idle")
  @ApiOperation({
    summary: "队列是否空转（worker 在册却不再消费新 job）",
  })
  @ApiOkResponse({ type: AgentQueueIdleResponseDto })
  async inspectQueueIdle(): Promise<{
    idleStuck: boolean;
    oldestAgeMs: number;
    thresholdMs: number;
    waitingCount: number;
    retried: boolean;
    suppressedBy: "queue-stall" | null;
    degraded: boolean;
    basis: {
      wallClockMs: number;
      concurrency: number;
      tickMs: number;
      thresholdMs: number;
      formula: string;
    };
  }> {
    if (!this.queueIdle) {
      // ⚠️ 服务缺席 ⇒ **显式报不可用**，绝不谎报「队列在正常消费」。
      throw new AppError(ErrorCode.AGENT_QUEUE_IDLE_CHECK_UNAVAILABLE, {});
    }
    return this.queueIdle.inspect();
  }

  @Get("sessions/:id")
  @ApiOperation({ summary: "获取某个 Agent 会话及其步骤" })
  @ApiOkResponse({ type: AgentSessionDetailResponseDto })
  async detail(@Param("id", ParseUuidShapePipe) id: string) {
    const session = await this.sessions.requireById(id);
    const [steps, toolCalls, children] = await Promise.all([
      this.sessions.listSteps(id),
      this.sessions.listToolCalls(id),
      this.sessions.findChildren(id),
    ]);
    return { session, steps, toolCalls, children };
  }

  /**
   * 导出会话完整转录（排障/审计用）。
   *
   * 为什么需要：会话视图是分页/聚合的，复盘一次事故时需要**一份**自包含的
   * JSON（会话 + 全部步骤 + 工具调用 + 审批单），便于离线分析或附到工单。
   * 与「导出即包含凭据」无关：工具参数与结果在落库前已脱敏（见 tool-executor）。
   */
  @Get("sessions/:id/export")
  @ApiOperation({ summary: "导出 Agent 会话完整转录（JSON）" })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        exportedAt: { type: "string", format: "date-time" },
        session: { type: "object" },
        steps: { type: "array", items: { type: "object" } },
        toolCalls: { type: "array", items: { type: "object" } },
        approvals: { type: "array", items: { type: "object" } },
      },
    },
  })
  async exportSession(@Param("id", ParseUuidShapePipe) id: string) {
    const session = await this.sessions.requireById(id);
    const [steps, toolCalls, approvals] = await Promise.all([
      this.sessions.listSteps(id),
      this.sessions.listToolCalls(id),
      this.approvals.listForSession(id),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      session,
      steps,
      toolCalls,
      approvals,
    };
  }

  @Post("sessions")
  @ApiOperation({ summary: "创建一个 Agent 会话并入队执行" })
  // POST 无 @HttpCode → 实际 201。
  @ApiCreatedResponse({ type: AgentSessionCreateResponseDto })
  async create(
    @Body() dto: CreateAgentSessionDto,
    @CurrentUser() user?: { username?: string } | null,
  ) {
    // G4：记录**真实发起人**（审批四眼原则的数据基础）；缺主体时退化为
    // `user:unknown`（策略层按「不可判定」处理）。
    const actor = user?.username ? `user:${user.username}` : "user:unknown";
    const session = await this.sessions.create({
      kind: dto.kind,
      triggerSource: actor,
      createdBy: actor,
      title: dto.title,
      context: dto.context ?? null,
      scope: dto.scope ?? {},
    });

    await this.queue.add(
      "run",
      { sessionId: session.id, reason: "trigger:manual" },
      {
        // 会话 id 作为 jobId：同一会话不会被重复入队（resume 撞车时去重）
        jobId: session.id,
        // 失败不自动重试——重试会重复执行已发生的副作用（见 processor 注释）
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return { id: session.id, status: session.status };
  }

  /**
   * 手动恢复一个挂起/失败的会话。
   *
   * 用途：审批已通过、澄清已回复、或排查后想让它继续。走与首次运行**同一条**
   * `runtime.run()`（可重入），因此恢复语义与中断前完全一致。
   */
  @Post("sessions/:id/resume")
  @ApiOperation({ summary: "恢复挂起/失败的 Agent 会话" })
  // 终态会话 soft-fail {ok:false,reason}（200）；running 才 409（B-8）。
  @ApiCreatedResponse({ type: AgentSessionResumeResponseDto })
  async resume(@Param("id") id: string) {
    const session = await this.sessions.requireById(id);

    // 已兑现结果的终态不可恢复——重跑等于让状态机倒退，且副作用无法撤销。
    // 需要重跑请新建会话。
    if (session.status === "succeeded" || session.status === "aborted") {
      return {
        ok: false,
        reason: `会话已处于终态（${session.status}），请新建会话重跑`,
      };
    }

    // 已有 worker 持有执行权；409 让前端如实提示（resumable 列表同步排除 running）。
    if (session.status === "running") {
      throw new AppError("AGENT_SESSION_ALREADY_RUNNING");
    }

    // A1 执行侧闭环（实施轮 #14）：还有 pending 审批单时不允许绕过审批直接
    // 恢复。否则「审批」从门退化成通知——会话在未批准状态下继续推理并重提
    // 同一工具，管理员唯一的出口只剩拒绝。处置单之后再恢复（grant 会自动
    // 入队；deny 后此守卫自然放开，管理员可显式恢复）。
    if (await this.approvals.hasPendingForSession(id)) {
      throw new AppError("AGENT_SESSION_PENDING_APPROVAL", { sessionId: id });
    }

    // GAP-6：「失败可恢复」此前是**静默 no-op**——端点回 ok:true、job 入队、
    // run() 看到 failed（终态）立刻让位，什么都没发生。failed 的语义是
    // 「链路坏了/模型没给出结论」，不是「结果已兑现」，因此显式恢复是合理的；
    // 但必须先把状态重开成 pending（run() 与 markRunning 的 CAS 都排除终态）。
    //
    // budget_exceeded 不接受恢复：预算是创建时快照，且成本闸门（步数/令牌/
    // 工具调用）按会话累计、恢复不会清零——重开必然在下一次闸门立刻再次
    // 触顶。回 ok:false 比给一个假承诺诚实（此前同样静默 no-op）。
    // 注意：墙钟**会**因人工恢复而重开（RT-2），不要把它写进拒绝理由。
    if (session.status === "budget_exceeded") {
      return {
        ok: false,
        reason:
          "会话已触达预算上限（预算是创建时快照，步数/令牌/工具调用按会话累计、恢复不重置），请调大预算并新建会话",
      };
    }
    if (session.status === "failed") {
      // 数据审计 #2：保留期可能已清掉 steps（failed 是终态，>90 天会清）。
      // 此时恢复只会得到「没有过去」的上下文：totalSteps 仍是旧值、模型
      // 重新规划，把已发生的写操作再做一遍。宁可拒绝，也不做半截恢复。
      const steps = await this.sessions.listSteps(id);
      if (Number(session.totalSteps) > 0 && steps.length === 0) {
        return {
          ok: false,
          reason:
            "会话步骤已被保留期清理，无法重建上下文；请新建会话重跑（原会话的结论与台账仍可查看）",
        };
      }
      const reopened = await this.sessions.reopenForResume(id);
      if (!reopened) {
        return {
          ok: false,
          reason: "会话状态已变化或上下文已被清理，请刷新后重试",
        };
      }
    }

    await this.enqueueResume(session, "resume:manual");
    return { ok: true };
  }

  private enqueueResume(
    session: AgentSession,
    reason: "resume:manual" | "resume:approval",
  ) {
    const { id: sessionId, totalSteps } = session;
    return this.queue.add(
      "run",
      { sessionId, reason, expectTotalSteps: totalSteps },
      manualResumeJobOptions(
        sessionId,
        totalSteps,
        session.status === "failed",
      ),
    );
  }

  /** 当前生效的预算（供设置页展示与运维核对）。 */
  @Get("budget")
  @ApiOperation({ summary: "获取生效的 Agent 预算设置" })
  @ApiOkResponse({ type: AgentBudgetResponseDto })
  budgetInfo() {
    return this.budget.resolveBudget();
  }

  // ── A1 审批闭环（实施轮 #12）──────────────────────────────────────
  //
  // grant / deny 是 approvalRequired 工具（update_task / rollback_task_version /
  // upgrade_deployment / stop_deployment / sop_publish）从「声明可审批」变为
  // 「真的可审批」的另一半：申请在 ToolExecutorService.requestApproval 落库，
  // 这里提供人工处置端点，批准后复用既有 resume 链路恢复会话。

  /** 审批单处置的共享体：approve 与 deny 只差 decision 值。 */
  private async decideApproval(
    sessionId: string,
    approvalKey: string,
    decision: "granted" | "denied",
    user: AuthUser,
  ) {
    const session = await this.sessions.requireById(sessionId);
    const approval = await this.approvals.findByKey(approvalKey);
    if (!approval) {
      throw new AppError("AGENT_APPROVAL_NOT_FOUND", { approvalKey });
    }
    // 归属校验：审批单必须属于 URL 里的会话——防止拿 A 会话的审批键去
    // 处置 B 会话（审批单本身不校验调用方会话，谁持 ADMIN 谁可处置）。
    if (approval.sessionId !== session.id) {
      throw new AppError("AGENT_APPROVAL_SESSION_MISMATCH", { sessionId });
    }
    // G4（OSS 对照审计）：四眼原则——发起人不能批准自己发起的会话的审批单。
    // 默认关闭（单人部署/演示会被卡死），部署方显式开启后生效；发起人缺失
    // （存量行 NULL）时不可判定，只 warn 不拦（不假装有策略）。
    if (
      decision === "granted" &&
      this.config?.get<boolean>("agent.policy.blockSelfApproval") === true &&
      session.createdBy
    ) {
      if (session.createdBy === `user:${user.username}`) {
        throw new AppError("AGENT_APPROVAL_SELF_DENIED");
      }
    }
    // 条件写（pending → granted/denied）：并发处置撞上时后到者收 409。
    const row = await this.approvals.decide(
      approvalKey,
      decision,
      user.username,
    );
    if (!row) {
      throw new AppError("AGENT_APPROVAL_NOT_FOUND", { approvalKey });
    }

    // 处置结果的行为**按 decision 分流**（实施轮 #14 修）：
    //
    //   · granted → 若会话挂起在 waiting_input 且**没有其它仍在等的单**，
    //     重新入队恢复（重放同一调用时闸门会读到 granted 并放行一次）。
    //     仍有 pending 时先不恢复：恢复也只会立刻再次挂起，白烧一轮 LLM。
    //   · denied  → **不自动恢复**。原实现 deny 同样 resume，而模型手里没有
    //     「被拒绝」这一事实（回给它的最后一条是「已提交审批单」），最自然的
    //     下一步就是重提同一调用 → 再生成一张单 → 管理员只能无限拒绝，
    //     拒绝反而成了一个可持续驱动的执行/计费循环。这里把调用行按 denied
    //     落库（台账可辨），管理员若想让它继续，显式 resume 即可——那时
    //     rebuildMessages 会把「被拒绝」作为 tool 应答喂回模型。
    if (decision === "denied") {
      const settled = await this.sessions.settleToolCallByApprovalId(
        approvalKey,
        "denied",
        `已被 ${user.username} 人工拒绝（审批单 ${approvalKey}）——不得重试同一调用`,
      );
      // S7-G1 第五阶段：台账行**真的**被条件写成 denied 之后，补一条状态事件。
      // 判据是 `affected > 0`（而不是「deny 走到了这里」）：条件写钉住
      // `status='awaiting_approval'`，命中 0 行说明这一行已被别的路径写过
      // （已执行 / 已拒绝），**库里没变 ⇒ 事件也不能说变**——与 `approval_decided`
      // 同一条纪律（并发输家不得写出「批了/拒了」的事实）。
      if (settled > 0) {
        await this.emitToolCallSettledEvents(sessionId, approvalKey);
      }
    }

    let resumed = false;
    if (decision === "granted") {
      // 时序修复：worker 可能先落 pending 单、后 markWaiting；管理员在两者之间
      // grant 时 :611 的快照还是 running，而 markWaiting 触发的 wakeup probe
      // 见单仍 pending 会直接 return，随后本处若再信旧快照就不入队 ⇒ 会话永停
      // waiting_input、单永不 consume。这里在 decide 成功后重读会话，用最新
      // status/totalSteps 判定并入队；重读失败或为 null 时沿用原快照，不制造
      // 新的崩溃面（decide 前的 requireById 已钉住会话存在）。
      let freshSession = session;
      try {
        const reread = await this.sessions.findById(sessionId);
        if (reread) freshSession = reread;
      } catch {
        // 重读异常：沿用 decide 前快照，保持既有语义。
      }
      if (
        freshSession.status === "waiting_input" &&
        !(await this.approvals.hasPendingForSession(sessionId))
      ) {
        await this.enqueueResume(freshSession, "resume:approval");
        resumed = true;
      }
    }
    return {
      ok: true,
      approval: {
        approvalKey: row.approvalKey,
        status: row.status,
        decidedBy: row.decidedBy,
        decidedAt: row.decidedAt,
      },
      resumed,
    };
  }

  /**
   * deny 之后补一条 `tool_call_status_changed`（**旁路**：永不抛出）。
   *
   * ## 为什么这个写入点也**必须**发事件
   *
   * `agent_tool_calls.status` 是**就地覆盖**的（表里没有历史列）。S7-G1 因此把
   * 「每迁移一次就留一条事件」定成纪律——`updateToolCallByToolCallId` 早已照做。
   * 但 deny 走的是**另一条写入路径**：`settleToolCallByApprovalId` 的按
   * `approvalId` 条件 UPDATE，它此前只改库、不发事件。后果不是「少一条日志」：
   * 事件流里这次调用永远停在 `awaiting_approval`，于是同一段历史有两种说法——
   * 投影（按事件）说「【已被拒绝】不得重试」、快照（按台账行）说
   * 「【调用未成功】状态 denied：…」。事件投影与快照重建的双跑对账因此在这一
   * 条路径上永远差一句；切换读路径的那一天，模型看到什么就取决于走哪一条。
   *
   * ## 为什么落点在 `affected > 0` 之后（并发语义）
   *
   * 谓词钉住 `status='awaiting_approval'`：命中 0 行 = 已被别的路径写过
   * （执行完了 / 已被拒过），库里什么都没变 ⇒ 事件也不能说变了。若在 UPDATE
   * 之前（或无论命中与否）落事件，事件流就会多出一次**没有发生**的迁移，而投影
   * 正是拿它指挥模型的下一步。
   *
   * ## 为什么还要一次回读
   *
   * 事件的键是 `toolCallId`（投影按它归属调用），而 `settleToolCallByApprovalId`
   * 的谓词只有 `approvalId`，方法体内没有 `toolCallId` / `toolName` / `tier`。
   * 回读发生在 UPDATE **之后**，因此读到的必然是 settle 之后的当前行（不会把
   * 「还停在 awaiting_approval」的旧值写进事件）；payload 里的 `status` 也取行上
   * 的值，而不是调用侧期望的值——**事件只描述库里真的发生了什么**。
   * 正常一个 `approvalId` 只对应一行（一次审批 = 一次调用）；这里按行循环只是
   * 不为「万一多行」说谎。用的是既有读面 `listToolCalls`（会话级一次 SELECT，
   * deny 是人工低频动作）；刻意不为此在 session service 里加一个新的按
   * `approvalId` 的读方法——那会把这次改动扩散到另一个文件（写入点仍只有一处）。
   *
   * ## 正文为什么**必须**进事件（第六阶段补的缺口 ②）
   *
   * 此前这里只写 `errorMessage: "present"` 这个**存在性哨兵**，正文留在台账行上，
   * 于是「为什么被拒绝」这句话只能靠回读 `agent_tool_calls.errorMessage`。而那一
   * 列是**就地覆盖**的：本行之后若又被别的路径写一次（重放、二次 settle、人工
   * 修正），回读到的就不再是「deny 那一刻」的拒绝文案——偏偏「为什么被拒绝」
   * 正是模型下一步该依据的唯一关键信息（它决定模型是放弃该调用、改走别的工具，
   * 还是又原样重提一次）。**这条信息会随台账行被覆盖而丢失**，只有事件能把它
   * 钉在这次迁移上。
   *
   * 正文的形状与另两个写入点（`recordToolCall` / `updateToolCallByToolCallId`）
   * **逐字段同形**：`payload.body.{result|error}` = `{text, bytes, originalBytes,
   * truncated}`，脱敏走 `agent-session.service.ts` 的 `buildEventBody`（规则本体仍
   * 是 `tools/agent-sanitize.util.ts` 的 `sanitizeString`，本文件不自创规则），
   * 单条 2048B 截断 + `truncated` 标记 + `originalBytes` 记原文长度。读侧的
   * `readBody(payload, "error")` 早就按这个槽位取正文，因此投影**无需改动**。
   *
   * 存在性哨兵 `errorMessage: "present"` 原样保留：投影与守卫脚本都在按它判断
   * 「事件说这里有错误文案」，改语义会连带改读侧。
   *
   * ## 旁路（纪律 2）
   *
   * 读失败 / 写失败只 warn，不改变 deny 的结论——与 `tryAppendEvent` 的
   * 「永不抛出、失败返回 null」同款契约。代价写清楚：事件**可能缺失**，缺的那
   * 一段由投影侧的 `toolCallSettled` 缺口显式承认（而不是假装一致）。
   */
  private async emitToolCallSettledEvents(
    sessionId: string,
    approvalKey: string,
  ): Promise<void> {
    try {
      // A2 因果：这次 settle 是**被那条审批决定引起的**（管理员点了 deny）。
      // 起因在循环外解析一次（`approvalKey` 同一时刻唯一），而且**必须自成一道
      // try/catch**：`findEventSeqByRef` 可能不存在（既有单测替身只给
      // `listToolCalls`/`settleToolCallByApprovalId`）或解析时抖动——那种情况下
      // 只能丢掉**这条边**，绝不能连累下面的事件本身（旁路纪律：记账失败不得
      // 让一条真实的事件迁移消失）。取到 NULL 时事件照写，读侧会标
      // `resolvedBy: "heuristic"`——比「没有事件」好，比「假边」也诚实。
      //
      // 为什么起因不用 `tool_call_recorded`：这条迁移的**直接**原因是人按下了
      // 拒绝，不是当初那次申请。指向申请会让「谁在什么时候拒的、之后才落 denied」
      // 这段先后关系在因果图里消失（规则表 `tool_call_status_changed.cause` 的
      // 第二个分支，也是规则里唯一允许偏离「指向发起事件」的情形）。
      let causedBySeq: number | null = null;
      try {
        causedBySeq = await this.sessions.findEventSeqByRef(
          sessionId,
          "approval_decided",
          { approvalKey, status: "denied" },
        );
      } catch (err: unknown) {
        this.logger.debug(
          `causation resolve skipped (event still appended): session=${sessionId} ` +
            `key=${approvalKey} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const rows = await this.sessions.listToolCalls(sessionId);
      for (const row of rows) {
        // 只认「这次 settle 之后真的处于 denied」的那一行。存量行可能没有
        // toolCallId（迁移 069 之前），没有身份就没法归属，宁可不发——投影那边
        // 会把它记成 row_without_event，比一条归不到调用的状态事件诚实。
        if (row.approvalId !== approvalKey) continue;
        if (row.status !== "denied" || !row.toolCallId) continue;
        await this.sessions.tryAppendEvent(sessionId, {
          kind: "tool_call_status_changed",
          causedBySeq,
          payload: {
            toolCallId: row.toolCallId,
            toolName: row.toolName,
            tier: row.tier,
            status: row.status,
            durationMs: row.durationMs ?? 0,
            resultTruncated: row.resultTruncated === true,
            hasResult: (row.resultJson ?? null) !== null,
            // 存在性哨兵：投影与守卫脚本按它判断「事件说这里有错误文案」。
            errorMessage: row.errorMessage ? "present" : null,
            // 正文进事件（与 recordToolCall / updateToolCallByToolCallId 同形）：
            // 拒绝文案必须钉在**这次迁移**上，否则「为什么被拒绝」会随台账行被
            // 就地覆盖而丢失（见方法头注）。脱敏/截断/标记全交给既有实现。
            body: {
              result: buildEventBody(row.resultJson),
              error: buildEventBody(row.errorMessage),
            },
          },
        });
      }
    } catch (err: unknown) {
      // 记账失败绝不能反向弄挂一次人工拒绝（纪律 2：事件是旁路）。
      this.logger.warn(
        `agent_events append failed (bypass — deny unaffected): ` +
          `session=${sessionId} kind=tool_call_status_changed key=${approvalKey} — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @Post("sessions/:id/approvals/:approvalKey/grant")
  @ApiOperation({ summary: "批准 Agent 审批单并恢复会话" })
  @ApiOkResponse({ schema: { type: "object", additionalProperties: true } })
  async grantApproval(
    @Param("id") id: string,
    @Param("approvalKey") approvalKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decideApproval(id, approvalKey, "granted", user);
  }

  @Post("sessions/:id/approvals/:approvalKey/deny")
  @ApiOperation({ summary: "拒绝 Agent 审批单" })
  @ApiOkResponse({ schema: { type: "object", additionalProperties: true } })
  async denyApproval(
    @Param("id") id: string,
    @Param("approvalKey") approvalKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decideApproval(id, approvalKey, "denied", user);
  }

  /**
   * N17：一句话审批的 HTTP 装配层。语义零重写——短语白名单、reset 拒绝、
   * 策略指纹比对、once 条件写全在 `approvals.decideByPhrase` 里，这里只做
   * 三件事：会话归属校验、取登录用户名、按**当前**策略快照重算指纹。
   *
   * `decidedBy` / `policyFingerprint` 均不接受请求体自报（DTO 里根本没有
   * 这两个字段）——自报身份会冒批，自报旧指纹会绕过策略变更失效。
   */
  @Post("sessions/:id/approvals/:approvalKey/phrase")
  // 显式再标一次 ADMIN（类级已有）：让「短语审批是 ADMIN-only」在方法元数据上
  // 也能被守卫与契约检查直接钉住，不靠读类注释推断。
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "用审批短语处置 Agent 审批单（一次性授权）",
    description:
      "短语仅接受 allow / allow once / 允许 / 批准 / deny / 拒绝；处置人取当前登录管理员，策略指纹由服务端当前策略快照重算，请求体自报一律忽略。",
  })
  @ApiOkResponse({ type: ApprovalPhraseResponseDto })
  async decideApprovalByPhrase(
    @Param("id") id: string,
    @Param("approvalKey") approvalKey: string,
    @Body() dto: ApprovalPhraseDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ApprovalPhraseResponseDto> {
    const session = await this.sessions.requireById(id);
    const approval = await this.approvals.findByKey(approvalKey);
    if (!approval) {
      throw new AppError("AGENT_APPROVAL_NOT_FOUND", { approvalKey });
    }
    if (approval.sessionId !== session.id) {
      throw new AppError("AGENT_APPROVAL_SESSION_MISMATCH", { sessionId: id });
    }

    // 指纹口径与闸门/落库侧同一份 computeApprovalPolicyFingerprint：读的是
    // ConfigService 的当前值（boundary.resolveApprovalPolicy / resolveExecutableSourceGate
    // 的 readBool 语义），而不是请求体给的字符串。配置读不到时 fail-closed：
    // 显式 AppError + 中文 detail，不裸抛、不回退成「假定没变」。
    const readBool = (key: string, fallback: boolean): boolean => {
      const raw = this.config?.get<unknown>(key);
      if (raw === undefined || raw === null || raw === "") return fallback;
      if (typeof raw === "boolean") return raw;
      const s = String(raw).trim().toLowerCase();
      if (s === "true" || s === "1") return true;
      if (s === "false" || s === "0") return false;
      return fallback;
    };
    let policyFingerprint: string;
    try {
      policyFingerprint = computeApprovalPolicyFingerprint({
        writeRequiresApproval: readBool(
          "agent.policy.writeRequiresApproval",
          false,
        ),
        dangerousRequiresApproval: readBool(
          "agent.policy.dangerousRequiresApproval",
          true,
        ),
        allowDangerous: readBool("agent.policy.allowDangerous", false),
        executableSourceGate: readBool(
          "agent.policy.executableSourceGate",
          true,
        ),
      });
    } catch (err: unknown) {
      throw new AppError("VALIDATION_FAILED", {
        detail:
          "无法读取当前审批策略快照，拒绝按短语处置审批单：" +
          (err instanceof Error ? err.message : String(err)),
      });
    }

    const row = await this.approvals.decideByPhrase(
      approvalKey,
      dto.phrase,
      user.username,
      policyFingerprint,
    );
    return {
      ok: true,
      approval: row
        ? {
            approvalKey: row.approvalKey,
            status: row.status,
            decidedBy: row.decidedBy,
            decidedAt: row.decidedAt,
          }
        : null,
    };
  }

  @Get("sessions/:id/approvals")
  @ApiOperation({ summary: "列出会话的全部审批单" })
  @ApiOkResponse({
    schema: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  })
  async listApprovals(@Param("id", ParseUuidShapePipe) id: string) {
    await this.sessions.requireById(id);
    return this.approvals.listForSession(id);
  }

  /**
   * R278：**跨会话**的待审批单聚合（收件箱「审批单」小节的唯一数据源）。
   *
   * ## 为什么是新端点，而不是给 `sessions/:id/approvals` 加跨会话参数
   *
   * 那条端点的返回是 `AgentApproval[]` 裸数组（既有前端与 3 个用例依赖这个形状）。
   * 收件箱要的是**信封**：`total`（独立计数）/ `truncated` / `degraded` ——
   * 裸数组装不下这三个字段，而缺了它们就是本条产品问题的原始形态
   * （「少报且不说明少报」）。⇒ 新增端点，旧端点一字不改。
   *
   * ## 为什么 `limit` 由这里钳
   *
   * 钳制逻辑是**纯函数**（`clampPendingApprovalLimit`）并且被测过（1..200，默认
   * 100）。controller 只做 `parseInt` 与转发——非法值安全回落，**不 400**
   * （保持「非法深链安全回落」的既有契约）。
   */
  @Get("approvals/pending")
  // GCO §5：方法级放行覆盖类级 ADMIN；只放这两个只读端点，写面全部保持 ADMIN。
  @Roles(UserRole.ADMIN, UserRole.USER)
  @ApiOperation({ summary: "列出待我审批单（含总数、截断与降级标记）" })
  @ApiOkResponse({ type: AgentPendingApprovalsResponseDto })
  @ApiQuery({ name: "limit", required: false, type: String })
  async listPendingApprovals(
    @Query("limit") limit?: string,
    @CurrentUser() user?: AuthUser,
  ): Promise<AgentPendingApprovalsResponseDto> {
    if (!this.inbox) {
      // ⚠️ 服务缺席 ⇒ 显式报不可用。回 `{items:[], total:0}` 会让运营以为
      // 「没有待办」，而事实是「读不到」——这正是本仓要消灭的那类假事实。
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    const parsedLimit = limit === undefined ? undefined : parseInt(limit, 10);
    return this.inbox.pending({ limit: parsedLimit, viewer: user });
  }

  /**
   * R278：收件箱**计数**的唯一服务端口径（顶栏徽标用）。
   *
   * 一次请求换掉前端的 5 次请求（`/app-deployments/approvals/pending`、
   * `/agent/sessions?status=waiting_input`、`?stalled=1`、`/sessions/backlogged`、
   * `/sessions/queue-stall`）—— 那 5 次共用一个 60/min 的限流桶，是「转圈很久 /
   * 偶发读取失败」的成因。
   *
   * 口径分工（brief §二 D1）：`pendingApprovals` 是**审批单**数，
   * `waitingSessions` 是**会话**数；两者**不可相加**（会话已含审批单）。
   */
  @Get("inbox/counts")
  // GCO §5：同上，仅本只读计数端点方法级放行；其它 Agent 面仍继承类级 ADMIN。
  @Roles(UserRole.ADMIN, UserRole.USER)
  @ApiOperation({ summary: "收件箱各项计数（读不到时为 null，绝不伪装成 0）" })
  @ApiOkResponse({ type: AgentInboxCountsResponseDto })
  async inboxCounts(
    @CurrentUser() user: AuthUser,
  ): Promise<AgentInboxCountsResponseDto> {
    if (!this.inbox) throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    return this.inbox.counts({ viewer: user });
  }

  // ── R308: TTFV opt-in 授权闭环 ────────────────────────────────
  // 只改授权状态与系统总闸，绝不直接写 funnel_events：埋点写入仍由
  // TelemetryOptinService.isOptedIn 的双闸决定，避免绕过闸门造数据。

  /** 总闸读失败 / 缺键一律 false（与 TelemetryOptinService 同口径）。 */
  private async telemetryGateState(): Promise<boolean> {
    try {
      const row = await this.systemConfig!.findOne(TTFV_SYSTEM_GATE_KEY);
      return row?.value === "true" || row?.value === "1";
    } catch {
      return false;
    }
  }

  /**
   * 目标 install 解析：显式 installId > 设备指纹派生 > 全部已知 executor 指纹。
   *
   * `includeStoredOptIns` 只用于撤销的无参分支：已下线执行器不在 executor 表里，
   * 但授权行仍在，必须一并撤销，否则「关总闸」只是暂时遮住残留授权。
   */
  private async resolveTelemetryInstallIds(
    dto: AgentTelemetryConsentDto,
    includeStoredOptIns: boolean,
  ): Promise<string[]> {
    const ids = new Set<string>();
    if (dto.installId) {
      ids.add(dto.installId);
      return [...ids];
    }

    const fingerprints: string[] = [];
    if (dto.deviceFingerprint) {
      fingerprints.push(dto.deviceFingerprint);
    } else if (this.executors) {
      const rows = await this.executors.find({
        select: { deviceFingerprint: true },
      });
      for (const row of rows) {
        if (row.deviceFingerprint) fingerprints.push(row.deviceFingerprint);
      }
    }

    for (const fingerprint of fingerprints) {
      const derived = this.secretsCrypto!.deriveAnonymousId(
        fingerprint,
        "ttfv-install",
      );
      // 无 SEC_SECRETS_KEY ⇒ 派生不出稳定匿名 id。此时授权毫无意义，
      // 直接 fail-closed，绝不把原始指纹当 installId 落库。
      if (!derived) throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
      ids.add(derived);
    }

    if (includeStoredOptIns) {
      const stored = await this.optinRows!.find({
        where: { optIn: true },
        select: { installId: true },
      });
      for (const row of stored) ids.add(row.installId);
    }
    return [...ids];
  }

  @Post("telemetry/consent")
  @ApiOperation({ summary: "设置 TTFV 授权状态与系统总闸" })
  @ApiCreatedResponse({ type: AgentTelemetryConsentResultDto })
  async setTelemetryConsent(
    @Body() dto: AgentTelemetryConsentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AgentTelemetryConsentResultDto> {
    if (
      !this.systemConfig ||
      !this.telemetryOptin ||
      !this.secretsCrypto ||
      !this.executors ||
      !this.optinRows
    ) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }

    // 用户维度只落 HMAC 哈希；原始 username 既不进 telemetry_optin，也不进
    // config_history（HistoryOptions 刻意只带数字 userId）。
    const userIdHash = this.secretsCrypto.deriveAnonymousId(
      user.username,
      "ttfv-user",
    );
    if (!userIdHash) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }

    const installIds = await this.resolveTelemetryInstallIds(
      dto,
      !dto.optIn && !dto.installId && !dto.deviceFingerprint,
    );
    const source = dto.source ?? "admin-ui";
    const gateValue = dto.optIn ? "true" : "false";

    if (dto.optIn) {
      // 先授权再开闸：避免「总闸已开、install 尚未授权」的采集窗口。
      for (const installId of installIds) {
        await this.telemetryOptin.grant(installId, userIdHash, source);
      }
      await this.systemConfig.upsert(
        {
          key: TTFV_SYSTEM_GATE_KEY,
          value: gateValue,
          valueType: "boolean",
          description: "TTFV opt-in system gate",
        },
        { userId: user.id },
      );
    } else {
      // 反向同理：先关闸再撤销，撤销失败也不会留下一个开着的采集口。
      await this.systemConfig.upsert(
        {
          key: TTFV_SYSTEM_GATE_KEY,
          value: gateValue,
          valueType: "boolean",
          description: "TTFV opt-in system gate",
        },
        { userId: user.id },
      );
      for (const installId of installIds) {
        await this.telemetryOptin.revoke(installId);
      }
    }

    return {
      systemEnabled: dto.optIn,
      optedIn: dto.optIn,
      installIds,
      count: installIds.length,
      source,
    };
  }

  @Get("telemetry/status")
  @ApiOperation({ summary: "读取 TTFV 授权状态供管理端展示" })
  @ApiOkResponse({ type: AgentTelemetryStatusDto })
  async telemetryStatus(): Promise<AgentTelemetryStatusDto> {
    if (!this.systemConfig || !this.optinRows) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    const systemEnabled = await this.telemetryGateState();
    const rows = await this.optinRows.find({ order: { optedAt: "DESC" } });
    const optedIn = rows.filter((row) => row.optIn);
    // 已授权 installId 集合：只取 opt_in=true 的行；撤销行（opt_in=false）
    // 不是授权，不能拿它把覆盖率凑成 full。
    const authorizedIds = new Set(optedIn.map((row) => row.installId));
    const iso = (value: Date | null | undefined): string | null =>
      value ? new Date(value).toISOString() : null;

    // ── R329：授权覆盖率可观测性（纯只读，绝不授权、绝不改任何状态）──
    // knownExecutorCount 与 consent 全量路径（resolveTelemetryInstallIds）
    // 取数口径一致：executors 表 select deviceFingerprint 后去重计数。
    // executors 依赖缺席 ⇒ 0，coverage 按下方规则降级（不伪造 full）。
    const fingerprints = new Set<string>();
    if (this.executors) {
      const execRows = await this.executors.find({
        select: { deviceFingerprint: true },
      });
      for (const row of execRows) {
        if (row.deviceFingerprint) fingerprints.add(row.deviceFingerprint);
      }
    }
    const knownExecutorCount = fingerprints.size;

    let coverage: AgentTelemetryStatusDto["coverage"];
    if (!systemEnabled) {
      coverage = "gate_off";
    } else if (knownExecutorCount === 0) {
      // 审计 B2 核心见证：总闸已开但无已知执行器 ⇒ 静默零采集陷阱。
      coverage = "no_executors";
    } else if (!this.secretsCrypto) {
      // 派生依赖缺席：无法比对，fail-closed 降级 partial，绝不报 full。
      this.logger.warn(
        "[R329] telemetry status: secretsCrypto absent, coverage degraded to partial",
      );
      coverage = "partial";
    } else {
      // 与 consent 全量路径同样用 deriveAnonymousId(fp,"ttfv-install") 派生，
      // 只比较 HMAC 匿名 id，绝不把原始指纹/用户名带进响应。
      const derivedIds = new Set<string>();
      let derivationFailed = false;
      for (const fingerprint of fingerprints) {
        const derived = this.secretsCrypto.deriveAnonymousId(
          fingerprint,
          "ttfv-install",
        );
        if (!derived) {
          derivationFailed = true;
          break;
        }
        derivedIds.add(derived);
      }
      if (derivationFailed) {
        // 无 SEC_SECRETS_KEY ⇒ 派生失败：记 warn、降级 partial，不伪造 full。
        this.logger.warn(
          "[R329] telemetry status: installId derivation failed, coverage degraded to partial",
        );
        coverage = "partial";
      } else {
        const allCovered = [...derivedIds].every((id) => authorizedIds.has(id));
        coverage = allCovered ? "full" : "partial";
      }
    }

    return {
      systemEnabled,
      count: optedIn.length,
      latestOptedAt: optedIn.length > 0 ? iso(optedIn[0].optedAt) : null,
      installs: rows.map((row) => ({
        installId: row.installId,
        optIn: row.optIn,
        optedAt: iso(row.optedAt),
        userIdHash: row.userIdHash ?? null,
        source: row.source,
      })),
      knownExecutorCount,
      coverage,
    };
  }

  /**
   * R325（北极星 §6 步骤 1-2）：显式确认某次执行「已被业务确认」。
   *
   * - 幂等：重复调用一律 ok:true 且 emit；去重由下游 listener 的
   *   dedupeKey = confirmed:<execution_id_hash> 保证，业务侧不去重。
   * - 鉴权沿用 controller 级 JwtAuthGuard + ADMIN（不自定义角色）。
   * - 与 telemetry 解耦（§7）：本端点不查 opt-in，未授权也照常确认成功。
   */
  @Post("executions/:execId/confirm")
  @ApiOperation({
    summary: "显式确认执行已被业务确认（北极星 business_confirmed 事件源）",
  })
  @ApiOkResponse({
    description:
      "确认成功（幂等，重复确认同样返回成功并 emit execution.confirmed）",
  })
  async confirmExecution(
    @Param("execId", ParseUuidShapePipe) execId: string,
  ): Promise<{ ok: true; confirmedAt: string }> {
    if (!this.confirmation) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    const result = await this.confirmation.confirm(execId);
    if (!result.ok) {
      throw new AppError(ErrorCode.TASK_EXECUTION_NOT_FOUND, {
        executionId: execId,
      });
    }
    return result;
  }

  /**
   * R327（北极星 §6 步骤 5 的后端一半）：双口径周报读面，供管理端看板消费。
   *
   * - `?as_of=`（ISO-8601，缺省 now）：观测截止参数；非法值由 service 抛 400。
   * - 鉴权沿用 controller 级 JwtAuthGuard + ADMIN，与 telemetry/status 同面；
   *   刻意不落 metrics 模块（那是 @Public + scraper guard 的 Prometheus 抓取面）。
   * - service 缺席 ⇒ 显式 503（不回 200 空信封）；空数据由 service 返回
   *   weeks=[]/totals=0/warnings 仍在，与脚本 buildPayload 逐字对齐。
   */
  @Get("north-star/metrics")
  @ApiOperation({
    summary: "北极星双口径周报（严格 business_confirmed + 代理值，绝不混用）",
  })
  @ApiQuery({
    name: "as_of",
    required: false,
    type: String,
    description: "观测截止 ISO-8601；缺省 now",
  })
  @ApiOkResponse({ type: AgentNorthStarResponseDto })
  async northStarReport(
    @Query("as_of") asOf?: string,
  ): Promise<AgentNorthStarResponseDto> {
    if (!this.northStarMetrics) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    return this.northStarMetrics.report(asOf);
  }

  /**
   * N8：waiting_input 期追加一条 steer 意图。
   *
   * 只写 inbox，**不**入队 resume job、**不**产生 step/LLM 调用——会话仍在等
   * 人工审批，模型此刻不在跑。真正注入发生在运行时的下一个模型步边界
   * （AgentRuntimeService.run 的 drain）。终态/其它状态 soft-fail，沿用
   * `resume` 端点的状态判定写法（200 + ok:false），绝不复活死意图。
   */
  @Post("sessions/:id/steer")
  @ApiOperation({
    summary: "向 waiting_input 会话追加 steer 意图（下一轮步边界注入）",
  })
  @ApiCreatedResponse({
    schema: { type: "object", additionalProperties: true },
  })
  async steer(
    @Param("id", ParseUuidShapePipe) id: string,
    @Body() dto: AgentSteerDto,
  ) {
    if (!this.steerInbox) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    const session = await this.sessions.requireById(id);
    if (session.status !== "waiting_input") {
      return {
        ok: false,
        parked: false,
        wake: false,
        reason: `会话不在 waiting_input（${session.status}），steer 未入队`,
      };
    }
    const content = typeof dto?.content === "string" ? dto.content.trim() : "";
    if (!content) {
      throw new AppError("VALIDATION_FAILED", {
        detail: "steer content 不能为空",
      });
    }
    const result = this.steerInbox.park(
      id,
      content,
      Number(session.totalSteps) || 0,
      session.status,
    );
    return {
      ok: true,
      parked: result.intent !== null,
      wake: result.wake,
      intentId: result.intent?.id ?? null,
    };
  }
}
