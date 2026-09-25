import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AgentSessionService } from "./runtime/agent-session.service";
import { AgentBudgetService } from "./runtime/agent-budget.service";
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

export class CreateAgentSessionDto {
  @IsString()
  @IsIn(AGENT_SESSION_KINDS as unknown as string[])
  kind: AgentSessionKind;

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
    @InjectQueue(AGENT_QUEUE_NAME) private readonly queue: Queue<AgentJobData>,
  ) {}

  @Get("sessions")
  @ApiOperation({ summary: "List agent sessions (newest first)" })
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
  @ApiOperation({ summary: "Get an agent session with its steps" })
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
  @ApiOperation({
    summary: "Create an agent session and enqueue it for execution",
  })
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
  @ApiOperation({ summary: "Resume a paused/failed agent session" })
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

    await this.queue.add(
      "run",
      { sessionId: id, reason: "resume:manual" },
      { jobId: `${id}:resume:${Date.now()}`, attempts: 1 },
    );
    return { ok: true };
  }

  /** 当前生效的预算（供设置页展示与运维核对）。 */
  @Get("budget")
  @ApiOperation({ summary: "Get effective agent budget settings" })
  budgetInfo() {
    return this.budget.resolveBudget();
  }
}
