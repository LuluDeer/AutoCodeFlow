import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AgentSession } from "../entities/agent-session.entity";
import {
  AgentSessionService,
  type RecordToolCallInput,
} from "../runtime/agent-session.service";
import { AgentNotifyService } from "../runtime/agent-notify.service";
import {
  AgentApprovalsService,
  computeApprovalArgsDigest,
  computeApprovalPolicyFingerprint,
  isSessionScopeEligible,
} from "../runtime/agent-approvals.service";
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
// 第 6 轮审计 P2：裁剪口径抽到独立文件（打断 runtime↔executor 环），
// 这里保留 re-export 以维持既有 import 面（spec 直接从本文件取）。
import { shapeToolResultForModel } from "./tool-result-shaping";
export { shapeToolResultForModel } from "./tool-result-shaping";
// S7-G1 第五阶段：脱敏实现抽到独立文件（**同一先例**，打断
// session↔executor 的 ESM 环），本文件保留同名 private 方法做薄转发。
// 用 namespace 而不是具名 import：方法名与函数名相同，`sanitize.sanitizeArgs`
// 能一眼看清「这里调的是共享实现，不是我自己的重载」。
import * as sanitize from "./agent-sanitize.util";

/**
 * P3：工具执行器（设计文档 03 §5 的执行侧）。
 *
 * ## 本服务是工具执行的唯一入口
 * 任何人要执行工具都必须经过 `execute()`，而它**强制先调边界闸门**。
 * 这是「没有工具能绕过闸门」的机制保证——不是靠约定，是靠只有这一条路径。
 *
 * ## 三道执行期纪律
 *   ① 超时：工具调用必须有上限（防某个端点卡死拖垮整个会话）；
 *   ② 结果截断：大结果只回首尾给模型（中间省略），**截断时持久化副本是
 *      preview + sha256 + truncated 标记，不保存完整结果**（避免 DB 膨胀）。
 *      运行时没有「回读完整结果」的工具（get_tool_call_result 未实现），
 *      所以提示词里不得承诺可回读；需要细节时模型应按 id 重新查询。
 *   ③ 脱敏：参数与**结果**落库前过脱敏（参数可能含模型从上下文抄来的凭据，
 *      结果里同样会有——例如 get_execution_logs 的日志行里带
 *      `AUTOFLOW_TOKEN=…` / `Bearer …`）。脱敏只作用于**持久化副本**，
 *      回给模型的 content 保持原样（见 execute 内的取舍注释）。
 */

/** 单次工具执行的超时。 */
export const TOOL_TIMEOUT_MS = 60_000;

/**
 * 超时错误（与普通执行错误区分）。
 *
 * 超时的语义不是「失败」而是「等待结束、底层仍在跑」——写/危险 tier 的
 * 超时必须按「结果未知」回给模型（见 execute 的 catch 分支）。用类型而非
 * 正则判据，避免 handler 自己的错误文案里恰好出现 "timed out" 被误判。
 */
export class ToolTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`tool ${label} timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * 回给模型的观察结果长度上限。
 *
 * 为什么是 2000 字符：典型工具结果（一条执行记录、几行日志）远小于此；
 * 而 500 条任务的列表会远超。截断保住上下文窗口：模型拿到首尾 + 省略计数，
 * 持久化副本是脱敏后的 preview+sha256（不是完整结果——`resultJson` 只保证
 * 可审计、可对账，不保证可回读全文）。
 */
export const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * 截断结果**脱敏原文**的入库上限（P4 `get_tool_call_result` 的数据源）。
 *
 * 注意「脱敏原文」不是「原始字节」：`sanitizeString` 对单个字符串另有 4000
 * 字符上限（凭据脱敏的同时防止单字段撑爆行），所以这里 32KB 约束的是**整个
 * JSON 文档**（多字段/数组仍可能超）。超过则只存 preview + sha256，工具如实
 * 告诉模型「只有预览」。32KB 是有意折中：覆盖绝大多数工具结果，又不让
 * agent_tool_calls 变成日志仓库（512KB 日志正文另有数据面）。
 */
export const TOOL_RESULT_FULL_MAX_CHARS = 32_768;

/**
 * 审批预览里**单个字符串值**的长度上限（S1-C3）。
 *
 * 超过就只留「字段名 + 长度 + 摘要」（`[omitted string len=N sha256=…]`），
 * 不再落原文——规格明写「**不落可执行脚本全文**，只落结构化字段名 + 长度 + 摘要」：
 * `sop_publish` 的正文、`update_task` 的 script 若整段落库，`agent_approvals`
 * 就悄悄变成了一份可执行的脚本文本仓库（审批表没有版本、没有访问控制分级，
 * 却会随导出接口一起流出去）。200 字符足够覆盖路径/ID/短标题这类「看名字就够」
 * 的值。
 */
export const APPROVAL_PREVIEW_VALUE_MAX_CHARS = 200;

/**
 * 审批预览的 UTF-8 字节上限（2KB）。超出即截断并置 `truncated:true` 标记
 * ——**不静默丢**（规格硬要求）：审批人必须看得出「你看的不是全部」。
 */
export const APPROVAL_PREVIEW_MAX_BYTES = 2048;

/**
 * 预览**信封**（`{"truncated":…,"omittedBytes":…,"args":…}`）的结构。
 *
 * 截断发生在 `args` 这段 JSON 文本上，而信封会把它**再转义一次**（`"` → `\"`）：
 * 转义只会变长（[`"`、控制字符]），因此「固定预留 N 字节」的做法在引号密集的
 * 载荷上会被顶破——实测 40 字段的 patch 就溢到 2081 > 2048。所以上限不是靠预留
 * 算出来的，而是**按真实信封长度二分**（见 `buildArgsPreview`）。
 */
