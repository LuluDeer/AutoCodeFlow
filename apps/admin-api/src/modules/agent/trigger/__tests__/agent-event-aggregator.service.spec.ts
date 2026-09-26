import { ConfigService } from "@nestjs/config";

import {
  AgentEventAggregator,
  TRIGGERABLE_EVENTS,
} from "../agent-event-aggregator.service";

function svc(configValues: Record<string, unknown> = {}) {
  const config = { get: jest.fn((k: string) => configValues[k]) };
  return new AgentEventAggregator(config as unknown as ConfigService);
}

describe("AgentEventAggregator · 配置解析", () => {
  it("窗口/阈值缺省值；配置覆盖；非法值回退", () => {
    expect(svc().resolveWindowMs()).toBe(5 * 60 * 1000);
    expect(svc().resolveThreshold()).toBe(3);
    expect(
      svc({
        "agent.trigger.windowMs": 1000,
        "agent.trigger.threshold": 2,
      }).resolveWindowMs(),
    ).toBe(1000);
    const bad = svc({
      "agent.trigger.windowMs": "abc",
      "agent.trigger.threshold": 0,
    });
    expect(bad.resolveWindowMs()).toBe(5 * 60 * 1000);
    expect(bad.resolveThreshold()).toBe(3);
  });
});

describe("AgentEventAggregator · observe（聚合而非逐条触发）", () => {
  it("白名单外事件直接忽略", () => {
    const s = svc();
    expect(s.observe("deployment.failed", "x", {}, 1)).toMatchObject({
      action: "ignored",
    });
    expect(s.bucketCount()).toBe(0);
  });

  it("未达阈值累积并回报 needed；达标放行 fire（带聚合载荷与样例）", () => {
    const s = svc({ "agent.trigger.threshold": 3 });
    const key = "exec-03";
    expect(s.observe("execution.failed", key, { n: 1 })).toMatchObject({
      action: "accumulate",
      count: 1,
      needed: 3,
    });
    expect(s.observe("execution.failed", key, { n: 2 })).toMatchObject({
      action: "accumulate",
      count: 2,
    });
    const fire = s.observe("execution.failed", key, { n: 3 });
    expect(fire.action).toBe("fire");
    if (fire.action === "fire") {
      expect(fire.trigger).toMatchObject({
        eventType: "execution.failed",
        resourceKey: key,
        count: 3,
      });
      expect(fire.trigger.samples).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    }
  });

  it("resourceKey 缺省聚合到 global；不同资源不互相计数", () => {
    const s = svc({ "agent.trigger.threshold": 1 });
    expect(s.observe("executor.offline", null, {}).action).toBe("fire");
    const s2 = svc({ "agent.trigger.threshold": 2 });
    expect(s2.observe("executor.offline", "a", {}).action).toBe("accumulate");
    expect(s2.observe("executor.offline", "b", {}).action).toBe("accumulate");
    expect(s2.bucketCount()).toBe(2);
  });

  it("同窗口只触发一次：fire 后继续 accumulate（needed=0）", () => {
    const s = svc({ "agent.trigger.threshold": 1 });
    expect(s.observe("executor.offline", "a", {}).action).toBe("fire");
    const again = s.observe("executor.offline", "a", {});
    expect(again).toMatchObject({ action: "accumulate", count: 2, needed: 0 });
  });

  it("thresholdOverride > 0 时覆盖配置阈值（离线事件单次即重要）", () => {
    const s = svc({ "agent.trigger.threshold": 3 });
    expect(s.observe("executor.offline", "a", {}, 1).action).toBe("fire");
    // override 非正数回退配置阈值
    expect(s.observe("execution.failed", "b", {}, 0)).toMatchObject({
      action: "accumulate",
      needed: 3,
    });
  });

  it("样例只留前 5 条", () => {
    const s = svc({ "agent.trigger.threshold": 99 });
    for (let i = 0; i < 8; i++) s.observe("execution.failed", "k", { i });
    const b = s.drain("execution.failed", "k");
    expect(b?.samples).toHaveLength(5);
  });

  it("窗口过期后重置：新窗口从累积起点重新开始且可再触发", () => {
    const s = svc({
      "agent.trigger.windowMs": 1000,
      "agent.trigger.threshold": 1,
    });
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(10_000);
      expect(s.observe("executor.offline", "a", {}).action).toBe("fire");
      nowSpy.mockReturnValue(50_000); // 远超窗口
      const verdict = s.observe("executor.offline", "a", {});
      expect(verdict.action).toBe("fire"); // 新窗口可再触发
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("AgentEventAggregator · drain / sweep / reset", () => {
  it("drain 取走并删除桶；不存在返回 null", () => {
    const s = svc({ "agent.trigger.threshold": 1 });
    s.observe("executor.offline", "a", {});
    expect(s.drain("executor.offline", "a")).toMatchObject({ count: 1 });
    expect(s.drain("executor.offline", "a")).toBeNull();
    expect(s.bucketCount()).toBe(0);
  });

  it("sweep 只清过期桶并回报数量", () => {
    const s = svc({
      "agent.trigger.windowMs": 1000,
      "agent.trigger.threshold": 99,
    });
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(10_000);
      s.observe("execution.failed", "old", {});
      nowSpy.mockReturnValue(11_500);
      s.observe("execution.failed", "fresh", {});
      expect(s.sweep()).toBe(1);
      expect(s.bucketCount()).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("白名单常量与设计一致（四类事件）", () => {
    expect(TRIGGERABLE_EVENTS).toEqual([
      "execution.failed",
      "execution.killed",
      "executor.offline",
      "deployment.completed",
    ]);
  });
});
