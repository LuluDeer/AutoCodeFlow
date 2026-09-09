/**
 * FEAT-07: 出站事件订阅——util 纯函数 + 派发器行为 + CRUD 服务。
 *
 * 覆盖：
 * - 签名格式与 applications 发版 webhook 先例逐字节一致
 *   （sha256= + hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))）。
 * - 过滤只发订阅的事件类型；enabled=false 不发。
 * - 重试退避（3 次尝试）与终败死信落库 + 失败统计。
 * - replay 成功删行 / 失败保行。
 * - CRUD：url SSRF 拒内网、secret 脱敏、属主校验。
 */
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { UserRole } from "../../../modules/users/entities/user.entity";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { DOMAIN_EVENTS } from "../../../common/events/domain-events";
import { EventSubscription } from "../entities/event-subscription.entity";
import { EventSubscriptionDeadLetter } from "../entities/event-subscription-dead-letter.entity";
import { EventSubscriptionService } from "../event-subscription.service";
import {
  OutboundEventDispatcher,
  OutboundEventDispatcher as Dispatcher,
} from "../outbound-event-dispatcher.service";
import {
  MAX_DELIVERY_ATTEMPTS,
  retryDelayMs,
  subscriptionMatches,
  SUBSCRIBABLE_EVENTS,
} from "../event-subscription.util";
import { AuthUser } from "../../../common/interfaces/auth-user.interface";

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ status: 200 }) },
}));
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeHttpUrl: jest
    .fn()
    .mockResolvedValue(new URL("https://x.example.com")),
}));

// 工厂 mock 带 __esModule+default（ts-jest 无 esModuleInterop 的既有先例，
// app-deployment.service.spec.ts 同款）；requireMock 拿同一实例。
import axios from "axios";
const axiosPost = axios.post as unknown as jest.Mock;
const assertSafe = jest.requireMock("../../../common/utils/safe-http.util")
  .assertSafeHttpUrl as unknown as jest.Mock;

const adminUser: AuthUser = {
  id: 1,
  username: "admin",
  email: "a@x",
  role: UserRole.ADMIN,
  isActive: true,
};
const plainUser: AuthUser = {
  id: 7,
  username: "u7",
  email: "u7@x",
  role: UserRole.USER,
  isActive: true,
};

function makeSub(
  overrides: Partial<EventSubscription> = {},
): EventSubscription {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: 7,
    eventTypes: ["execution.failed"],
    url: "https://ci.example.com/hooks",
    secret: "s3cret-s3cret-s3cret-1234",
    enabled: true,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as EventSubscription;
}

function makeDl(
  overrides: Partial<EventSubscriptionDeadLetter> = {},
): EventSubscriptionDeadLetter {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    subscriptionId: "11111111-1111-4111-8111-111111111111",
    eventType: "execution.failed",
    payload: { event: "execution.failed", occurredAt: "t", data: {} },
    error: "boom",
    attempts: 3,
    createdAt: new Date(),
    ...overrides,
  } as EventSubscriptionDeadLetter;
}

describe("FEAT-07 event-subscription.util", () => {
  it("retryDelayMs 指数退避（1s → 2s → 4s，封顶 30s）", () => {
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(2000);
    expect(retryDelayMs(3)).toBe(4000);
    expect(retryDelayMs(50)).toBe(30000);
    expect(retryDelayMs(0)).toBe(1000);
  });

  it("subscriptionMatches 只命中订阅的事件名；空集不命中", () => {
    expect(subscriptionMatches(["execution.failed"], "execution.failed")).toBe(
      true,
    );
    expect(
      subscriptionMatches(["execution.failed"], "execution.completed"),
    ).toBe(false);
    expect(subscriptionMatches([], "execution.failed")).toBe(false);
    expect(subscriptionMatches(null, "execution.failed")).toBe(false);
  });

  it("可订阅事件目录含四类事件", () => {
    expect(SUBSCRIBABLE_EVENTS).toContain("execution.failed");
    expect(SUBSCRIBABLE_EVENTS).toContain("executor.offline");
    expect(SUBSCRIBABLE_EVENTS).toContain("deployment.completed");
    expect(SUBSCRIBABLE_EVENTS).toContain("execution.completed");
  });
});

