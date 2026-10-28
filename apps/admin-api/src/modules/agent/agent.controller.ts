import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiOkResponse,
  ApiCreatedResponse,
} from "@nestjs/swagger";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AgentSessionService } from "./runtime/agent-session.service";
import { AgentBudgetService } from "./runtime/agent-budget.service";
import { AgentApprovalsService } from "./runtime/agent-approvals.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/interfaces/auth-user.interface";
import { AGENT_QUEUE_NAME, type AgentJobData } from "./runtime/agent.processor";
import {
  AGENT_SESSION_KINDS,
  type AgentSessionKind,
} from "./entities/agent-session.entity";
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
// ARCH-23 / N-12: Agent HTTP 面响应契约。
import {
  AgentBudgetResponseDto,
  AgentSessionCreateResponseDto,
  AgentSessionDetailResponseDto,
  AgentSessionListResponseDto,
  AgentSessionResumeResponseDto,
} from "./dto/agent-response.dto";

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

/**
 * P2：Agent HTTP 面。
 *
 * 权限：**全部 ADMIN-only**。理由与既有 ai 模块（N11/R11）一致——AI 配置面
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
  constructor(
    private readonly sessions: AgentSessionService,
    private readonly budget: AgentBudgetService,
    private readonly approvals: AgentApprovalsService,
    @InjectQueue(AGENT_QUEUE_NAME) private readonly queue: Queue<AgentJobData>,
  ) {}

  @Get("sessions")
  @ApiOperation({ summary: "列出 Agent 会话（最新在前）" })
  // N-12: 裸分页 {items,total}（与 /sop 同形态，无页元数据）。
  @ApiOkResponse({ type: AgentSessionListResponseDto })
  async list(
    @Query("kind") kind?: AgentSessionKind,
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    const result = await this.sessions.list({
      kind,
      status: status as never,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
    return result;
  }

  @Get("sessions/:id")
  @ApiOperation({ summary: "获取某个 Agent 会话及其步骤" })
  @ApiOkResponse({ type: AgentSessionDetailResponseDto })
  async detail(@Param("id") id: string) {
    const session = await this.sessions.requireById(id);
    const [steps, toolCalls, children] = await Promise.all([
      this.sessions.listSteps(id),
      this.sessions.listToolCalls(id),
      this.sessions.findChildren(id),
    ]);
    return { session, steps, toolCalls, children };
  }

  @Post("sessions")
  @ApiOperation({ summary: "创建一个 Agent 会话并入队执行" })
  // POST 无 @HttpCode → 实际 201。
  @ApiCreatedResponse({ type: AgentSessionCreateResponseDto })
  async create(@Body() dto: CreateAgentSessionDto) {
    const session = await this.sessions.create({
      kind: dto.kind,
      // 人工发起的会话，触发源记录为 user:<id> 语义（P2 无 req.user 注入面，
      // 先记固定值；P3 接 CurrentUser 后替换为真实 id）
      triggerSource: "user:admin",
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

    // 终态会话不可恢复——强行 resume 会让状态机倒退（且已产生的副作用
    // 无法撤销）。需要重跑请新建会话。
    if (session.status === "succeeded" || session.status === "aborted") {
      return {
        ok: false,
        reason: `会话已处于终态（${session.status}），请新建会话重跑`,
      };
    }

    // B-8：running 会话拒绝再入队——下面的 jobId 带 Date.now() 会绕过
    // BullMQ 去重，双 worker 同时跑同一会话 = 双 LLM 循环、副作用双份。
    // 409 让前端如实提示（resumable 列表同步排除 running）。
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

    await this.queue.add(
      "run",
      { sessionId: id, reason: "resume:manual" },
      { jobId: `${id}:resume:${Date.now()}`, attempts: 1 },
    );
    return { ok: true };
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
      await this.sessions.settleToolCallByApprovalId(
        approvalKey,
        "denied",
        `已被 ${user.username} 人工拒绝（审批单 ${approvalKey}）——不得重试同一调用`,
      );
    }

    let resumed = false;
    if (
      decision === "granted" &&
      session.status === "waiting_input" &&
      !(await this.approvals.hasPendingForSession(sessionId))
    ) {
      await this.queue.add(
        "run",
        { sessionId, reason: "resume:approval" },
        { jobId: `${sessionId}:resume:${Date.now()}`, attempts: 1 },
      );
      resumed = true;
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

  @Get("sessions/:id/approvals")
  @ApiOperation({ summary: "列出会话的全部审批单" })
  @ApiOkResponse({
    schema: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  })
  async listApprovals(@Param("id") id: string) {
    await this.sessions.requireById(id);
    return this.approvals.listForSession(id);
  }
}
