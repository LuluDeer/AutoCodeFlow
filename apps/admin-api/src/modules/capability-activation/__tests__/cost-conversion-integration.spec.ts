/**
 * 成本线 P1（第 93 轮）：把 convertToAmount 接进 stats 顶层 dualBasis 的集成单测。
 *
 * 内存替身口径：repo 的三条 GROUP BY 查询返回空行（故 dualReport 保持
 * dual-meter 硬编码的 null / NO_TOKEN_SAMPLE），price / token-sample 用假端口。
 * 只断言顶层 currencyValue / priceReason 的覆盖，不改行级 showback。
 */
jest.mock("@nestjs/common", () => {
  const deco =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return {
    Injectable: deco,
    Inject: deco,
    Optional: deco,
    Logger: class {
      warn(): void {}
      log(): void {}
    },
  };
});
jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
}));
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
  return {
    ApiProperty: deco,
    ApiPropertyOptional: deco,
  };
});

import "reflect-metadata";
import {
  ALLOCATION_NOTE,
  CapabilityActivationService,
} from "../capability-activation.service";
import type { PricingConfig } from "../price.dto";
import { PriceService } from "../price.service";
import {
  TokenSamplePort,
  type ProviderModelTokenRow,
  type TokenSampleDataSource,
} from "../token-sample.port";

type DualRow = {
  capabilityKey: string;
  projectId: string | null;
  result: string;
};

function makeRepo(dualRows: DualRow[] = []) {
  return {
    createQueryBuilder() {
      const state = { selects: [] as string[], group: "" };
      const qb: Record<string, unknown> = {
        select(field: string) {
          state.selects.push(field);
          return qb;
        },
        addSelect(field: string) {
          state.selects.push(field);
          return qb;
        },
        groupBy(field: string) {
          state.group = field;
          return qb;
        },
        addGroupBy() {
          return qb;
        },
        orderBy() {
          return qb;
        },
        where() {
          return qb;
        },
        andWhere() {
          return qb;
        },
        setParameters() {
          return qb;
        },
        async getRawMany() {
          if (!state.group && state.selects.includes("log.result")) {
            return dualRows.map((r) => ({ ...r }));
          }
          return [];
        },
      };
      return qb;
    },
  };
}

function cfg(
  provider: string,
  model: string,
  direction: "in" | "out",
  pricePerMillionTokens: number,
  currency = "CNY",
): PricingConfig {
  return { provider, model, direction, pricePerMillionTokens, currency };
}

function makePrices(configs: PricingConfig[], opts: { fail?: boolean } = {}) {
  return {
    getByPrefix: jest.fn(async () => {
      if (opts.fail) throw new Error("config read failed");
      return configs;
    }),
  };
}

function makeTokenSamples(
  rows: readonly ProviderModelTokenRow[],
  opts: { absent?: boolean; fail?: boolean } = {},
) {
  if (opts.absent) return null;
  return {
    selectTokenByProviderModel: jest.fn(async () => {
      if (opts.fail) throw new Error("sql failed");
      return rows;
    }),
  };
}

function svcOf(
  repo: ReturnType<typeof makeRepo>,
  prices: unknown = null,
  tokenSamples: unknown = null,
): CapabilityActivationService {
  // 定位参数：repo / gate / scopeGate 仍是原三位，成本依赖追加末尾（R394）。
  return new CapabilityActivationService(
    repo as never,
    undefined as never,
    undefined as never,
    prices as never,
    tokenSamples as never,
  );
}

const row = (
  provider: string,
  model: string,
  inCount: number,
  outCount: number,
  steps = 10,
): ProviderModelTokenRow => ({
  provider,
  model,
  in: inCount,
  out: outCount,
  steps,
});

