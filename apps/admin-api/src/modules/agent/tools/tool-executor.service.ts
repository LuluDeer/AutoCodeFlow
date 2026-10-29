import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AgentSession } from "../entities/agent-session.entity";
import {
  AgentSessionService,
  type RecordToolCallInput,
} from "../runtime/agent-session.service";
import { AgentNotifyService } from "../runtime/agent-notify.service";
import { AgentApprovalsService } from "../runtime/agent-approvals.service";
import { AgentBoundaryService } from "../boundary/agent-boundary.service";
import { SopService } from "../../sop/sop.service";
import {
  ALL_AGENT_TOOL_SPECS,
  toolsForSessionKind,
  type AgentToolSpec,
} from "./tool-registry";
import type {
  AgentToolDefinition,
  AgentToolExecutor,
} from "../runtime/agent-runtime.service";
import { AgentApiClient, type ApiCallResult } from "./agent-api.client";

/**
 * P3：工具执行器（设计文档 03 §5 的执行侧）。
 *
 * ## 本服务是工具执行的唯一入口
 * 任何人要执行工具都必须经过 `execute()`，而它**强制先调边界闸门**。
 * 这是「没有工具能绕过闸门」的机制保证——不是靠约定，是靠只有这一条路径。
 *
 * ## 三道执行期纪律
 *   ① 超时：工具调用必须有上限（防某个端点卡死拖垮整个会话）；
 *   ② 结果截断：大结果只回摘要给模型（完整结果落库，需要时用
 *      get_tool_call_result 回读——P4 补该工具）；
 *   ③ 脱敏：参数与结果落库前过脱敏（参数可能含模型从上下文抄来的凭据）。
 */

/** 单次工具执行的超时。 */
export const TOOL_TIMEOUT_MS = 60_000;

/**
 * 回给模型的观察结果长度上限。
 *
 * 为什么是 2000 字符：典型工具结果（一条执行记录、几行日志）远小于此；
 * 而 500 条任务的列表会远超。截断保住上下文窗口，完整结果在
 * `agent_tool_calls.resultJson` 里可回读。
 */
export const TOOL_RESULT_MAX_CHARS = 2000;

/** 凭据类键名（顶层与嵌套层一视同仁剥除）。 */
const SECRET_KEYS_RE =
  /token|password|passwd|secret|apikey|api_key|credential/i;

