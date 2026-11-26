/**
 * N15：运行时能力审计服务单测（内存 repo 替身）。
 *
 * 验收级别：单测 / 内存替身——证明摘要确定性、明文不落库、过滤/聚合逻辑与
 * append-only 代码契约成立；不代表真实 PG 持久化与 Nest DI 集成。
 *
 * 与 im-identity.service.spec.ts 同款：jest.mock 掉 Nest/TypeORM 框架边界，
 * 让 service 的摘要、过滤、聚合与 DTO 校验真实执行。裸 jest（不带
 * --experimental-vm-modules）下 @nestjs/common 是 ESM，必须 mock。
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
// controller 的 emitDecoratorMetadata 会在运行时引用构造参数类型；
// QuotaService 会连带拉起 @nestjs/schedule 的 ESM，这里只留空壳供元数据使用。
jest.mock("../quota.service", () => ({
  QuotaService: class {},
}));
// 裸 jest 下 AppError 依赖的 Nest HttpException 是 ESM；用替身保留 errorCode /
// params.detail 供精确断言。
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
import { createHash } from "crypto";
import { validate } from "class-validator";
import { CapabilityActivationController } from "../capability-activation.controller";
import {
  CapabilityActivationService,
  parametersDigest,
  stableStringify,
} from "../capability-activation.service";
import { CreateActivationDto } from "../dto/create-activation.dto";
import { CapabilityActivationLog } from "../entities/activation-log.entity";
import type { QuotaHardLimitGate } from "../quota-limit.gate";

type Row = CapabilityActivationLog & Record<string, unknown>;

function isFindOperator(v: unknown): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    "type" in (v as object) &&
    "value" in (v as object)
  );
}
function ts(v: unknown): number {
  return v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
}

/** 只实现 service 用到的 repo 面：create/save/findAndCount/createQueryBuilder。 */
function makeRepo() {
  const rows: Row[] = [];
  const createCalls: unknown[] = [];

  const repo = {
    rows,
    createCalls,
    create(dto: Record<string, unknown>) {
      const copy = { ...dto } as Row;
      createCalls.push(copy);
      return copy;
    },
    async save(row: Row) {
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
      order: Record<string, string>;
      skip: number;
      take: number;
    }): Promise<[Row[], number]> {
      let filtered = rows.filter((row) =>
        Object.entries(opts.where ?? {}).every(([key, cond]) => {
          const actual = row[key];
          if (!isFindOperator(cond)) return actual === cond;
          const op = cond as { type: string; value: unknown };
          if (op.type === "between") {
            const [a, b] = op.value as [unknown, unknown];
            return ts(actual) >= ts(a) && ts(actual) <= ts(b);
          }
          if (op.type === "moreThanOrEqual") return ts(actual) >= ts(op.value);
          if (op.type === "lessThanOrEqual") return ts(actual) <= ts(op.value);
          return false;
        }),
      );
      filtered = [...filtered].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return [
        filtered.slice(opts.skip, opts.skip + opts.take),
        filtered.length,
      ];
    },
    createQueryBuilder() {
      let groupField = "";
      const selected: string[] = [];
      const qb: Record<string, unknown> = {
        select(field: string) {
          selected.push(field);
          return qb;
        },
        addSelect(field: string) {
          selected.push(field);
          return qb;
        },
        groupBy(field: string) {
          groupField = field;
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
          // N20 双口径取的是逐行最小投影（无 GROUP BY、含 log.result），
          // 与两条 GROUP BY 查询区分开，交给真实 meterActivations 计数。
          if (!groupField && selected.includes("log.result")) {
            return rows.map((r) => ({
              capabilityKey: r.capabilityKey,
              projectId: r.projectId ?? null,
              result: r.result,
            }));
          }
          if (groupField.includes("capabilityKey")) {
            const map = new Map<
              string,
              {
                count: number;
                success: number;
                failure: number;
                blocked: number;
              }
            >();
            for (const r of rows) {
              const e = map.get(r.capabilityKey) ?? {
                count: 0,
                success: 0,
                failure: 0,
                blocked: 0,
              };
              e.count += 1;
              e[r.result] += 1;
              map.set(r.capabilityKey, e);
            }
            return [...map].map(([capabilityKey, e]) => ({
              capabilityKey,
              count: String(e.count),
              success: String(e.success),
              failure: String(e.failure),
              blocked: String(e.blocked),
            }));
          }
          const map = new Map<string, number>();
          for (const r of rows) {
            const key = r.projectId ?? "__NULL__";
            map.set(key, (map.get(key) ?? 0) + 1);
          }
          return [...map].map(([projectId, count]) => ({
            projectId: projectId === "__NULL__" ? null : projectId,
            count: String(count),
          }));
        },
      };
      return qb;
    },
  };
  return repo;
}

