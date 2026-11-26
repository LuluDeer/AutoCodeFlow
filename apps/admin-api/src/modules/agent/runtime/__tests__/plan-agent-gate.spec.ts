/**
 * N11 · Plan 身份接 agent loop 的单测（内存替身级）。
 *
 * 验收判据：
 *  1) 写 / destructive 工具在 plan 下 deny，即使原模式是 yolo 且 allow；
 *  2) ZCode 历史 bug 场景——build 下需审批的只读工具在 plan 下仍 ask/按原模式，
 *     不得因「进入 plan」就裸跑；
 *  3) allowedPrompts 只做意图级精确命中，命中只放行本次、不落永久规则；
 *  4) exitPlanMode("all") 抛错且状态不迁移；
 *  5) 非 plan 会话 runtime 行为逐字不变（工具集同一引用、逐项相同）。
 */

import { AgentRuntimeService } from "../agent-runtime.service";
import {
  classifyAllowedPrompt,
  enterPlanMode,
  exitPlanMode,
  InvalidPlanApprovalScopeError,
  type AllowedPrompt,
  type PlanState,
} from "../plan-agent";
import {
  narrowPlanTools,
  planGateDecision,
  planSessionIdentity,
  type PlanGateEffect,
  type PlanGateSessionLike,
  type PlanGateToolLike,
} from "../plan-agent-gate";

const RULES: readonly AllowedPrompt[] = [
  { intent: "run_tests", decision: "granted" },
  { intent: "install_dependencies", decision: "denied" },
];

const TOOLS: readonly PlanGateToolLike[] = [
  { name: "list_tasks", tier: "read", description: "只读", parameters: {} },
  { name: "update_task", tier: "write", description: "写", parameters: {} },
  {
    name: "delete_application",
    tier: "dangerous",
    description: "破坏性",
    parameters: {},
  },
];

const names = (tools: readonly { name: string }[]): string[] =>
  tools.map((t) => t.name);

const planInput = (over: Record<string, unknown> = {}) => ({
  identity: "plan",
  baseMode: "build",
  baseDecision: "ask" as PlanGateEffect,
  toolTier: "read",
  toolName: "list_tasks",
  allowedPrompts: RULES,
  ...over,
});

describe("N11 · planGateDecision：闸门只收紧，放行回原模式", () => {
  it("控制组：plan 只读工具回原模式 ask（不裸跑）", () => {
    const d = planGateDecision(planInput());
    expect(d.effect).toBe("ask");
    expect(d.reason).toBe("plan_read_passthrough");
    expect(d.onceOnly).toBe(false);
  });

  it("反证 A：build 下需审批的只读工具被 plan 升级成 allow ⇒ 本用例转红", () => {
    // ZCode 历史 bug 的最小复现：提示注入先 EnterPlanMode，再调 build 下需
    // 审批的只读工具；plan 闸门不得把它变成裸跑的 allow。
    expect(
      planGateDecision(planInput({ baseMode: "build", baseDecision: "ask" }))
        .effect,
    ).toBe("ask");
    expect(planGateDecision(planInput({ baseDecision: "deny" })).effect).toBe(
      "deny",
    );
  });

  it("反证 B：plan 下 write 工具在 yolo + allow 原模式仍 deny ⇒ 本用例转红", () => {
    const d = planGateDecision(
      planInput({
        baseMode: "yolo",
        baseDecision: "allow",
        toolTier: "write",
        toolName: "update_task",
        prompt: "unrelated_intent",
      }),
    );
    expect(d.effect).toBe("deny");
    expect(d.reason).toBe("plan_write_denied");
  });

  it("反证 C：destructive MCP 即使 yolo + 意图命中也恒 deny ⇒ 本用例转红", () => {
    const d = planGateDecision(
      planInput({
        baseMode: "yolo",
        baseDecision: "allow",
        toolTier: "write",
        toolName: "external_mcp",
        isDestructive: true,
        prompt: "run_tests",
      }),
    );
    expect(d.effect).toBe("deny");
    expect(d.reason).toBe("destructive_denied_in_plan");
  });

  it("dangerous tier 与未知 tier 恒 deny", () => {
    expect(planGateDecision(planInput({ toolTier: "dangerous" })).effect).toBe(
      "deny",
    );
    expect(planGateDecision(planInput({ toolTier: "BYPASSED" })).reason).toBe(
      "unknown_tool_tier",
    );
  });

  it("非 plan 身份：闸门不下场，原模式判定逐字透传", () => {
    const d = planGateDecision(
      planInput({
        identity: "executor",
        baseMode: "yolo",
        baseDecision: "allow",
        toolTier: "write",
      }),
    );
    expect(d.effect).toBe("allow");
    expect(d.reason).toBe("non_plan_passthrough");
    expect(d.onceOnly).toBe(false);
  });

  it("allowedPrompts 意图级命中只放行回原模式，不生成永久规则", () => {
    const before = JSON.stringify(RULES);
    const d = planGateDecision(
      planInput({
        toolTier: "write",
        toolName: "run_tests_tool",
        prompt: "run_tests",
      }),
    );
    expect(d.effect).toBe("ask"); // 原模式仍是 ask，plan 不能替它放行
    expect(d.onceOnly).toBe(true);
    expect(d.reason).toBe("allowed_prompt_once");
    expect(Object.keys(d).sort()).toEqual(["effect", "onceOnly", "reason"]);
    expect(JSON.stringify(RULES)).toBe(before); // 纯函数：输入规则不被改写
    // 不缓存：下一次调用仍以传入规则为准。
    expect(
      planGateDecision(
        planInput({
          toolTier: "write",
          prompt: "run_tests",
          allowedPrompts: [],
        }),
      ).effect,
    ).toBe("deny");
  });

  it("allowedPrompts 变形意图 / denied 规则不得蹭到放行", () => {
    const base = {
      toolTier: "write",
      toolName: "run_tests_tool",
      baseMode: "yolo",
      baseDecision: "allow",
    };
    expect(
      planGateDecision(planInput({ ...base, prompt: "run_tests_extra" }))
        .effect,
    ).toBe("deny");
    expect(
      planGateDecision(planInput({ ...base, prompt: "RUN_TESTS" })).effect,
    ).toBe("deny");
    expect(
      planGateDecision(planInput({ ...base, prompt: "install_dependencies" }))
        .effect,
    ).toBe("deny");
    expect(classifyAllowedPrompt("run tests", RULES)).toBe("ask");
  });
});