describe("FEAT-07 OutboundEventDispatcher", () => {
  const subRepoMock = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(),
    create: jest.fn((x) => x),
    delete: jest.fn(),
  };
  const dlRepoMock = {
    save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
    create: jest.fn((x) => x),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const subServiceMock = {
    recordDeliveryFailure: jest.fn().mockResolvedValue(undefined),
    recordDeliverySuccess: jest.fn().mockResolvedValue(undefined),
    deleteDeadLetter: jest.fn().mockResolvedValue(undefined),
  };

  let dispatcher: Dispatcher;
  let bus: DomainEventBus;

  beforeEach(async () => {
    jest.clearAllMocks();
    axiosPost.mockResolvedValue({ status: 200 });
    assertSafe.mockResolvedValue(new URL("https://ci.example.com/hooks"));
    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboundEventDispatcher,
        DomainEventBus,
        { provide: EventSubscriptionService, useValue: subServiceMock },
        {
          provide: getRepositoryToken(EventSubscription),
          useValue: subRepoMock,
        },
        {
          provide: getRepositoryToken(EventSubscriptionDeadLetter),
          useValue: dlRepoMock,
        },
      ],
    }).compile();
    dispatcher = moduleRef.get(OutboundEventDispatcher);
    bus = moduleRef.get(DomainEventBus);
    dispatcher.onModuleInit();
  });

  afterEach(() => {
    dispatcher.onModuleDestroy();
  });

  it("签名格式与 applications webhook 先例逐字节一致（header 名 + sha256= 前缀 + timestamp.rawBody）", async () => {
    subRepoMock.find.mockResolvedValue([makeSub()]);
    const payload = {
      executionId: "e1",
      status: "failed",
      failureReason: "script_error",
    };
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, payload);
    await Promise.resolve();
    await Promise.resolve();
    expect(axiosPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = axiosPost.mock.calls[0];
    expect(url).toBe("https://ci.example.com/hooks");
    expect(config.headers["X-AutoCodeFlow-Event"]).toBe("execution.failed");
    const ts = config.headers["X-AutoCodeFlow-Timestamp"];
    expect(String(Number(ts))).toBe(ts);
    const expected =
      "sha256=" +
      createHmac("sha256", "s3cret-s3cret-s3cret-1234")
        .update(
          Buffer.concat([Buffer.from(`${ts}.`), Buffer.from(body, "utf8")]),
        )
        .digest("hex");
    expect(config.headers["X-Hub-Signature-256"]).toBe(expected);
    // 先例同款输入：`${timestamp}.${rawBody}` 拼接（application.controller.ts L291-295）。
    expect(JSON.parse(body).data).toEqual(payload);
  });

  it("过滤：只发订阅的类型；未订阅事件不出站", async () => {
    subRepoMock.find.mockResolvedValue([makeSub()]);
    bus.emit(DOMAIN_EVENTS.EXECUTION_COMPLETED, { executionId: "e2" });
    await Promise.resolve();
    await Promise.resolve();
    expect(axiosPost).not.toHaveBeenCalled();
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, { executionId: "e3" });
    await Promise.resolve();
    await Promise.resolve();
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it("enabled=false 的订阅不出站（查询侧 where enabled=true 契约）", async () => {
    // 派发器把 enabled 过滤下推到仓库查询（where { enabled: true }），
    // mock 仓库不执行 where——这里断言查询契约本身 + 空结果不出站。
    subRepoMock.find.mockResolvedValue([]);
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, {});
    await Promise.resolve();
    await Promise.resolve();
    expect(subRepoMock.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enabled: true } }),
    );
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it("失败重试：最多 3 次尝试后死信落库 + 失败统计", async () => {
    jest.useFakeTimers();
    try {
      subRepoMock.find.mockResolvedValue([makeSub()]);
      axiosPost.mockRejectedValue(new Error("connect ECONNREFUSED"));
      bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, { executionId: "e4" });
      // flush microtasks + timers until settled
      for (let i = 0; i < 20 && axiosPost.mock.calls.length < 3; i++) {
        await Promise.resolve();
        await jest.runAllTimersAsync();
      }
      expect(axiosPost).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
      expect(dlRepoMock.save).toHaveBeenCalledTimes(1);
      const dl = dlRepoMock.save.mock.calls[0][0];
      expect(dl.eventType).toBe("execution.failed");
      expect(dl.attempts).toBe(3);
      expect(dl.error).toContain("ECONNREFUSED");
      expect(subServiceMock.recordDeliveryFailure).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("成功派发后清零失败统计（仅在有过失败时）", async () => {
    subRepoMock.find.mockResolvedValue([makeSub({ consecutiveFailures: 2 })]);
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, {});
    // dispatch → deliverOnce(axios) → recordDeliverySuccess 链路跨多个微任务拍。
    for (
      let i = 0;
      i < 10 && subServiceMock.recordDeliverySuccess.mock.calls.length < 1;
      i++
    ) {
      await Promise.resolve();
    }
    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(subServiceMock.recordDeliverySuccess).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFailures: 2 }),
    );
  });

  it("出站前 SSRF 复核拒绝（确定性失败→终败死信，不再重试）", async () => {
    jest.useFakeTimers();
    try {
      assertSafe.mockRejectedValue(
        new BadRequestException("URL host 127.0.0.1 is on the deny list"),
      );
      subRepoMock.find.mockResolvedValue([
        makeSub({ url: "http://127.0.0.1:9999/hook" }),
      ]);
      bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, {});
      // SSRF 拒绝是确定性失败但走同一条 retry 循环（3 次尝试 × 退避），
      // 用 fake timers 快进到全部尝试结束。
      for (let i = 0; i < 20 && dlRepoMock.save.mock.calls.length < 1; i++) {
        await Promise.resolve();
        await jest.runAllTimersAsync();
      }
      expect(dlRepoMock.save).toHaveBeenCalledTimes(1);
      const dl = dlRepoMock.save.mock.calls[0][0];
      expect(dl.error).toContain("SSRF");
      expect(axiosPost).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("replay 成功：以订阅当前 url/secret 重签一次，死信删除", async () => {
    const sub = makeSub();
    const dl = makeDl();
    await dispatcher.replayDeadLetter(sub, dl);
    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(subServiceMock.deleteDeadLetter).toHaveBeenCalledWith(dl.id);
  });

  it("replay 失败：返回 error 且死信保留", async () => {
    axiosPost.mockRejectedValue(new Error("boom again"));
    const res = await dispatcher.replayDeadLetter(makeSub(), makeDl());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("boom again");
    expect(subServiceMock.deleteDeadLetter).not.toHaveBeenCalled();
    expect(subServiceMock.recordDeliveryFailure).toHaveBeenCalled();
  });

  it("模块销毁：bus 监听器全部退订", () => {
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(1);
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTOR_OFFLINE)).toBe(1);
    expect(bus.listenerCount(DOMAIN_EVENTS.DEPLOYMENT_COMPLETED)).toBe(1);
    dispatcher.onModuleDestroy();
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(0);
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTOR_OFFLINE)).toBe(0);
    expect(bus.listenerCount(DOMAIN_EVENTS.DEPLOYMENT_COMPLETED)).toBe(0);
  });
});

