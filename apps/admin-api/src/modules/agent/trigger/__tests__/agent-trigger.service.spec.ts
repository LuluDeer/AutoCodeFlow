import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AgentTriggerService } from "../agent-trigger.service";
import { AgentEventAggregator } from "../agent-event-aggregator.service";
import { DOMAIN_EVENTS } from "../../../../common/events/domain-events";
import {
  getRuntimeCountersSnapshot,
  resetRuntimeMetrics,
} from "../../../metrics/runtime-metrics-entry";
import * as metricsEntry from "../../../metrics/runtime-metrics-entry";

function harness(opts?: {
  enabled?: unknown;
  cronEnabled?: unknown;
  isLeader?: boolean;
  statsThrows?: boolean;
  createError?: Error;
  aggregatorConfig?: Record<string, unknown>;
  /** 熔断用例：伪造「最近若干条 ops_watch 会话」（按 createdAt DESC 传入） */
  recentWatchSessions?: Array<{ status: string; errorMessage?: string | null }>;
}) {
  const bus = {
    on: jest.fn(),
    off: jest.fn(),
  };
  const queue = { add: jest.fn(async () => undefined) };
  const sessions = {
    create: jest.fn(async (v: Record<string, unknown>) => {
      if (opts?.createError) throw opts.createError;
      return { id: "s-new", ...v };
    }),
    // 2026-10-23 熔断：scheduledWatch 现在先读最近 ops_watch 会话判定连续失败。
    // 默认给空列表（= 从未跑过，放行），个别用例覆写。
    list: jest.fn(async () => ({
      items: opts?.recentWatchSessions ?? [],
      total: 0,
    })),
  };
  const scheduler = {
    getStats: jest.fn(() => {
      if (opts?.statsThrows) throw new Error("stats unavailable");
      return { isLeader: opts?.isLeader ?? true };
    }),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === "agent.trigger.enabled") return opts?.enabled;
      if (key === "agent.trigger.cronEnabled") return opts?.cronEnabled;
      if (key.startsWith("agent.trigger."))
        return opts?.aggregatorConfig?.[key];
      return undefined;
    }),
  };
  const aggregator = new AgentEventAggregator(
    config as unknown as ConfigService,
  );
  const svc = new AgentTriggerService(
    sessions as never,
    aggregator,
    scheduler as never,
    bus as never,
    config as unknown as ConfigService,
    queue as never,
  );
  return { svc, bus, queue, sessions, scheduler, aggregator };
}

/** 注册事件处理器（走真实 onModuleInit 接线），返回 handler 映射。 */
function wired(opts?: Parameters<typeof harness>[0]) {
  const h = harness(opts);
  h.svc.onModuleInit();
  const handlers = new Map<string, (e: unknown) => Promise<void>>();
  for (const call of h.bus.on.mock.calls) {
    handlers.set(call[0] as string, call[1] as (e: unknown) => Promise<void>);
  }
  return { ...h, handlers };
}

