/**
 * N5：业务结果归因埋点单测（内存 repo 替身，与 capability-activation.service.spec.ts
 * 同款 mock 边界）。覆盖：合法写入、缺省 NULL/false、outcome 过滤、DTO 校验。
 *
 * 验收级别：单测 / 内存替身——证明 service 字段映射与过滤分支成立；不代表
 * 真实 PG numeric/boolean 持久化。
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
    Controller: deco,
    Get: deco,
    Post: deco,
    Put: deco,
    Body: deco,
    Query: deco,
    HttpCode: deco,
    SetMetadata: () => () => undefined,
  };
});
jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
}));
jest.mock("../quota.service", () => ({
  QuotaService: class {},
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
  ErrorCode: { RATE_LIMITED: "RATE_LIMITED" },
}));
jest.mock("@nestjs/swagger", () => {
  const deco =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return {
    ApiProperty: deco,
    ApiPropertyOptional: deco,
    ApiBearerAuth: deco,
    ApiOkResponse: deco,
    ApiOperation: deco,
    ApiTags: deco,
  };
});

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CapabilityActivationService } from "../capability-activation.service";
import { ActivationQueryDto } from "../dto/activation-query.dto";
import { CreateActivationDto } from "../dto/create-activation.dto";
import { CapabilityActivationLog } from "../entities/activation-log.entity";

type Row = CapabilityActivationLog & Record<string, unknown>;

function makeRepo() {
  const rows: Row[] = [];
  const createCalls: Record<string, unknown>[] = [];
  return {
    rows,
    createCalls,
    create(dto: Record<string, unknown>): Row {
      const copy = { ...dto } as Row;
      createCalls.push(copy);
      return copy;
    },
    async save(row: Row): Promise<Row> {
      const saved = {
        id: `uuid-${rows.length + 1}`,
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        ...row,
      } as Row;
      rows.push(saved);
      return saved;
    },
    async findAndCount(opts: {
      where: Record<string, unknown>;
      skip: number;
      take: number;
    }): Promise<[Row[], number]> {
      const filtered = rows.filter((row) =>
        Object.entries(opts.where ?? {}).every(
          ([key, cond]) => row[key] === cond,
        ),
      );
      return [
        filtered.slice(opts.skip, opts.skip + opts.take),
        filtered.length,
      ];
    },
  };
}

function svcOf(repo: ReturnType<typeof makeRepo>): CapabilityActivationService {
  return new CapabilityActivationService(repo as never, undefined as never);
}

describe("N5 · record 业务结果归因字段落库", () => {
  it("合法写入：三字段由 DTO 校验通过并原样落到 create/save", async () => {
    const dto = plainToInstance(CreateActivationDto, {
      capabilityKey: "finance-export",
      baselineMetric: "monthly_revenue",
      improvement: 12.34,
      confirmed: true,
    } as object);
    expect(await validate(dto)).toHaveLength(0);

    const repo = makeRepo();
    const saved = await svcOf(repo).record(dto);
    expect(repo.createCalls[0]).toMatchObject({
      baselineMetric: "monthly_revenue",
      improvement: 12.34,
      confirmed: true,
    });
    expect(saved.baselineMetric).toBe("monthly_revenue");
    expect(saved.improvement).toBe(12.34);
    expect(saved.confirmed).toBe(true);
  });

  it("缺省写入：baselineMetric/improvement 落 NULL，confirmed 落 false", async () => {
    const repo = makeRepo();
    const saved = await svcOf(repo).record({
      capabilityKey: "finance-export",
    });
    expect(saved.baselineMetric).toBeNull();
    expect(saved.improvement).toBeNull();
    expect(saved.confirmed).toBe(false);
    expect(repo.createCalls[0]).toMatchObject({
      baselineMetric: null,
      improvement: null,
      confirmed: false,
    });
  });

  it("显式 null/0/false 不被默认覆盖", async () => {
    const repo = makeRepo();
    const saved = await svcOf(repo).record({
      capabilityKey: "finance-export",
      baselineMetric: "latency_p95",
      improvement: 0,
      confirmed: false,
    });
    expect(saved.improvement).toBe(0);
    expect(saved.confirmed).toBe(false);
  });
});

describe("N5 · outcome 过滤", () => {
  it("confirmed / unconfirmed 精确过滤，且与 result 正交", async () => {
    const repo = makeRepo();
    const service = svcOf(repo);
    await service.record({
      capabilityKey: "finance-export",
      baselineMetric: "monthly_revenue",
      improvement: 12.34,
      confirmed: true,
      result: "success",
    });
    await service.record({
      capabilityKey: "finance-export",
      result: "failure",
    });
    await service.record({
      capabilityKey: "file-import",
      confirmed: true,
    });

    expect((await service.query({ outcome: "confirmed" })).total).toBe(2);
    expect((await service.query({ outcome: "unconfirmed" })).total).toBe(1);
    expect(
      (
        await service.query({
          outcome: "unconfirmed",
          result: "failure",
        })
      ).list[0].capabilityKey,
    ).toBe("finance-export");
    expect(
      (await service.query({ outcome: "confirmed", result: "success" })).total,
    ).toBe(2);
    // 不给 outcome 时不过滤，行为与旧查询一致。
    expect((await service.query({})).total).toBe(3);
  });

  it("非法 outcome 被 DTO 拒绝", async () => {
    const dto = plainToInstance(ActivationQueryDto, {
      outcome: "maybe",
    } as object);
    expect(
      (await validate(dto)).find((e) => e.property === "outcome"),
    ).toBeDefined();
    const ok = plainToInstance(ActivationQueryDto, {
      outcome: "confirmed",
    } as object);
    expect(await validate(ok)).toHaveLength(0);
  });
});

describe("N5 · 新字段 DTO 边界校验", () => {
  it("超长 baselineMetric / 超 2 位小数 / 非布尔 confirmed 均失败", async () => {
    const tooLong = plainToInstance(CreateActivationDto, {
      capabilityKey: "ok-key",
      baselineMetric: "x".repeat(65),
    } as object);
    expect(
      (await validate(tooLong)).find((e) => e.property === "baselineMetric"),
    ).toBeDefined();

    const tooPrecise = plainToInstance(CreateActivationDto, {
      capabilityKey: "ok-key",
      improvement: 1.234,
    } as object);
    expect(
      (await validate(tooPrecise)).find((e) => e.property === "improvement"),
    ).toBeDefined();

    const badBool = plainToInstance(CreateActivationDto, {
      capabilityKey: "ok-key",
      confirmed: "yes",
    } as object);
    expect(
      (await validate(badBool)).find((e) => e.property === "confirmed"),
    ).toBeDefined();
  });
});