function svcOf(
  repo: ReturnType<typeof makeRepo>,
  gate?: QuotaHardLimitGate,
): CapabilityActivationService {
  return new CapabilityActivationService(repo as never, gate as never);
}

describe("N15 · stableStringify / parametersDigest", () => {
  it("键序无关：内层乱序对象摘要一致", () => {
    expect(stableStringify({ a: 1, b: { x: 2, y: 3 } })).toBe(
      stableStringify({ b: { y: 3, x: 2 }, a: 1 }),
    );
    expect(stableStringify([{ z: 1, a: 2 }])).toBe(
      stableStringify([{ a: 2, z: 1 }]),
    );
  });

  it("摘要 = sha256(stableStringify(parameters))，且与 node:crypto 独立计算一致", () => {
    const params = { b: "2", a: { q: 1 } };
    const expected = createHash("sha256")
      .update(stableStringify(params))
      .digest("hex");
    expect(parametersDigest(params)).toBe(expected);
    expect(expected).toHaveLength(64);
  });

  it("深嵌套折叠，不抛 RangeError", () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 100; i++) deep = { nested: deep };
    expect(() => parametersDigest(deep)).not.toThrow();
  });
});

describe("N15 · record：明文不落库 + 字段映射", () => {
  it("落库行只有 parametersDigest，无 parameters 明文字段", async () => {
    const repo = makeRepo();
    const service = svcOf(repo);
    await service.record({
      capabilityKey: "finance-export",
      capabilityVersion: "2.3.1",
      sessionId: "sop-42",
      parameters: { token: "TOP_SECRET_TOKEN", amount: 999 },
      userId: 7,
      username: "alice",
      imPlatform: "wecom",
      imSenderId: "sender-1",
      projectId: "proj-a",
      result: "success",
    });
    expect(repo.rows).toHaveLength(1);
    const saved = repo.rows[0];
    expect(saved.parametersDigest).toBe(
      parametersDigest({ token: "TOP_SECRET_TOKEN", amount: 999 }),
    );
    expect(Object.keys(saved)).not.toContain("parameters");
    expect(Object.keys(repo.createCalls[0] as object)).not.toContain(
      "parameters",
    );
    expect(JSON.stringify(saved)).not.toContain("TOP_SECRET_TOKEN");
    expect(saved.capabilityVersion).toBe("2.3.1");
    expect(saved.sessionId).toBe("sop-42");
    expect(saved.imPlatform).toBe("wecom");
    expect(saved.imSenderId).toBe("sender-1");
    expect(saved.projectId).toBe("proj-a");
  });

  it("不同键序的同一参数 → 同一摘要；缺省字段落 null / result 默认 success", async () => {
    const repo = makeRepo();
    const service = svcOf(repo);
    await service.record({
      capabilityKey: "finance-export",
      parameters: { a: 1, b: 2 },
    });
    await service.record({
      capabilityKey: "finance-export",
      parameters: { b: 2, a: 1 },
    });
    expect(repo.rows[0].parametersDigest).toBe(repo.rows[1].parametersDigest);
    expect(repo.rows[0].userId).toBeNull();
    expect(repo.rows[0].imPlatform).toBeNull();
    expect(repo.rows[0].result).toBe("success");
  });
});