function previewEnvelope(
  argsJson: string,
  truncated: boolean,
  omittedBytes: number,
): string {
  return truncated
    ? JSON.stringify({ truncated: true, omittedBytes, args: argsJson })
    : JSON.stringify({ truncated: false, args: argsJson });
}

/**
 * 工具参数的**保守修复**（参考 langchain `parse_partial_json` 的取舍）。
 *
 * 真实模型经常把 tool_call.arguments 写成下面几种形态：
 *   · 包在 Markdown 代码围栏里（```json … ```）；
 *   · 前后夹一句解释（"好的，参数如下：{…}"）；
 *   · 末尾多一个逗号（`{"a":1,}`）——JS 模型最常见的语法漂移。
 *
 * 这些都是**无歧义**的语法噪音，修掉不会改变语义。反之，缺引号/缺括号/缺值
 * 一律不猜：把 `{"timeout":}` 猜成 0 或 null，会让工具带着错误参数执行，比
 * 直接报错更难排查（与「结果截断不要假装完整」同一条纪律）。
 *
 * 返回 `{ok:true,value}` 或 `{ok:false,reason}`；reason 面向模型/日志，说明
 * 尝试过哪些修复。
 */
export interface RepairedToolArguments {
  ok: boolean;
  value?: unknown;
  reason?: string;
}