describe("成本线 P1 · convertToAmount 接进 stats 顶层 dualBasis", () => {
  it("① 零行样本 → 不覆盖，仍是 NO_TOKEN_SAMPLE + null（看板诚实标缺）", async () => {
    const svc = svcOf(
      makeRepo(),
      makePrices([cfg("p1", "m1", "in", 2), cfg("p1", "m1", "out", 3)]),
      makeTokenSamples([]),
    );
    const { dualBasis } = await svc.stats();
    expect(dualBasis).toBeDefined();
    expect(dualBasis!.currencyValue).toBeNull();
    expect(dualBasis!.priceReason).toBe("NO_TOKEN_SAMPLE");
    expect(dualBasis!.allocationNote).toBe(ALLOCATION_NOTE);
  });

  it("② 一组非零 token + 匹配价目 → 金额=3.5、reason=OK（不变量钉死）", async () => {
    const svc = svcOf(
      makeRepo(),
      makePrices([cfg("p1", "m1", "in", 2), cfg("p1", "m1", "out", 3)]),
      makeTokenSamples([row("p1", "m1", 1_000_000, 500_000)]),
    );
    const { dualBasis } = await svc.stats();
    expect(dualBasis!.priceReason).toBe("OK");
    expect(dualBasis!.currencyValue).toBe(3.5);
    // assertAmountProjectionInvariant 的透传不变量：amount=null ⇔ reason≠OK。
    expect(dualBasis!.currencyValue === null).toBe(
      dualBasis!.priceReason !== "OK",
    );
    // 只覆盖顶层金额位：tokenSample / byCapability / byProject 一律不动。
    expect(dualBasis!.tokenSample).toBeNull();
    expect(dualBasis!.byCapability).toEqual([]);
    expect(dualBasis!.byProject).toEqual([]);
  });

  it("③ 非零 token 但缺价目 → PRICE_MISSING + null（不编造）", async () => {
    const svc = svcOf(
      makeRepo(),
      makePrices([]),
      makeTokenSamples([row("p1", "m1", 1_000_000, 500_000)]),
    );
    const { dualBasis } = await svc.stats();
    expect(dualBasis!.priceReason).toBe("PRICE_MISSING");
    expect(dualBasis!.currencyValue).toBeNull();
    expect(dualBasis!.currencyValue === null).toBe(
      dualBasis!.priceReason !== "OK",
    );
  });

  it("④ 多组同币种 → 求和正确，不附加多币种说明", async () => {
    const svc = svcOf(
      makeRepo(),
      makePrices([cfg("p1", "m1", "in", 2), cfg("p2", "m2", "in", 1)]),
      makeTokenSamples([
        row("p1", "m1", 1_000_000, 0, 5),
        row("p2", "m2", 2_000_000, 0, 7),
      ]),
    );
    const { dualBasis } = await svc.stats();
    expect(dualBasis!.priceReason).toBe("OK");
    expect(dualBasis!.currencyValue).toBe(4);
    expect(dualBasis!.allocationNote).toBe(ALLOCATION_NOTE);
  });

  it("⑤ 多组不同币种 → 不相加；顶层取样本量最大主币种，其它币种写说明", async () => {
    const svc = svcOf(
      makeRepo(),
      makePrices([
        cfg("p1", "m1", "in", 2, "CNY"),
        cfg("p2", "m2", "in", 1, "USD"),
      ]),
      makeTokenSamples([
        row("p1", "m1", 1_000_000, 0, 5), // 2 CNY
        row("p2", "m2", 10_000_000, 0, 7), // 10 USD（样本量最大 → 主币种）
      ]),
    );
    const { dualBasis } = await svc.stats();
    expect(dualBasis!.priceReason).toBe("OK");
    expect(dualBasis!.currencyValue).toBe(10); // 绝不为 12
    expect(dualBasis!.allocationNote).toContain("主币种 USD");
    expect(dualBasis!.allocationNote).toContain("CNY");
    expect(dualBasis!.allocationNote).toContain("不跨币种相加");
  });

  it("⑥ 端口缺席 → fail-soft 不崩，保持 NO_TOKEN_SAMPLE + null", async () => {
    const svc = svcOf(makeRepo(), makePrices([cfg("p1", "m1", "in", 2)]), null);
    const { dualBasis } = await svc.stats();
    expect(dualBasis!.priceReason).toBe("NO_TOKEN_SAMPLE");
    expect(dualBasis!.currencyValue).toBeNull();
  });

  it("⑦ 价目读失败 → fail-soft 标缺，不把 stats 带崩", async () => {
    const svc = svcOf(
      makeRepo(),
      makePrices([], { fail: true }),
      makeTokenSamples([row("p1", "m1", 1_000_000, 0)]),
    );
    const { dualBasis } = await svc.stats();
    expect(dualBasis!.priceReason).toBe("NO_TOKEN_SAMPLE");
    expect(dualBasis!.currencyValue).toBeNull();
  });

  it("⑧ token 样本查询抛错 → fail-soft 标缺，不抛异常", async () => {
    const svc = svcOf(
      makeRepo(),
      makePrices([cfg("p1", "m1", "in", 2)]),
      makeTokenSamples([row("p1", "m1", 1_000_000, 0)], { fail: true }),
    );
    const { dualBasis } = await svc.stats();
    expect(dualBasis!.priceReason).toBe("NO_TOKEN_SAMPLE");
    expect(dualBasis!.currencyValue).toBeNull();
  });

  it("⑨ Port 层：pg bigint 字符串归一为 number；ds 无该方法 → 空数组", async () => {
    const withBigint = {
      selectAgentSessionTotals: async () => null,
      selectStepUsages: async () => [],
      selectTokenByProviderModel: async () => [
        { provider: "p", model: "m", in: "1000000", out: "500000", steps: 3 },
      ],
    } as unknown as TokenSampleDataSource;
    expect(
      await new TokenSamplePort(withBigint).selectTokenByProviderModel(),
    ).toEqual([row("p", "m", 1_000_000, 500_000, 3)]);

    const bare = {
      selectAgentSessionTotals: async () => null,
      selectStepUsages: async () => [],
    } as TokenSampleDataSource;
    expect(
      await new TokenSamplePort(bare).selectTokenByProviderModel(),
    ).toEqual([]);
  });

  it("⑩ DI 令牌回归：design:paramtypes 第 4/5 位必须是运行时类，防 type-only import 退化", () => {
    const params = Reflect.getMetadata(
      "design:paramtypes",
      CapabilityActivationService,
    ) as unknown[];
    expect(params).toHaveLength(5);
    expect(params[3]).toBe(PriceService);
    expect(params[4]).toBe(TokenSamplePort);
  });

  it("⑪ 聚合查询失败 → fail-soft 空数组，但错误钩子留痕（不静默吞 SQL 错误）", async () => {
    const boom = new Error('column "in" does not exist');
    const onError = jest.fn();
    const badDs = {
      selectAgentSessionTotals: async () => null,
      selectStepUsages: async () => [],
      selectTokenByProviderModel: async () => {
        throw boom;
      },
    } as unknown as TokenSampleDataSource;
    const port = new TokenSamplePort(badDs, { onAggregateError: onError });
    expect(await port.selectTokenByProviderModel()).toEqual([]);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  // ── 第 94 轮：顶层金额与激活次数同源，按 stats 的 from/to 过滤 agent_steps ──
  /** 按 from/to 决定返回行的窗口 fake，并记录 service 透传的端点。 */
  function makeWindowTokenSamples(
    resolve: (from?: Date, to?: Date) => readonly ProviderModelTokenRow[],
  ) {
    const selectTokenByProviderModel = jest.fn(
      async (
        from?: Date,
        to?: Date,
      ): Promise<readonly ProviderModelTokenRow[]> => resolve(from, to),
    );
    return { selectTokenByProviderModel };
  }

  it("⑫ 无 from/to → 全局累计，ds 收到 (undefined, undefined)（第 93 轮零回归）", async () => {
    const fake = makeWindowTokenSamples(() => [row("p1", "m1", 1_000_000, 0)]);
    const svc = svcOf(makeRepo(), makePrices([cfg("p1", "m1", "in", 2)]), fake);
    const { dualBasis } = await svc.stats();
    expect(dualBasis!.priceReason).toBe("OK");
    expect(dualBasis!.currencyValue).toBe(2);
    expect(fake.selectTokenByProviderModel).toHaveBeenCalledTimes(1);
    expect(fake.selectTokenByProviderModel).toHaveBeenCalledWith(
      undefined,
      undefined,
    );
  });

  it("⑬ from/to 过滤 → 只算窗内行，金额随窗口变化（去掉透传此例真红）", async () => {
    const fake = makeWindowTokenSamples(
      (from, to) =>
        from && to
          ? [row("p2", "m2", 2_000_000, 0)] // 窗内：2M × 2 / 1e6 = 4
          : [row("p1", "m1", 1_000_000, 0)], // 全局：1M × 2 / 1e6 = 2
    );
    const prices = makePrices([
      cfg("p1", "m1", "in", 2),
      cfg("p2", "m2", "in", 2),
    ]);
    const svc = svcOf(makeRepo(), prices, fake);
    const global = await svc.stats();
    const windowed = await svc.stats({
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-30T23:59:59.999Z",
    });
    expect(global.dualBasis!.currencyValue).toBe(2);
    expect(windowed.dualBasis!.currencyValue).toBe(4);
    expect(windowed.dualBasis!.currencyValue).not.toBe(
      global.dualBasis!.currencyValue,
    );
    expect(fake.selectTokenByProviderModel).toHaveBeenLastCalledWith(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-30T23:59:59.999Z"),
    );
  });

  it("⑭ 边界 ISO 口径 → 透传 Date 的 toISOString() 与 applyWindow 逐字一致（闭区间端点不漂移）", async () => {
    const fromISO = "2026-06-01T00:00:00.000Z";
    const toISO = "2026-06-30T23:59:59.999Z";
    const fake = makeWindowTokenSamples(() => [row("p1", "m1", 1_000_000, 0)]);
    const svc = svcOf(makeRepo(), makePrices([cfg("p1", "m1", "in", 2)]), fake);
    await svc.stats({ from: fromISO, to: toISO });
    const call = fake.selectTokenByProviderModel.mock.calls[0]!;
    expect(call[0]).toBeInstanceOf(Date);
    expect(call[1]).toBeInstanceOf(Date);
    expect(call[0]?.toISOString()).toBe(fromISO);
    expect(call[1]?.toISOString()).toBe(toISO);
  });

  it("⑮ 空窗（from>to / 无匹配行）→ 空数组 → NO_TOKEN_SAMPLE + null，不报错", async () => {
    const reversed = makeWindowTokenSamples((from, to) =>
      from && to && from.getTime() > to.getTime()
        ? []
        : [row("p1", "m1", 1_000_000, 0)],
    );
    const prices = () => makePrices([cfg("p1", "m1", "in", 2)]);
    const svc = svcOf(makeRepo(), prices(), reversed);
    const { dualBasis } = await svc.stats({
      from: "2026-06-30T00:00:00.000Z",
      to: "2026-06-01T00:00:00.000Z",
    });
    expect(dualBasis!.priceReason).toBe("NO_TOKEN_SAMPLE");
    expect(dualBasis!.currencyValue).toBeNull();

    // 单边窗口无匹配行同样标缺（不误当成全局样本）。
    const noMatch = svcOf(
      makeRepo(),
      prices(),
      makeWindowTokenSamples(() => []),
    );
    const single = await noMatch.stats({ from: "2026-06-01T00:00:00.000Z" });
    expect(single.dualBasis!.priceReason).toBe("NO_TOKEN_SAMPLE");
    expect(single.dualBasis!.currencyValue).toBeNull();
  });

  it("⑯ 单边窗口 → 仅存在的端点透传，另一端 undefined", async () => {
    const fake = makeWindowTokenSamples(() => []);
    const svc = svcOf(makeRepo(), makePrices([cfg("p1", "m1", "in", 2)]), fake);
    const fromISO = "2026-06-01T00:00:00.000Z";
    await svc.stats({ from: fromISO });
    expect(fake.selectTokenByProviderModel).toHaveBeenLastCalledWith(
      new Date(fromISO),
      undefined,
    );
    const toISO = "2026-06-30T00:00:00.000Z";
    await svc.stats({ to: toISO });
    expect(fake.selectTokenByProviderModel).toHaveBeenLastCalledWith(
      undefined,
      new Date(toISO),
    );
  });
});
