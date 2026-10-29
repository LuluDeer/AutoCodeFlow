import {
  getRuntimeCountersSnapshot,
  recordRuntime,
  resetRuntimeMetrics,
} from "../runtime-metrics-entry";

/**
 * 观测审计 P1：`recordRuntime` 曾经只有事件语义（每次 +1），而
 * `autoflow_agent_tokens_total` 的 help/告警都宣称是「令牌消耗、成本归因
 * 唯一数据源」——按它算成本会低 2~3 个数量级。这里把「增量 = 令牌数」
 * 钉成契约。
 */
describe("recordRuntime —— 计数增量语义", () => {
  beforeEach(() => resetRuntimeMetrics());

  const valueOf = (
    name: "autoflow_agent_tokens_total" | "autoflow_agent_sessions_total",
    labels: Record<string, string>,
  ): number | undefined =>
    getRuntimeCountersSnapshot().get(name)?.get(JSON.stringify(labels));

  it("默认增量 1（事件计数）", () => {
    recordRuntime("autoflow_agent_sessions_total", {
      kind: "incident",
      status: "failed",
    });
    recordRuntime("autoflow_agent_sessions_total", {
      kind: "incident",
      status: "failed",
    });
    expect(
      valueOf("autoflow_agent_sessions_total", {
        kind: "incident",
        status: "failed",
      }),
    ).toBe(2);
  });

  it("显式 value 按数量累加（令牌量而不是步数）", () => {
    const labels = { provider: "qwen", model: "qwen-max", direction: "in" };
    recordRuntime("autoflow_agent_tokens_total", labels, 120);
    recordRuntime("autoflow_agent_tokens_total", labels, 30);
    expect(valueOf("autoflow_agent_tokens_total", labels)).toBe(150);
  });

  it("非法增量回落 1（不让脏值写坏计数器）", () => {
    const labels = { provider: "p", model: "m", direction: "out" };
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      recordRuntime("autoflow_agent_tokens_total", labels, bad);
    }
    expect(valueOf("autoflow_agent_tokens_total", labels)).toBe(4);
  });

  it("未知计数器名静默忽略（不抛错、不入表）", () => {
    expect(() =>
      recordRuntime("not_a_counter" as never, { a: "b" }, 10),
    ).not.toThrow();
    expect(getRuntimeCountersSnapshot().has("not_a_counter" as never)).toBe(
      false,
    );
  });
});