describe("N20 · record 硬阈闸（blocked 审计 + fail-open）", () => {
  const dto = {
    capabilityKey: "finance-export",
    projectId: "proj-a",
    parameters: { token: "SECRET" },
    userId: 7,
    username: "alice",
  };

  it("gate blocked → 落 blocked 行 + 抛 RATE_LIMITED，无 success 行", async () => {
    const repo = makeRepo();
    const gate = {
      evaluateHardLimit: jest.fn(async () => ({
        blocked: true,
        matched: {
          scope: "project" as const,
          target: "proj-a",
          usage: 20,
          hardLimit: 20,
          windowDays: 7,
        },
      })),
    };
    const service = svcOf(repo, gate);
    await expect(service.record(dto)).rejects.toMatchObject({
      errorCode: "RATE_LIMITED",
      params: {
        detail: expect.stringContaining("project/proj-a 用量 20 ≥ 硬阈值 20"),
      },
    });
    expect(gate.evaluateHardLimit).toHaveBeenCalledWith({
      capabilityKey: "finance-export",
      projectId: "proj-a",
    });
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].result).toBe("blocked");
    expect(repo.rows[0].userId).toBe(7);
    expect(repo.rows[0].username).toBe("alice");
    expect(repo.rows[0].projectId).toBe("proj-a");
    expect(repo.createCalls[0]).toMatchObject({ result: "blocked" });
    expect(JSON.stringify(repo.rows[0])).not.toContain("SECRET");
  });

  it("gate 放行 → 正常 save，结果仍按 dto / 默认 success", async () => {
    const repo = makeRepo();
    const gate = {
      evaluateHardLimit: jest.fn(async () => ({ blocked: false })),
    };
    const service = svcOf(repo, gate);
    const saved = await service.record(dto);
    expect(saved.result).toBe("success");
    expect(repo.rows).toHaveLength(1);
    expect(repo.createCalls[0]).toMatchObject({ result: "success" });
  });

  it("gate 缺席 → fail-open 放行", async () => {
    const repo = makeRepo();
    const saved = await svcOf(repo).record(dto);
    expect(saved.result).toBe("success");
    expect(repo.rows).toHaveLength(1);
  });

  it("gate 抛错 → fail-open 放行并记 warn", async () => {
    const repo = makeRepo();
    const { Logger } = jest.requireMock("@nestjs/common") as {
      Logger: { prototype: { warn: (...args: unknown[]) => void } };
    };
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    try {
      const gate = {
        evaluateHardLimit: jest.fn(async () => {
          throw new Error("quota down");
        }),
      };
      const saved = await svcOf(repo, gate).record(dto);
      expect(saved.result).toBe("success");
      expect(repo.rows).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("blocked 审计写失败 → 仍抛 RATE_LIMITED（审计 fail-open）", async () => {
    const repo = makeRepo();
    repo.save = async () => {
      throw new Error("db down");
    };
    const gate = {
      evaluateHardLimit: jest.fn(async () => ({
        blocked: true,
        matched: {
          scope: "capability" as const,
          target: "finance-export",
          usage: 5,
          hardLimit: 5,
          windowDays: 30,
        },
      })),
    };
    await expect(svcOf(repo, gate).record(dto)).rejects.toMatchObject({
      errorCode: "RATE_LIMITED",
    });
  });
});

describe("N15 · query 过滤器", () => {
  async function seed() {
    const repo = makeRepo();
    const service = svcOf(repo);
    const base = {
      capabilityKey: "finance-export",
      parameters: {},
      result: "success" as const,
    };
    await service.record({
      ...base,
      sessionId: "sop-1",
      userId: 7,
      username: "alice",
      projectId: "proj-a",
    });
    await service.record({
      ...base,
      capabilityKey: "file-import",
      sessionId: "sop-2",
      userId: 8,
      username: "bob",
      projectId: "proj-b",
      result: "blocked",
    });
    return { repo, service };
  }

  it("按 capabilityKey / sessionId / userId / projectId / username / result 精确过滤", async () => {
    const { service } = await seed();
    expect(
      (await service.query({ capabilityKey: "finance-export" })).total,
    ).toBe(1);
    expect((await service.query({ sessionId: "sop-2" })).total).toBe(1);
    expect((await service.query({ userId: 7 })).total).toBe(1);
    expect((await service.query({ projectId: "proj-b" })).total).toBe(1);
    expect((await service.query({ username: "alice" })).total).toBe(1);
    expect((await service.query({ result: "blocked" })).total).toBe(1);
    expect(
      (await service.query({ capabilityKey: "not-exist" })).list,
    ).toHaveLength(0);
  });

  it("from/to 闭区间 + 分页信封字段", async () => {
    const { repo, service } = await seed();
    repo.rows[0].createdAt = new Date("2026-11-10T00:00:00.000Z");
    repo.rows[1].createdAt = new Date("2026-11-20T00:00:00.000Z");
    expect(
      (await service.query({ from: "2026-11-15T00:00:00.000Z" })).list,
    ).toHaveLength(1);
    expect(
      (await service.query({ to: "2026-11-15T00:00:00.000Z" })).list,
    ).toHaveLength(1);
    expect(
      (
        await service.query({
          from: "2026-11-01T00:00:00.000Z",
          to: "2026-11-30T00:00:00.000Z",
        })
      ).total,
    ).toBe(2);
    const page = await service.query({ page: 2, pageSize: 1 });
    expect(page.list).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.totalPages).toBe(2);
  });
});

