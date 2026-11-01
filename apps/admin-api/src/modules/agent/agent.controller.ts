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
import { ParseUuidShapePipe } from "../../common/pipes/parse-uuid-shape.pipe";
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
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import {
  AgentSessionService,
  buildEventBody,
} from "./runtime/agent-session.service";
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
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly sessions: AgentSessionService,
    private readonly budget: AgentBudgetService,
    private readonly approvals: AgentApprovalsService,
    @InjectQueue(AGENT_QUEUE_NAME) private readonly queue: Queue<AgentJobData>,
    // G4：四眼原则开关（@Optional——既有单测装配缺席时默认不启用）
    @Optional()
    private readonly config?: ConfigService | null,
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
