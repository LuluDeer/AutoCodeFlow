import {
  AGENT_KINDS,
  AGENT_TERMINAL_STATUSES,
  RUNTIME_COUNTERS,
} from "../runtime-metrics";
import { ALL_AGENT_TOOL_SPECS } from "../../agent/tools/tool-registry";
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

/**
 * OBS3-08（第 3 轮观测审计）：llm_retry 的 result 取值必须覆盖写入侧真实产出。
 *
 * 写入侧新增了恢复面三类（approved_replay / resume_queued /
 * resume_enqueue_failed），此前未登记——既无 0 值基线，help 也与实际语义不符。
 */
describe("autoflow_agent_llm_retry_total · result 取值与写入侧对齐", () => {
  it("登记集合 = 重试面 5 值 + 恢复面 3 值", () => {
    const results = (
      RUNTIME_COUNTERS.autoflow_agent_llm_retry_total.labelValueSets ?? []
    )
      .map((s) => s.result)
      .sort();
    expect(results).toEqual(
      [
        "approved_replay",
        "deadline",
        "exhausted",
        "fatal",
        "recovered",
        "resume_enqueue_failed",
        "resume_queued",
        "scheduled",
      ].sort(),
    );
  });

  it("help 文案提到恢复面三类（避免「只讲重试、实际还记恢复」的误导）", () => {
    const help = RUNTIME_COUNTERS.autoflow_agent_llm_retry_total.help;
    for (const r of [
      "approved_replay",
      "resume_queued",
      "resume_enqueue_failed",
    ]) {
      expect(help).toContain(r);
    }
  });
});

/**
 * OBS3-02：tool_calls 的 0 值基线不得包含注册表里不存在的工具名。
 */
describe("autoflow_agent_tool_calls_total · 基线工具名必须真实存在", () => {
  it("labelValueSets 的每个 tool 都在工具注册表里", () => {
    const toolNames = new Set(ALL_AGENT_TOOL_SPECS.map((s) => s.name));
    const sets =
      RUNTIME_COUNTERS.autoflow_agent_tool_calls_total.labelValueSets ?? [];
    expect(sets.length).toBeGreaterThan(0);
    for (const labels of sets) {
      expect(toolNames.has(labels.tool)).toBe(true);
    }
  });
});
