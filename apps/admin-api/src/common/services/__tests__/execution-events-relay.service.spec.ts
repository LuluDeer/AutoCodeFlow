/**
 * 第四轮审计（A3）: 执行终态事件跨实例 relay 单测。
 *
 * ioredis 以「每次构造一个独立实例」的 mock 替身——发布端/订阅端两条连接
 * 分别对应 instances[0]（onModuleInit 即建，订阅端）与 instances[1]（首次
 * publish 惰性建）。总线用真实 DomainEventBus，验证端到端补发语义。
 */
jest.mock("ioredis", () => {
  const instances: any[] = [];
  const RedisMock = jest.fn().mockImplementation(() => {
    const instance = {
      on: jest.fn(),
      subscribe: jest.fn(async () => "OK"),
      publish: jest.fn(async () => 1),
      quit: jest.fn(async () => "OK"),
      disconnect: jest.fn(),
      status: "ready",
    };
    instances.push(instance);
    return instance;
  });
  (RedisMock as any).mockInstances = instances;
  return { __esModule: true, default: RedisMock };
});

import { ConfigService } from "@nestjs/config";
import { DomainEventBus } from "../domain-event-bus.service";
import {
  EXECUTION_EVENTS_RELAY_CHANNEL,
  ExecutionEventsRelayService,
} from "../execution-events-relay.service";
import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../events/domain-events";

const { default: RedisMock } = jest.requireMock("ioredis") as {
  default: jest.Mock & { mockInstances: Array<Record<string, jest.Mock>> };
};

const makeConfig = () =>
  ({
    get: jest.fn().mockImplementation((key: string) => {
      if (key === "redis.host") return "localhost";
      if (key === "redis.port") return 6379;
      if (key === "redis.db") return 0;
      return undefined;
    }),
  }) as unknown as ConfigService;

const makePayload = (
  overrides: Partial<ExecutionTerminalEventPayload> = {},
): ExecutionTerminalEventPayload => ({
  executionId: "exec-1",
  taskId: "task-1",
  taskName: "demo",
  status: "failed",
  failureReason: "exit_code_nonzero",
  finishedAt: new Date().toISOString(),
  ...overrides,
});

describe("ExecutionEventsRelayService (A3 cross-instance terminal events)", () => {
  let bus: DomainEventBus;
  let service: ExecutionEventsRelayService;

  beforeEach(() => {
    RedisMock.mockInstances.length = 0;
    bus = new DomainEventBus();
    service = new ExecutionEventsRelayService(bus, makeConfig());
    service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  const subscriber = () => RedisMock.mockInstances[0];
  const publisher = () => RedisMock.mockInstances[1];

  const messageHandler = (): (channel: string, raw: string) => void => {
    const call = subscriber()
      .on.mock.calls.find(([event]) => event === "message") as unknown as [
      string,
      (channel: string, raw: string) => void,
    ];
    expect(call).toBeDefined();
    return call[1];
  };

  it("a) 订阅端 onModuleInit 即订阅 relay channel（独立连接）", () => {
    expect(subscriber().subscribe).toHaveBeenCalledWith(
      EXECUTION_EVENTS_RELAY_CHANNEL,
    );
  });

  it("b) 本地总线终态事件 → Redis 广播（信封带 instanceId 与事件名）", async () => {
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, makePayload());
    await Promise.resolve();

    expect(publisher().publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = publisher().publish.mock.calls[0] as [
      string,
      string,
    ];
    expect(channel).toBe(EXECUTION_EVENTS_RELAY_CHANNEL);
    const envelope = JSON.parse(raw) as {
      instanceId: string;
      event: string;
      payload: ExecutionTerminalEventPayload;
    };
    expect(envelope.instanceId).toBe(
      (service as unknown as { instanceId: string }).instanceId,
    );
    expect(envelope.event).toBe(DOMAIN_EVENTS.EXECUTION_FAILED);
    expect(envelope.payload.executionId).toBe("exec-1");
  });

  it("c) 自身消息去重：广播回来不再补发（本地已派发过）", async () => {
    const seen: ExecutionTerminalEventPayload[] = [];
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, (p) => seen.push(p as ExecutionTerminalEventPayload));

    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, makePayload());
    await Promise.resolve();
    expect(seen).toHaveLength(1); // 本地 emit 的一次

    // 把刚广播的消息原样送回订阅端（模拟收到自己的 pub/sub 回声）
    const [, raw] = publisher().publish.mock.calls[0] as [string, string];
    messageHandler()(EXECUTION_EVENTS_RELAY_CHANNEL, raw);
    expect(seen).toHaveLength(1); // 未双投
    expect(publisher().publish).toHaveBeenCalledTimes(1); // 也未回声再广播
  });

  it("d) 远端消息 → 本地总线补发（viaRelay=true），副作用订阅方可据此跳过", () => {
    const seen: ExecutionTerminalEventPayload[] = [];
    bus.on(DOMAIN_EVENTS.EXECUTION_COMPLETED, (p) => seen.push(p as ExecutionTerminalEventPayload));

    const remote = {
      instanceId: "other-instance",
      event: DOMAIN_EVENTS.EXECUTION_COMPLETED,
      payload: makePayload({ status: "success", failureReason: null }),
    };
    messageHandler()(EXECUTION_EVENTS_RELAY_CHANNEL, JSON.stringify(remote));

    expect(seen).toHaveLength(1);
    expect(seen[0].viaRelay).toBe(true);
    expect(seen[0].executionId).toBe("exec-1");
  });

  it("e) 补发进总线的事件不再二次广播（防回声环）", async () => {
    const remote = {
      instanceId: "other-instance",
      event: DOMAIN_EVENTS.EXECUTION_KILLED,
      payload: makePayload({ status: "killed" }),
    };
    messageHandler()(EXECUTION_EVENTS_RELAY_CHANNEL, JSON.stringify(remote));
    await Promise.resolve();

    // 发布端连接甚至不应被创建（补发事件被 viaRelay 短路，publish 零调用）。
    expect(RedisMock.mockInstances.length).toBe(1); // 仅订阅端一条连接
  });

  it("f) Redis 挂掉不崩：publish 拒绝只 warn，主链 emit 照常", async () => {
    const seen: ExecutionTerminalEventPayload[] = [];
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, (p) =>
      seen.push(p as ExecutionTerminalEventPayload),
    );

    // 首次 emit 创建发布端并成功广播
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, makePayload());
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);

    // Redis 开始拒绝：本地派发不受影响（单实例语义不变），且不抛
    publisher().publish.mockRejectedValueOnce(new Error("connection refused"));
    expect(() =>
      bus.emit(
        DOMAIN_EVENTS.EXECUTION_FAILED,
        makePayload({ executionId: "exec-2" }),
      ),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(2);
  });

  it("g) 订阅失败/非法消息：fail-open 忽略，不抛不补发", () => {
    (subscriber().subscribe as jest.Mock).mockReset();
    (subscriber().subscribe as jest.Mock).mockRejectedValue(
      new Error("redis down"),
    );
    const seen: ExecutionTerminalEventPayload[] = [];
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, (p) => seen.push(p as ExecutionTerminalEventPayload));

    // 垃圾消息与非目标事件名：忽略
    expect(() =>
      messageHandler()(EXECUTION_EVENTS_RELAY_CHANNEL, "not-json"),
    ).not.toThrow();
    expect(() =>
      messageHandler()(
        EXECUTION_EVENTS_RELAY_CHANNEL,
        JSON.stringify({ instanceId: "x", event: "executor.offline" }),
      ),
    ).not.toThrow();
    expect(seen).toHaveLength(0);
  });
});
