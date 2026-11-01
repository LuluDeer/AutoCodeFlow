import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";

import {
  ToolExecutorService,
  TOOL_RESULT_MAX_CHARS,
  TOOL_TIMEOUT_MS,
  shapeToolResultForModel,
  repairToolArguments,
} from "../tool-executor.service";
import { AgentBoundaryService } from "../../boundary/agent-boundary.service";
import {
  APPROVAL_POLICY_FINGERPRINT_KEYS,
  canonicalJson,
  computeApprovalPolicyFingerprint,
} from "../../runtime/agent-approvals.service";
import type { AgentSession } from "../../entities/agent-session.entity";
import { ALL_AGENT_TOOL_SPECS, toolsForSessionKind } from "../tool-registry";

function harness(opts?: {
  invoke?: (
    spec: { name: string },
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  toolCalls?: Array<{ toolName: string; status: string }>;
  /** 已存在的审批单（granted/denied/consumed/pending）；默认无。 */
  existingApproval?: {
    approvalKey: string;
    status: string;
    decidedBy?: string | null;
    /** N3：批这份授权时的策略指纹；undefined ⇒ 用「当前策略」的值（即未变更）。 */
    policyFingerprint?: string | null;
    scope?: string;
  } | null;
  /** consume 条件写是否成功（默认 true）。 */
  consumeOk?: boolean;
  /** N3：consume 失败时的可断言理由（默认 not_granted）。 */
  consumeFailReason?: "policy_changed" | "not_granted" | "missing";
  /** S1-C2：命中的会话级授权行（默认无）。 */
  sessionGrant?: {
    approvalKey: string;
    status: string;
    scope?: string;
    expiresAt?: Date | null;
    policyFingerprint?: string | null;
  } | null;
  sops?: Partial<{
    getBySlug: (slug: string) => Promise<unknown>;
    getClarificationScopeInfo: (
      id: string,
    ) => Promise<Record<string, unknown> | null>;
  }>;
  /**
   * N3：**策略求值抛错**（模拟 ConfigService 读取时炸了 / 配置结构坏掉）。
   *
   * 有了它才能测「当前策略指纹读不到 ⇒ fail-closed」这一条——那是纪律里
   * 明写的要求（「指纹读不到/解析失败 ⇒ 拒绝，不静默放行」）。默认 undefined
   * （策略可读，一切正常），只有显式给出时才让 `config.get` 抛。
   *
   * **只让「指纹自己的那四个键」抛**：抛别的键（如速率限制的
   * `agent.policy.maxCallsPerTool`）会让闸门在**求值阶段**就炸掉——那测的是
   * 「闸门崩了」，不是「策略指纹读不到」。本用例要精确模拟的是后者：闸门
   * 仍能跑完（速率/熔断/白名单都正常），只是**指纹那一项**求不出来。
   */
  policyConfigThrows?: boolean;
  /**
   * 只让**这一个键**的读取抛错（比 `policyConfigThrows` 更精确）。
   *
   * 为什么需要更精确的粒度：`resolveApprovalPolicy()` 的三个键
   * （writeRequiresApproval / dangerousRequiresApproval / allowDangerous）
   * **闸门自己也要读**——让它们抛，异常会在 `boundary.check()` 里逃出去
   * （测的是"闸门崩了"，不是"指纹读不到"）。而
   * `agent.policy.executableSourceGate` 只在**有 `executableSourceFields` 的
   * 工具**上才被闸门读（`validateExecutableSource` 先看字段、没有就早退），
   * 因此对 `stop_deployment` 这类工具：让它抛 ⇒ **闸门照常跑完**，
   * 但 `currentPolicyFingerprint()` 求不出指纹 ⇒ 正是纪律 ③ 的场景。
   */
  policyConfigThrowsFor?: string;
}) {
  const boundary = new AgentBoundaryService({
    get: (key: string) => {
      if (opts?.policyConfigThrowsFor === key) {
        throw new Error(`配置读取失败：${key}`);
      }
      if (
        opts?.policyConfigThrows &&
        (APPROVAL_POLICY_FINGERPRINT_KEYS as readonly string[]).includes(key)
      ) {
        throw new Error(`配置读取失败：${key}`);
      }
      return undefined;
    },
  } as unknown as ConfigService);
  const sessions = {
    // 第 6 轮：在途台账/幂等闸的读面（默认无历史行）
    findToolCall: jest.fn(async () => null),
    recordToolCall: jest.fn(async (v: unknown) => v),
    // TOOLS-02 确定性重放：就地更新原台账行（避开 GAP-5 唯一索引）
    updateToolCallByToolCallId: jest.fn(async () => true),
    listToolCalls: jest.fn(async () => opts?.toolCalls ?? []),
    markWaiting: jest.fn(async () => undefined),
  };
  const api = {
    invoke: jest.fn(
      opts?.invoke ?? (async () => ({ data: { ok: true }, isError: false })),
    ),
  };
  const notify = { approvalRequested: jest.fn(async () => undefined) };
  // B-2/B-3：执行体入口的两道校验依赖 SopService（slug→id、澄清归属投影）
  const sops = {
    getBySlug: jest.fn(
      opts?.sops?.getBySlug ?? (async () => ({ id: "sop-1" })),
    ),
    getClarificationScopeInfo: jest.fn(
      opts?.sops?.getClarificationScopeInfo ??
        (async () => ({
          assignmentId: "a1",
          sopId: "sop-1",
          reviewSessionId: null,
        })),
    ),
  };
  const checkSpy = jest.spyOn(boundary, "check");
  // 缺陷 A：熔断记账是「超时算不算失败」的判据，用例要能断言它的参数
  const outcomeSpy = jest.spyOn(boundary, "recordOutcome");
  // A1 审批闭环（实施轮 #12）：requestApproval 现在要经 approvals 落库并
  // markWaiting 挂起——替身默认放行（不落真行），闭环行为由
  // agent-approvals.spec.ts 与本文件的新用例钉。
  // N3：harness 的 boundary 用默认策略（config.get 恒 undefined），故"当前
  // 策略指纹"是个确定值——已批准的假行默认带同一个值，表示"策略未变更"。
  // 想模拟"策略收紧"的用例显式传一个不同的 policyFingerprint 即可。
  const currentPolicyFingerprint = computeApprovalPolicyFingerprint({
    writeRequiresApproval: false,
    dangerousRequiresApproval: true,
    allowDangerous: false,
    executableSourceGate: true,
  });
  const approvals = {
    request: jest.fn(async (v: unknown) => v),
    // 实施轮 #14（执行侧闭环）：闸门消费审批结论需要这三个口子。
    //   buildKey 用真实实现（纯函数，键的确定性本身要被测）
    //   findByKey 默认「没有审批单」；consume 默认领取成功。
    buildKey: (
      sessionId: string,
      toolName: string,
      args: Record<string, unknown> | null,
    ) => `apr-${sessionId}-${toolName}-${JSON.stringify(args ?? null)}`,
    findByKey: jest.fn(async () =>
      opts?.existingApproval
        ? {
            policyFingerprint: currentPolicyFingerprint,
            scope: "once",
            ...opts.existingApproval,
          }
        : null,
    ),
    // S1-C2：会话级授权的查单口（默认无 —— 老用例的语义完全不变）
    findActiveSessionGrant: jest.fn(async () => opts?.sessionGrant ?? null),
    consume: jest.fn(async () => opts?.consumeOk ?? true),
    explainConsumeFailure: jest.fn(
      async () => opts?.consumeFailReason ?? "not_granted",
    ),
  };
  const svc = new ToolExecutorService(
    boundary,
    sessions as never,
    api as never,
    notify as never,
    approvals as never,
    sops as never,
  );
  return {
    svc,
    boundary,
    currentPolicyFingerprint,
    sessions,
    api,
    notify,
    approvals,
    sops,
    checkSpy,
    outcomeSpy,
  };
}

function session(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "s-1",
    kind: "chat",
    scopeJson: { unrestricted: true },
    ...patch,
  } as unknown as AgentSession;
}