describe("AgentTriggerService · 生命周期接线", () => {
  it("默认启用：订阅 failed/killed/offline 三类事件", () => {
    const h = wired();
    expect(h.bus.on).toHaveBeenCalledTimes(3);
    expect(h.handlers.has(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(true);
    expect(h.handlers.has(DOMAIN_EVENTS.EXECUTION_KILLED)).toBe(true);
    expect(h.handlers.has(DOMAIN_EVENTS.EXECUTOR_OFFLINE)).toBe(true);
    h.svc.onModuleDestroy();
    expect(h.bus.off).toHaveBeenCalledTimes(3);
  });

  it("开关关闭时不订阅；空串/缺省按默认开处理", () => {
    for (const disabled of [false, "false", "0"]) {
      const h = harness({ enabled: disabled });
      h.svc.onModuleInit();
      expect(h.bus.on).not.toHaveBeenCalled();
    }
    for (const enabled of [undefined, null, "", "yes"]) {
      const h = harness({ enabled });
      h.svc.onModuleInit();
      expect(h.bus.on).toHaveBeenCalledTimes(3);
    }
  });

  it("事件处理路径整体 fail-open：会话创建抛错不冒泡", async () => {
    const h = wired({
      aggregatorConfig: { "agent.trigger.threshold": 1 },
      createError: new Error("db down"),
    });
    await expect(
      h.handlers.get(DOMAIN_EVENTS.EXECUTOR_OFFLINE)!({
        executorId: "e-1",
        address: "a",
        appName: "x",
      }),
    ).resolves.toBeUndefined();
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

describe("AgentTriggerService · 事件 → 聚合 → 会话", () => {
  it("未达阈值只累积不起会话", async () => {
    const h = wired({ aggregatorConfig: { "agent.trigger.threshold": 3 } });
    const failed = h.handlers.get(DOMAIN_EVENTS.EXECUTION_FAILED)!;
    await failed({ taskId: "t-1", executionId: "e-1" });
    await failed({ taskId: "t-1", executionId: "e-2" });
    expect(h.sessions.create).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  // SCOPE-BIND（2026-10-27 审计轮 #11，A2）：本用例原先钉的是 `scope: {}`。
  // 那个断言把**功能残废**固化成了"预期行为"：incident 白名单里的
  // trigger_task / retry_execution / kill_execution / pause_task / resume_task
  // 都是 resourceKind=task|execution 的工具，会走 validateScope，而空集合
  // 一律 deny out_of_scope —— 于是白名单形同虚设，事件处置场景只剩只读工具。
  // 现在改为"绑定到该事件资源"（仍只涉及这一个资源，不放大权限）。
  it("达阈值起 incident 会话：scope 绑定事件资源 + 聚合上下文 + 队列入列 + drain", async () => {
    const h = wired({ aggregatorConfig: { "agent.trigger.threshold": 2 } });
    const failed = h.handlers.get(DOMAIN_EVENTS.EXECUTION_FAILED)!;
    await failed({ taskId: "t-1", executionId: "e-1" });
    await failed({ taskId: "t-1", executionId: "e-2" });
    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "incident",
        triggerSource: "event:execution.failed",
        // 只含事件自身的 id，且不含任何通配（unrestricted 绝不允许出现）
        scope: { executions: ["t-1"], tasks: ["t-1"] },
        context: expect.objectContaining({
          aggregated: true,
          eventCount: 2,
          resourceKey: "t-1",
        }),
      }),
    );
    expect(h.queue.add).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({ sessionId: "s-new" }),
      expect.objectContaining({ jobId: "s-new", attempts: 1 }),
    );
  });

  it("执行器离线阈值覆盖为 1：单次即起会话", async () => {
    const h = wired({ aggregatorConfig: { "agent.trigger.threshold": 3 } });
    await h.handlers.get(DOMAIN_EVENTS.EXECUTOR_OFFLINE)!({
      executorId: "e-1",
      address: "office:8002",
      appName: "x",
    });
    expect(h.sessions.create).toHaveBeenCalledTimes(1);
    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("执行器离线"),
        triggerSource: "event:executor.offline",
        // SCOPE-BIND：执行器事件只授权这一个执行器（restart/offline 类工具的维度）
        scope: { executors: ["e-1"] },
      }),
    );
  });

  // SCOPE-BIND 的**保守默认**：认不出的事件/缺 resourceKey 时绝不能放大权限。
  // 这两条是"修复"与"放开"的分界线——没有它们，上面的映射随时可能被改成通配。
  it("buildEventScope：认不出的形态一律返回空 scope（保守默认不倒退）", () => {
    const h = wired();
    expect(h.svc.buildEventScope("unknown.event", "x-1")).toEqual({});
    expect(h.svc.buildEventScope("execution.failed", null)).toEqual({});
    expect(h.svc.buildEventScope("execution.failed", "global")).toEqual({});
    expect(h.svc.buildEventScope("execution.failed", "   ")).toEqual({});
  });

  it("buildEventScope：执行器事件用 id 而不是地址（维度不能绑错）", () => {
    const h = wired();
    // 正常：从载荷取 executorId
    expect(
      h.svc.buildEventScope("executor.offline", "office:8002", {
        executorId: "exec-uuid-1",
        address: "office:8002",
      }),
    ).toEqual({ executors: ["exec-uuid-1"] });
    // 载荷缺 id ⇒ 不绑（保守：该会话对执行器仍是只读，而不是拿地址冒充 id）
    expect(
      h.svc.buildEventScope("executor.offline", "office:8002", {
        address: "office:8002",
      }),
    ).toEqual({});
  });

  it("buildEventScope：绝不产生 unrestricted 通配", () => {
    const h = wired();
    for (const ev of [
      "execution.failed",
      "execution.killed",
      "executor.offline",
      "deployment.completed",
    ]) {
      const scope = h.svc.buildEventScope(ev, "id-1");
      expect(scope.unrestricted).toBeUndefined();
      // 每个键都只含事件自身的 id
      for (const v of Object.values(scope)) expect(v).toEqual(["id-1"]);
    }
  });

  it("kill 事件与 failed 同路聚合（白名单内）", async () => {
    const h = wired({ aggregatorConfig: { "agent.trigger.threshold": 1 } });
    await h.handlers.get(DOMAIN_EVENTS.EXECUTION_KILLED)!({
      taskId: "t-9",
      executionId: "e-9",
    });
    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("执行被终止") }),
    );
  });
});

