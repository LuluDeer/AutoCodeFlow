import { Logger } from "@nestjs/common";
import type { SystemConfigService } from "../../config/config.service";
import {
  PRICE_KEY_PREFIX,
  type PricingConfig,
  type SetPriceDto,
} from "../price.dto";
import {
  AMOUNT_NOTE,
  assertAmountProjectionInvariant,
  convertToAmount,
  PriceService,
  priceKey,
  toPriceMap,
} from "../price.service";

const inPrice: PricingConfig = {
  provider: "acme",
  model: "m1",
  direction: "in",
  pricePerMillionTokens: 2,
  currency: "CNY",
};
const outPrice: PricingConfig = {
  provider: "acme",
  model: "m1",
  direction: "out",
  pricePerMillionTokens: 3,
  currency: "CNY",
};
const prices = toPriceMap([inPrice, outPrice]);

const baseDto = (over: Partial<SetPriceDto> = {}): SetPriceDto => ({
  provider: "acme",
  model: "m1",
  direction: "in",
  pricePerMillionTokens: 2,
  currency: "CNY",
  ...over,
});

type Row = { key: string; value: string | null; valueType?: string };

function configStub(rows: Row[] = []) {
  const store = new Map(rows.map((row) => [row.key, row]));
  const upsert = jest.fn(async (dto: Row) => {
    const row: Row = {
      key: dto.key,
      value: dto.value,
      valueType: dto.valueType,
    };
    store.set(dto.key, row);
    return row;
  });
  const findOne = jest.fn(async (key: string) => {
    const row = store.get(key);
    if (!row) throw new Error(`no config: ${key}`);
    return row;
  });
  const getByPrefix = jest.fn(async (prefix: string) =>
    [...store.values()]
      .filter((row) => row.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
  const remove = jest.fn(async (key: string) => ({
    deleted: store.delete(key),
  }));
  return { upsert, findOne, getByPrefix, remove, store };
}

function makeService(config: ReturnType<typeof configStub>): PriceService {
  return new PriceService(config as unknown as SystemConfigService);
}

describe("N20 · convertToAmount 金额折算纯函数", () => {
  it("(1) tokens 全为 0 / null / 非正数 → NO_TOKEN_SAMPLE 且 amount=null（绝不 0 元）", () => {
    const cases: [number | null, number | null, number, number][] = [
      [0, 0, 0, 0],
      [null, null, 0, 0],
      [null, 0, 0, 0],
      [-5, 0, 0, 0],
    ];
    for (const [tokensIn, tokensOut, wantIn, wantOut] of cases) {
      expect(
        convertToAmount(tokensIn, tokensOut, prices, "acme", "m1"),
      ).toEqual({
        amount: null,
        currency: null,
        reason: "NO_TOKEN_SAMPLE",
        basis: "per-million-tokens",
        tokensIn: wantIn,
        tokensOut: wantOut,
        note: AMOUNT_NOTE,
      });
    }
  });

  it("(2) 有 token 但缺对应方向价目 → PRICE_MISSING 且 amount=null", () => {
    const onlyIn = toPriceMap([inPrice]);
    // 只有 in 价目，out 方向有 token → 缺对应价目。
    expect(convertToAmount(0, 1, onlyIn, "acme", "m1")).toMatchObject({
      reason: "PRICE_MISSING",
      amount: null,
      currency: null,
    });
    expect(convertToAmount(1_000_000, 0, onlyIn, "acme", "m1")).toMatchObject({
      reason: "OK",
      amount: 2,
    });
    expect(convertToAmount(1_000_000, 1, {}, "acme", "m1")).toMatchObject({
      reason: "PRICE_MISSING",
      amount: null,
    });
    // 省略 provider/model 时，价目表有多组 provider/model 属不可判定 → 标缺。
    const twoModels = toPriceMap([
      inPrice,
      outPrice,
      { ...inPrice, model: "m2" },
      { ...outPrice, model: "m2" },
    ]);
    expect(convertToAmount(1_000_000, 0, twoModels)).toMatchObject({
      reason: "PRICE_MISSING",
      amount: null,
    });
  });

  it("(3) 齐备 → 精确按公式折算，保留 6 位小数，currency 取价目值", () => {
    const result = convertToAmount(1_000_000, 500_000, prices, "acme", "m1");
    expect(result).toEqual({
      amount: 3.5, // 1e6×2/1e6 + 5e5×3/1e6
      currency: "CNY",
      reason: "OK",
      basis: "per-million-tokens",
      tokensIn: 1_000_000,
      tokensOut: 500_000,
      note: AMOUNT_NOTE,
    });

    const tiny = toPriceMap([{ ...inPrice, pricePerMillionTokens: 1 }]);
    expect(convertToAmount(1, 0, tiny, "acme", "m1").amount).toBe(0.000001);
    expect(convertToAmount(1_000_000, 0, tiny, "acme", "m1").amount).toBe(1);
    // 省略 provider/model：价目表恰好一组时按 key 推断。
    expect(convertToAmount(1_000_000, 0, prices).amount).toBe(2);
  });

  it("(4) 非法 token / 非法 price → INVALID_* 且 amount=null", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(convertToAmount(bad, 0, prices, "acme", "m1")).toMatchObject({
        reason: "INVALID_TOKEN_COUNT",
        amount: null,
      });
    }
    for (const badPrice of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const broken = toPriceMap([
        { ...inPrice, pricePerMillionTokens: badPrice },
      ]);
      expect(convertToAmount(1_000_000, 0, broken, "acme", "m1")).toMatchObject(
        { reason: "INVALID_PRICE", amount: null },
      );
    }
    const badCurrency = toPriceMap([{ ...inPrice, currency: "CN" }]);
    expect(
      convertToAmount(1_000_000, 0, badCurrency, "acme", "m1"),
    ).toMatchObject({ reason: "INVALID_PRICE", amount: null });

    const mixed = toPriceMap([inPrice, { ...outPrice, currency: "USD" }]);
    expect(convertToAmount(1_000_000, 1, mixed, "acme", "m1")).toMatchObject({
      reason: "INVALID_PRICE",
      amount: null,
    });
  });

  it("(5) 不变量成立；人为破坏的投影必须抛错", () => {
    const projections = [
      convertToAmount(0, 0, prices, "acme", "m1"),
      convertToAmount(1, 0, {}, "acme", "m1"),
      convertToAmount(1_000_000, 0, prices, "acme", "m1"),
    ];
    for (const projection of projections) {
      assertAmountProjectionInvariant(projection);
      if (projection.amount === null) {
        expect(projection.reason).not.toBe("OK");
      } else {
        expect(projection.reason).toBe("OK");
      }
    }
    expect(() =>
      assertAmountProjectionInvariant({
        ...projections[2],
        amount: null,
        reason: "OK",
      }),
    ).toThrow(/不变量/);
    expect(() =>
      assertAmountProjectionInvariant({
        ...projections[0],
        amount: 1,
        reason: "PRICE_MISSING",
      }),
    ).toThrow(/不变量/);
  });

  it("反证载体：NO_TOKEN_SAMPLE 若被写成 0 元，不变量立即转红", () => {
    const zeroSample = convertToAmount(0, 0, prices, "acme", "m1");
    expect(zeroSample.amount).toBeNull();
    expect(() =>
      assertAmountProjectionInvariant({ ...zeroSample, amount: 0 }),
    ).toThrow(/不变量/);
  });
});