const call = (name: string, args: unknown) => ({
  id: "call-1",
  function: {
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  },
});

describe("ToolExecutorService · availableTools（喂给 LLM 的白名单）", () => {
  it("硬禁用工具不暴露给模型；chat 会话见全集（除硬禁用）", async () => {
    const { svc } = harness();
    const tools = await svc.availableTools(session());
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("approve_deployment");
    expect(names).not.toContain("reject_deployment");
    expect(names).toContain("get_task");
    // TOOLS-01：内部 SOP 工具与收编工具一起下发（此前用 AGENT_TOOL_SPECS
    // 过滤，6 个 sop_* 从不出现在请求的 tools 里，SOP 链路静默不可用）。
    expect(names).toContain("sop_publish");
    expect(names).toContain("sop_draft");
    for (const t of tools) {
      expect(t).toHaveProperty("parameters");
      expect(t).toHaveProperty("tier");
    }
    // 阶段维度接入后 chat 语义**逐字未变**：仍是「全集 − 硬禁用」（不是空集、
    // 也不是某个子集），且 registry 对 chat 仍返回 null（「不限」的哨兵）。
    expect(names).toHaveLength(
      ALL_AGENT_TOOL_SPECS.filter((t) => !t.hardDisabled).length,
    );
    expect(toolsForSessionKind("chat")).toBeNull();
  });

  it("ops_watch 会话只见只读工具", async () => {
    const { svc } = harness();
    const tools = await svc.availableTools(
      session({ kind: "ops_watch" } as never),
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_task");
    expect(names).not.toContain("trigger_task");
  });
});

describe("ToolExecutorService · execute（唯一入口，强制过闸）", () => {
  it("畸形 JSON 参数：落 error 并把可读原因回给模型", async () => {
    const { svc, sessions, api } = harness();
    const out = await svc.execute(
      session(),
      call("get_task", "{bad json"),
      "step-1",
    );
    expect(out).toEqual({
      content: expect.stringContaining("不是合法 JSON"),
      truncated: false,
    });
    expect(sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", tier: "read" }),
    );
    expect(api.invoke).not.toHaveBeenCalled();
  });

  it("闸门 DENY：denied 落库 + 不消耗速率预算（denied 不计入 priorCalls）", async () => {
    const h = harness({
      toolCalls: [
        { toolName: "get_task", status: "denied" },
        { toolName: "get_task", status: "denied" },
        { toolName: "get_task", status: "ok" },
      ],
    });
    // out_of_scope：会话 scope 不含 tasks
    const restricted = session({ scopeJson: {} } as never);
    const out = await h.svc.execute(
      restricted,
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" }),
    );
    // 3 条历史里 2 条 denied → priorCalls=1（denied 不消耗预算）
    expect(h.checkSpy.mock.calls[0][3]).toBe(1);
  });

  // APPROVAL-GAP（2026-10-27 审计轮 #11，A1）：本用例原先断言文案含
  // 【等待人工审批】——而"等待"在实现上等于"永远等不到"（审批单不落库、
  // 无 grant 端点、markWaiting 无生产调用方）。断言把**声明与实现不符**
  // 固化成了预期行为。现改为断言"如实告知不可执行"，并把三条事实一起钉住。
  it("NEED_APPROVAL：审批单落库 + 会话挂起 + 通知推送 + 告知已提交（A1 闭环）", async () => {
    const h = harness();
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    // 闭环后文案不再说"不可执行"——审批单真的在等人处置，grant 后自动恢复
    expect(out.content).toContain("【需人工审批，已提交审批单】");
    expect(out.content).toContain("请勿重复提交");
    // 落库三件套：agent_approvals 申请（含幂等键）、调用行 awaiting_approval、
    // 会话 markWaiting 挂起（"生产零调用"是 A1 的原始形态之一，必须钉住）
    expect(h.approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalKey: expect.stringContaining("apr-s-1-"),
        sessionId: "s-1",
        toolName: "sop_publish",
      }),
    );
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "awaiting_approval",
        approvalId: expect.stringContaining("apr-s-1-"),
      }),
    );
    expect(h.sessions.markWaiting).toHaveBeenCalledWith(
      "s-1",
      expect.stringContaining("等待审批"),
    );
    expect(h.notify.approvalRequested).toHaveBeenCalled();
    // needsApproval 是运行时的「停轮」信号：没有它，会话会在已 waiting_input
    // 的状态下继续下一轮推理（实施轮 #14 的并发缺陷形态）。
    expect(out.needsApproval).toBe(true);
  });

  /**
   * S1-C3（审批信息完整性）：审批单必须携带**被批对象**——审批人此前只看得到
   * 工具名与固定 reason，四眼原则在信息面上是空的（盲批）。
   *
   * 这里钉住落库那一份数据的两条硬约束（preview 是一条**新泄密面**，所以脱敏
   * 与截断各有一条独立断言，不做就等于把风险引进来）：
   *   · **脱敏**：含 `token=` / `apiKey` / `password` 的参数落库后查不到明文；
   *   · **截断不静默**：超 2KB 截断且带可断言的 `truncated` 标记，长字符串值
   *     只留「字段名 + 长度 + 摘要」（不落可执行脚本全文）。
   */
  describe("S1-C3 · 审批单携带参数摘要与脱敏预览", () => {
    const TASK_ID = "11111111-1111-4111-8111-111111111111";

    /** 落库那一份（= approvals.request 的入参，它就是 agent_approvals 的行）。 */
    const requestPayload = (h: ReturnType<typeof harness>) =>
      (h.approvals.request as jest.Mock).mock.calls[0][0] as {
        argsDigest: string;
        preview: string | null;
      };

    it("argsDigest = sha256(canonicalJson(args))（现算核对）；preview 已脱敏、库中无明文", async () => {
      const args = {
        taskId: TASK_ID,
        patch: {
          title: "改个名字",
          apiKey: "sk-live-abcdef1234567890",
          env: { DB_PASSWORD: "sup3rs3cret-value" },
          note: "AUTOFLOW_TOKEN=plaintext-token-value",
          // 小写/混合形态（模型抄上下文时最常见的写法）：既有规则只认全大写 env
          // 形态，S1-C3 在同一份 sanitizeString 里补了凭据词表的 case-insensitive 分支
          headers: "Authorization: Bearer sk-live-abcdef1234567890",
          body: "token=lowercase-plaintext-token&user=bob",
          inline: '{"api_key": "json-plaintext-key"}',
          glueSource: "echo hello; ".repeat(40),
        },
      };
      const h = harness();
      const out = await h.svc.execute(
        session(),
        call("update_task", args),
        null,
      );
      expect(out.needsApproval).toBe(true);
      const payload = requestPayload(h);

      // ① 摘要：与审批键**同一份**规范化（这里用 node:crypto + 同一个
      //    canonicalJson 独立算一遍，实现里若偷换序列化立刻红）
      expect(payload.argsDigest).toBe(
        createHash("sha256").update(canonicalJson(args)).digest("hex"),
      );

      // ② 预览：走既有 sanitizeArgs（键名 + 内容两条规则都生效，且递归进嵌套）
      expect(payload.preview).not.toBeNull();
      const envelope = JSON.parse(payload.preview as string) as {
        truncated: boolean;
        args: string;
      };
      const persisted = JSON.parse(envelope.args) as {
        taskId: string;
        patch: Record<string, unknown>;
      };
      expect(envelope.truncated).toBe(false);
      expect(persisted.patch.apiKey).toBe("[REDACTED]");
      expect((persisted.patch.env as Record<string, unknown>).DB_PASSWORD).toBe(
        "[REDACTED]",
      );
      // 键名保留（审批人要看得见「哪个变量被改」），值打码
      expect(persisted.patch.note).toBe("AUTOFLOW_TOKEN=[REDACTED]");
      // 小写形态：值里的凭据样式串同样打码（只认全大写 env 形态是旧实现的缺口）
      expect(String(persisted.patch.body)).toContain("[REDACTED]");
      expect(String(persisted.patch.headers)).toContain("[REDACTED]");
      expect(String(persisted.patch.inline)).toContain("[REDACTED]");
      // 不落可执行脚本全文：只留字段名 + 长度 + 摘要
      expect(persisted.patch.glueSource).toMatch(
        /^\[omitted string len=\d+ sha256=[0-9a-f]{16}\]$/,
      );

      // ③ 「库中不存在明文」逐条钉死（脱敏不能停在感觉上）
      const raw = payload.preview as string;
      expect(raw).not.toContain("sup3rs3cret-value");
      expect(raw).not.toContain("plaintext-token-value");
      expect(raw).not.toContain("sk-live-abcdef1234567890");
      expect(raw).not.toContain("lowercase-plaintext-token");
      expect(raw).not.toContain("json-plaintext-key");
      expect(raw).not.toContain("echo hello");
      expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "awaiting_approval",
          args: expect.objectContaining({
            patch: expect.objectContaining({ apiKey: "[REDACTED]" }),
          }),
        }),
      );
    });

    it("preview 超 2KB → 截断 + truncated 标记（不静默丢），且不切出半个字符", async () => {
      // 多字节字符 + 贴身塞满：既压到 2KB 之上，也逼出「切点落在 3 字节
      // 序列中间」的边界（用 Buffer 硬切会吐 U+FFFD 并顶破 2KB）
      const patch: Record<string, string> = {};
      for (let i = 0; i < 40; i += 1) patch[`field${i}`] = "值".repeat(30);
      const args = { taskId: TASK_ID, patch };
      const h = harness();
      await h.svc.execute(session(), call("update_task", args), null);
      const payload = requestPayload(h);
      const preview = payload.preview as string;

      expect(preview).toContain('"truncated":true');
      const envelope = JSON.parse(preview) as {
        truncated: boolean;
        omittedBytes: number;
        args: string;
      };
      expect(envelope.truncated).toBe(true);
      expect(envelope.omittedBytes).toBeGreaterThan(0);
      // 硬上限：截断后的整串（含信封）不得超过 2KB
      expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(2048);
      // 截断不静默：args 段非空且是合法 JSON 文本的前缀（留着让人看到截到哪）
      expect(envelope.args.length).toBeGreaterThan(0);
      expect(envelope.args.startsWith('{"taskId":')).toBe(true);
      expect(preview).not.toContain("\uFFFD");
      // 摘要在：被批对象仍可与 buildKey 对账
      expect(payload.argsDigest).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── 执行侧闭环（实施轮 #14）：审批结论必须被执行路径消费 ──────────────
  //
  // 原实现只有申请侧：闸门恒返回 NEED_APPROVAL，grant 只翻数据库行。批准后
  // resume，模型重提同一调用会得到第二张单——「人工点头后可用」不成立。
  it("granted 审批单 → 闸门放行（其余闸照旧）+ 执行前领取 + 真的调用 API", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-sop_publish-x",
        status: "granted",
      },
    });
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    // 闸门收到第五参（本次调用的通行证），而不是再次 NEED_APPROVAL
    expect(h.checkSpy.mock.calls[0][4]).toEqual(expect.any(String));
    expect(h.api.invoke).toHaveBeenCalled();
    expect(out.content).not.toContain("需人工审批");
    // 领取在副作用之前：consume 被调用且 key 与闸门收到的一致
    // N3：领取时**必须**带上当前策略指纹（null/漏传就等于跳过指纹校验）
    expect(h.approvals.consume).toHaveBeenCalledWith(
      h.checkSpy.mock.calls[0][4],
      expect.any(String),
    );
  });

  it("denied 审批单 → 直接拒绝：不重新申请、不挂起、不调用 API", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-sop_publish-x",
        status: "denied",
        decidedBy: "alice",
      },
    });
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    expect(out.content).toContain("已被人工拒绝");
    expect(out.content).toContain("alice");
    expect(out.needsApproval).toBeUndefined();
    expect(h.approvals.request).not.toHaveBeenCalled();
    expect(h.sessions.markWaiting).not.toHaveBeenCalled();
    expect(h.api.invoke).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" }),
    );
  });

  it("consumed 审批单 → 拒绝（一张批准单只放行一次）", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-sop_publish-x",
        status: "consumed",
      },
    });
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    expect(out.content).toContain("只放行一次");
    expect(h.api.invoke).not.toHaveBeenCalled();
  });

  it("领取失败（并发抢单 / 已被用掉）→ 拒绝且不产生副作用", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-sop_publish-x",
        status: "granted",
      },
      consumeOk: false,
    });
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    expect(out.content).toContain("已被另一次调用使用");
    expect(h.approvals.consume).toHaveBeenCalled();
    expect(h.api.invoke).not.toHaveBeenCalled();
  });

  // C4（审计轮 #11）：awaiting_approval 不得消耗速率配额——审批通道没闭环时，
  // 一个会话碰几次"需审批"的工具就会把配额烧光，而它一次都没真正执行过。
  it("C4：awaiting_approval 不计入速率配额（只有真正执行过才算）", async () => {
    const h = harness();
    h.sessions.listToolCalls.mockResolvedValue([
      { toolName: "sop_publish", status: "awaiting_approval" },
      { toolName: "sop_publish", status: "awaiting_approval" },
      { toolName: "sop_publish", status: "success" },
    ]);
    await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    // 3 条历史里 2 条 awaiting_approval 被排除 ⇒ priorCalls=1
    expect(h.checkSpy.mock.calls[0][3]).toBe(1);
  });

  it("执行成功：小结果原样回传；recordOutcome(true)", async () => {
    const h = harness();
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.truncated).toBe(false);
    expect(JSON.parse(out.content)).toEqual({ ok: true });
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", resultTruncated: false }),
    );
  });

  it("大结果截断：模型拿前 2000 字符 + 截断标记；完整落库为 preview+sha256", async () => {
    const big = { items: "x".repeat(TOOL_RESULT_MAX_CHARS + 500) };
    const h = harness({ invoke: async () => ({ data: big, isError: false }) });
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.truncated).toBe(true);
    // 首尾保留 + 中段省略：错误/结论通常在尾部，不能只留头部
    expect(out.content).toContain("中间省略");
    expect(out.content.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(out.content.startsWith("{")).toBe(true);
    expect(out.content).toContain('"items"');
    expect(out.content.trimEnd().endsWith("}")).toBe(true);
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as Record<string, unknown>;
    expect(recorded.resultTruncated).toBe(true);
    expect((recorded.result as Record<string, unknown>).preview).toHaveLength(
      500,
    );
    // P4：原文 ≤32KB 时一并存下（get_tool_call_result 的数据源）
    expect(typeof (recorded.result as Record<string, unknown>).full).toBe(
      "string",
    );
    expect(
      ((recorded.result as Record<string, unknown>).full as string).length,
    ).toBeGreaterThan(TOOL_RESULT_MAX_CHARS);
    expect((recorded.result as Record<string, unknown>).sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("invoke 抛异常：error 落库 + 熔断记账失败", async () => {
    const h = harness({
      invoke: async () => {
        throw new Error("connection refused");
      },
    });
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.content).toContain("【调用失败】connection refused");
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" }),
    );
  });

  it("超时：status=timeout（不与普通 error 混淆）", async () => {
    jest.useFakeTimers();
    try {
      const h = harness({
        invoke: () => new Promise<never>(() => undefined), // 永不 resolve
      });
      const p = h.svc.execute(
        session(),
        call("get_task", { taskId: "t-1" }),
        null,
      );
      const race = jest.advanceTimersByTimeAsync(60_000);
      const out = await p;
      await race;
      expect(out.content).toContain("timed out");
      expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ status: "timeout" }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("invoke 返回 isError（如「尚未实现」）：调用失败回传 + 失败记账", async () => {
    const h = harness({
      invoke: async () => ({
        data: null,
        isError: true,
        errorMessage: "尚未实现",
      }),
    });
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.content).toBe("【调用失败】尚未实现");
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", errorMessage: "尚未实现" }),
    );
  });
});

