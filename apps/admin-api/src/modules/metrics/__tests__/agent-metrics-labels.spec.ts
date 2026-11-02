import {
  AGENT_EVENT_KINDS,
  AGENT_KINDS,
  AGENT_TERMINAL_STATUSES,
  RUNTIME_AGENT_EVENT_TRIGGER_STAGES,
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

/**
 * 审批重放文案轮：`autoflow_agent_approval_status_read_failed_total` 的**标签收敛**。
 *
 * 这条指标刻意**没有任何标签维度**——唯一的写点是 `loadApprovalStatuses` 的那一个
 * catch，可拆的维度只有无界的错误文本（超时 / 池耗尽 / 连接被关）。放进 label 就是
 * OBS3-02 已经修过一次的基数事故（当时 `tool` 直接取模型给的名字）；给一个单值标签
 * （如 `scope=replay`）更坏：那是在假装还有别的取值，看板会以为「还有分支没画」。
 * 所以这里的断言是「确实没有维度」，且基线只有一条空组合——渲染侧据此有一条 0 值
 * series，`increase(...[10m]) > 0` 的告警在**首次失败之前**就是可计算的（不是「无数据」）。
 */
describe("autoflow_agent_approval_status_read_failed_total · 标签收敛（零维度）", () => {
  it("labelNames 为空、labelValueSets 恰好一条空组合（不制造假维度）", () => {
    const spec =
      RUNTIME_COUNTERS.autoflow_agent_approval_status_read_failed_total;
    expect(spec.labelNames).toEqual([]);
    expect(spec.labelValueSets).toEqual([{}]);
  });

  it("help 写清「服务未装配不计数」，避免值班把它读成部署故障", () => {
    const help =
      RUNTIME_COUNTERS.autoflow_agent_approval_status_read_failed_total.help;
    expect(help).toContain("not wired up");
    expect(help).toContain("NOT counted");
  });
});

/**
 * 静默降级轮 ①：`autoflow_agent_watch_breaker_check_failed_total` 的**标签收敛**。
 *
 * 与审批那条同一姿态：零维度。唯一写点（`watchBreakerVerdict` 的 catch）能拆的
 * 只有无界的错误文本；单值标签（如 `stage=breaker`）是在假装有维度。
 * 这里额外钉住 help 里的**告警判据**——这条指标的整个价值在于「恒 0 = 闸门看得见」，
 * 若 help 退化成不含可执行判据的一句话，值班就没有可照抄的表达式。
 */
describe("autoflow_agent_watch_breaker_check_failed_total · 标签收敛（零维度）", () => {
  it("labelNames 为空、labelValueSets 恰好一条空组合（不制造假维度）", () => {
    const spec =
      RUNTIME_COUNTERS.autoflow_agent_watch_breaker_check_failed_total;
    expect(spec.labelNames).toEqual([]);
    expect(spec.labelValueSets).toEqual([{}]);
  });

  it("help 同时写清「失明的后果」与值班动作（否则告警无法分诊）", () => {
    const help =
      RUNTIME_COUNTERS.autoflow_agent_watch_breaker_check_failed_total.help;
    // 后果：blocked=false 在这一分支是「不知道」，不是「provider 健康」
    expect(help).toContain("went blind");
    expect(help).toContain("burning LLM quota");
    // 动作：手动关 cronEnabled（自动熔断已经不存在了）
    expect(help).toContain("agent.trigger.cronEnabled");
  });
});

/**
 * 静默降级轮 ②：`autoflow_agent_event_trigger_failed_total` 的 `stage` **闭集**。
 *
 * 与 `AGENT_EVENT_KINDS` 相反，这一组闭集由 metrics 侧**拥有**（写点用
 * `import type RuntimeAgentEventTriggerStage` 钉住），所以不存在「复制→漂移」，
 * 这里的断言是接口契约本身：恰好 2 个值、无重复、基线覆盖全部、且两个值都是
 * **代码字面量**（不是错误文本/事件类型这类会随输入增长的维度）。
 *
 * 为什么两个值必须分开（否则这条指标会误导分诊）：
 *   · `session_create` = 会话行没建出来 ⇒ 该轮不存在（查写入面 DB/约束）；
 *   · `enqueue`        = 行在、job 不在 ⇒ 它永远不会跑（查队列面 Redis/BullMQ）。
 */
describe("autoflow_agent_event_trigger_failed_total · stage 标签闭集", () => {
  it("labelValueSets 恰好是闭集本身（无遗漏、无幽灵值、无重复）", () => {
    const sets =
      RUNTIME_COUNTERS.autoflow_agent_event_trigger_failed_total.labelValueSets;
    const registered = sets.map((s) => s.stage).sort();
    expect(registered).toEqual([...RUNTIME_AGENT_EVENT_TRIGGER_STAGES].sort());
    expect(new Set(registered).size).toBe(registered.length);
    expect(
      RUNTIME_COUNTERS.autoflow_agent_event_trigger_failed_total.labelNames,
    ).toEqual(["stage"]);
  });

  it("闭集恰为 2 个代码字面量：会话没建 / 建了没入列（不分错误文本）", () => {
    expect([...RUNTIME_AGENT_EVENT_TRIGGER_STAGES]).toEqual([
      "session_create",
      "enqueue",
    ]);
  });

  it("help 写清「过阈值才算」与「关闭/未达阈值不计数」，避免把聚合节流读成故障", () => {
    const help =
      RUNTIME_COUNTERS.autoflow_agent_event_trigger_failed_total.help;
    expect(help).toContain("crossed the threshold");
    expect(help).toContain("NOT counted");
  });

  // 决策 B 的前置数据（2026-11-02）：`autoflow_agent_llm_retry_sleep_ms_total`。
  // 它最容易出的错**不是**名字写错，而是「把毫秒当次数记」——
  // 那样 `rate(...)/1000` 算出来的「占槽槽位数」会小三个数量级，
  // 进而把「占槽损失可忽略」这个结论**算错**（而结论本身会拿去决定要不要改协议）。
  it("重试睡眠计数器：零标签 + help 声明**毫秒累加**（不是次数）", () => {
    const spec = RUNTIME_COUNTERS.autoflow_agent_llm_retry_sleep_ms_total;
    expect(spec.labelNames).toEqual([]);
    expect(spec.labelValueSets).toEqual([{}]);
    // help 必须能让人一眼看出单位与读法 —— 否则「次数 vs 毫秒」会被混读
    expect(spec.help).toContain("milliseconds");
    expect(spec.help).toContain("sleeping");
    // 与 `_total` 后缀的计数语义区分：本条是**累加量**，不是事件条数
    expect(spec.help.toLowerCase()).toContain("rate/1000");
  });
});
