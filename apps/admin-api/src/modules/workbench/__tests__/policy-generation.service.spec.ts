/**
 * N14+ 运行时代际注册表单测（内存替身级）。
 *
 * 沿用 workbench specs 的 jest.mock 风格隔掉 ESM-only 框架边界；事件总线用
 * 真实 DomainEventBus（node:events 薄封装），验证 emit→on→bump→generation
 * 变化的完整链路，但不依赖 Nest DI / PG / Redis。
 *
 * 持久化部分用内存 ConfigStore 替身：验首次回源 + 缓存命中不再读、bump 写 DB
 * + 广播、失效后重读、以及 ConfigStore 缺席/读失败的 fail-open。
 */
jest.mock("@nestjs/common", () => {
  class HttpError extends Error {
    response?: unknown;
    status?: number;
    constructor(response?: unknown, status?: number) {
      super(
        typeof response === "object" && response && "message" in response
          ? String((response as { message?: unknown }).message)
          : undefined,
      );
      this.response = response;
      this.status = status;
    }
    getResponse() {
      return this.response;
    }
    getStatus() {
      return this.status;
    }
  }
  const exceptions = [
    "BadGatewayException",
    "BadRequestException",
    "ConflictException",
    "ForbiddenException",
    "HttpException",
    "InternalServerErrorException",
    "NotFoundException",
    "ServiceUnavailableException",
    "UnauthorizedException",
  ];
  const out: Record<string, unknown> = {};
  for (const name of exceptions) out[name] = HttpError;
  return {
    ...out,
    Controller: () => () => undefined,
    Post: () => () => undefined,
    Body: () => () => undefined,
    Ip: () => () => undefined,
    UseGuards: () => () => undefined,
    Injectable: () => () => undefined,
    Optional: () => () => undefined,
    Logger: class {
      log(): void {}
      warn(): void {}
      error(): void {}
    },
  };
});

import {
  DOMAIN_EVENTS,
  EVENT_SCHEMA_VERSION,
} from "../../../common/events/domain-events";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import {
  computePolicyGeneration,
  policySnapshotForVersion,
} from "../preview-validator";
import {
  POLICY_GENERATION_CONFIG_KEY,
  POLICY_GENERATION_VALUE_TYPE,
  PolicyGenerationService,
} from "../policy-generation.service";

const emitChanged = (
  bus: DomainEventBus,
  operation: "create" | "update" | "remove" = "update",
): boolean =>
  bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, {
    key: "browser",
    operation,
    occurredAt: new Date().toISOString(),
    schemaVersion: EVENT_SCHEMA_VERSION,
  });

/** 内存 ConfigStore 替身：findOne/upsert 带 spy 语义，set 模拟别的实例改写。 */
function makeStore(initial: string | null) {
  let value = initial;
  return {
    findOne: jest.fn(async (_key: string) => {
      if (value === null) {
        throw Object.assign(new Error("not found"), {
          errorCode: "CONFIG_ITEM_NOT_FOUND",
        });
      }
      return { value };
    }),
    upsert: jest.fn(async (dto: { value: string }) => {
      value = dto.value;
      return { value };
    }),
    set(next: string | null) {
      value = next;
    },
  };
}

