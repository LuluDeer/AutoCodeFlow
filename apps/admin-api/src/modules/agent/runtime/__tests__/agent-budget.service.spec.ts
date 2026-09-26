import { ConfigService } from "@nestjs/config";

import { AgentBudgetService, DEFAULT_BUDGET } from "../agent-budget.service";

function svc(configValues: Record<string, unknown> = {}) {
  const config = { get: jest.fn((k: string) => configValues[k]) };
  return new AgentBudgetService(config as unknown as ConfigService);
}

const usage = (
  patch: Partial<Parameters<AgentBudgetService["check"]>[1]> = {},
) => ({
  steps: 0,
  tokensIn: 0,
  tokensOut: 0,
  toolCalls: 0,
  startedAt: null,
  ...patch,
});

describe("AgentBudgetService · resolveBudget（创建时快照语义）", () => {
  it("缺省回落 DEFAULT_BUDGET", () => {
    expect(svc().resolveBudget()).toEqual(DEFAULT_BUDGET);
  });

  it("配置覆盖生效（数字与数字字符串皆可）", () => {
    const out = svc({
      "agent.budget.maxSteps": 7,
      "agent.budget.maxTokens": "3000",
    }).resolveBudget();
    expect(out.maxSteps).toBe(7);
    expect(out.maxTokens).toBe(3000);
    expect(out.wallClockMs).toBe(DEFAULT_BUDGET.wallClockMs);
  });

  it("非法配置（NaN/非正数/空串）逐键回退——预算不可被配坏", () => {
    const out = svc({
      "agent.budget.maxSteps": "abc",
      "agent.budget.maxTokens": 0,
      "agent.budget.wallClockMs": "",
    }).resolveBudget();
    expect(out.maxSteps).toBe(DEFAULT_BUDGET.maxSteps);
    expect(out.maxTokens).toBe(DEFAULT_BUDGET.maxTokens);
    expect(out.wallClockMs).toBe(DEFAULT_BUDGET.wallClockMs);
  });
});

describe("AgentBudgetService · check（每轮开头判定，顺序固定）", () => {
  it("steps → tokens → wallClock → toolCalls 顺序固定，同用量同 kind", () => {
    const s = svc();
    // 四项同时超限 → 只报第一项 max_steps
    const all = s.check(null, {
      steps: 999,
      tokensIn: 999_999,
      tokensOut: 0,
      toolCalls: 999,
      startedAt: new Date(Date.now() - 999_999_999),
    });
    expect(all).toMatchObject({ ok: false, kind: "max_steps" });

    const tokens = s.check(
      null,
      usage({ tokensIn: 100_000, tokensOut: 100_000 }),
    );
    expect(tokens).toMatchObject({ ok: false, kind: "max_tokens" });

    const clock = s.check(
      null,
      usage({ startedAt: new Date(Date.now() - 60 * 60 * 1000) }),
    );
    expect(clock).toMatchObject({ ok: false, kind: "wall_clock" });

    const calls = s.check(null, usage({ toolCalls: 50 }));
    expect(calls).toMatchObject({ ok: false, kind: "max_tool_calls" });
  });

  it("startedAt 缺失不判墙钟；边界值（恰好等于上限）即超限", () => {
    const s = svc();
    expect(s.check(null, usage())).toEqual({ ok: true });
    expect(
      s.check(null, usage({ steps: DEFAULT_BUDGET.maxSteps })),
    ).toMatchObject({ ok: false, kind: "max_steps" });
    expect(
      s.check(null, usage({ steps: DEFAULT_BUDGET.maxSteps - 1 })),
    ).toEqual({ ok: true });
  });

  it("自定义预算快照生效；null 预算回落默认", () => {
    const s = svc();
    const tiny = {
      maxSteps: 2,
      maxTokens: 10,
      wallClockMs: 1000,
      maxToolCalls: 1,
    };
    expect(s.check(tiny, usage({ steps: 2 }))).toMatchObject({ ok: false });
    expect(s.check(null, usage({ toolCalls: 50 }))).toMatchObject({
      ok: false,
      kind: "max_tool_calls",
    });
  });
});