describe("ToolExecutorService · 脱敏（凭据不落库）", () => {
  it("键名剥离（token/password/apiKey/credential）+ 值形态剥离（Bearer/hex/VAR=）", async () => {
    const h = harness();
    await h.svc.execute(
      session(),
      call("get_task", {
        taskId: "t-1",
        apiKey: "sk-abcdef",
        password: "hunter2",
        note: "Authorization=Bearer abc.def TIMEOUT=30 0123abcd0123abcd0123abcd0123abcd",
      }),
      null,
    );
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as {
      args: Record<string, unknown>;
    };
    expect(recorded.args.apiKey).toBe("[REDACTED]");
    expect(recorded.args.password).toBe("[REDACTED]");
    expect(recorded.args.note as string).toContain("[REDACTED]");
    expect(recorded.args.note as string).not.toContain("hunter2");
    expect(recorded.args.note as string).toContain("[REDACTED_HEX]");
    expect(recorded.args.note as string).not.toContain("0123abcd0123abcd");
  });

  it("嵌套层的凭据同样剥离（对象/数组递归——落库前无死角）", async () => {
    const h = harness();
    await h.svc.execute(
      session(),
      call("trigger_task", {
        taskId: "t-1",
        params: {
          nested: { apiToken: "sk-nested-secret", password: "hunter2" },
          tokens: ["tok-a", "tok-b"],
          list: ["tok-a", "tok-b"],
          note: "Bearer nested.should.not.leak",
        },
      }),
      null,
    );
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as {
      args: Record<string, unknown>;
    };
    const params = recorded.args.params as Record<string, unknown>;
    const nested = params.nested as Record<string, unknown>;
    expect(nested.apiToken).toBe("[REDACTED]");
    expect(nested.password).toBe("[REDACTED]");
    // 键名含 token → 整体剥除（键名剥除优先于递归）
    expect(params.tokens).toBe("[REDACTED]");
    // 中性键名的数组：元素逐个过值形态脱敏
    expect(params.list).toEqual(["tok-a", "tok-b"]);
    const note = params.note as string;
    expect(note).toContain("[REDACTED]");
    expect(note).not.toContain("nested.should.not.leak");
    // 非 凭据键/字符串 字段原样保留（回归锚：脱敏不误伤数据）
    expect(recorded.args.taskId).toBe("t-1");
  });
});