describe("PolicyGenerationService (N14 运行时代际 / 进程内 counter)", () => {
  it("初始 generation 稳定，且保持 16 hex 格式", async () => {
    const svc = new PolicyGenerationService(new DomainEventBus());
    const gen = await svc.currentGeneration();

    expect(gen).toMatch(/^[0-9a-f]{16}$/);
    expect(gen).toBe(computePolicyGeneration(policySnapshotForVersion(0)));
    expect(computePolicyGeneration(policySnapshotForVersion(0))).toMatch(
      /^[0-9a-f]{16}$/,
    );
    expect(await svc.currentGeneration()).toBe(gen);
    expect(await svc.currentVersion()).toBe(0);
  });

  it("emit capability.changed → generation 改变（在途旧卡失效的源头）", async () => {
    const bus = new DomainEventBus();
    const svc = new PolicyGenerationService(bus);
    const before = await svc.currentGeneration();

    expect(emitChanged(bus, "create")).toBe(true);
    expect(await svc.currentVersion()).toBe(1);
    expect(await svc.currentGeneration()).not.toBe(before);
    expect(await svc.currentGeneration()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("多次 bump 单调递增，每次 generation 都不同", async () => {
    const bus = new DomainEventBus();
    const svc = new PolicyGenerationService(bus);
    const gens = [await svc.currentGeneration()];

    for (const operation of ["update", "remove", "create"] as const) {
      emitChanged(bus, operation);
      gens.push(await svc.currentGeneration());
    }

    expect(await svc.currentVersion()).toBe(3);
    expect(new Set(gens).size).toBe(4);
    for (const gen of gens) expect(gen).toMatch(/^[0-9a-f]{16}$/);
  });

  it("bump 抛错被吞：emit 不抛、generation 不变（fail-open）", async () => {
    const bus = new DomainEventBus();
    const svc = new PolicyGenerationService(bus);
    const before = await svc.currentGeneration();
    const boom = jest.spyOn(svc, "bump").mockImplementation(() => {
      throw new Error("counter backend down");
    });

    expect(() => emitChanged(bus)).not.toThrow();
    expect(await svc.currentVersion()).toBe(0);
    expect(await svc.currentGeneration()).toBe(before);
    boom.mockRestore();
  });

  it("bus 缺席（极简装配）→ 仍可手动 bump，不崩", async () => {
    const svc = new PolicyGenerationService();
    const before = await svc.currentGeneration();
    expect(() => svc.bump("manual")).not.toThrow();
    await svc.bump("manual");
    expect(await svc.currentVersion()).toBe(2);
    expect(await svc.currentGeneration()).not.toBe(before);
  });
});

describe("PolicyGenerationService (N14+ 持久化 + 缓存)", () => {
  it("首次从 DB 读到 version N → 对应 gen；缓存后第二次不再读 DB", async () => {
    const store = makeStore("7");
    const svc = new PolicyGenerationService(null, store as any);

    const gen = await svc.currentGeneration();
    expect(gen).toBe(computePolicyGeneration(policySnapshotForVersion(7)));
    expect(gen).toMatch(/^[0-9a-f]{16}$/);
    expect(store.findOne).toHaveBeenCalledTimes(1);
    expect(store.findOne).toHaveBeenCalledWith(POLICY_GENERATION_CONFIG_KEY);

    // 第二次命中缓存
    expect(await svc.currentGeneration()).toBe(gen);
    expect(await svc.currentVersion()).toBe(7);
    expect(store.findOne).toHaveBeenCalledTimes(1);
  });

  it("key 不存在 → 回退 version 0，generation 仍是 16 hex", async () => {
    const store = makeStore(null);
    const svc = new PolicyGenerationService(null, store as any);
    const warn = jest
      .spyOn((svc as any).logger, "warn")
      .mockImplementation(() => undefined);
    expect(await svc.currentVersion()).toBe(0);
    expect(await svc.currentGeneration()).toMatch(/^[0-9a-f]{16}$/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("bump：写 DB（key + valueType=number + 新 value）+ 本地缓存更新 + publishInvalidate 调用", async () => {
    const store = makeStore("7");
    const invalidator = {
      publishInvalidate: jest.fn(async (_key?: string) => {}),
    };
    const svc = new PolicyGenerationService(
      null,
      store as any,
      invalidator as any,
    );

    expect(await svc.bump("test")).toBe(8);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: POLICY_GENERATION_CONFIG_KEY,
        value: "8",
        valueType: POLICY_GENERATION_VALUE_TYPE,
      }),
    );
    expect(invalidator.publishInvalidate).toHaveBeenCalledWith(
      POLICY_GENERATION_CONFIG_KEY,
    );
    // 本地缓存已更新为写入值，不再回源
    expect(await svc.currentVersion()).toBe(8);
    expect(store.findOne).toHaveBeenCalledTimes(2); // bump 的读 + 写后确认
  });

  it("失效（模拟另一实例置 loaded=false）→ currentGeneration 重读 DB 得新值", async () => {
    const store = makeStore("7");
    const svc = new PolicyGenerationService(null, store as any);

    expect(await svc.currentVersion()).toBe(7);
    expect(store.findOne).toHaveBeenCalledTimes(1);

    // 另一实例把 DB 版本改到 9 并广播失效 → 本地置 loaded=false
    store.set("9");
    svc.invalidate();

    const gen = await svc.currentGeneration();
    expect(gen).toBe(computePolicyGeneration(policySnapshotForVersion(9)));
    expect(await svc.currentVersion()).toBe(9);
    expect(store.findOne).toHaveBeenCalledTimes(2);
  });

  it("ConfigStore 读抛错 → warn + 回退 0，不崩（fail-open）", async () => {
    const store = makeStore("0");
    store.findOne.mockImplementation(async () => {
      throw new Error("db down");
    });
    const svc = new PolicyGenerationService(null, store as any);
    const warn = jest
      .spyOn((svc as any).logger, "warn")
      .mockImplementation(() => undefined);

    expect(await svc.currentGeneration()).toMatch(/^[0-9a-f]{16}$/);
    expect(await svc.currentVersion()).toBe(0);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("db down");
    warn.mockRestore();
  });

  it("ConfigStore 缺席 → 退回进程内 counter 语义", async () => {
    const svc = new PolicyGenerationService(new DomainEventBus(), null);
    expect(await svc.currentVersion()).toBe(0);
    await svc.bump("fail-open");
    expect(await svc.currentVersion()).toBe(1);
    expect(await svc.currentGeneration()).toBe(
      computePolicyGeneration(policySnapshotForVersion(1)),
    );
  });
});