describe("AgentTriggerService · 定时巡检（leader 门禁）", () => {
  it("非 leader / cron 关闭 / 总开关关闭 都跳过", async () => {
    const notLeader = harness({ isLeader: false });
    await notLeader.svc.scheduledWatch();
    expect(notLeader.sessions.create).not.toHaveBeenCalled();

    const cronOff = harness({ cronEnabled: false });
    await cronOff.svc.scheduledWatch();
    expect(cronOff.sessions.create).not.toHaveBeenCalled();

    const disabled = harness({ enabled: false });
    await disabled.svc.scheduledWatch();
    expect(disabled.sessions.create).not.toHaveBeenCalled();
  });

  it("leader 执行：建 ops_watch 会话（纯只读空 scope）并返回会话 id", async () => {
    const h = harness({ isLeader: true });
    const id = await h.svc.createWatchSession();
    expect(id).toBe("s-new");
    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ops_watch",
        triggerSource: "cron",
        scope: {},
        title: "定时环境巡检",
      }),
    );
    expect(h.queue.add).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({ reason: "trigger:cron" }),
      expect.anything(),
    );
  });

  it("scheduledWatch fail-open：会话创建抛错不冒泡", async () => {
    const h = harness({ isLeader: true, createError: new Error("boom") });
    await expect(h.svc.scheduledWatch()).resolves.toBeUndefined();
  });

  // 2026-10-23 实测缺陷：巡检失败发生在 LLM 调用阶段（job 内部），
  // createWatchSession 永远成功，于是失败会话每小时落一行、无人叫停。
  // 实测 demo 库 22 条同样的 `LLM call failed: ... 403`。
  describe("巡检熔断（连续失败即停）", () => {
    it("连续 3 条 failed → 跳过本轮，不再创建会话", async () => {
      const h = harness({
        isLeader: true,
        recentWatchSessions: [
          { status: "failed", errorMessage: "LLM call failed: 403" },
          { status: "failed", errorMessage: "LLM call failed: 403" },
          { status: "failed", errorMessage: "LLM call failed: 403" },
        ],
      });
      await h.svc.scheduledWatch();
      expect(h.sessions.create).not.toHaveBeenCalled();
      expect(h.sessions.list).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "ops_watch" }),
      );
    });

    it("连续 2 条 failed（未达阈值）→ 照常创建", async () => {
      const h = harness({
        isLeader: true,
        recentWatchSessions: [
          { status: "failed" },
          { status: "failed" },
          { status: "succeeded" },
        ],
      });
      await h.svc.scheduledWatch();
      expect(h.sessions.create).toHaveBeenCalledTimes(1);
    });

    it("最新一条成功即解除熔断（看「连续」，不看历史计数）", async () => {
      const h = harness({
        isLeader: true,
        recentWatchSessions: [
          { status: "succeeded" },
          { status: "failed" },
          { status: "failed" },
          { status: "failed" },
        ],
      });
      await h.svc.scheduledWatch();
      expect(h.sessions.create).toHaveBeenCalledTimes(1);
    });

    it("运行中/等待输入不算失败（不误熔断）", async () => {
      const h = harness({
        isLeader: true,
        recentWatchSessions: [{ status: "running" }, { status: "failed" }],
      });
      await h.svc.scheduledWatch();
      expect(h.sessions.create).toHaveBeenCalledTimes(1);
    });

    it("熔断判定查询失败 → fail-open 照常创建（熔断器坏了不该让巡检停摆）", async () => {
      const h = harness({ isLeader: true });
      h.sessions.list.mockRejectedValueOnce(new Error("db down"));
      await h.svc.scheduledWatch();
      expect(h.sessions.create).toHaveBeenCalledTimes(1);
    });
  });

  it("leader 状态读不到时保守跳过（不冒险多副本重复触发）", async () => {
    const h = harness({ statsThrows: true });
    await h.svc.scheduledWatch();
    expect(h.sessions.create).not.toHaveBeenCalled();
    h.svc.sweepAggregator();
    expect(h.aggregator.bucketCount()).toBe(0); // sweep 未执行（无异常即未清）
  });

  it("sweepAggregator：leader 清理过期桶，非 leader 一个都不动", async () => {
    // 原用例只有 `expect(true).toBe(true)`——名字说"清理过期桶"，实体什么都没断言
    // （把 sweepAggregator 的实现删空它照样绿）。这里改成正反两态：
    //   · leader + 已过期桶 → 桶消失（清理真的发生）；
    //   · 非 leader（follower）+ 同一个过期桶 → 桶保留（多副本不重复清理/重复触发）。
    // 窗口取 1ms（readInt 只接受 >0，故不能用 0）+ 等 20ms，让"过期"是**真实**过期。
    const leader = harness({
      isLeader: true,
      aggregatorConfig: { "agent.trigger.windowMs": 1 },
    });
    leader.aggregator.observe("executor.offline", "a", {}, 1);
    expect(leader.aggregator.bucketCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    leader.svc.sweepAggregator();
    expect(leader.aggregator.bucketCount()).toBe(0);

    const follower = harness({
      isLeader: false,
      aggregatorConfig: { "agent.trigger.windowMs": 1 },
    });
    follower.aggregator.observe("executor.offline", "a", {}, 1);
    await new Promise((r) => setTimeout(r, 20));
    follower.svc.sweepAggregator();
    expect(follower.aggregator.bucketCount()).toBe(1);
  });
});

