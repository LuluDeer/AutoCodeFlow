/**
 * N24 —— 进程内能力网关 service 的单测（内存替身 CapabilityService / AuditService）。
 *
 * 断言实际副作用：下游 invoke 调用次数、预算 usage 行数、审计 action/detail 精确值、
 * 缓存是否真被调用；接口返回体 200/ok 本身不是结论。
 * 验收级别：单测 / 内存替身（真 PG / 真 Nest DI 由主控收口）。
 */
jest.mock("@nestjs/common", () => ({
  Injectable: () => () => undefined,
  Optional: () => () => undefined,
  Inject: () => () => undefined,
}));

jest.mock("../../audit/audit.service", () => ({
  AuditService: class AuditService {},
}));

jest.mock("../capability.service", () => ({
  CapabilityService: class CapabilityService {},
}));

import type { AuditService } from "../../audit/audit.service";
import {
  CAPABILITY_DEGRADED_ACTION,
  InProcessCapabilityService,
  type InProcessGateOptions,
  type InProcessInvokeRequest,
} from "../inprocess-gate.service";
import type { CapabilityService } from "../capability.service";

function resolution(
  overrides: Record<string, unknown> = {},
): InProcessInvokeRequest["resolution"] {
  return {
    key: "browser",
    effective: {
      key: "browser",
      kind: "agent",
      version: "v1",
      scope: { mode: "self_service", guidance: "L3" },
      ...overrides,
    },
    decision: "allow",
  } as InProcessInvokeRequest["resolution"];
}

const allowed = () => resolution();
const unauthorized = () =>
  resolution({
    scope: { mode: "managed", guidance: "L2" },
    attestation: null,
  });

function harness(options: Partial<InProcessGateOptions> = {}) {
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const capabilities = {
    findAll: jest.fn().mockResolvedValue([]),
    resolveFor: jest.fn(),
  };
  const svc = new InProcessCapabilityService(
    capabilities as unknown as CapabilityService,
    audit as unknown as AuditService,
    { limitPerGeneration: 10, maxSlots: 4, maxStreams: 4, ...options },
  );
  return { svc, audit, capabilities };
}

function request(
  overrides: Partial<InProcessInvokeRequest> = {},
): InProcessInvokeRequest {
  return {
    key: "browser",
    mode: "read",
    generation: "v1",
    invoke: jest.fn().mockResolvedValue("downstream-value"),
    resolution: allowed(),
    // degradeOnFailure 的只读性取运行时调用面，缺席即按写处理（fail-closed）
    access: "read" as const,
    ...overrides,
  };
}

