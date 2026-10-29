import {
  AGENT_KINDS,
  AGENT_TERMINAL_STATUSES,
  RUNTIME_COUNTERS,
} from "../runtime-metrics";
import {
  AGENT_SESSION_KINDS,
  AGENT_SESSION_STATUSES,
  AGENT_TERMINAL_STATUSES as AGENT_ENTITY_TERMINAL_STATUSES,
} from "../../agent/entities/agent-session.entity";

/**
 * `runtime-metrics.ts` 的注释承诺「本文件由 agent-metrics-labels.spec.ts
 * 断言两侧一致」——但该 spec 从未存在（观测审计 P3）：metrics 模块为了
 * 避免依赖环，把 Agent 的 kind/status 标签取值**本地重复**了一份，却没有人
 * 守这个不变量。一旦实体新增 kind（例如未来的 code_review），指标会缺
 * 基线 series：该 kind 的首个事件之前看板是空图，而不是 0——比缓慢漂移更
 * 难察觉。这个 spec 就是那条注释的兑现。
 */
describe("Agent 指标标签取值 ↔ 实体常量（漂移守卫）", () => {
  it("AGENT_KINDS 与 AGENT_SESSION_KINDS 集合一致", () => {
    expect([...AGENT_KINDS].sort()).toEqual([...AGENT_SESSION_KINDS].sort());
  });

  it("终态集合一致（指标基线与状态机同源）", () => {
    expect([...AGENT_TERMINAL_STATUSES].sort()).toEqual(
      [...AGENT_ENTITY_TERMINAL_STATUSES].sort(),
    );
  });

  it("会话指标只使用实体里存在的状态值（没有幽灵标签）", () => {
    const valid = new Set<string>(AGENT_SESSION_STATUSES);
    const sets = RUNTIME_COUNTERS.autoflow_agent_sessions_total.labelValueSets;
    for (const labels of sets) {
      expect(valid.has(labels.status)).toBe(true);
      expect((AGENT_KINDS as readonly string[]).includes(labels.kind)).toBe(
        true,
      );
    }
  });
});