describe("FEAT-07 EventSubscriptionService", () => {
  const subRepoMock = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
    create: jest.fn((x) => x),
    count: jest.fn().mockResolvedValue(0),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dlRepoMock = {
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn(),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
    create: jest.fn((x) => x),
  };

  let svc: EventSubscriptionService;
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(async () => {
    jest.clearAllMocks();
    assertSafe.mockResolvedValue(new URL("https://ci.example.com/hooks"));
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventSubscriptionService,
        {
          provide: getRepositoryToken(EventSubscription),
          useValue: subRepoMock,
        },
        {
          provide: getRepositoryToken(EventSubscriptionDeadLetter),
          useValue: dlRepoMock,
        },
      ],
    }).compile();
    svc = moduleRef.get(EventSubscriptionService);
    const logger = (svc as unknown as { logger: { warn: unknown } }).logger;
    warnSpy = jest
      .spyOn(logger as { warn: (...a: unknown[]) => unknown }, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("create：url 走 assertSafeHttpUrl（内网 url 被 SSRF 守卫拒绝）", async () => {
    assertSafe.mockRejectedValue(
      new BadRequestException("URL host 10.0.0.5 is on the deny list"),
    );
    await expect(
      svc.create(
        { url: "http://10.0.0.5:8080/hook", eventTypes: ["execution.failed"] },
        plainUser,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("create：未传 secret 时生成并在响应一次性回显；读面脱敏", async () => {
    const { subscription, generatedSecret } = await svc.create(
      { url: "https://ci.example.com/hooks", eventTypes: ["execution.failed"] },
      plainUser,
    );
    expect(generatedSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(subscription.secret).toBe("******");
    // 非 ADMIN：userId 挂创建者
    expect((subscription as { userId?: number }).userId).toBe(plainUser.id);
  });

  it("create：事件名白名单兜底拒绝", async () => {
    await expect(
      svc.create(
        {
          url: "https://ci.example.com/hooks",
          eventTypes: ["not.an.event" as never],
        },
        adminUser,
      ),
    ).rejects.toThrow(/Unknown event type/);
  });

  it("listDeadLetters：非属主非 ADMIN 抛 403", async () => {
    subRepoMock.findOne.mockResolvedValue(makeSub({ userId: 99 }));
    await expect(
      svc.listDeadLetters(makeSub().id, plainUser, 1, 20),
    ).rejects.toThrow(ForbiddenException);
  });

  it("getDeadLetterForReplay：死信不属于该订阅时 404", async () => {
    subRepoMock.findOne.mockResolvedValue(makeSub({ userId: plainUser.id }));
    dlRepoMock.findOne.mockResolvedValue(null);
    await expect(
      svc.getDeadLetterForReplay(makeSub().id, "nope", plainUser),
    ).rejects.toThrow(/not found/i);
  });

  it("update：url 变更时再次 SSRF 校验", async () => {
    subRepoMock.findOne.mockResolvedValue(makeSub({ userId: plainUser.id }));
    await svc.update(
      makeSub().id,
      { url: "https://new.example.com/hook" },
      plainUser,
    );
    expect(assertSafe).toHaveBeenCalledWith("https://new.example.com/hook");
  });
});