@Injectable()
export class ToolExecutorService implements AgentToolExecutor {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private readonly boundary: AgentBoundaryService,
    private readonly sessions: AgentSessionService,
    private readonly api: AgentApiClient,
    private readonly notify: AgentNotifyService,
    // A1 审批闭环（实施轮 #12）：审批单落库与状态翻转。
    private readonly approvals: AgentApprovalsService,
    // forwardRef：agent.module ↔ sop.module 装配期环（与 ToolBinderService
    // 同款）。B-2/B-3 的两道执行体入口校验需要读 SOP 侧数据（slug→id、
    // 澄清归属投影）。
    @Inject(forwardRef(() => SopService))
    private readonly sops: SopService,
  ) {}

  /** 本次会话可用的工具（白名单过滤后的定义，喂给 LLM）。 */
  async availableTools(session: AgentSession): Promise<AgentToolDefinition[]> {
    const specs = this.specsForSession(session);
    return (
      specs
        // 硬禁用的工具**不暴露给模型**——连看都看不到，就不会尝试。
        // 这是纵深防御的第一层（L1），比「暴露但拒绝」更干净。
        .filter((s) => !s.hardDisabled)
        .map((s) => ({
          name: s.name,
          description: s.description,
          parameters: s.parameters,
          tier: s.tier,
        }))
    );
  }

  /**
   * 执行一次工具调用。
   *
   * 流程：闸门 → 落库(denied/awaiting) → 执行 → 落库(ok/error) → 回观察结果。
   *
   * **被拒与待审批同样落库**（设计文档 03 §6）：前者是安全信号，后者是
   * 挂起恢复的锚点。
   */
  async execute(
    session: AgentSession,
    call: { id: string; function: { name: string; arguments: string } },
    stepId: string | null,
    opts: { replayApproved?: boolean } = {},
  ): Promise<{ content: string; truncated: boolean; needsApproval?: boolean }> {
    const toolName = call.function?.name ?? "unknown";

    // TOOLS-02 确定性重放：台账里已有一条同 toolCallId 的 awaiting_approval
    // 行（模型当初发起、审批挂起时落库）。GAP-5 的 (sessionId, toolCallId)
    // 唯一索引禁止再插一行，而且「一次调用只对应一行台账」才是审计语义——
    // 因此重放路径就地更新那一行（不重复累加 totalToolCalls）。
    const replayApproved = opts.replayApproved === true;
    const persist = async (input: RecordToolCallInput): Promise<void> => {
      if (!replayApproved || !input.toolCallId) {
        await this.sessions.recordToolCall(input);
        return;
      }
      const updated = await this.sessions.updateToolCallByToolCallId(
        session.id,
        input.toolCallId,
        {
          toolName: input.toolName,
          tier: input.tier,
          status: input.status,
          args: input.args ?? null,
          result: input.result ?? null,
          resultTruncated: input.resultTruncated ?? false,
          errorMessage: input.errorMessage ?? null,
          durationMs: input.durationMs ?? 0,
        },
      );
      // 行不在了（被清理/被别的路径更新）→ 退回插入，宁可多一行也不能丢审计
      if (!updated) await this.sessions.recordToolCall(input);
    };

    // 解析参数——模型给的是 JSON 字符串，可能是畸形 JSON
    let args: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(call.function?.arguments || "{}");
      args = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      const msg = `工具参数不是合法 JSON：${(call.function?.arguments ?? "").slice(0, 200)}`;
      await persist({
        sessionId: session.id,
        stepId,
        toolCallId: call.id,
        toolName,
        tier: "read",
        status: "error",
        errorMessage: msg,
      });
      return { content: msg, truncated: false };
    }

    // 该工具在本会话内的已调用次数（速率闸门的输入）
    const priorCalls = await this.countPriorCalls(session.id, toolName);

    // ── B-2：sop_get 的 sopId/slug 二选一，闸门只认 id ────────────────
    // slug 是名字不是 id，scope 白名单里是 SOP id——若闸门对「缺 id」放行，
    // 传 {slug} 就能读任意 SOP。在执行体入口先解析成 id 再走闸，保持闸门
    // 语义单一（有 id 且命中白名单）。slug 不存在时如实按调用失败回给模型。
    if (
      toolName === "sop_get" &&
      args &&
      !args.sopId &&
      typeof args.slug === "string"
    ) {
      try {
        const sop = await this.sops.getBySlug(args.slug);
        args = { ...args, sopId: sop.id };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await persist({
          sessionId: session.id,
          stepId,
          toolCallId: call.id,
          toolName,
          tier: "read",
          args: this.sanitizeArgs(args),
          status: "error",
          errorMessage: msg,
        });
        return { content: `【调用失败】${msg}`, truncated: false };
      }
    }

    // ── 审批单消费（执行侧闭环，实施轮 #14）─────────────────────────
    // 闸门的 NEED_APPROVAL 是**纯函数判定**（不读库），审批结论的消费在这里。
    // 键是确定性的（同会话 + 同工具 + 同参数 ⇒ 同键），因此：
    //   · granted  → 把键作为「本次调用通行证」带给闸门（其余五道闸照常生效）；
    //   · denied   → 按拒绝回给模型，不重新申请、不再次挂起；
    //   · consumed → 这张单已放行过一次，重复调用按拒绝（一张单只放行一次）；
    //   · pending  → 不重复申请（request 的 23505 分支会命中同一行）。
    // 没有审批单时 approvedKey=null，闸门按既有策略自行返回 NEED_APPROVAL。
    const approvalKey = this.approvals.buildKey(session.id, toolName, args);
    const existingApproval = await this.approvals.findByKey(approvalKey);
    if (
      existingApproval &&
      (existingApproval.status === "denied" ||
        existingApproval.status === "consumed")
    ) {
      const why =
        existingApproval.status === "denied"
          ? `该调用已被人工拒绝（审批单 ${approvalKey}${
              existingApproval.decidedBy
                ? `，处置人 ${existingApproval.decidedBy}`
                : ""
            }）——不得重试同一调用，请改走其他手段或把结论写进最终报告。`
          : `该调用已凭审批单 ${approvalKey} 执行过一次；一张批准单只放行一次，` +
            `重复提交同一调用会被拒绝。若确需再次执行，请改用只读手段核实结果，` +
            `或在最终报告中说明需要人工再执行一次。`;
      await persist({
        sessionId: session.id,
        stepId,
        toolCallId: call.id,
        toolName,
        tier:
          ALL_AGENT_TOOL_SPECS.find((s) => s.name === toolName)?.tier ?? "read",
        args: this.sanitizeArgs(args),
        status: "denied",
        approvalId: approvalKey,
        errorMessage: why,
      });
      this.logger.warn(
        `Agent tool call blocked by approval state: session=${session.id} tool=${toolName} approval=${approvalKey} status=${existingApproval.status}`,
      );
      return { content: `【调用被拒绝】${why}`, truncated: false };
    }
    const approvedKey =
      existingApproval?.status === "granted" ? approvalKey : null;

    // ── 闸门（唯一入口）──
    const verdict = this.boundary.check(
      session,
      toolName,
      args,
      priorCalls,
      approvedKey,
    );

    if (verdict.kind === "DENY") {
      await persist({
        sessionId: session.id,
        stepId,
        toolCallId: call.id,
        toolName,
        tier:
          ALL_AGENT_TOOL_SPECS.find((s) => s.name === toolName)?.tier ?? "read",
        args: this.sanitizeArgs(args),
        status: "denied",
        errorMessage: verdict.message,
      });
      // 回给模型的是**可理解的原因**，让它换路径而不是盲目重试
      return { content: `【调用被拒绝】${verdict.message}`, truncated: false };
    }

    if (verdict.kind === "NEED_APPROVAL") {
      const approvalId = await this.requestApproval(
        session,
        verdict.spec,
        verdict.message,
        approvalKey,
      );
      await persist({
        sessionId: session.id,
        stepId,
        toolCallId: call.id,
        toolName,
        tier: verdict.spec.tier,
        args: this.sanitizeArgs(args),
        status: "awaiting_approval",
        approvalId,
        errorMessage: verdict.message,
      });
      // A1 审批闭环（实施轮 #12 申请侧 / #14 执行侧）：审批单已落库
      // （agent_approvals）、会话已 markWaiting 挂起。`needsApproval` 让运行时
      // **停下本轮循环**——否则循环会在会话已显示 waiting_input 的情况下继续
      // 调 LLM、继续重提调用，出现「状态说在等审批、实际还在跑」的窗口
      // （B-8 的双跑守卫正是按状态判的）。
      return {
        content:
          `【需人工审批，已提交审批单】${verdict.message}` +
          `（审批单 ${approvalId}）会话已挂起等待人工处置；` +
          `管理员批准后将自动恢复会话并执行本次调用，请勿重复提交同一工具调用。`,
        truncated: false,
        needsApproval: true,
      };
    }

    // ── 执行 ──
    const spec = verdict.spec;

    // ── B-3：sop_reply_clarification 的归属校验 ──────────────────────
    // 该工具在注册表标 resourceKind=none（无资源 id 参数可验），但回复权 =
    // 修订权（sop_amended 会改写 SOP 工作副本并自主发 patch 版，绕过发布
    // 审批红线）。执行体入口补一道闸：只允许本会话处理的复核澄清，或澄清
    // 所属 SOP 在会话 scope 的 sops 白名单内。越权回复按 denied 落库。
    if (spec.name === "sop_reply_clarification") {
      const denyMsg = await this.checkClarificationReplyScope(session, args);
      if (denyMsg) {
        await persist({
          sessionId: session.id,
          stepId,
          toolCallId: call.id,
          toolName,
          tier: spec.tier,
          args: this.sanitizeArgs(args),
          status: "denied",
          errorMessage: denyMsg,
        });
        return { content: `【调用被拒绝】${denyMsg}`, truncated: false };
      }
    }

    // ── 领取审批单（granted → consumed）——**必须在副作用之前**──
    // 领取成功才执行：反过来（先执行再领取）在并发下会出现「两次执行、一次
    // 领取」，副作用双份。领取失败 = 这张单已被别处用掉，按拒绝处理
    // （fail-closed：宁可少执行一次让管理员重新批准，不可多执行一次）。
    if (verdict.approvedApprovalKey) {
      const claimed = await this.approvals.consume(verdict.approvedApprovalKey);
      if (!claimed) {
        const why =
          `审批单 ${verdict.approvedApprovalKey} 已被另一次调用使用` +
          `（一张批准单只放行一次）——本次调用未执行。`;
        await persist({
          sessionId: session.id,
          stepId,
          toolCallId: call.id,
          toolName,
          tier: spec.tier,
          args: this.sanitizeArgs(args),
          status: "denied",
          approvalId: verdict.approvedApprovalKey,
          errorMessage: why,
        });
        this.logger.warn(
          `Agent approval claim lost: session=${session.id} tool=${toolName} approval=${verdict.approvedApprovalKey}`,
        );
        return { content: `【调用被拒绝】${why}`, truncated: false };
      }
      this.logger.log(
        `Agent approval consumed: session=${session.id} tool=${toolName} approval=${verdict.approvedApprovalKey}`,
      );
    }

    const started = Date.now();
    let result: ApiCallResult;
    try {
      result = await this.withTimeout(
        this.api.invoke(spec, args),
        TOOL_TIMEOUT_MS,
        spec.name,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - started;
      this.boundary.recordOutcome(session.id, toolName, false);
      await persist({
        sessionId: session.id,
        stepId,
        toolCallId: call.id,
        toolName,
        tier: spec.tier,
        args: this.sanitizeArgs(args),
        status: /timed out/i.test(msg) ? "timeout" : "error",
        errorMessage: msg,
        durationMs,
      });
      return { content: `【调用失败】${msg}`, truncated: false };
    }

    const durationMs = Date.now() - started;
    const serialized = JSON.stringify(result.data, null, 2);
    const truncated = serialized.length > TOOL_RESULT_MAX_CHARS;

    this.boundary.recordOutcome(session.id, toolName, !result.isError);

    await persist({
      sessionId: session.id,
      stepId,
      toolCallId: call.id,
      toolName,
      tier: spec.tier,
      args: this.sanitizeArgs(args),
      result: truncated
        ? {
            truncated: true,
            sha256: this.sha256(serialized),
            preview: serialized.slice(0, 500),
          }
        : (result.data as Record<string, unknown>),
      resultTruncated: truncated,
      status: result.isError ? "error" : "ok",
      errorMessage: result.errorMessage ?? null,
      durationMs,
    });

    if (result.isError) {
      return {
        content: `【调用失败】${result.errorMessage ?? "未知错误"}`,
        truncated: false,
      };
    }

    return {
      content: truncated
        ? `${serialized.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[结果已截断，共 ${serialized.length} 字符]`
        : serialized,
      truncated,
    };
  }

  // ── 内部 ────────────────────────────────────────────────────────

  /**
   * B-3：澄清回复的 scope 校验（sop_reply_clarification 专用）。
   * 返回 null = 放行；返回字符串 = 拒绝理由。
   *
   * 判定顺序（与边界闸门的 scope 语义一致）：
   *   ① unrestricted 会话（chat 管理员对话 = 管理员本人操作）放行；
   *   ② 本会话就是处理该澄清的复核会话（reviewSessionId 相等）放行；
   *   ③ 澄清所属 SOP 在会话 scope.sops 白名单内（交付复核会话的形态）放行；
   *   ④ 其余一律拒——别人的复核会话/异 SOP 会话改写不了他人工单的 SOP。
   */
  private async checkClarificationReplyScope(
    session: AgentSession,
    args: Record<string, unknown> | null,
  ): Promise<string | null> {
    const clarificationId =
      typeof args?.clarificationId === "string" ? args.clarificationId : "";
    const info = await this.sops.getClarificationScopeInfo(clarificationId);
    if (!info) {
      return `sop_reply_clarification: 澄清 ${clarificationId} 不存在或归属不可追溯。`;
    }
    if (
      (session.scopeJson as Record<string, unknown> | null)?.unrestricted ===
      true
    ) {
      return null;
    }
    if (info.reviewSessionId && info.reviewSessionId === session.id) {
      return null;
    }
    const allowedSops = Array.isArray(
      (session.scopeJson as Record<string, unknown> | null)?.sops,
    )
      ? ((session.scopeJson as Record<string, unknown>).sops as unknown[])
      : [];
    if (allowedSops.includes(info.sopId)) return null;
    return (
      `sop_reply_clarification: 澄清 ${clarificationId} 所属 SOP ${info.sopId} ` +
      `不在本会话作用域内——只能回复本会话复核的澄清，或 scope.sops 白名单内 SOP 的澄清。`
    );
  }

  private specsForSession(session: AgentSession): AgentToolSpec[] {
    // 复用注册表的白名单判定——与闸门读**同一份**数据源，不会漂移。
    //
    // TOOLS-01：这里必须用 ALL_AGENT_TOOL_SPECS（收编集 ∪ 内部集）。
    // 用 AGENT_TOOL_SPECS 会让 6 个 sop_* 内部工具**从不下发给模型**：
    // 白名单里有、闸门认得、执行体已绑定，唯独模型看不到函数定义——
    // SOP 起草/发布/澄清复核整条链路静默不可用，且没有任何报错。
    const allowed = toolsForSessionKind(session.kind);
    if (allowed === null) return [...ALL_AGENT_TOOL_SPECS];
    return ALL_AGENT_TOOL_SPECS.filter((s) => allowed.includes(s.name));
  }

  private async countPriorCalls(
    sessionId: string,
    toolName: string,
  ): Promise<number> {
    const calls = await this.sessions.listToolCalls(sessionId);
    // 只数**真正执行过**的：
    //   · denied 不该消耗速率预算——否则越权尝试会把正常调用也拖到限流，
    //     反而放大了攻击效果；
    //   · awaiting_approval 也不该（C4，审计轮 #11）：审批通道尚未闭环
    //     （A1），若它计入配额，一个会话只要碰几次"需审批"的工具就会把
    //     15 次配额耗尽，而它一次都没真正执行过——等于用"等待"惩罚自己。
    return calls.filter(
      (c) =>
        c.toolName === toolName &&
        c.status !== "denied" &&
        c.status !== "awaiting_approval",
    ).length;
  }

  /**
   * 参数脱敏。
   *
   * 参数来自 LLM，可能包含它从上下文里抄来的凭据样式串。剥离的判据与
   * AiService.sanitizeLogs 同口径（项目已有 S-10 纪律），并额外按**键名**
   * 剥离凭据字段。
   *
   * 脱敏必须**递归**：嵌套对象/数组里的字符串同样落库（resultJson 进审计
   * 详情页）——只扫顶层会把 `{"params":{"password":"…"}}` 形态整个漏掉。
   * args 来自 JSON.parse（无环），深度钳位只是防御性收口。
   */
  private sanitizeArgs(
    args: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!args) return null;
    return this.sanitizeValue(args, 0) as Record<string, unknown>;
  }

  private sanitizeValue(value: unknown, depth: number): unknown {
    if (depth > 32) return "[TRUNCATED_NESTED]";
    if (Array.isArray(value)) {
      return value.map((v) => this.sanitizeValue(v, depth + 1));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEYS_RE.test(k)) {
          out[k] = "[REDACTED]";
          continue;
        }
        out[k] = this.sanitizeValue(v, depth + 1);
      }
      return out;
    }
    return typeof value === "string" ? this.sanitizeString(value) : value;
  }

  private sanitizeString(s: string): string {
    return s
      .replace(/([A-Z_]{3,}\s*=\s*)[^\s\n]+/g, "$1[REDACTED]")
      .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]")
      .replace(/[0-9a-fA-F]{32,}/g, "[REDACTED_HEX]")
      .slice(0, 4000);
  }

  private sha256(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }

  private async withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`tool ${label} timed out after ${ms}ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 请求人工审批。
   *
   * P3 阶段：落一条待审批记录（复用 agent_tool_calls 的 approvalId 字段），
   * 会话挂起等人工 resume。P4/P5 接入通知渠道后会把审批请求推送到
   * 企微/飞书（设计文档 03 §3）。
   *
   * 为什么现在就要有：没有审批落点，「需审批」判定就只是个拒绝——那与
   * 「直接禁用」没有区别，而这些工具（如 deploy_application）恰恰是设计上
   * **应该在人工点头后可用**的。
   */
  private async requestApproval(
    session: AgentSession,
    spec: AgentToolSpec,
    reason: string,
    approvalKey: string,
  ): Promise<string> {
    // 键由调用方按 (会话, 工具, 参数) 确定性生成（approvals.buildKey）：
    // 同参重试命中同一行，管理员批的那张就是模型正在等的那张。
    const approvalId = approvalKey;
    // A1 审批闭环（实施轮 #12）：先落库（agent_approvals，approvalKey 唯一
    // 约束保证重试幂等）再把会话挂起——「先落盘后发送」同款纪律。挂起用
    // markWaiting 的条件写（R36）：会话恰好被 finish 收敛到终态时挂起让位，
    // 此时的审批单留在 pending 等管理员处置（或过期清理），不阻塞任何人。
    await this.approvals.request({
      approvalKey: approvalId,
      sessionId: session.id,
      toolName: spec.name,
      reason,
    });
    await this.sessions.markWaiting(session.id, `等待审批 ${approvalId}`);
    this.logger.log(
      `Agent approval requested: session=${session.id} tool=${spec.name} approval=${approvalId}`,
    );
    // P4：审批单推送到配置渠道（WARNING 级）——审批不催等于没审，管理员
    // 不该靠轮询会话列表发现挂着的单子。fail-open：通知失败不影响工具
    // 调用路径（AgentNotifyService 内部已吞异常）。
    await this.notify.approvalRequested(session, spec.name, approvalId, reason);
    return approvalId;
  }
}