/**
 * 静默降级轮：两处 Agent 侧 fail-open 的**信号**（只加信号，不改语义）。
 *
 * 两处的共同点：fail-open 是纪律（Agent/熔断器坏了不得拖垮主链），但它让
 * 「我们不知道」与「一切正常」在指标面上同形：
 *   ① `watchBreakerVerdict` 读失败 ⇒ `blocked=false` 是**默认值**而不是判定结果
 *      ⇒ 每个 cron 周期继续派发注定失败的 ops_watch 会话（烧额度 + 刷错误会话）；
 *   ② `handleEvent` 抛错 ⇒ 过阈值的事件**没跑成会话**，而执行主链与指标面都正常
 *      ——「该跑的那轮没跑」比「多跑一次」更严重，却更安静。
 *
 * 这里钉四件事：
 *   · 故障要有计数；② 的计数还要与**现有 warn** 同源存在（不能替代它）；
 *   · ① 的 `blocked=false` 是**回归锁**：计数只是旁路，语义一个字都不许动；
 *   · 2 个 stage 是闭集且**不能混**（「会话没建」vs「建了没入列」分诊方向相反）；
 *   · 正常路径 / 未达阈值 / 总开关关闭都**不计数**（计数只计真故障，否则指标
 *     自己变成噪音源）。
 */
