import {
  AGENT_EVENT_KINDS,
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
// S7-G1 补丁：事件类型闭集（两处同名常量必须逐字一致，见下）
import { AGENT_EVENT_KINDS as AGENT_ENTITY_EVENT_KINDS } from "../../agent/entities/agent-event.entity";

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

/**
 * S7-G1 补丁（`autoflow_agent_event_append_failed_total`）：`kind` 是**闭集**
 * 才允许进标签——这份守卫就是「闭集」这个词的举证责任。
 *
 * 指标侧为了不造出 metrics → agent 的编译期依赖，把手写的 kind 列表复制了一份
 * （同 `AGENT_KINDS` 的既有处理）。复制就会漂移，而漂移的后果是：实体新增一种
 * 事件后，那条 kind 的失败**没有 0 值基线**（首次失败前是「无数据」而不是 0，
 * 告警在第一次丢事件前是黑的），以及闭集假设本身失效（标签面从此有界性靠运气）。
 * 两个方向都断言：集合相等 + 基线恰好覆盖集合（不多不少）。
 */
describe("autoflow_agent_event_append_failed_total · kind 标签与事件闭集对齐", () => {
  it("AGENT_EVENT_KINDS 与 agent-event.entity.ts 的集合一致（新增事件类型必须同时登记）", () => {
    expect([...AGENT_EVENT_KINDS].sort()).toEqual(
      [...AGENT_ENTITY_EVENT_KINDS].sort(),
    );
  });

  it("labelValueSets 恰好是闭集本身（无遗漏、无幽灵值、无重复）", () => {
    const sets =
      RUNTIME_COUNTERS.autoflow_agent_event_append_failed_total.labelValueSets;
    const registered = sets.map((s) => s.kind).sort();
    expect(registered).toEqual([...AGENT_EVENT_KINDS].sort());
    // 重复登记会让渲染侧对同一 series inc 两次（0 值基线变成 2×0 仍为 0，
    // 但一旦有真实计数就会被重复相加），因此按集合唯一性单独钉一次。
    expect(new Set(registered).size).toBe(registered.length);
    expect(
      RUNTIME_COUNTERS.autoflow_agent_event_append_failed_total.labelNames,
    ).toEqual(["kind"]);
  });
});