export function repairToolArguments(raw: string): RepairedToolArguments {
  const original = typeof raw === "string" ? raw : "{}";
  let text = original.trim();
  if (text === "") return { ok: true, value: {} };

  // ① 剥离 Markdown 代码围栏（可带 json 语言标注，围栏内是 JSON 本体）
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/m.exec(text);
  if (fence) text = fence[1].trim();

  const attempts: Array<{ label: string; value: string }> = [
    { label: "原始 JSON", value: text },
  ];

  // ② 散文包裹：截取第一个 `{` 到最后一个 `}`（或 `[`…`]`）
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  const objectSpan =
    firstBrace >= 0 && lastBrace > firstBrace
      ? text.slice(firstBrace, lastBrace + 1)
      : null;
  const arraySpan =
    firstBracket >= 0 && lastBracket > firstBracket
      ? text.slice(firstBracket, lastBracket + 1)
      : null;
  if (objectSpan && objectSpan !== text) {
    attempts.push({ label: "去除前后散文", value: objectSpan });
  } else if (!objectSpan && arraySpan && arraySpan !== text) {
    attempts.push({ label: "去除前后散文", value: arraySpan });
  }

  // ③ 尾逗号：`,}` / `,]`（只删紧跟闭合符前的逗号，字符串内的逗号不受影响
  //    ——这里用简单正则；如果逗号在字符串里，删除后 JSON 仍能解析则说明它
  //    本来就不是分隔符，语义不变）。
  for (const base of [text, objectSpan, arraySpan]) {
    if (!base) continue;
    const noTrailingComma = base.replace(/,\s*([}\]])/g, "$1");
    if (noTrailingComma !== base) {
      attempts.push({ label: "去除尾逗号", value: noTrailingComma });
    }
  }

  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (seen.has(attempt.value)) continue;
    seen.add(attempt.value);
    try {
      return { ok: true, value: JSON.parse(attempt.value) };
    } catch {
      /* 继续下一种 */
    }
  }
  return {
    ok: false,
    reason: `已尝试 ${[...seen].length} 种保守修复（去围栏/去散文/去尾逗号）仍无法解析`,
  };
}

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
    // C2：`stateChangedAt`（状态迁移时间戳）由 AgentSessionService 的写入口按
    // now() 兜底，所以 denied/awaiting_approval 等路径不必逐处传。下面**5 处**
    // （in_flight ×2 / timeout / error / ok 终局）显式传到**决定迁移的那一刻**：
    // 它们开合的是「副作用可能已发生」的窗口，是崩溃点判定与恢复文案的输入，
    // 时间点必须与调用方的因果链对齐，而不是等落库时才生成。
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
          stateChangedAt: input.stateChangedAt,
        },
      );
      // 行不在了（被清理/被别的路径更新）→ 退回插入，宁可多一行也不能丢审计
      if (!updated) await this.sessions.recordToolCall(input);
    };

    // 解析参数——模型给的是 JSON 字符串，可能是畸形 JSON。先做**保守修复**
    // （代码围栏/散文包裹/尾逗号），修不了才如实报错（见 repairToolArguments
    // 头注：绝不通猜缺失值，那会把「参数错了」变成「参数对了但值是猜的」）。
    const rawArguments = call.function?.arguments ?? "{}";
    const repaired = repairToolArguments(rawArguments);
    if (!repaired.ok) {
      const msg = `工具参数不是合法 JSON（${repaired.reason}）：${rawArguments.slice(0, 200)}`;
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
    const parsedArgs = repaired.value;
    let args: Record<string, unknown> | null =
      parsedArgs && typeof parsedArgs === "object"
        ? (parsedArgs as Record<string, unknown>)
        : null;

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

    // ── N3：当前策略指纹（授权所依据的政策快照的确定性摘要）────────────
    // 从**闸门自己用的那份求值**取值（boundary 的 resolve*），不另读配置——
    // 否则指纹会与闸门漂移：指纹说"没变"、闸门行为变了，比没有指纹更坏。
    // null = 读不到（求值抛错）⇒ 一切依赖它的判断都必须 fail-closed。
    const currentPolicyFingerprint = this.currentPolicyFingerprint();

    // ── S1-C2：会话级同参免审（只对 3 个收敛操作，白名单在审批服务里）──
    // 必须在「consumed ⇒ 拒绝」**之前**查：同会话同参的第二次调用命中的正是
    // 那条已被 consume 的一次性单，而会话级授权恰恰是为这一刻准备的。
    // argsDigest 与申请时同一份规范化（computeApprovalArgsDigest），因此
    // "同参"的判定与 approvalKey 的口径一致。
    // 只对白名单内工具算摘要/查单：其余工具的这次调用连"会话级授权"这个
    // 概念都不适用，没必要在热路径上多算一次 sha256。
    const sessionGrant = isSessionScopeEligible(toolName)
      ? await this.approvals.findActiveSessionGrant({
          sessionId: session.id,
          toolName,
          argsDigest: computeApprovalArgsDigest(args),
          policyFingerprint: currentPolicyFingerprint,
        })
      : null;

    if (existingApproval && existingApproval.status === "denied") {
      const why = `该调用已被人工拒绝（审批单 ${approvalKey}${
        existingApproval.decidedBy
          ? `，处置人 ${existingApproval.decidedBy}`
          : ""
      }）——不得重试同一调用，请改走其他手段或把结论写进最终报告。`;
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
        `Agent tool call blocked by approval state: session=${session.id} tool=${toolName} approval=${approvalKey} status=denied`,
      );
      return { content: `【调用被拒绝】${why}`, truncated: false };
    }

    if (
      existingApproval &&
      existingApproval.status === "consumed" &&
      !sessionGrant
    ) {
      const why =
        `该调用已凭审批单 ${approvalKey} 执行过一次；一张批准单只放行一次，` +
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
        `Agent tool call blocked by approval state: session=${session.id} tool=${toolName} approval=${approvalKey} status=consumed`,
      );
      return { content: `【调用被拒绝】${why}`, truncated: false };
    }

    // ── N3：已批准的一次性单必须**能证明**授权依据没变 ──────────────
    // 三道 fail-closed（顺序有意义：先报"读不到当前策略"，再报"这行没记录"，
    // 最后报"记录的不等于当前的"——给运维的是不同的处置动作）。
    if (existingApproval && existingApproval.status === "granted") {
      const rejection = this.checkApprovalPolicyBasis(
        existingApproval,
        currentPolicyFingerprint,
      );
      if (rejection) {
        await persist({
          sessionId: session.id,
          stepId,
          toolCallId: call.id,
          toolName,
          tier:
            ALL_AGENT_TOOL_SPECS.find((s) => s.name === toolName)?.tier ??
            "read",
          args: this.sanitizeArgs(args),
          status: "denied",
          approvalId: approvalKey,
          errorMessage: rejection,
        });
        this.logger.warn(
          `Agent approval blocked by policy fingerprint: session=${session.id} tool=${toolName} ` +
            `approval=${approvalKey} recorded=${existingApproval.policyFingerprint ?? "NULL"} ` +
            `current=${currentPolicyFingerprint ?? "UNREADABLE"} — fail-closed`,
        );
        return { content: `【调用被拒绝】${rejection}`, truncated: false };
      }
    }

    // 通行证优先级：**一次性单优先**（它必须被 consume 一次，保住"一次点头 =
    // 一次执行"），会话级授权只在一次性单不可用时接管（已 consumed / 尚不存在）。
    const onceApprovedKey =
      existingApproval?.status === "granted" ? approvalKey : null;
    const approvedKey = onceApprovedKey ?? sessionGrant?.approvalKey ?? null;
    // 会话级授权**不 consume**（可反复命中直到过期/策略变更）；用它时不能走
    // 领取分支，否则这张常驻授权会被一次调用吃掉。
    const approvedBySessionGrant =
      approvedKey !== null && approvedKey === sessionGrant?.approvalKey;

    // ── 闸门（唯一入口）──
    //
    // N3 纪律 ③（主会话复核补记，2026-11-01）：**策略读不到 ⇒ fail-closed**，
    // 且必须是「显式拒绝 + 零副作用」，不是「异常逃出去」。
    //
    // 背景：闸门内部会读同一份策略配置（`resolveApprovalPolicy()` /
    // `resolveExecutableSourceGate()`）。配置求值抛错时，异常会从
    // `boundary.check()` 逃出 `execute()` ⇒ 上层拿到的是**未捕获异常**而不是
    // 一条可判定的拒绝：这既不是 fail-closed（调用方看到的是崩溃而非拒绝），
    // 也可能让 AgentProcessor 的「不重抛」策略把它吞成一条含糊的失败。
    //
    // 判据：闸门抛错 ⇒ **当 DENY 处理**（落 denied 行 + 回可识别文案）。
    // 「配置抖动」与「策略不可读」都不该被当成「可以放行」，所以方向是保守的：
    // 宁可让这次调用失败并要求重试，也不放行一份依据不明的副作用。
    let verdict: ReturnType<AgentBoundaryService["check"]>;
    try {
      verdict = this.boundary.check(
        session,
        toolName,
        args,
        priorCalls,
        approvedKey,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Agent boundary check failed (policy unreadable) — failing closed: ` +
          `session=${session.id} tool=${toolName} err=${msg}`,
      );
      await persist({
        sessionId: session.id,
        stepId,
        toolCallId: call.id,
        toolName,
        tier:
          ALL_AGENT_TOOL_SPECS.find((s) => s.name === toolName)?.tier ?? "read",
        args: this.sanitizeArgs(args),
        status: "denied",
        errorMessage: `策略不可读（fail-closed）：${msg}`,
      });
      return {
        content:
          `【调用被拒绝】策略不可读（fail-closed）：${msg}。` +
          `这是环境侧的问题（配置读取失败），不是本次调用本身有问题；` +
          `请让管理员修复配置后重试，本次调用没有任何副作用。`,
        truncated: false,
      };
    }

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
      // N3：**读不到当前策略指纹时不出具审批单**。
      //
      // 理由：审批单的全部价值是"人在这套策略下点了头"。若策略求值本身失败，
      // 我们既无法把指纹写进单据、日后也无法证明它，这张单从诞生起就注定
      // 在 consume 时被拒——与其让人白点一次并留下一条 pending 垃圾，不如
      // 当场 fail-closed 并把理由写给模型/运维。
      if (!currentPolicyFingerprint) {
        const why =
          `当前审批策略指纹不可读（配置缺失或解析失败）——按 fail-closed ` +
          `拒绝放行，且不予出具无法验证的审批单。请修复策略配置后重试。`;
        await persist({
          sessionId: session.id,
          stepId,
          toolCallId: call.id,
          toolName,
          tier: verdict.spec.tier,
          args: this.sanitizeArgs(args),
          status: "denied",
          errorMessage: why,
        });
        return { content: `【调用被拒绝】${why}`, truncated: false };
      }
      const approvalId = await this.requestApproval(
        session,
        verdict.spec,
        verdict.message,
        approvalKey,
        args,
        currentPolicyFingerprint,
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
    //
    // S1-C2：走**会话级授权**时不领取——它是常驻授权（可反复命中直到过期/
    // 策略变更），被 consume 掉就退化成"一次免审"。故只有**一次性单**进这里。
    if (verdict.approvedApprovalKey && !approvedBySessionGrant) {
      const claimed = await this.approvals.consume(
        verdict.approvedApprovalKey,
        // N3：领取的原子谓词里带上当前策略指纹（不一致 ⇒ 命中 0 行 ⇒ 拒绝）。
        currentPolicyFingerprint,
      );
      if (!claimed) {
        // N3：区分"被别处用掉"与"策略已变"——两者的处置动作完全不同
        // （前者去查并发，后者去查策略配置），不能都报成"已被使用"。
        const reason = await this.approvals.explainConsumeFailure(
          verdict.approvedApprovalKey,
          currentPolicyFingerprint,
        );
        const why =
          reason === "policy_changed"
            ? `审批单 ${verdict.approvedApprovalKey} 的授权依据已失效：` +
              `批准时的策略指纹与当前生效的策略不一致（策略已收紧/变更，` +
              `或该单未记录指纹）。按 fail-closed 拒绝放行，请按当前策略` +
              `重新发起审批——不要重复提交同一调用。`
            : `审批单 ${verdict.approvedApprovalKey} 已被另一次调用使用` +
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
          `Agent approval claim lost: session=${session.id} tool=${toolName} ` +
            `approval=${verdict.approvedApprovalKey} reason=${reason}`,
        );
        return { content: `【调用被拒绝】${why}`, truncated: false };
      }
      this.logger.log(
        `Agent approval consumed: session=${session.id} tool=${toolName} approval=${verdict.approvedApprovalKey}`,
      );
    } else if (verdict.approvedApprovalKey && approvedBySessionGrant) {
      // 审计：这次调用是被哪条会话级授权放行的（它不是一次性单，不会留
      // consumedAt 痕迹，故必须在这里留一行可检索的日志）。
      this.logger.log(
        `Agent session grant hit (not consumed): session=${session.id} tool=${toolName} ` +
          `grant=${verdict.approvedApprovalKey} policyFingerprint=${currentPolicyFingerprint}`,
      );
    }

    // ── 在途台账 + 幂等闸（第 6 轮八域审计 P1）───────────────────────
    // 闸门放行到结果落库之间此前没有任何持久痕迹：进程崩溃/重启后 resume
    // 拿不到这一行，只能回「结果缺失，请重新观察」——模型最自然的下一步就是
    // 重提，deploy/trigger/rollback 变成双份副作用（langgraph 用 put_writes
    // 在任何后续步之前落 writes，结构上不会重跑）。
    //
    // 这里在**副作用之前**落一行 status=in_flight；若同一 (sessionId,
    // toolCallId) 已有一行 in_flight，说明上一进程正是死在这个窗口里：
    // 不执行、不猜测，如实回「结果未知，先核实」。同一调用的确定性幂等键
    // 同时经 ctx 透传给 handler（未来接入服务端幂等面）。
    const priorCall = await this.sessions.findToolCall(session.id, call.id);
    if (priorCall?.status === "in_flight") {
      const unknown =
        "【结果未知】该调用在进程中断前已经发起，副作用**可能已经发生**" +
        "（例如部署已派发、执行已入队）。请先用只读工具核实当前状态，" +
        "确认未生效后再决定是否重新提交；不要直接重提同一调用。";
      this.logger.warn(
        `Agent tool call found in_flight after restart: session=${session.id} ` +
          `tool=${toolName} toolCallId=${call.id} — refusing to re-execute`,
      );
      return { content: unknown, truncated: false };
    }
    // S1-C2：会话级授权放行的调用是**新调用**（此前没有 awaiting_approval
    // 台账行），必须新增一行而不是就地更新——否则在途台账/幂等闸这一层
    // 对"免审放行"的调用完全失效（崩溃后查不到痕迹）。
    if (verdict.approvedApprovalKey && !approvedBySessionGrant) {
      // 审批重放路径：原台账行已存在（awaiting_approval），**就地**改成
      // in_flight（不新增行——TOOLS-02/GAP-5 的「一次调用一行」契约）。
      await this.sessions.updateToolCallByToolCallId(session.id, call.id, {
        toolName,
        tier: spec.tier,
        status: "in_flight",
        args: this.sanitizeArgs(args),
        // C2：副作用窗口的开启时刻（就地改状态，时间戳与 status 同一次 UPDATE）
        stateChangedAt: new Date(),
      });
    } else {
      await this.sessions.recordToolCall({
        sessionId: session.id,
        stepId,
        toolCallId: call.id,
        toolName,
        tier: spec.tier,
        args: this.sanitizeArgs(args),
        status: "in_flight",
        // C2：同上——in_flight 落行时刻 = 「副作用可能已发生」窗口的起点
        stateChangedAt: new Date(),
      });
    }

    const started = Date.now();
    // ── 缺陷 A ①：取消通道 ────────────────────────────────────────
    // 超时不只是「不再等」，还要**告诉执行体别继续**：Promise.race 只是让
    // 等待结束，底层 Promise 仍在跑，副作用可能已经发生（trigger_task 建了
    // 执行、deploy 派发了部署）。这里给每次调用一个 AbortController，超时
    // 时 abort()，经 invoke 透传给**声明了第二参的组织**的 handler。
    //
    // 残差（不假装）：Promise 无法被外部杀死。只对「消费 ctx.signal」的
    // handler 生效；未改造的 handler 会继续跑完，abort 对它们只是通知。
    const controller = new AbortController();
    let result: ApiCallResult;
    try {
      result = await this.withTimeout(
        this.api.invoke(spec, args, {
          signal: controller.signal,
          sessionId: session.id,
          // 同一 (session, toolCall) 的确定性幂等键：handler 侧做服务端幂等
          // 时无需自己拼（当前尚无 handler 消费，接口先钉住，避免以后再改签名）。
          idempotencyKey: `${session.id}:${call.id}`,
        }),
        TOOL_TIMEOUT_MS,
        spec.name,
        () =>
          controller.abort(new ToolTimeoutError(spec.name, TOOL_TIMEOUT_MS)),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - started;
      const isTimeout =
        err instanceof ToolTimeoutError || /timed out/i.test(msg);

      // ── 缺陷 A ②：写/危险 tier 的超时 = 「结果未知」，不是「调用失败」──
      // 超时只是等待结束了，执行体可能已经生效。把它记成「调用失败」有两个
      // 坏后果：① 模型读到「失败」会立刻重试同一调用 → 双份副作用；
      // ② 计入熔断的连续失败，「未知」被当成「失败」，一次超时就把该工具
      // 推向熔断，后续正常调用被拒。因此写/危险 tier 的超时：
      //   · 回给模型的语义是「结果未知 + 先只读核实 + 不要重试」；
      //   · 不计入熔断连续失败（既不记 true 也不记 false —— 「未知」不改变
      //     连续失败计数，避免把结论写歪）。
      // 只读工具没有副作用（重试是安全的），超时仍按失败处理。
      if (isTimeout && spec.tier !== "read") {
        const content =
          `【结果未知（超时）】工具 ${toolName} 超过 ${TOOL_TIMEOUT_MS}ms 未返回，` +
          `本次调用可能已经生效（副作用可能已发生），但没有回执。` +
          `请先用只读工具核实（例如 list_executions / get_execution）本次调用是否落地，` +
          `不要直接重试同一写调用——重复执行会产生双份副作用。`;
        this.logger.warn(
          `Agent tool timeout (write tier, outcome unknown): session=${session.id} ` +
            `tool=${toolName} tier=${spec.tier} — ${msg}`,
        );
        await persist({
          sessionId: session.id,
          stepId,
          toolCallId: call.id,
          toolName,
          tier: spec.tier,
          args: this.sanitizeArgs(args),
          // status 仍记 timeout：审计要能按「超时」筛出这类调用（与 error 区分）
          status: "timeout",
          errorMessage: `结果未知（超时）：${msg}`,
          durationMs,
          // C2：窗口关闭时刻（结果未知也是终局，时间戳让审计能圈出未知窗口）
          stateChangedAt: new Date(),
        });
        return { content, truncated: false };
      }

      this.boundary.recordOutcome(session.id, toolName, false);
      await persist({
        sessionId: session.id,
        stepId,
        toolCallId: call.id,
        toolName,
        tier: spec.tier,
        args: this.sanitizeArgs(args),
        status: isTimeout ? "timeout" : "error",
        errorMessage: msg,
        durationMs,
        // C2：窗口关闭时刻（只读超时 / 普通失败都是终局）
        stateChangedAt: new Date(),
      });
      return { content: `【调用失败】${msg}`, truncated: false };
    }

    const durationMs = Date.now() - started;
    // 模型侧看的序列化（原文）：content 必须保留事实，脱敏只针对持久化副本。
    const serialized = JSON.stringify(result.data, null, 2);
    const truncated = serialized.length > TOOL_RESULT_MAX_CHARS;

    this.boundary.recordOutcome(session.id, toolName, !result.isError);

    // ── 缺陷 B：结果落库前同样脱敏 ─────────────────────────────────
    // 典型载荷：get_execution_logs 的日志行里有 `AUTOFLOW_TOKEN=…`、`Bearer …`。
    // 只用 sanitizeValue 会误伤 digest（见 agent-sanitize.util 的 DIGEST_ONLY_RE）——结果侧走
    // 「保留整体 digest」的变体，args 侧维持更严格的现状。
    // **取舍**：脱敏后的副本落库（长期保留、进审计详情页），回给模型的
    // content 仍是原文（模型要从日志里读事实才能推理；而错剥一个 sha256
    // 会让它对不上任何东西）。`sha256` 字段也按**原文**算——它的用途是与
    // 源数据对账，算脱敏后的串就失去意义。
    const persistedData = this.sanitizeResult(result.data);
    const preview = JSON.stringify(persistedData, null, 2).slice(0, 500);
    const sanitizedFull = JSON.stringify(persistedData, null, 2);

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
            preview,
            // P4：原文在 32KB 内时一并存下，供 get_tool_call_result 回读
            // （避免模型为了看完整结果而重新调用有副作用的工具）。
            ...(sanitizedFull.length <= TOOL_RESULT_FULL_MAX_CHARS
              ? { full: sanitizedFull }
              : {}),
          }
        : (persistedData as Record<string, unknown>),
      resultTruncated: truncated,
      status: result.isError ? "error" : "ok",
      errorMessage: result.errorMessage ?? null,
      durationMs,
      // C2：正常终局的迁移时刻（与 in_flight 成对，差值即本次调用耗时的事实口径）
      stateChangedAt: new Date(),
    });

    if (result.isError) {
      return {
        content: `【调用失败】${result.errorMessage ?? "未知错误"}`,
        truncated: false,
      };
    }

    const shaped = shapeToolResultForModel(serialized, TOOL_RESULT_MAX_CHARS);
    return { content: shaped.content, truncated: shaped.truncated };
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

  /**
   * N3：**当前生效策略的指纹**（null = 读不到 ⇒ 一切依赖它的判断 fail-closed）。
   *
   * 取值来源是 `AgentBoundaryService` 的 `resolveApprovalPolicy()` 与
   * `resolveExecutableSourceGate()`——**与闸门真正用的那份求值同一份代码**。
   * 这里刻意不自己读 `ConfigService`：另写一套键名/默认值口径，迟早与闸门
   * 漂移（指纹说"策略没变"、闸门行为却变了），那比没有指纹更坏。
   *
   * 为什么把异常吞成 null 而不是抛：本方法在工具执行路径上，抛错会让整个
   * 调用以 500 形态失败；而"策略不可证"的正确语义是**这个调用不放行**
   * （fail-closed，带可读理由），不是"会话崩了"。
   */
  private currentPolicyFingerprint(): string | null {
    try {
      const policy = this.boundary.resolveApprovalPolicy();
      return computeApprovalPolicyFingerprint({
        writeRequiresApproval: policy.writeRequiresApproval,
        dangerousRequiresApproval: policy.dangerousRequiresApproval,
        allowDangerous: policy.allowDangerous,
        executableSourceGate: this.boundary.resolveExecutableSourceGate(),
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Agent policy fingerprint unreadable: ${
          err instanceof Error ? err.message : String(err)
        } — approval paths will fail closed`,
      );
      return null;
    }
  }

  /**
   * N3：**已批准的一次性单是否仍可放行**。返回 null = 可以；返回字符串 = 拒绝理由。
   *
   * 三道判据（顺序刻意：先"读不到当前策略"，再"这行没记录"，最后"记录的不等于
   * 当前的"——三种情形运维的处置动作不同，不能合并成一句"策略已变更"）：
   *
   *   ① **当前指纹读不到**（`current === null`，配置求值抛错）⇒ 拒绝。
   *      fail-closed：证不了"授权所依据的策略没变"，就不放行。
   *   ② **该行没有记录指纹**（`policyFingerprint === null`，本列上线前创建的单）
   *      ⇒ 拒绝。**这是有代价的一次性取舍**：上线本特性时，那些"已批准但尚未
   *      执行"的存量单会失效，需要重新审批。理由：指纹机制的全部价值就是
   *      "能证明依据未变"，对无法证明的行放行等于给这条机制开一个永久后门
   *      （而存量 granted 单是短暂的：批准→执行本身是秒级动作）。
   *   ③ **记录的 ≠ 当前的** ⇒ 拒绝。这就是"策略收紧 ⇒ 旧授权不再放行"。
   */
  private checkApprovalPolicyBasis(
    row: { policyFingerprint: string | null },
    currentPolicyFingerprint: string | null,
  ): string | null {
    if (!currentPolicyFingerprint) {
      return (
        `无法读取当前审批策略指纹（配置缺失或解析失败）——` +
        `按 fail-closed 拒绝放行：在不能证明"授权所依据的策略未变"的情况下，` +
        `本调用不执行。请修复策略配置后重新发起审批。`
      );
    }
    if (!row.policyFingerprint) {
      return (
        `该审批单没有记录策略指纹（本机制上线前创建）——` +
        `按 fail-closed 拒绝放行：无法证明它是在当前策略下被批准的。` +
        `请重新发起审批（策略未变时重新批准的代价只是一次点头）。`
      );
    }
    if (row.policyFingerprint !== currentPolicyFingerprint) {
      return (
        `该审批单的授权依据已失效：批准时的策略指纹与当前生效的策略不一致` +
        `（策略已变更/收紧）——按 fail-closed 拒绝放行。` +
        `请按当前策略重新发起审批，不要重复提交同一调用。`
      );
    }
    return null;
  }

  private specsForSession(session: AgentSession): AgentToolSpec[] {
    // 复用注册表的白名单判定——与闸门读**同一份**数据源，不会漂移。
    //
    // TOOLS-01：这里必须用 ALL_AGENT_TOOL_SPECS（收编集 ∪ 内部集）。
    // 用 AGENT_TOOL_SPECS 会让 6 个 sop_* 内部工具**从不下发给模型**：
    // 白名单里有、闸门认得、执行体已绑定，唯独模型看不到函数定义——
    // SOP 起草/发布/澄清复核整条链路静默不可用，且没有任何报错。
    //
    // 第二个参数是**阶段**（registry 的 SESSION_PHASE_TOOL_ALLOWLIST）：本仓
    // 除 kind 外没有可靠的阶段字段（见该表注释），故显式传 null = 只按类型裁剪，
    // 行为不变。阶段维度只在**暴露侧**收窄；闸门（agent-boundary.service.ts）
    // 仍按类型判，两者是「暴露 ⊆ 放行」的关系（收窄不会放宽任何闸门）。
    const allowed = toolsForSessionKind(session.kind, null);
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
   * 参数脱敏（**薄转发** —— 实现对 S7-G1 第五阶段搬到了
   * `./agent-sanitize.util.ts`，理由见该文件头注：事件 payload 也要脱敏，
   * 而反向 import 会与 `agent-session.service.ts` 成 ESM 环）。
   *
   * 保留这层方法而不是把 20+ 个调用点改成自由函数：本轮是**纯搬移**，
   * 调用点一行不动，回归面为零。规则本体逐字未改（含 S1-C3 小写凭据规则）。
   */
  private sanitizeArgs(
    args: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    return sanitize.sanitizeArgs(args);
  }

  /**
   * 结果侧脱敏（落库副本用；薄转发，同上）。
   *
   * 与 `sanitizeArgs` 同一套规则，唯一差别：**整体是 digest 的字符串原值
   * 保留**（`DIGEST_ONLY_RE`）。args 侧不启用——模型给的参数里没有对账
   * 需求，宁可多剥。
   */
  private sanitizeResult(data: unknown): unknown {
    return sanitize.sanitizeResult(data);
  }

  private sha256(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }

  /**
   * 审批单的「被批对象」人类可读预览（S1-C3）。
   *
   * 三段式，缺一不可：
   *   ① **脱敏**：直接复用 `sanitizeArgs`（`agent-sanitize.util`；键名命中 `SECRET_KEYS_RE` +
   *      env 赋值 / `Bearer` / 32+ hex 样式串，递归）。**不新写第二套规则**——
   *      preview 是一条新泄密面，而两套规则一定会漂移，届时「参数列已脱敏」
   *      这个结论就不再对 preview 成立。
   *   ② **长值降级**：单值超 `APPROVAL_PREVIEW_VALUE_MAX_CHARS` 只留长度 + 摘要，
   *      不落脚本全文（见常量注释）。
   *   ③ **2KB 截断 + 标记**：超预算就截断并置 `truncated:true`，附带
   *      `omittedBytes`——审批人看得见「这份预览不是全部」，机器也能断言。
   *
   * 返回 JSON 文本信封 `{"truncated":bool,"omittedBytes"?,"args":"<JSON 文本>"}`：
   * 信封恒定可 `JSON.parse`（截断只发生在 `args` 这段字符串内部，不影响外层
   * 语法），因此前端能稳定地区分「无预览」与「被截断的预览」，而不用去猜尾缀。
   * `args` 恒为字符串，使 `truncated` 可以只靠信封表达，不必把对象切一半。
   *
   * args 为 null（无参数调用）时返回 null：NULL 的语义由实体注释界定，读面按
   * 「无参数 / 旧单」降级展示。
   */
  private buildArgsPreview(
    args: Record<string, unknown> | null,
  ): string | null {
    if (!args) return null;
    const sanitized = this.sanitizeArgs(args);
    if (!sanitized) return null;
    const body = JSON.stringify(this.previewValue(sanitized, 0)) ?? "null";
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (
      Buffer.byteLength(previewEnvelope(body, false, 0), "utf8") <=
      APPROVAL_PREVIEW_MAX_BYTES
    ) {
      return previewEnvelope(body, false, 0);
    }
    // 超预算：二分找「最大的可放入信封的前缀」。判据是**真实信封长度**而不是
    // 预留字节数——信封会把 args 再转义一次（`"` → `\"`），固定预留会在引号
    // 密集的载荷上被顶破（实测 2081 > 2048）。
    //   · 上界 min(body, 2048)：转义只会变长，切点超过 2048 字节必然放不下，
    //     同时让每次 cutUtf8 的步行有界；
    //   · 判定时把 omittedBytes 取**最大可能值**（= bodyBytes，位数最多）⇒ 判据
    //     对 mid 单调（只随 args 变长），落地时用真实值只会更短。
    const hi = Math.min(bodyBytes, APPROVAL_PREVIEW_MAX_BYTES);
    let lo = 0;
    let high = hi;
    let bestCut = "";
    while (lo <= high) {
      const mid = (lo + high) >> 1;
      const cut = cutUtf8(body, mid);
      if (
        Buffer.byteLength(previewEnvelope(cut, true, bodyBytes), "utf8") <=
        APPROVAL_PREVIEW_MAX_BYTES
      ) {
        bestCut = cut;
        lo = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return previewEnvelope(
      bestCut,
      true,
      bodyBytes - Buffer.byteLength(bestCut, "utf8"),
    );
  }

  /**
   * 预览用的值折叠：长字符串 → `[omitted string len=N sha256=…]`。
   *
   * 摘要算在**已脱敏**的字符串上（入参已过 `sanitizeArgs`），供审批人核对
   * 「被省掉的正是这一段」；与 `argsDigest` 同类暴露面，不引入新的可爆破面。
   * 深度钳位与 `sanitizeValue` 同口径（32 层，越界给稳定占位串）。
   */
  private previewValue(value: unknown, depth: number): unknown {
    if (depth > 32) return "[TRUNCATED_NESTED]";
    if (Array.isArray(value)) {
      return value.map((v) => this.previewValue(v, depth + 1));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.previewValue(v, depth + 1);
      }
      return out;
    }
    if (
      typeof value === "string" &&
      value.length > APPROVAL_PREVIEW_VALUE_MAX_CHARS
    ) {
      return `[omitted string len=${value.length} sha256=${this.sha256(value).slice(0, 16)}]`;
    }
    return value;
  }

  /**
   * 超时闸门。
   *
   * `onTimeout` 在 reject 之前调用——先发取消信号（告诉执行体别继续），再
   * reject（给等待者回执）。顺序有意义：abort 抛错不能吞掉超时语义，因此
   * 单独 try 包住。
   */
  private async withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
    onTimeout?: () => void,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            try {
              onTimeout?.();
            } catch {
              // handler 的 abort 处理抛错不影响超时结论
            }
            reject(new ToolTimeoutError(label, ms));
          }, ms);
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
    args: Record<string, unknown> | null,
    policyFingerprint: string,
  ): Promise<string> {
    // 键由调用方按 (会话, 工具, 参数) 确定性生成（approvals.buildKey）：
    // 同参重试命中同一行，管理员批的那张就是模型正在等的那张。
    const approvalId = approvalKey;
    // A1 审批闭环（实施轮 #12）：先落库（agent_approvals，approvalKey 唯一
    // 约束保证重试幂等）再把会话挂起——「先落盘后发送」同款纪律。挂起用
    // markWaiting 的条件写（R36）：会话恰好被 finish 收敛到终态时挂起让位，
    // 此时的审批单留在 pending 等管理员处置（或过期清理），不阻塞任何人。
    //
    // S1-C3（审批信息完整性）：审批单现在必须带上**被批对象**——审批人此前只看
    // 得到工具名与固定文案，四眼原则在信息面上是空的。两件东西各管一件事：
    //   · argsDigest：与 approvalKey 同源的参数摘要（机器对账锚点）；
    //   · preview：脱敏 + 截断后的人类可读预览（给人看）。
    // 两者在这里只算一次、随申请一起落库——审批卡片与导出接口读的是同一份事实，
    // 而不是读侧各算各的（那样「审批人看到的」与「被批准的」可能不一致）。
    await this.approvals.request({
      approvalKey: approvalId,
      sessionId: session.id,
      toolName: spec.name,
      reason,
      argsDigest: computeApprovalArgsDigest(args),
      preview: this.buildArgsPreview(args),
      // N3：把"这份授权所依据的策略"定格在单据上。清单一律走 apply/session
      // 之外的两列（scope 由服务端固定 once）——申请方不能自选授权范围。
      policyFingerprint,
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

/**
 * 按**码点边界**把 UTF-8 字符串切到不超过 `maxBytes` 字节。
 *
 * 为什么不能 `Buffer.from(s).subarray(0, n).toString("utf8")`：切在多字节序列
 * 中间时 TextDecoder 会吐 U+FFFD（每个 3 字节），3 个残缺字节最多膨胀成 9 字节
 * ——「截到 2048」这一条会在边界上被自己顶破，而且库里存进替换字符后，
 * `omittedBytes` 也不再等于真实丢弃量。这里逐码点累加，切点只落在字符边界上，
 * 返回值的字节数**恰好** ≤ maxBytes，`args` 也不会以半个字符收尾。
 */
function cutUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let chars = 0;
  for (const ch of s) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    chars += ch.length;
  }
  return s.slice(0, chars);
}