// ── 缺陷 A（P2）：超时只 reject 不取消，结论被写成「调用失败」──────────
// 修法两级：① 取消通道（execute 建 AbortController，超时 abort 并经 invoke
// 透传给接受第二参的 handler）；② 语义分级——写/危险 tier 的超时是「结果
// 未知」（副作用可能已发生），只读工具的超时才是「失败」。
describe("ToolExecutorService · 超时语义分级（写工具=结果未知 / 只读=失败）", () => {
  /** 永不 resolve 的执行体：只会被超时闸门终结。 */
  const never = () => new Promise<never>(() => undefined);

  it("写工具超时：回给模型「结果未知」（不是调用失败）+ 台账 timeout + 不计熔断失败", async () => {
    jest.useFakeTimers();
    try {
      const h = harness({ invoke: never });
      const p = h.svc.execute(
        session(),
        call("trigger_task", { taskId: "t-1" }),
        null,
      );
      const timers = jest.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
      const out = await p;
      await timers;

      // 语义：结果未知，且明确禁止盲目重试
      expect(out.content).toContain("结果未知");
      expect(out.content).not.toContain("调用失败");
      expect(out.content).toContain("list_executions");
      expect(out.content).toContain("不要直接重试");

      // 台账仍记 timeout（审计要能按「超时」筛，不与 error 混）
      expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ status: "timeout" }),
      );

      // 「未知」不计为失败：熔断记账一次都不该发生（尤其不能是 false）
      expect(h.outcomeSpy).not.toHaveBeenCalled();

      // 取消通道确实发出了：本次调用的 AbortSignal 已 abort
      // （harness 的 mock 声明只有两参，第三参用 unknown[] 读）
      const invokeArgs = h.api.invoke.mock.calls[0] as unknown as unknown[];
      const ctx = invokeArgs[2] as { signal: AbortSignal };
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(ctx.signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("只读工具超时：维持「调用失败」语义并计入熔断失败（重试无副作用）", async () => {
    jest.useFakeTimers();
    try {
      const h = harness({ invoke: never });
      const p = h.svc.execute(
        session(),
        call("get_task", { taskId: "t-1" }),
        null,
      );
      const timers = jest.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
      const out = await p;
      await timers;

      expect(out.content).toContain("调用失败");
      expect(out.content).not.toContain("结果未知");
      expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ status: "timeout" }),
      );
      expect(h.outcomeSpy).toHaveBeenCalledWith("s-1", "get_task", false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── 缺陷 B（P3）：结果未脱敏就落库 ──────────────────────────────────
// 脱敏只作用于**持久化副本**；回给模型的 content 保持原文（模型需要事实）。
// 结果侧额外启用「整体 digest 保留」——32+ hex 规则会误伤 sha256/commit id。
describe("ToolExecutorService · 结果脱敏（落库副本脱敏，模型侧保留原文）", () => {
  const sha = "a".repeat(64);

  it("结果落库前脱敏：键名/日志行剥凭据，64 位 digest 保留，content 仍是原文", async () => {
    const h = harness({
      invoke: async () => ({
        data: { token: "abc", logs: ["API_TOKEN=secret123"], sha },
        isError: false,
      }),
    });
    const out = await h.svc.execute(
      session(),
      call("get_execution_logs", { executionId: "e-1" }),
      null,
    );
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as {
      result: Record<string, unknown>;
    };
    // 键名剥除
    expect(recorded.result.token).toBe("[REDACTED]");
    // 值形态剥除（日志行里的 VAR=）
    expect((recorded.result.logs as string[])[0]).toContain("[REDACTED]");
    expect((recorded.result.logs as string[])[0]).not.toContain("secret123");
    // digest 保留（对账需要，不能被 32+ hex 规则误伤）
    expect(recorded.result.sha).toBe(sha);
    // 模型侧：事实原样（含凭据原文与 digest）
    expect(out.content).toContain("secret123");
    expect(out.content).toContain(sha);
  });

  it("truncated 分支：preview 用脱敏后的串；sha256 仍按原文算", async () => {
    const data = {
      logs: [
        "AUTOFLOW_TOKEN=live-secret-123",
        "Authorization: Bearer leak.me.now",
        "x".repeat(TOOL_RESULT_MAX_CHARS + 500),
      ],
      sha,
    };
    const h = harness({ invoke: async () => ({ data, isError: false }) });
    const out = await h.svc.execute(
      session(),
      call("get_execution_logs", { executionId: "e-1" }),
      null,
    );
    expect(out.truncated).toBe(true);

    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as {
      result: Record<string, unknown>;
    };
    const preview = recorded.result.preview as string;
    expect(preview).toHaveLength(500);
    expect(preview).not.toContain("live-secret-123");
    expect(preview).not.toContain("leak.me.now");
    // sha256 与**原文**对账：算脱敏后的串就失去意义
    expect(recorded.result.sha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(data, null, 2))
        .digest("hex"),
    );
    // 模型侧仍是原文
    expect(out.content).toContain("live-secret-123");
  });
});

// B-2：sop_get 的 slug 路径在执行体入口先解析成 id 再走闸——闸门语义单一
// （缺 id 不放行），slug 绕不过 scope 白名单。
describe("ToolExecutorService · sop_get slug 归一（B-2）", () => {
  const scopedSession = (sops: string[]) =>
    session({ kind: "sop_review", scopeJson: { sops } } as never);

  it("slug 解析出的 id 在白名单内 → 放行；闸门收到的是归一后的 id", async () => {
    const h = harness({
      sops: { getBySlug: async () => ({ id: "sop-2" }) },
    });
    const out = await h.svc.execute(
      scopedSession(["sop-2"]),
      call("sop_get", { slug: "my-sop" }),
      null,
    );
    expect(JSON.parse(out.content)).toEqual({ ok: true });
    expect(h.sops.getBySlug).toHaveBeenCalledWith("my-sop");
    // 闸门看到的 args 已含归一后的 sopId
    expect(h.checkSpy.mock.calls[0][2]).toMatchObject({ sopId: "sop-2" });
    expect(h.api.invoke).toHaveBeenCalled();
  });

  it("slug 解析出的 id 不在白名单内 → 拒绝（slug 绕过被闸死）", async () => {
    const h = harness({
      sops: { getBySlug: async () => ({ id: "sop-OTHER" }) },
    });
    const out = await h.svc.execute(
      scopedSession(["sop-2"]),
      call("sop_get", { slug: "other-sop" }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(out.content).toContain("不在本会话作用域内");
    expect(h.api.invoke).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" }),
    );
  });

  it("slug 不存在 → 按调用失败回给模型，不冒泡异常", async () => {
    const h = harness({
      sops: {
        getBySlug: async () => {
          throw new Error("SOP no-such 不存在");
        },
      },
    });
    const out = await h.svc.execute(
      session({ kind: "chat" } as never),
      call("sop_get", { slug: "no-such" }),
      null,
    );
    expect(out.content).toContain("【调用失败】SOP no-such 不存在");
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" }),
    );
    expect(h.api.invoke).not.toHaveBeenCalled();
  });

  it("sopId 路径回归：带 sopId 时不查 slug，直接过闸", async () => {
    const h = harness();
    await h.svc.execute(
      scopedSession(["sop-9"]),
      call("sop_get", { sopId: "sop-9" }),
      null,
    );
    expect(h.sops.getBySlug).not.toHaveBeenCalled();
    expect(h.api.invoke).toHaveBeenCalled();
  });
});

// B-3：sop_reply_clarification 的归属校验——回复权 = 修订权（可自主发版），
// 只有「本会话复核的澄清」或「scope.sops 白名单内 SOP 的澄清」可回复。
describe("ToolExecutorService · sop_reply_clarification 归属校验（B-3）", () => {
  const reviewSession = (sops: string[]) =>
    session({ kind: "sop_review", scopeJson: { sops } } as never);

  it("他机复核会话对他人工单澄清回复 → denied，不执行", async () => {
    const h = harness({
      sops: {
        getClarificationScopeInfo: async () => ({
          assignmentId: "a-other",
          sopId: "sop-OTHER",
          reviewSessionId: "sess-elsewhere",
        }),
      },
    });
    const out = await h.svc.execute(
      reviewSession(["sop-mine"]),
      call("sop_reply_clarification", {
        clarificationId: "clr-1",
        resolution: "sop_amended",
        answer: "我改一下别人的 SOP",
      }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(out.content).toContain("不在本会话作用域内");
    expect(h.api.invoke).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied", tier: "write" }),
    );
  });

  it("本会话复核的澄清（reviewSessionId === session.id）→ 放行", async () => {
    const h = harness({
      sops: {
        getClarificationScopeInfo: async () => ({
          assignmentId: "a1",
          sopId: "sop-1",
          reviewSessionId: "s-1",
        }),
      },
    });
    await h.svc.execute(
      reviewSession([]), // scope 里没有 SOP——靠 reviewSessionId 本人身份放行
      call("sop_reply_clarification", {
        clarificationId: "clr-1",
        resolution: "answered",
        answer: "重启浏览器",
      }),
      null,
    );
    expect(h.api.invoke).toHaveBeenCalled();
  });

  it("澄清所属 SOP 在 scope.sops 白名单内 → 放行（交付复核会话形态）", async () => {
    const h = harness({
      sops: {
        getClarificationScopeInfo: async () => ({
          assignmentId: "a1",
          sopId: "sop-1",
          reviewSessionId: "sess-elsewhere",
        }),
      },
    });
    await h.svc.execute(
      reviewSession(["sop-1"]),
      call("sop_reply_clarification", {
        clarificationId: "clr-1",
        resolution: "answered",
        answer: "按验收项核对",
      }),
      null,
    );
    expect(h.api.invoke).toHaveBeenCalled();
  });

  it("澄清不存在/不可追溯 → denied", async () => {
    const h = harness({
      sops: { getClarificationScopeInfo: async () => null },
    });
    const out = await h.svc.execute(
      reviewSession(["sop-1"]),
      call("sop_reply_clarification", {
        clarificationId: "clr-404",
        resolution: "answered",
        answer: "x",
      }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(h.api.invoke).not.toHaveBeenCalled();
  });
});

/**
 * TOOLS-02 确定性重放：台账里已有同 toolCallId 的 awaiting_approval 行。
 * GAP-5 的 (sessionId, toolCallId) 唯一索引禁止再插一行，且「一次调用一行
 * 台账」是审计语义——重放必须就地更新。
 */
describe("ToolExecutorService · 已批准调用的就地更新（TOOLS-02）", () => {
  it("replayApproved：更新原台账行而不是新增（避开唯一索引）", async () => {
    const h = harness({
      existingApproval: { approvalKey: "apr-any", status: "granted" },
    });
    const call = {
      id: "call-1",
      function: { name: "get_task", arguments: '{"taskId":"t-1"}' },
    };

    const out = await h.svc.execute(
      {
        id: "s-1",
        kind: "chat",
        scopeJson: { unrestricted: true },
      } as never,
      call,
      null,
      { replayApproved: true },
    );

    expect(out.content).toBeTruthy();
    expect(h.sessions.updateToolCallByToolCallId).toHaveBeenCalledWith(
      "s-1",
      "call-1",
      expect.objectContaining({ toolName: "get_task", status: "ok" }),
    );
    expect(h.sessions.recordToolCall).not.toHaveBeenCalled();
  });

  it("非重放路径仍走 insert（既有行为不变）", async () => {
    const h = harness();
    await h.svc.execute(
      {
        id: "s-1",
        kind: "chat",
        scopeJson: { unrestricted: true },
      } as never,
      {
        id: "call-2",
        function: { name: "get_task", arguments: '{"taskId":"t-1"}' },
      },
      null,
    );
    expect(h.sessions.updateToolCallByToolCallId).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalled();
  });
});

describe("shapeToolResultForModel（首尾保留裁剪）", () => {
  it("不超限原样返回", () => {
    const out = shapeToolResultForModel("short", 100);
    expect(out).toEqual({ content: "short", truncated: false });
  });

  it("超限时保留首尾，中段省略并报告省略字符数", () => {
    const src = "HEAD" + "x".repeat(500) + "TAIL";
    const out = shapeToolResultForModel(src, 120);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(120);
    expect(out.content.startsWith("HEAD")).toBe(true);
    expect(out.content.endsWith("TAIL")).toBe(true);
    expect(out.content).toContain("中间省略");
    expect(out.content).toContain("字符");
  });

  it("max 小于标记长度时不产出超长内容（边界安全）", () => {
    const out = shapeToolResultForModel("y".repeat(100), 10);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(10);
    expect(out.content).toBe("y".repeat(10));
  });
});

/**
 * 工具参数的保守修复：只修**无歧义**的语法噪音（围栏/散文/尾逗号），
 * 缺值/缺括号一律报错——"参数错了"要报错，"值猜错了"更难查。
 */
describe("repairToolArguments（保守修复）", () => {
  it("合法 JSON 原样解析", () => {
    expect(repairToolArguments('{"a":1}')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("空字符串 = 无参数", () => {
    expect(repairToolArguments("")).toEqual({ ok: true, value: {} });
  });

  it("Markdown 代码围栏（带 json 标注）", () => {
    const raw = '```json\n{"taskId":"t-1"}\n```';
    expect(repairToolArguments(raw)).toEqual({
      ok: true,
      value: { taskId: "t-1" },
    });
  });

  it("前后散文包裹（截取对象本体）", () => {
    const raw = '好的，参数如下：{"limit":10} 请执行';
    expect(repairToolArguments(raw)).toEqual({
      ok: true,
      value: { limit: 10 },
    });
  });

  it("尾逗号（对象与数组）", () => {
    expect(repairToolArguments('{"a":1,}')).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(repairToolArguments('{"a":[1,2,]}')).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
  });

  it("围栏 + 尾逗号叠加也能修", () => {
    expect(repairToolArguments('```json\n{"a":1,}\n```')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("缺值/缺括号**不猜**——如实报错并说明尝试过哪些修复", () => {
    const missingValue = repairToolArguments('{"a":}');
    expect(missingValue.ok).toBe(false);
    expect(missingValue.reason).toContain("保守修复");

    const missingBrace = repairToolArguments('{"a":1');
    expect(missingBrace.ok).toBe(false);
  });
});

describe("execute 接线：畸形参数经保守修复后照常执行", () => {
  it("围栏包裹的 arguments 不会让工具调用失败", async () => {
    const h = harness({
      invoke: async (_spec, args) => ({
        data: { echoed: args },
        isError: false,
      }),
    });
    const out = await h.svc.execute(
      session(),
      call("get_task", '```json\n{"taskId":"t-1"}\n```'),
      null,
    );
    expect(out.truncated).toBe(false);
    expect(JSON.parse(out.content)).toEqual({ echoed: { taskId: "t-1" } });
  });

  it("P4: 超过 32KB 的截断结果不存全文（只 preview + sha256）", async () => {
    // 单字段会被脱敏截到 4000 字符，所以用「多字段」把整份文档推过 32KB。
    const big = { items: Array.from({ length: 12 }, () => "x".repeat(4000)) };
    const h = harness({ invoke: async () => ({ data: big, isError: false }) });
    await h.svc.execute(session(), call("get_task", { taskId: "t-1" }), null);
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as Record<string, unknown>;
    const stored = recorded.result as Record<string, unknown>;
    expect(stored.truncated).toBe(true);
    expect(stored.full).toBeUndefined();
    expect(stored.preview).toBeTruthy();
  });
});

/**
 * 第 6 轮八域审计 P1：写工具「执行前在途台账 + 同 id 幂等闸」。
 *
 * 崩溃发生在「闸门放行 → 结果落库」之间时，旧实现没有任何持久痕迹，resume
 * 只能回「结果缺失」，模型会直接重提 → deploy/trigger 双份副作用。
 */
describe("ToolExecutorService · in_flight 在途台账（第 6 轮审计 P1）", () => {
  it("发现同 id 的 in_flight 行 → 不执行、回「结果未知，先核实」", async () => {
    const h = harness();
    (h.sessions.findToolCall as jest.Mock).mockResolvedValueOnce({
      status: "in_flight",
    });
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.content).toContain("结果未知");
    expect(out.content).toContain("不要直接重提");
    expect(h.api.invoke).not.toHaveBeenCalled();
  });

  it("正常路径：副作用之前先落 in_flight（顺序早于 invoke）", async () => {
    const h = harness();
    await h.svc.execute(session(), call("get_task", { taskId: "t-1" }), null);
    const inFlight = h.sessions.recordToolCall.mock.calls.find(
      (c: unknown[]) => (c[0] as { status?: string }).status === "in_flight",
    );
    expect(inFlight).toBeTruthy();
    // C2：in_flight 行必须带**状态迁移时间戳**（副作用窗口开启时刻）——
    // 没有它，崩溃恢复只能拿 createdAt 猜「窗口从何时开始未知」。
    expect(
      (inFlight?.[0] as { stateChangedAt?: unknown }).stateChangedAt,
    ).toBeInstanceOf(Date);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0];
    expect(order(h.sessions.recordToolCall)).toBeLessThan(order(h.api.invoke));
  });

  it("C2：终局（ok/error）落行同样带状态迁移时间戳（窗口关闭时刻）", async () => {
    const h = harness();
    await h.svc.execute(session(), call("get_task", { taskId: "t-1" }), null);
    const terminal = h.sessions.recordToolCall.mock.calls.find(
      (c: unknown[]) => (c[0] as { status?: string }).status === "ok",
    );
    expect(
      (terminal?.[0] as { stateChangedAt?: unknown }).stateChangedAt,
    ).toBeInstanceOf(Date);
  });
});

/**
 * N3 + S1-C2（R8 / R9 缩窄版）：**执行体**这一层的行为。
 *
 * 服务层的谓词级判据在 `__tests__/agent-approval-policy-fingerprint.spec.ts`；
 * 这里钉的是"执行体怎么用它们"：
 *   · N3：已批准的单在**策略收紧后**不得放行（fail-closed，且不产生副作用）；
 *   · S1-C2：白名单内工具同会话同参第二次**不再要人批**，且会话级授权不被吃掉；
 *   · S1-C2：白名单外（sop_publish / update_task）**有会话级授权也仍要审批**。
 */
describe("N3/S1-C2 · 执行体的策略指纹与会话级免审", () => {
  const SESSION_GRANT_KEY = "aprs-s-1-0123456789abcdef";
  /** 与 harness 的 boundary 默认策略不同的一个值（模拟"策略已收紧"）。 */
  const OTHER_FP = "9".repeat(64);

  it("N3：已批准的单在策略收紧后**不放行**（fail-closed，无副作用）", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-stop_deployment-x",
        status: "granted",
        // 批准时的策略指纹 ≠ 当前（boundary 默认策略算出来的那个）
        policyFingerprint: OTHER_FP,
      },
    });
    const out = await h.svc.execute(
      session(),
      call("stop_deployment", { deploymentId: "d-1" }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(out.content).toContain("策略指纹");
    expect(out.content).toContain("fail-closed");
    expect(h.api.invoke).not.toHaveBeenCalled();
    // 拒绝发生在**领取之前**：这张单没有被消耗掉（状态还是 granted）
    expect(h.approvals.consume).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" }),
    );
  });

  it("N3：本列上线前创建的单（没有指纹）同样 fail-closed", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-stop_deployment-y",
        status: "granted",
        policyFingerprint: null,
      },
    });
    const out = await h.svc.execute(
      session(),
      call("stop_deployment", { deploymentId: "d-1" }),
      null,
    );
    expect(out.content).toContain("没有记录策略指纹");
    expect(h.api.invoke).not.toHaveBeenCalled();
    expect(h.approvals.consume).not.toHaveBeenCalled();
  });

  it("N3：读取策略指纹的实参必须是**当前算出来的那个**（漏传/传 null 等于跳过校验）", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-stop_deployment-z",
        status: "granted",
      },
    });
    await h.svc.execute(
      session(),
      call("stop_deployment", { deploymentId: "d-1" }),
      null,
    );
    // 键是 harness 的确定性假 buildKey 算出来的（闸门收到的同一串）
    expect(h.approvals.consume).toHaveBeenCalledWith(
      h.checkSpy.mock.calls[0][4],
      h.currentPolicyFingerprint,
    );
  });

  /**
   * N3 纪律 ③：**当前策略指纹读不到 ⇒ fail-closed**（不放行、不静默放行）。
   *
   * 这是三条 fail-closed 里最容易漏的一条：指纹不一致与「指纹读不到」在
   * 机器上都表现为"两个值不等"，但后者是**求值失败**——配置读取抛错时若
   * 把它当成"不相等"就还好（都拒绝），**真正危险的写法是把它当成"相等"**
   * （例如把 null 当成"没有策略变化"），那会在配置服务抖动时静默放行一份
   * 依据不明的授权。故此处断言的是**显式拒绝 + 零副作用**。
   */
  it("N3：当前策略指纹**读不到**（配置求值抛错）⇒ fail-closed 拒绝放行", async () => {
    // 只让 `executableSourceGate` 的读取抛错：这个键**只在有
    // `executableSourceFields` 的工具上**才被闸门读，`stop_deployment` 没有
    // 那些字段 ⇒ 闸门照常跑完（不抛），而 `currentPolicyFingerprint()` 求不出
    // 指纹 ⇒ 精确命中纪律 ③ 的场景。
    const h = harness({
      policyConfigThrowsFor: "agent.policy.executableSourceGate",
    });
    const out = await h.svc.execute(
      session(),
      call("stop_deployment", { deploymentId: "d-1" }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(out.content).toContain("不可读");
    expect(out.content).toContain("fail-closed");
    // 零副作用：既没执行，也没领取任何审批单
    expect(h.api.invoke).not.toHaveBeenCalled();
    expect(h.approvals.consume).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" }),
    );
  });

  /**
   * N3 纪律 ③ 的第二半：**读不到策略时连审批单都不出具**。
   *
   * 为什么：审批单的全部价值是"人在这套策略下点了头"。若策略求值失败，
   * 我们既写不进指纹、日后也无法证明它——这张单从诞生起就注定在 consume
   * 时被拒。与其让人白点一次并留下一条永远 pending 的垃圾单，不如当场
   * fail-closed 并把理由写给模型/运维。
   */
  it("N3：策略读不到 ⇒ **不出具**无法验证的审批单（不制造注定被拒的 pending 单）", async () => {
    const h = harness({
      policyConfigThrowsFor: "agent.policy.executableSourceGate",
    });
    const out = await h.svc.execute(
      session(),
      // sop_publish 是逐工具强制审批的工具（approvalRequired=true），
      // 不依赖任何全局策略开关 ⇒ 闸门仍会判 NEED_APPROVAL。
      call("sop_publish", { sopId: "11111111-1111-4111-8111-111111111111" }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(out.content).toContain("不可读");
    expect(out.content).toContain("fail-closed");
    // 关键断言：没有落任何审批单，也没有挂起会话
    expect(h.approvals.request).not.toHaveBeenCalled();
    expect(h.sessions.markWaiting).not.toHaveBeenCalled();
    expect(h.api.invoke).not.toHaveBeenCalled();
  });

  /**
   * N3 纪律 ③ 的第三种形态：**闸门自己抛错**（配置读取在闸门内部就炸了）。
   *
   * 与上面两条的区别：上面是「只有指纹那一项求不出」，闸门仍能跑完；这里
   * 是**闸门内部读同一份策略时就炸了**——异常会从 `boundary.check()` 逃出。
   *
   * 为什么这条必须 fail-closed 而不是让异常上抛：上抛时调用方拿到的是
   * **未捕获异常**（不是一条可判定的拒绝）——AgentProcessor 的"不重抛"策略
   * 会把它吞成一条含糊的失败，运维看不出"这是配置坏了"；更糟的是若上层
   * 任何一处把它当"未知 → 放行"，那就是配置抖动时的静默放行。
   *
   * 判据：闸门抛错 ⇒ **当 DENY 处理**（落 denied 行 + 回可识别文案 + 零副作用）。
   */
  it("N3：闸门内部读策略抛错 ⇒ 当 DENY 处理（不把异常抛给上层，零副作用）", async () => {
    // 四个指纹键全抛 ⇒ `resolveApprovalPolicy()` 在闸门内部就炸了
    const h = harness({ policyConfigThrows: true });
    const out = await h.svc.execute(
      session(),
      call("stop_deployment", { deploymentId: "d-1" }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(out.content).toContain("策略不可读");
    expect(out.content).toContain("fail-closed");
    // 零副作用：没执行、没领取、没出具审批单、没挂起会话
    expect(h.api.invoke).not.toHaveBeenCalled();
    expect(h.approvals.consume).not.toHaveBeenCalled();
    expect(h.approvals.request).not.toHaveBeenCalled();
    expect(h.sessions.markWaiting).not.toHaveBeenCalled();
    // 落库为 denied（可检索的安全信号）
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" }),
    );
  });

  /**
   * N3：**申请时把指纹落库**（授权与「它被批准时的策略」绑定的那一环）。
   *
   * 钉住的是 `approvals.request` 的入参——那正是 `agent_approvals` 的行。
   * 若这里漏传（或传成别的值），单据上就没有指纹，consume 时的比对无从
   * 谈起（整条机制退化成"看起来有指纹、实际永远对不上"）。
   */
  it("N3：申请时把**当前策略指纹**落进审批单（授权与当时的策略绑定）", async () => {
    const h = harness();
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "11111111-1111-4111-8111-111111111111" }),
      null,
    );
    expect(out.content).toContain("【需人工审批，已提交审批单】");
    // 落库那一份 = approvals.request 的入参
    const payload = (h.approvals.request as jest.Mock).mock.calls[0][0] as {
      policyFingerprint: string;
      approvalKey: string;
    };
    // 指纹必须**等于当前策略的指纹**（不是随便一个值、也不是空）
    expect(payload.policyFingerprint).toBe(h.currentPolicyFingerprint);
    expect(payload.policyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("S1-C2：同会话同参第二次 ⇒ 会话级授权直接放行（不再要人批、也不吃掉授权）", async () => {
    const h = harness({
      // 第一调用已把一次性单 consume 掉
      existingApproval: {
        approvalKey: "apr-s-1-stop_deployment-w",
        status: "consumed",
      },
      sessionGrant: {
        approvalKey: SESSION_GRANT_KEY,
        status: "granted",
        scope: "session",
      },
    });
    const out = await h.svc.execute(
      session(),
      call("stop_deployment", { deploymentId: "d-1" }),
      null,
    );
    expect(out.content).not.toContain("需人工审批");
    expect(out.content).not.toContain("只放行一次");
    expect(h.api.invoke).toHaveBeenCalled();
    // 没有新申请、没有挂起会话
    expect(h.approvals.request).not.toHaveBeenCalled();
    expect(h.sessions.markWaiting).not.toHaveBeenCalled();
    // 会话级授权**不被 consume**（它是常驻授权，吃掉就退化成一次免审）
    expect(h.approvals.consume).not.toHaveBeenCalled();
    // 闸门收到的通行证是**会话级授权**的键
    expect(h.checkSpy.mock.calls[0][4]).toBe(SESSION_GRANT_KEY);
  });

  it("S1-C2：跨会话不生效——查单必须带上**本会话**的 sessionId", async () => {
    const h = harness({
      sessionGrant: {
        approvalKey: SESSION_GRANT_KEY,
        status: "granted",
        scope: "session",
      },
    });
    await h.svc.execute(
      session({ id: "s-OTHER" }),
      call("stop_deployment", { deploymentId: "d-1" }),
      null,
    );
    expect(h.approvals.findActiveSessionGrant).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-OTHER" }),
    );
  });

  it.each([
    ["sop_publish", { sopId: "sop-1" }],
    ["update_task", { taskId: "t-1", patch: { timeout: 5 } }],
  ])(
    "S1-C2：白名单外 %s —— 即便库里有一行会话级授权，仍必须人工审批",
    async (toolName, args) => {
      const h = harness({
        sessionGrant: {
          approvalKey: SESSION_GRANT_KEY,
          status: "granted",
          scope: "session",
        },
      });
      const out = await h.svc.execute(session(), call(toolName, args), null);
      // 白名单在**查单之前**就短路了：这两类工具连"会话级授权"这个概念都不适用
      expect(h.approvals.findActiveSessionGrant).not.toHaveBeenCalled();
      expect(out.content).toContain("需人工审批");
      expect(out.needsApproval).toBe(true);
      expect(h.api.invoke).not.toHaveBeenCalled();
      // 放行依据绝不能是会话级授权
      expect(h.checkSpy.mock.calls[0][4]).toBeNull();
    },
  );

  it("S1-C2：人拒绝优先于任何会话级授权（denied 永远赢）", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-stop_deployment-v",
        status: "denied",
        decidedBy: "alice",
      },
      sessionGrant: {
        approvalKey: SESSION_GRANT_KEY,
        status: "granted",
        scope: "session",
      },
    });
    const out = await h.svc.execute(
      session(),
      call("stop_deployment", { deploymentId: "d-1" }),
      null,
    );
    expect(out.content).toContain("已被人工拒绝");
    expect(h.api.invoke).not.toHaveBeenCalled();
  });
});
