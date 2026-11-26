/**
 * N20 配额 + showback 单测（内存替身 SystemConfigService + mock webhook 渠道）。
 *
 * 验收级别：单测 / 内存替身——证明 upsert 校验、三态边界、告警去重、
 * fail-open 与 stats 映射成立；不代表真实 PG 持久化或 Nest DI 集成。
 * 裸 jest 下 @nestjs/common / @nestjs/swagger 是 ESM，先 mock 框架边界。
 */
jest.mock("@nestjs/common", () => ({
  Injectable: () => () => undefined,
  Logger: class {
    warn(): void {}
    log(): void {}
  },
}));
// LANG-ERR-01：生产用 AppError + ErrorCode.VALIDATION_FAILED；裸 jest 不可加载
// Nest HttpException（ESM），用替身保留 errorCode / params.detail 供精确断言。
jest.mock("../../../common/errors/app-error", () => ({
  AppError: class extends Error {
    readonly errorCode: string;
    readonly params: Record<string, unknown> | null;
    constructor(code: string, params?: Record<string, unknown> | null) {
      super(`${code}: ${params?.detail ?? ""}`);
      this.errorCode = code;
      this.params = params ?? null;
    }
  },
}));
jest.mock("../../../common/errors/error-codes", () => ({
  ErrorCode: { VALIDATION_FAILED: "VALIDATION_FAILED" },
}));
jest.mock("@nestjs/swagger", () => {
  const deco =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return { ApiProperty: deco, ApiPropertyOptional: deco };
});
// 只需 AlertChannel 这个值；其余空壳仅供 @Injectable 的 design:paramtypes 元数据。
jest.mock("../../notification/notification.service", () => ({
  AlertChannel: { WEBHOOK: "webhook" },
  NotificationService: class {},
}));
jest.mock("../capability-activation.service", () => ({
  CapabilityActivationService: class {},
  parametersDigest: () => "",
  stableStringify: () => "",
}));
jest.mock("../../config/config.service", () => ({
  SystemConfigService: class {},
}));
jest.mock("../../notification/channel-config.store", () => ({
  ChannelConfigStore: class {},
}));
// 裸 jest 无 reflect-metadata：class-transformer 的 @Type 会炸，桩掉即可。
jest.mock("class-transformer", () => ({
  Type: () => () => undefined,
}));

import type { CapabilityActivationService } from "../capability-activation.service";
import type { SetQuotaDto } from "../dto/quota.dto";
import { QuotaService } from "../quota.service";
import type { SystemConfigService } from "../../config/config.service";
import type { ChannelConfigStore } from "../../notification/channel-config.store";
import type { NotificationService } from "../../notification/notification.service";
import type { NotificationPayload } from "../../notification/channels/base.channel";

type Row = { key: string; value: string | null };
type StatProject = {
  projectId: string | null;
  count: number;
  currencyValue?: number | null;
  priceReason?: string;
};
type StatCap = {
  capabilityKey: string;
  count: number;
  currencyValue?: number | null;
  priceReason?: string;
};