describe("InProcessCapabilityService 判定顺序与真实副作用", () => {
  it("① 未授权 capability 被 classify 拒绝：下游零调用、预算未 inc、零审计", async () => {
    const { svc, audit } = harness({ limitPerGeneration: 2 });
    const invoke = jest.fn().mockResolvedValue("must-not-run");
    const req = request({
      invoke,
      resolution: unauthorized(),
      // 若预算闸越过 classify 先跑，这条畸形历史行会使其 degraded
      // 并写审计；拒绝路径应当连预算 state 都不读。
    });
    // 用畸形 usage 行制造「预算闸一跑就降级」的可观测状态
    svc.budget.usage.set("browser", [{ generation: "v1", units: -1 }]);

    const result = await svc.invoke(req);

    expect(result.status).toBe("denied");
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("permission-denied");
    expect(invoke).toHaveBeenCalledTimes(0);
    expect(audit.log).toHaveBeenCalledTimes(0);
    expect(svc.budget.usage.get("browser")).toEqual([
      { generation: "v1", units: -1 },
    ]);
  });

  it("② 同 key 同代超预算 ⇒ degraded：下游恰好 2 次、零 inc、一条精确审计", async () => {
    const { svc, audit } = harness({ limitPerGeneration: 2 });
    const invoke = jest.fn().mockResolvedValue("ok");
    const req = request({ invoke });

    expect((await svc.invoke(req)).status).toBe("ok");
    expect((await svc.invoke(req)).status).toBe("ok");
    const third = await svc.invoke(req);

    expect(third.status).toBe("degraded");
    expect(third.decision).toBe("allow");
    expect(third.reason).toBe("budget");
    expect(third.action).toBe("fail-closed");
    expect(third.value).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(2);
    // 只给放行的两次计数，degraded 那次绝不 inc
    expect(svc.budget.usage.get("browser")).toEqual([
      { generation: "v1", units: 1 },
      { generation: "v1", units: 1 },
    ]);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith({
      action: CAPABILITY_DEGRADED_ACTION,
      resource: "capability",
      resourceId: "browser",
      detail: {
        key: "browser",
        generation: "v1",
        stage: "budget",
        action: "fail-closed",
        errorKind: "budget-exceeded",
        used: 3,
        limit: 2,
        remaining: 0,
      },
      result: "failure",
    });
  });

  it("③ classify → budget → degrade 顺序：ask 也不进预算闸，degrade 不被触发", async () => {
    const inc = jest.fn();
    const { svc, audit } = harness({
      limitPerGeneration: 1,
      budgetStore: { get: jest.fn(() => 0), inc },
    });
    const invoke = jest.fn();
    const asking = resolution({
      scope: { mode: "supervised", guidance: "L2" },
    });

    const result = await svc.invoke(request({ invoke, resolution: asking }));

    expect(result.status).toBe("denied");
    expect(result.decision).toBe("ask");
    expect(inc).toHaveBeenCalledTimes(0);
    expect(invoke).toHaveBeenCalledTimes(0);
    expect(audit.log).toHaveBeenCalledTimes(0);
    expect(svc.budget.usage.size).toBe(0);
  });

  it("④ slots 占用失败 ⇒ fail-closed 降级：下游零调用，槽位状态不变", async () => {
    const { svc, audit } = harness({ maxSlots: 1 });
    expect(svc.pressure.acquireSlot("held")).toBe("held");
    const before = svc.pressure.state;
    const invoke = jest.fn();

    const result = await svc.invoke(request({ invoke }));

    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("slots");
    expect(result.action).toBe("fail-closed");
    expect(invoke).toHaveBeenCalledTimes(0);
    expect(svc.pressure.state).toEqual(before);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0][0].detail.stage).toBe("slots");
  });

  it("⑤ streams 满额拒绝后释放 ⇒ 下一次调用恢复放行", async () => {
    const { svc } = harness({ maxStreams: 1 });
    expect(svc.pressure.enterStream()).toBe(true);
    const invoke = jest.fn().mockResolvedValue("ok");

    const blocked = await svc.invoke(request({ invoke, generation: "v1" }));
    expect(blocked.status).toBe("degraded");
    expect(blocked.reason).toBe("streams");
    expect(invoke).toHaveBeenCalledTimes(0);

    expect(svc.pressure.leaveStream()).toBe(true);
    const recovered = await svc.invoke(request({ invoke, generation: "v1" }));
    expect(recovered.status).toBe("ok");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(svc.pressure.state.streams).toBe(0);
    expect(svc.pressure.state.slots).toEqual([]);
  });
});

describe("degradeOnFailure 三分支的真实副作用", () => {
  it("use-cached：真读一次缓存并取值，审计 action=use-cached", async () => {
    const cache = { get: jest.fn().mockReturnValue("cached-value") };
    const { svc, audit } = harness({ cache });
    const invoke = jest.fn().mockRejectedValue(new Error("boom"));

    const result = await svc.invoke(request({ invoke, errorKind: "timeout" }));

    expect(result.status).toBe("degraded");
    expect(result.action).toBe("use-cached");
    expect(result.value).toBe("cached-value");
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledWith("browser");
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0][0].detail).toMatchObject({
      stage: "failure",
      action: "use-cached",
      errorKind: "timeout",
    });
  });

  it("empty-result：不发缓存读，返回空结果替身", async () => {
    const cache = { get: jest.fn().mockReturnValue("cached-value") };
    const { svc, audit } = harness({ cache });
    const invoke = jest.fn().mockRejectedValue(new Error("boom"));

    const result = await svc.invoke(request({ invoke, errorKind: "no_data" }));

    expect(result.status).toBe("degraded");
    expect(result.action).toBe("empty-result");
    expect(result.value).toBeNull();
    expect(cache.get).toHaveBeenCalledTimes(0);
    expect(audit.log.mock.calls[0][0].detail.action).toBe("empty-result");
  });

  it("fail-closed：未知错误类别不发缓存读、不给结果", async () => {
    const cache = { get: jest.fn().mockReturnValue("cached-value") };
    const { svc, audit } = harness({ cache });
    const invoke = jest.fn().mockRejectedValue(new Error("boom"));

    const result = await svc.invoke(
      request({ invoke, errorKind: "hard-failure" }),
    );

    expect(result.status).toBe("degraded");
    expect(result.action).toBe("fail-closed");
    expect(result.value).toBeUndefined();
    expect(cache.get).toHaveBeenCalledTimes(0);
    expect(audit.log.mock.calls[0][0].detail.errorKind).toBe("hard-failure");
  });
});