describe("N11 · narrowPlanTools：availableTools 之后的暴露面收窄", () => {
  it("plan 会话：write / dangerous 不暴露，read 保留", () => {
    const session: PlanGateSessionLike = { kind: "plan" };
    const narrowed = narrowPlanTools(session, TOOLS, {
      baseDecisions: {
        list_tasks: "allow",
        update_task: "allow",
        delete_application: "allow",
      },
    });
    expect(names(narrowed)).toEqual(["list_tasks"]);
    expect(names(TOOLS)).toEqual([
      "list_tasks",
      "update_task",
      "delete_application",
    ]); // 入参不被改动
  });

  it("destructive 工具名显式标记：即使 tier=read 也移除", () => {
    const session: PlanGateSessionLike = {
      kind: "plan",
      contextJson: { planDestructiveTools: ["read_but_destructive"] },
    };
    const tools = [
      { name: "read_but_destructive", tier: "read" },
      { name: "plain_read", tier: "read" },
    ];
    expect(names(narrowPlanTools(session, tools))).toEqual(["plain_read"]);
  });

  it("意图命中只放行本次到原模式；destructive 仍移除", () => {
    const session: PlanGateSessionLike = {
      kind: "plan",
      contextJson: { allowedPrompts: RULES },
    };
    const tools = [
      { name: "test_runner", tier: "write" },
      { name: "rm_all", tier: "write" },
    ];
    const narrowed = narrowPlanTools(session, tools, {
      baseMode: "yolo",
      baseDecisions: { test_runner: "allow", rm_all: "allow" },
      intentsByTool: { test_runner: "run_tests", rm_all: "run_tests" },
      destructiveToolNames: ["rm_all"],
    });
    expect(names(narrowed)).toEqual(["test_runner"]);
    // 同一会话下一次调用仍按传入规则判定，没有「始终允许」缓存。
    expect(
      names(
        narrowPlanTools(session, tools, {
          baseMode: "yolo",
          baseDecisions: { test_runner: "allow", rm_all: "allow" },
          intentsByTool: { test_runner: "run_tests", rm_all: "run_tests" },
          destructiveToolNames: ["rm_all"],
        }),
      ),
    ).toEqual(["test_runner"]);
  });

  it("contextJson.planIdentity 等价标记也进入 plan 身份", () => {
    const session: PlanGateSessionLike = {
      kind: "chat",
      contextJson: { planIdentity: "plan" },
    };
    expect(planSessionIdentity(session)).toBe("plan");
    expect(names(narrowPlanTools(session, TOOLS))).toEqual(["list_tasks"]);
  });

  it("非 plan 会话：返回同一数组引用，逐项不变", () => {
    for (const session of [
      null,
      undefined,
      { kind: "chat" },
      { kind: "incident" },
    ]) {
      const narrowed = narrowPlanTools(session, TOOLS as never);
      expect(narrowed).toBe(TOOLS);
      expect(names(narrowed)).toEqual(names(TOOLS));
    }
  });
});

