import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AgentSession } from "../entities/agent-session.entity";
import { AgentSessionService } from "../runtime/agent-session.service";
import { AgentNotifyService } from "../runtime/agent-notify.service";
import { AgentBoundaryService } from "../boundary/agent-boundary.service";
import {
  AGENT_TOOL_SPECS,
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

@Injectable()
export class ToolExecutorService implements AgentToolExecutor {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private readonly boundary: AgentBoundaryService,
    private readonly sessions: AgentSessionService,
    private readonly api: AgentApiClient,
    private readonly notify: AgentNotifyService,
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
  ): Promise<{ content: string; truncated: boolean }> {
    const toolName = call.function?.name ?? "unknown";

    // 解析参数——模型给的是 JSON 字符串，可能是畸形 JSON
    let args: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(call.function?.arguments || "{}");
      args = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      const msg = `工具参数不是合法 JSON：${(call.function?.arguments ?? "").slice(0, 200)}`;
      await this.sessions.recordToolCall({
        sessionId: session.id,
        stepId,
        toolName,
        tier: "read",
        status: "error",
        errorMessage: msg,
      });
      return { content: msg, truncated: false };
    }

    // 该工具在本会话内的已调用次数（速率闸门的输入）
    const priorCalls = await this.countPriorCalls(session.id, toolName);

    // ── 闸门（唯一入口）──
    const verdict = this.boundary.check(session, toolName, args, priorCalls);

    if (verdict.kind === "DENY") {
      await this.sessions.recordToolCall({
        sessionId: session.id,
        stepId,
        toolName,
        tier: AGENT_TOOL_SPECS.find((s) => s.name === toolName)?.tier ?? "read",
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
      );
      await this.sessions.recordToolCall({
        sessionId: session.id,
        stepId,
        toolName,
        tier: verdict.spec.tier,
        args: this.sanitizeArgs(args),
        status: "awaiting_approval",
        approvalId,
        errorMessage: verdict.message,
      });
      return {
        content:
          `【等待人工审批】${verdict.message}` +
          `（审批单 ${approvalId}）请不要重复提交，改用其他只读手段继续排查。`,
        truncated: false,
      };
    }

    // ── 执行 ──
    const spec = verdict.spec;
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
      await this.sessions.recordToolCall({
        sessionId: session.id,
        stepId,
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

    await this.sessions.recordToolCall({
      sessionId: session.id,
      stepId,
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

  private specsForSession(session: AgentSession): AgentToolSpec[] {
    // 复用注册表的白名单判定——与闸门读**同一份**数据源，不会漂移。
    const allowed = toolsForSessionKind(session.kind);
    if (allowed === null) return [...AGENT_TOOL_SPECS];
    return AGENT_TOOL_SPECS.filter((s) => allowed.includes(s.name));
  }

  private async countPriorCalls(
    sessionId: string,
    toolName: string,
  ): Promise<number> {
    const calls = await this.sessions.listToolCalls(sessionId);
    // 只数**真正执行过**的（denied 不该消耗速率预算——否则越权尝试
    // 会把正常调用也拖到限流，反而放大了攻击效果）
    return calls.filter((c) => c.toolName === toolName && c.status !== "denied")
      .length;
  }

  /**
   * 参数脱敏。
   *
   * 参数来自 LLM，可能包含它从上下文里抄来的凭据样式串。剥离的判据与
   * AiService.sanitizeLogs 同口径（项目已有 S-10 纪律），并额外按**键名**
   * 剥离凭据字段。
   */
  private sanitizeArgs(
    args: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!args) return null;
    const SECRET_KEYS =
      /token|password|passwd|secret|apikey|api_key|credential/i;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (SECRET_KEYS.test(k)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = typeof v === "string" ? this.sanitizeString(v) : v;
    }
    return out;
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
  ): Promise<string> {
    const approvalId = `apr-${session.id}-${Date.now()}`;
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