describe("N15 · stats 聚合", () => {
  it("按 capabilityKey 汇总 count + success/failure/blocked，按 project 汇总", async () => {
    const repo = makeRepo();
    const service = svcOf(repo);
    await service.record({
      capabilityKey: "finance-export",
      parameters: {},
      projectId: "p1",
      result: "success",
    });
    await service.record({
      capabilityKey: "finance-export",
      parameters: {},
      projectId: "p1",
      result: "failure",
    });
    await service.record({
      capabilityKey: "finance-export",
      parameters: {},
      result: "blocked",
    });
    await service.record({
      capabilityKey: "file-import",
      parameters: {},
      projectId: "p2",
      result: "success",
    });

    const stats = await service.stats();
    expect(stats.total).toBe(4);
    expect(
      stats.byCapability.find((e) => e.capabilityKey === "finance-export"),
    ).toEqual({
      capabilityKey: "finance-export",
      count: 3,
      success: 1,
      failure: 1,
      blocked: 1,
    });
    expect(
      stats.byCapability.find((e) => e.capabilityKey === "file-import")?.count,
    ).toBe(1);
    expect(stats.byProject.find((e) => e.projectId === "p1")?.count).toBe(2);
    expect(stats.byProject.find((e) => e.projectId === null)?.count).toBe(1);
  });
});