describe("AgentTriggerService · 静默降级可观测性（fail-open 信号）", () => {
  /** 无标签计数器 ⇒ 快照键是 `"{}"`（见 runtime-metrics-entry 的 JSON 键）。 */
  const breakerFailures = (): number | undefined =>
    getRuntimeCountersSnapshot()
      .get("autoflow_agent_watch_breaker_check_failed_total")
      ?.get("{}");

  const eventTriggerFailures = (stage: string): number | undefined =>
    getRuntimeCountersSnapshot()
      .get("autoflow_agent_event_trigger_failed_total")
      ?.get(JSON.stringify({ stage }));

  /** `watchBreakerVerdict` 是 private —— 用最小投射读它，避免为了测试放宽可见性。 */
  const verdictOf = (h: ReturnType<typeof harness>) =>
    (
      h.svc as unknown as {
        watchBreakerVerdict: () => Promise<{
          blocked: boolean;
          consecutiveFailures: number;
          lastError: string | null;
        }>;
      }
    ).watchBreakerVerdict();

  beforeEach(() => {
    resetRuntimeMetrics();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    resetRuntimeMetrics();
  });

  it("① 熔断器查询抛错 ⇒ 计数 +1，且 blocked 仍为 false（fail-open 语义的回归锁）", async () => {
    const h = harness({ isLeader: true });
    h.sessions.list.mockRejectedValueOnce(new Error("db down"));

    const verdict = await verdictOf(h);

    // ★ 回归锁：返回值必须**逐值**等于修复前的字面量（计数是旁路，不是语义）。
    expect(verdict).toEqual({
      blocked: false,
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(Object.is(verdict.blocked, false)).toBe(true);
    expect(verdict.consecutiveFailures).toBe(0);
    expect(verdict.lastError).toBeNull();

    // 信号：闸门失明这件事现在可查询
    expect(breakerFailures()).toBe(1);

    // 主链不变：放行 ⇒ 照常建巡检会话（这就是失明的代价，刻意保留）
    h.sessions.list.mockRejectedValueOnce(new Error("db down"));
    await expect(h.svc.scheduledWatch()).resolves.toBeUndefined();
    expect(h.sessions.create).toHaveBeenCalledTimes(1);
    expect(breakerFailures()).toBe(2);
  });

  it("①' 熔断器读得到时不计数（计数只计真故障，别把健康态算进来）", async () => {
    const h = harness({
      isLeader: true,
      recentWatchSessions: [{ status: "failed" }, { status: "succeeded" }],
    });
    await h.svc.scheduledWatch();
    expect(breakerFailures()).toBeUndefined();
  });

  it("② 建会话失败 ⇒ 计数 +1（stage=session_create），且现有 warn 仍在", async () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const h = wired({
      aggregatorConfig: { "agent.trigger.threshold": 1 },
      createError: new Error("db down"),
    });

    await expect(
      h.handlers.get(DOMAIN_EVENTS.EXECUTOR_OFFLINE)!({
        executorId: "e-1",
        address: "a",
        appName: "x",
      }),
    ).resolves.toBeUndefined();

    // 信号：整轮会话不存在
    expect(eventTriggerFailures("session_create")).toBe(1);
    // 反向：不能串到 enqueue（那会让分诊方向反过来）
    expect(eventTriggerFailures("enqueue")).toBeUndefined();

    // 现有 warn **保留**（计数与 warn 同源，不是替代关系）
    const warns = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("Agent event trigger failed (fail-open)"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("db down");

    // 主链不变：不冒泡、不入列
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("②' 入列失败 ⇒ stage=enqueue（行在、job 不在：分诊方向相反，不能混计）", async () => {
    const h = wired({ aggregatorConfig: { "agent.trigger.threshold": 1 } });
    h.queue.add.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      h.handlers.get(DOMAIN_EVENTS.EXECUTION_FAILED)!({
        taskId: "t-1",
        executionId: "e-1",
      }),
    ).resolves.toBeUndefined();

    expect(h.sessions.create).toHaveBeenCalledTimes(1);
    expect(eventTriggerFailures("enqueue")).toBe(1);
    expect(eventTriggerFailures("session_create")).toBeUndefined();
  });

  it("②'' 未达阈值 / 总开关关闭 ⇒ 都不计数（聚合节流与部署形态不是故障）", async () => {
    const belowThreshold = wired({
      aggregatorConfig: { "agent.trigger.threshold": 3 },
    });
    await belowThreshold.handlers.get(DOMAIN_EVENTS.EXECUTION_FAILED)!({
      taskId: "t-1",
      executionId: "e-1",
    });
    expect(eventTriggerFailures("session_create")).toBeUndefined();
    expect(eventTriggerFailures("enqueue")).toBeUndefined();

    const disabled = wired({ enabled: false });
    // 总开关关闭时总线根本不订阅，故直接投 handleEvent（private）——
    // 断言的正是「早退在 try 之前 ⇒ 不会走到计数」这条边界。
    await (
      disabled.svc as unknown as {
        handleEvent: (
          eventType: string,
          resourceKey: string | null,
          payload: unknown,
          thresholdOverride?: number,
        ) => Promise<void>;
      }
    ).handleEvent("execution.failed", "t-1", {}, 1);
    expect(disabled.sessions.create).not.toHaveBeenCalled();
    expect(eventTriggerFailures("session_create")).toBeUndefined();
  });

  it("③ 计数自身抛错 ⇒ 不冒泡，两处 fail-open 的主链行为逐字不变", async () => {
    // 故意破坏「recordRuntime 不抛错」的契约，验证旁路里的旁路真的存在
    const counter = jest
      .spyOn(metricsEntry, "recordRuntime")
      .mockImplementation(() => {
        throw new Error("counter blew up");
      });

    // ① 熔断器分支：计数炸了也必须照常放行并建会话
    const cron = harness({ isLeader: true });
    cron.sessions.list.mockRejectedValueOnce(new Error("db down"));
    await expect(cron.svc.scheduledWatch()).resolves.toBeUndefined();
    expect(cron.sessions.create).toHaveBeenCalledTimes(1);
    // 反证本用例不是空转：替身确实被调到，且调的就是这条计数
    expect(counter).toHaveBeenCalledWith(
      "autoflow_agent_watch_breaker_check_failed_total",
      {},
    );

    // ② 事件分支：计数炸了也必须 fail-open（不冒泡、不入列）
    const ev = wired({
      aggregatorConfig: { "agent.trigger.threshold": 1 },
      createError: new Error("db down"),
    });
    await expect(
      ev.handlers.get(DOMAIN_EVENTS.EXECUTOR_OFFLINE)!({
        executorId: "e-1",
        address: "a",
        appName: "x",
      }),
    ).resolves.toBeUndefined();
    expect(ev.queue.add).not.toHaveBeenCalled();
    expect(counter).toHaveBeenCalledWith(
      "autoflow_agent_event_trigger_failed_total",
      { stage: "session_create" },
    );
  });
});