describe("N20 · PriceService managed 价目表（零迁移）", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("set 后 system_configs 行带正确 key/valueType/value，并返回配置", async () => {
    const config = configStub();
    const svc = makeService(config);
    const saved = await svc.set(baseDto());

    expect(saved).toEqual({
      provider: "acme",
      model: "m1",
      direction: "in",
      pricePerMillionTokens: 2,
      currency: "CNY",
    });
    expect(config.upsert).toHaveBeenCalledTimes(1);
    expect(config.upsert).toHaveBeenCalledWith({
      key: "acf.showback.price.acme.m1.in",
      value: JSON.stringify(saved),
      description: "N20 showback price: acme/m1/in",
      valueType: "json",
    });
    expect(config.store.get(priceKey("acme", "m1", "in"))?.valueType).toBe(
      "json",
    );
  });

  it("坏价目拒绝落库（VALIDATION_FAILED，零 upsert）", async () => {
    const config = configStub();
    const svc = makeService(config);
    await expect(
      svc.set(baseDto({ pricePerMillionTokens: 0 })),
    ).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
    });
    await expect(svc.set(baseDto({ currency: "CN" }))).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
    });
    expect(config.upsert).not.toHaveBeenCalled();
  });

  it("get / getByPrefix / remove 走同一前缀键，坏 JSON 读出跳过并 warn", async () => {
    const config = configStub([
      {
        key: priceKey("acme", "m1", "in"),
        value: JSON.stringify(inPrice),
        valueType: "json",
      },
      {
        key: priceKey("acme", "m1", "out"),
        value: "{坏 JSON",
        valueType: "json",
      },
      {
        key: `${PRICE_KEY_PREFIX}acme.m1.bad`,
        value: JSON.stringify({ ...outPrice, currency: "CN" }),
        valueType: "json",
      },
    ]);
    const svc = makeService(config);

    expect(await svc.get("acme", "m1", "in")).toEqual(inPrice);
    expect(await svc.get("acme", "m1", "out")).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(await svc.getByPrefix()).toEqual([inPrice]);
    expect(await svc.remove("acme", "m1", "in")).toEqual({ deleted: true });
    expect(config.remove).toHaveBeenCalledWith(priceKey("acme", "m1", "in"));
  });
});