describe("N20 · stats 双口径接线", () => {
  it("混合 success/failure/blocked：三态字段逐字不变，成功交付只计 success", async () => {
    const repo = makeRepo();
    const service = svcOf(repo);
    await service.record({
      capabilityKey: "finance-export",
      parameters: {},
      projectId: "p1",
      result: "success",
    });
    await service.record({
      capabilityKey: "finance-export",
      parameters: {},
      projectId: "p1",
      result: "failure",
    });
    await service.record({
      capabilityKey: "finance-export",
      parameters: {},
      result: "blocked",
    });
    await service.record({
      capabilityKey: "file-import",
      parameters: {},
      projectId: "p2",
      result: "success",
    });

    const stats = await service.stats();

    // 既有三态契约（前端看板依赖）逐字不变。
    expect(stats.total).toBe(4);
    expect(
      stats.byCapability.find((e) => e.capabilityKey === "finance-export"),
    ).toEqual({
      capabilityKey: "finance-export",
      count: 3,
      success: 1,
      failure: 1,
      blocked: 1,
    });
    expect(
      stats.byCapability.find((e) => e.capabilityKey === "file-import"),
    ).toEqual({
      capabilityKey: "file-import",
      count: 1,
      success: 1,
      failure: 0,
      blocked: 0,
    });
    expect(stats.byProject.find((e) => e.projectId === "p1")).toEqual({
      projectId: "p1",
      count: 2,
    });
    expect(stats.byProject.find((e) => e.projectId === null)).toEqual({
      projectId: null,
      count: 1,
    });

    // 新字段：invocations 对账三态合计，successfulDeliveries 只取 success。
    expect(stats.dualBasis).toMatchObject({
      basis: "invocations+successfulDeliveries",
      invocations: 4,
      successfulDeliveries: 2,
      skipped: 0,
      note: "无 token 样本，不产出 token/货币值；仅调用次数与成功交付次数两个可复算口径",
      tokenSample: null,
      currencyValue: null,
    });
    expect(stats.dualBasis?.byCapability).toEqual([
      {
        capabilityKey: "finance-export",
        invocations: 3,
        successfulDeliveries: 1,
      },
      {
        capabilityKey: "file-import",
        invocations: 1,
        successfulDeliveries: 1,
      },
    ]);
    expect(stats.dualBasis?.byProject).toEqual([
      { projectId: "p1", invocations: 2, successfulDeliveries: 1 },
      { projectId: null, invocations: 1, successfulDeliveries: 0 },
      { projectId: "p2", invocations: 1, successfulDeliveries: 1 },
    ]);
    expect(stats.dualBasis?.allocationNote).toContain("attributeCost 未接线");
  });

  it("控制组：空数据下三态为空，双口径全 0 且 token/货币仍为 null", async () => {
    const stats = await svcOf(makeRepo()).stats();
    expect(stats.total).toBe(0);
    expect(stats.byCapability).toEqual([]);
    expect(stats.byProject).toEqual([]);
    expect(stats.dualBasis).toEqual({
      basis: "invocations+successfulDeliveries",
      invocations: 0,
      successfulDeliveries: 0,
      skipped: 0,
      byCapability: [],
      byProject: [],
      note: "无 token 样本，不产出 token/货币值；仅调用次数与成功交付次数两个可复算口径",
      tokenSample: null,
      currencyValue: null,
      priceReason: "NO_TOKEN_SAMPLE",
      allocationNote:
        "attributeCost 未接线：相对份额分摊需外部权重配置，当前无业务权重来源；本字段只提供可复算的双口径计数。",
    });
  });
});

describe("N15 · append-only 契约", () => {
  it("service 与 controller 均无 update/delete 方法", () => {
    const repo = makeRepo();
    const service = svcOf(repo) as unknown as Record<string, unknown>;
    expect(service.update).toBeUndefined();
    expect(service.delete).toBeUndefined();
    expect(service.remove).toBeUndefined();
    const controller =
      CapabilityActivationController.prototype as unknown as Record<
        string,
        unknown
      >;
    expect(controller.update).toBeUndefined();
    expect(controller.delete).toBeUndefined();
  });
});

describe("N15 · DTO 校验", () => {
  it("缺 capabilityKey → 校验失败", async () => {
    const dto = plainToInstance(CreateActivationDto, {
      parameters: { a: 1 },
      result: "success",
    } as object);
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === "capabilityKey")).toBeDefined();
  });

  it("合法完整入参 → 校验通过", async () => {
    const dto = plainToInstance(CreateActivationDto, {
      capabilityKey: "finance-export",
      capabilityVersion: "2.3.1",
      sessionId: "s1",
      parameters: { a: 1 },
      userId: 7,
      username: "alice",
      imPlatform: "wecom",
      imSenderId: "s-1",
      projectId: "p1",
      result: "success",
    } as object);
    expect(await validate(dto)).toHaveLength(0);
  });

  it("非法 result / 非法 capabilityKey → 校验失败", async () => {
    const badResult = plainToInstance(CreateActivationDto, {
      capabilityKey: "ok-key",
      result: "unknown",
    } as object);
    expect(
      (await validate(badResult)).find((e) => e.property === "result"),
    ).toBeDefined();
    const badKey = plainToInstance(CreateActivationDto, {
      capabilityKey: "Bad Key!",
    } as object);
    expect(
      (await validate(badKey)).find((e) => e.property === "capabilityKey"),
    ).toBeDefined();
  });
});
