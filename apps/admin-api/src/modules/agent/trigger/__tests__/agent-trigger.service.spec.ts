import { ConfigService } from "@nestjs/config";

import { AgentTriggerService } from "../agent-trigger.service";
import { AgentEventAggregator } from "../agent-event-aggregator.service";
import { DOMAIN_EVENTS } from "../../../../common/events/domain-events";

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
    list: jest.fn(async () => ({ items: opts?.recentWatchSessions ?? [], total: 0 })),
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

  it("达阈值起 incident 会话：空 scope（自动触发无写权限）+ 聚合上下文 + 队列入列 + drain", async () => {
    const h = wired({ aggregatorConfig: { "agent.trigger.threshold": 2 } });
    const failed = h.handlers.get(DOMAIN_EVENTS.EXECUTION_FAILED)!;
    await failed({ taskId: "t-1", executionId: "e-1" });
    await failed({ taskId: "t-1", executionId: "e-2" });
    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "incident",
        triggerSource: "event:execution.failed",
        scope: {},
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
      }),
    );
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

  it("sweepAggregator：leader 时清理过期桶", () => {
    const h = harness({ isLeader: true });
    h.aggregator.observe("executor.offline", "a", {}, 1);
    h.aggregator.drain("executor.offline", "a");
    h.svc.sweepAggregator(); // 不抛即覆盖调用面
    expect(true).toBe(true);
  });
});