describe("N11 · exitPlanMode：拒绝所有非 once 授权", () => {
  const state = (): PlanState =>
    enterPlanMode({
      identity: "executor",
      baseToolTiers: ["read", "write"],
      toolTiers: ["read", "write"],
      fileSystem: "host",
      writePermission: "caller-decided",
      approvalScope: null,
      allowedPrompts: RULES,
    });

  it("all 抛错且状态不迁移", () => {
    const before = state();
    const snapshot = JSON.stringify(before);
    expect(() => exitPlanMode(before, "all")).toThrow(
      InvalidPlanApprovalScopeError,
    );
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("once 迁移为 executor 且 scope=once", () => {
    const exited = exitPlanMode(state(), "once");
    expect(exited.identity).toBe("executor");
    expect(exited.approvalScope).toBe("once");
    expect(JSON.stringify(exited)).not.toContain('"all"');
  });
});

// ── runtime 接线：内存替身 ────────────────────────────────────────────────
type Any = Record<string, any>;

function runtimeHarness(session: Any) {
  const state = {
    id: "sess-plan",
    status: "pending",
    totalSteps: 0,
    budgetJson: null,
    contextJson: null,
    waitingFor: null,
    startedAt: new Date(),
    contextFoldStreak: 0,
    ...session,
  };

  const baseSessionService = {
    requireById: jest.fn(async () => state),
    markRunning: jest.fn(async () => true),
    listSteps: jest.fn(async () => []),
    getUsage: jest.fn(async () => ({
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      wallClockMs: 0,
    })),
    appendStep: jest.fn(async () => ({ id: "step-1" })),
    finish: jest.fn(async () => undefined),
    recordToolCall: jest.fn(async () => undefined),
    listToolCalls: jest.fn(async () => []),
    tryAppendEvent: jest.fn(async () => 1),
    claimAutoResume: jest.fn(async () => true),
    markWaiting: jest.fn(async () => undefined),
    recordContextFold: jest.fn(async () => undefined),
  };
  // run() 未来新增的旁路读写一律吞掉（这里只断言喂给 LLM 的工具集）。
  const sessionService = new Proxy(baseSessionService, {
    get(target, prop) {
      return prop in target
        ? (target as Any)[prop as string]
        : jest.fn(async () => undefined);
    },
  });
  const budgetService = {
    check: jest.fn(() => ({ ok: true })),
    resolveContextWindow: jest.fn(() => ({
      maxTokens: 24_000,
      minRecentMessages: 12,
      preemptUnrecoverable: false,
    })),
  };
  const llm = jest.fn(async () => ({
    content: "结论",
    usage: { tokensIn: 1, tokensOut: 1 },
    model: "fixture",
  }));
  const aiService = {
    chatMultimodal: llm,
    getActiveRoute: jest.fn(async () => ({
      provider: "fixture",
      model: "fixture",
    })),
  };

  const service = new AgentRuntimeService(
    sessionService as never,
    budgetService as never,
    aiService as never,
  );
  service.setApprovals({
    listForSession: jest.fn(async () => []),
  } as never);
  const availableTools = jest.fn(async () => TOOLS.map((t) => ({ ...t })));
  service.setToolExecutor({
    availableTools,
    execute: jest.fn(async () => ({ content: "", truncated: false })),
  } as never);

  return { service, llm, availableTools };
}

const llmTools = (llm: jest.Mock): Any[] | undefined =>
  (llm.mock.calls[0]?.[0] as Any)?.tools as Any[] | undefined;

describe("N11 · agent loop 接线（内存替身）", () => {
  it("plan 会话：availableTools 之后移除写 / destructive，只把 read 交给模型", async () => {
    const h = runtimeHarness({ kind: "plan" });
    const outcome = await h.service.run("sess-plan");

    expect(outcome.status).toBe("succeeded");
    expect(h.availableTools).toHaveBeenCalledTimes(1);
    expect((llmTools(h.llm) ?? []).map((t) => t.function.name)).toEqual([
      "list_tasks",
    ]);
  });

  it("非 plan 会话：工具集逐项不变，可用工具只查一次", async () => {
    const h = runtimeHarness({ kind: "chat" });
    const outcome = await h.service.run("sess-plan");

    expect(outcome.status).toBe("succeeded");
    expect(h.availableTools).toHaveBeenCalledTimes(1);
    expect((llmTools(h.llm) ?? []).map((t) => t.function.name)).toEqual(
      names(TOOLS),
    );
  });
});