function configStub(rows: Row[] = []) {
  const store = new Map(rows.map((r) => [r.key, r]));
  const upsert = jest.fn(
    async (dto: { key: string; value: string; valueType?: string }) => {
      const row: Row = { key: dto.key, value: dto.value };
      store.set(dto.key, row);
      return row;
    },
  );
  const getByPrefix = jest.fn(async (prefix: string) =>
    [...store.values()]
      .filter((r) => r.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
  return { upsert, getByPrefix, store };
}

function activationStub(
  byProject: StatProject[] = [],
  byCapability: StatCap[] = [],
) {
  return {
    stats: jest.fn(async (_o?: { from?: string; to?: string }) => ({
      total: 0,
      byProject,
      byCapability,
    })),
  };
}

function notifyStub() {
  return {
    sendWebhook: jest.fn(
      async (_payload: NotificationPayload, _url?: string) => "sent" as const,
    ),
    sendToChannels: jest.fn(async () => ({})),
  };
}

function channelStub(url = "https://global.example/hook") {
  return {
    isEnabled: jest.fn(() => true),
    get: jest.fn(() => (url ? { url } : undefined)),
  };
}

function makeService(
  activation: ReturnType<typeof activationStub>,
  config: ReturnType<typeof configStub>,
  notify: ReturnType<typeof notifyStub>,
  channels: ReturnType<typeof channelStub>,
): QuotaService {
  return new QuotaService(
    activation as unknown as CapabilityActivationService,
    config as unknown as SystemConfigService,
    notify as unknown as NotificationService,
    channels as unknown as ChannelConfigStore,
  );
}

const base = (over: Partial<SetQuotaDto> = {}): SetQuotaDto => ({
  scope: "project",
  target: "proj-a",
  softLimit: 10,
  hardLimit: 20,
  windowDays: 30,
  ...over,
});

/** 精确断言 LANG-ERR-01：稳定码 VALIDATION_FAILED + 中文字段原因。 */
async function expectInvalid(
  promise: Promise<unknown>,
  detail: string,
): Promise<void> {
  try {
    await promise;
  } catch (err: unknown) {
    expect((err as { errorCode?: string }).errorCode).toBe("VALIDATION_FAILED");
    expect((err as { params?: { detail?: string } }).params?.detail).toBe(
      detail,
    );
    return;
  }
  throw new Error(`expected VALIDATION_FAILED(${detail}) but promise resolved`);
}

describe("N20 · upsert 校验与落库形态", () => {
  it("softLimit > hardLimit 拒写，非法 windowDays（0/91）拒写", async () => {
    const svc = makeService(
      activationStub(),
      configStub(),
      notifyStub(),
      channelStub(),
    );
    await expectInvalid(
      svc.upsert(base({ softLimit: 21, hardLimit: 20 })),
      "配额 softLimit 必须为正数且不大于 hardLimit",
    );
    await expectInvalid(
      svc.upsert(base({ windowDays: 0 })),
      "配额 windowDays 必须在 1 到 90 之间",
    );
    await expectInvalid(
      svc.upsert(base({ windowDays: 91 })),
      "配额 windowDays 必须在 1 到 90 之间",
    );
    await expectInvalid(
      svc.upsert(base({ softLimit: 0 })),
      "配额 softLimit 必须是正整数",
    );
    await expectInvalid(
      svc.upsert(base({ hardLimit: 0 })),
      "配额 hardLimit 必须是正整数",
    );
    await expectInvalid(
      svc.upsert(base({ scope: "bogus" as "project" })),
      "配额 scope 非法，仅支持 project 或 capability",
    );
    await expectInvalid(
      svc.upsert(base({ target: "" })),
      "配额 target 必须是非空字符串",
    );
  });

  it("合法配置以 JSON value + valueType=json 落在 acf.showback.quota. 前缀", async () => {
    const config = configStub();
    const svc = makeService(
      activationStub(),
      config,
      notifyStub(),
      channelStub(),
    );
    const saved = await svc.upsert(
      base({ webhookUrl: "https://own.example/h" }),
    );
    expect(saved).toEqual(base({ webhookUrl: "https://own.example/h" }));
    expect(config.upsert).toHaveBeenCalledTimes(1);
    const dto = config.upsert.mock.calls[0][0];
    expect(dto.key).toBe("acf.showback.quota.project.proj-a");
    expect(dto.valueType).toBe("json");
    expect(JSON.parse(dto.value)).toEqual(saved);
  });
});

describe("N20 · 三态边界与 stats 映射", () => {
  const cases: Array<[number, string]> = [
    [9, "ok"],
    [10, "warn"],
    [19, "warn"],
    [20, "exceeded"],
    [25, "exceeded"],
  ];

  it.each(cases)(
    "byProject usage=%i → status=%s（边界精确）",
    async (count, expected) => {
      const svc = makeService(
        activationStub([{ projectId: "proj-a", count }]),
        configStub([
          {
            key: "acf.showback.quota.project.proj-a",
            value: JSON.stringify(base()),
          },
        ]),
        notifyStub(),
        channelStub(),
      );
      const rows = await svc.status(30);
      expect(rows).toEqual([{ ...base(), usage: count, status: expected }]);
    },
  );

  it("scope=capability 从 byCapability 取数；未命中的 target usage=0 → ok", async () => {
    const svc = makeService(
      activationStub([], [{ capabilityKey: "cap-a", count: 7 }]),
      configStub([
        {
          key: "acf.showback.quota.capability.cap-a",
          value: JSON.stringify(base({ scope: "capability", target: "cap-a" })),
        },
        {
          key: "acf.showback.quota.capability.cap-z",
          value: JSON.stringify(base({ scope: "capability", target: "cap-z" })),
        },
      ]),
      notifyStub(),
      channelStub(),
    );
    const rows = await svc.status(30);
    expect(rows.map((r) => [r.target, r.usage, r.status])).toEqual([
      ["cap-a", 7, "ok"],
      ["cap-z", 0, "ok"],
    ]);
  });

  it("status 时间窗来自 windowDays 参数（from/to 相差 windowDays 天）", async () => {
    const activation = activationStub([{ projectId: "proj-a", count: 0 }]);
    const svc = makeService(
      activation,
      configStub([
        {
          key: "acf.showback.quota.project.proj-a",
          value: JSON.stringify(base()),
        },
      ]),
      notifyStub(),
      channelStub(),
    );
    await svc.status(7);
    expect(activation.stats).toHaveBeenCalledTimes(1);
    const { from, to } = activation.stats.mock.calls[0][0]!;
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(
      7 * 86_400_000,
    );
  });

  it("无配额配置 → 空数组，且不调用 stats（不虚构用量）", async () => {
    const activation = activationStub();
    const svc = makeService(
      activation,
      configStub(),
      notifyStub(),
      channelStub(),
    );
    expect(await svc.status()).toEqual([]);
    expect(activation.stats).not.toHaveBeenCalled();
  });
});

describe("N20 · evaluateHardLimit 闸接 status（fail-open）", () => {
  const dto = { capabilityKey: "cap-a", projectId: "proj-a" };
  const key = "acf.showback.quota.project.proj-a";

  it("usage 达硬阈 → blocked，且 stats 窗口取配置自己的 windowDays", async () => {
    const activation = activationStub([{ projectId: "proj-a", count: 20 }]);
    const svc = makeService(
      activation,
      configStub([{ key, value: JSON.stringify(base({ windowDays: 7 })) }]),
      notifyStub(),
      channelStub(),
    );
    expect(await svc.evaluateHardLimit(dto)).toEqual({
      blocked: true,
      matched: {
        scope: "project",
        target: "proj-a",
        usage: 20,
        hardLimit: 20,
        windowDays: 7,
      },
    });
    const { from, to } = activation.stats.mock.calls[0][0]!;
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(
      7 * 86_400_000,
    );
  });

  it("scope=capability 按 capabilityKey 命中；无关配置不拦", async () => {
    const capCfg = base({ scope: "capability", target: "cap-a" });
    const svc = makeService(
      activationStub([], [{ capabilityKey: "cap-a", count: 20 }]),
      configStub([
        {
          key: "acf.showback.quota.capability.cap-a",
          value: JSON.stringify(capCfg),
        },
      ]),
      notifyStub(),
      channelStub(),
    );
    expect((await svc.evaluateHardLimit(dto)).blocked).toBe(true);
    expect(
      (
        await svc.evaluateHardLimit({
          capabilityKey: "cap-z",
          projectId: "proj-a",
        })
      ).blocked,
    ).toBe(false);
  });

  it("多配置不同窗口：只用配置自己的 windowDays 判定，不串窗", async () => {
    const activation = activationStub();
    activation.stats.mockImplementation(async (o) => {
      const days =
        (new Date(o!.to!).getTime() - new Date(o!.from!).getTime()) /
        86_400_000;
      return {
        total: 0,
        byProject: [{ projectId: "proj-a", count: days <= 8 ? 19 : 25 }],
        byCapability: [{ capabilityKey: "cap-a", count: 10 }],
      };
    });
    const svc = makeService(
      activation,
      configStub([
        { key, value: JSON.stringify(base({ windowDays: 7 })) },
        {
          key: "acf.showback.quota.capability.cap-a",
          value: JSON.stringify(
            base({
              scope: "capability",
              target: "cap-a",
              hardLimit: 100,
              windowDays: 30,
            }),
          ),
        },
      ]),
      notifyStub(),
      channelStub(),
    );
    // proj-a 的 7 天用量 19 < 20；30 天的 25 不能套到它的 7 天配额上。
    expect(await svc.evaluateHardLimit(dto)).toEqual({ blocked: false });
  });

  it("无相关配额 → 放行且不查 stats；配置读取异常 → fail-open", async () => {
    const activation = activationStub([{ projectId: "proj-a", count: 99 }]);
    const config = configStub([
      {
        key: "acf.showback.quota.project.proj-z",
        value: JSON.stringify(base({ target: "proj-z" })),
      },
    ]);
    const svc = makeService(activation, config, notifyStub(), channelStub());
    expect(await svc.evaluateHardLimit(dto)).toEqual({ blocked: false });
    expect(activation.stats).not.toHaveBeenCalled();

    config.getByPrefix.mockRejectedValueOnce(new Error("config down"));
    expect(await svc.evaluateHardLimit(dto)).toEqual({ blocked: false });
  });
});

describe("N20 · 软阈值告警去重与 fail-open", () => {
  function wired(count: () => number, webhookUrl?: string) {
    const activation = activationStub();
    activation.stats.mockImplementation(async () => ({
      total: 0,
      byProject: [{ projectId: "proj-a", count: count() }],
      byCapability: [],
    }));
    const config = configStub([
      {
        key: "acf.showback.quota.project.proj-a",
        value: JSON.stringify(base(webhookUrl ? { webhookUrl } : {})),
      },
    ]);
    const notify = notifyStub();
    const channels = channelStub();
    const svc = makeService(activation, config, notify, channels);
    return { svc, notify, channels };
  }

  it("同 target 连续查询只发一次；回落 ok 清除后再发", async () => {
    let count = 10;
    const { svc, notify } = wired(() => count);
    await svc.status(30);
    await svc.status(30);
    expect(notify.sendWebhook).toHaveBeenCalledTimes(1);
    expect(notify.sendWebhook.mock.calls[0][0].content).toBe(
      "能力用量告警：proj-a 在 30 天内调用 10 次，已达软阈值 10",
    );
    count = 0;
    await svc.status(30); // 回落 ok → 清 alerted
    expect(notify.sendWebhook).toHaveBeenCalledTimes(1);
    count = 12;
    await svc.status(30); // 再次升到 warn → 重发
    expect(notify.sendWebhook).toHaveBeenCalledTimes(2);
  });

  it("配额级 webhookUrl 优先于全局；缺省时回落全局 URL", async () => {
    const own = wired(() => 10, "https://own.example/h");
    await own.svc.status(30);
    expect(own.notify.sendWebhook.mock.calls[0][1]).toBe(
      "https://own.example/h",
    );

    const fallback = wired(() => 10);
    await fallback.svc.status(30);
    expect(fallback.notify.sendWebhook.mock.calls[0][1]).toBe(
      "https://global.example/hook",
    );
  });

  it("webhook 发送失败只 warn，不阻断状态查询（fail-open）", async () => {
    const { svc, notify } = wired(() => 20);
    notify.sendWebhook.mockRejectedValueOnce(new Error("down"));
    const rows = await svc.status(30);
    expect(rows[0].status).toBe("exceeded");
    expect(notify.sendWebhook).toHaveBeenCalledTimes(1);
  });
});

describe("N20 · 金额闸接线与坏配置跳过", () => {
  const dto = { capabilityKey: "cap-a", projectId: "proj-a" };
  const key = "acf.showback.quota.project.proj-a";

  function warnSpy(svc: QuotaService) {
    const logger = (
      svc as unknown as {
        logger: { warn: (message: string) => void };
      }
    ).logger;
    return jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  }

  it("status 投影行级 currencyValue/priceReason；旧配置不新增金额字段", async () => {
    const amountCfg = base({
      unit: "amount",
      amountHardLimit: 10,
      target: "proj-a",
    });
    const legacyCfg = base({ target: "proj-a" });
    const svc = makeService(
      activationStub([
        {
          projectId: "proj-a",
          count: 3,
          currencyValue: 12.5,
          priceReason: "priced",
        },
      ]),
      configStub([
        { key, value: JSON.stringify(amountCfg) },
        {
          key: "acf.showback.quota.capability.legacy",
          value: JSON.stringify(legacyCfg),
        },
      ]),
      notifyStub(),
      channelStub(),
    );
    const rows = await svc.status(30);
    const amountRow = rows.find((r) => r.unit === "amount")!;
    expect(amountRow.amount).toBe(12.5);
    expect(amountRow.priceReason).toBe("priced");
    expect(amountRow.amountHardLimit).toBe(10);
    const legacyRow = rows.find((r) => r.unit === undefined)!;
    expect(legacyRow.amount).toBeUndefined();
    expect(legacyRow.priceReason).toBeUndefined();
  });

  it("金额达标 → blocked 且 detail 字段齐备；金额不可得 → skip 不比较", async () => {
    const cfg = base({ unit: "amount", amountHardLimit: 10, windowDays: 7 });
    const blocked = makeService(
      activationStub([
        {
          projectId: "proj-a",
          count: 3,
          currencyValue: 12.5,
          priceReason: "priced",
        },
      ]),
      configStub([{ key, value: JSON.stringify(cfg) }]),
      notifyStub(),
      channelStub(),
    );
    expect(await blocked.evaluateHardLimit(dto)).toEqual({
      blocked: true,
      matched: {
        scope: "project",
        target: "proj-a",
        usage: 3,
        hardLimit: 20,
        windowDays: 7,
        unit: "amount",
        amount: 12.5,
        priceReason: "priced",
        reason: "priced",
        amountHardLimit: 10,
      },
    });

    const skipped = makeService(
      activationStub([
        {
          projectId: "proj-a",
          count: 999,
          currencyValue: null,
          priceReason: "NO_TOKEN_SAMPLE",
        },
      ]),
      configStub([{ key, value: JSON.stringify(cfg) }]),
      notifyStub(),
      channelStub(),
    );
    const decision = await skipped.evaluateHardLimit(dto);
    expect(decision.blocked).toBe(false);
    expect(decision.matched).toBeUndefined();
    expect(decision.reasons?.[0]).toContain("NO_TOKEN_SAMPLE");
  });

  it("坏 unit / unit=amount 缺阈值或阈值非正 → 跳过本行并 warn", async () => {
    const badUnit = makeService(
      activationStub(),
      configStub([
        { key, value: JSON.stringify(base({ unit: "tokens" as "amount" })) },
      ]),
      notifyStub(),
      channelStub(),
    );
    const warn1 = warnSpy(badUnit);
    expect(await badUnit.list()).toEqual([]);
    expect(warn1).toHaveBeenCalledWith(expect.stringContaining("invalid unit"));

    for (const amountHardLimit of [undefined, 0, Number.NaN]) {
      const cfg = base({ unit: "amount" });
      if (amountHardLimit !== undefined) {
        cfg.amountHardLimit = amountHardLimit;
      }
      const svc = makeService(
        activationStub(),
        configStub([{ key, value: JSON.stringify(cfg) }]),
        notifyStub(),
        channelStub(),
      );
      const warn = warnSpy(svc);
      expect(await svc.list()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid amountHardLimit"),
      );
    }
  });
});
