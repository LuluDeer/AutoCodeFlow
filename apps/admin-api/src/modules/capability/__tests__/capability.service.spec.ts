/**
 * ADR-040 / P1：CapabilityService 单测（内存替身 repo）。
 *
 * 本机 Nest ESM/CJS 混装，直接在 spec 里 import 真框架边界会在 module load 期炸；
 * 故用 jest.mock 把装饰器 / AppError / DTO 常量 / entity 这些「框架边界」替换成最小
 * 实现，只让 capability.service.ts 的**校验与 CRUD 逻辑**真实执行。
 * 验收级别：单测 / 内存替身（不代表真实 PG 持久化与 Nest DI 集成）。
 */
jest.mock("@nestjs/common", () => {
  class HttpException extends Error {}
  class NotFoundException extends HttpException {}
  const noop =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return {
    Injectable: noop,
    Optional: noop,
    NotFoundException,
    HttpException,
    Logger: class {
      log(): void {}
      warn(): void {}
      error(): void {}
    },
  };
});

jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
}));

jest.mock("typeorm", () => {
  const deco =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return {
    Column: deco,
    CreateDateColumn: deco,
    Entity: deco,
    Index: deco,
    PrimaryGeneratedColumn: deco,
    UpdateDateColumn: deco,
  };
});

jest.mock("../../../common/errors/app-error", () => ({
  AppError: class AppError extends Error {
    errorCode: string;
    params: unknown;
    constructor(code: string, params?: unknown) {
      super(code);
      this.errorCode = code;
      this.params = params;
    }
  },
}));

jest.mock("../../audit/audit.service", () => ({
  AuditService: class AuditService {},
}));

jest.mock("../../users/entities/user.entity", () => ({
  UserRole: { ADMIN: "admin" },
}));

jest.mock("../dto/create-capability.dto", () => ({
  CAPABILITY_KINDS: ["skill", "mcp", "agent", "provider", "template"],
  CAPABILITY_VISIBILITIES: ["global", "project", "private"],
}));

import {
  DOMAIN_EVENTS,
  EVENT_SCHEMA_VERSION,
} from "../../../common/events/domain-events";
import {
  assertAttestationShape,
  CapabilityService,
} from "../capability.service";

interface Row {
  id: string;
  key: string;
  kind: string;
  label: string;
  visibility: string;
  scope: { mode: string; guidance: string };
  source: { type: string };
  manifest: Record<string, unknown>;
  [k: string]: unknown;
}

interface FakeRepo {
  rows: Row[];
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
  createQueryBuilder: jest.Mock;
  /** 最近一次条件写的 SET 列（断言 PATCH 只写显式字段）。 */
  lastSet: Record<string, unknown> | null;
  /** 在 execute 判定行谓词之前触发，用来模拟「读后写前」的并发窗口。 */
  beforeExecute: (() => void) | null;
}

function makeRepo(seed: Row[] = []): FakeRepo {
  const rows: Row[] = [...seed];
  const repo: FakeRepo = {
    rows,
    find: jest.fn(async () => [...rows]),
    findOne: jest.fn(
      async ({ where }: { where: { id?: string; key?: string } }) =>
        rows.find((r) =>
          where.id !== undefined ? r.id === where.id : r.key === where.key,
        ) ?? null,
    ),
    create: jest.fn((d: Partial<Row>) => ({ id: "cap-1", ...d }) as Row),
    save: jest.fn(async (e: Row) => {
      const i = rows.findIndex((x) => x.id === e.id);
      if (i >= 0) rows[i] = e;
      else rows.push(e);
      return e;
    }),
    remove: jest.fn(async (e: Row) => {
      const i = rows.findIndex((x) => x.id === e.id);
      if (i >= 0) rows.splice(i, 1);
      return e;
    }),
    createQueryBuilder: jest.fn(),
    lastSet: null,
    beforeExecute: null,
  };

  // ADR-026 条件写替身：理解 .update().set().where().andWhere().execute()，
  // 并把 updatedAt 毫秒桶当作真实行谓词判定 affected。
  repo.createQueryBuilder.mockImplementation(() => {
    const params: Record<string, unknown> = {};
    let set: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      update: jest.fn(() => builder),
      set: jest.fn((s: Record<string, unknown>) => {
        set = s;
        repo.lastSet = s;
        return builder;
      }),
      where: jest.fn((_sql: string, p?: Record<string, unknown>) => {
        Object.assign(params, p ?? {});
        return builder;
      }),
      andWhere: jest.fn((_sql: string, p?: Record<string, unknown>) => {
        Object.assign(params, p ?? {});
        return builder;
      }),
      execute: jest.fn(async () => {
        repo.beforeExecute?.();
        const row = rows.find((r) => r.id === params.id);
        if (!row) return { affected: 0 };
        const from = params.tsFrom as Date | undefined;
        const to = params.tsTo as Date | undefined;
        if (from && to) {
          const cur = new Date(row.updatedAt as Date).getTime();
          if (!(cur >= from.getTime() && cur < to.getTime())) {
            return { affected: 0 };
          }
        }
        for (const [k, v] of Object.entries(set)) {
          // CURRENT_TIMESTAMP 的函数占位：把版本推进到期望桶的末端。
          row[k] =
            typeof v === "function" ? new Date(to?.getTime() ?? Date.now()) : v;
        }
        return { affected: 1 };
      }),
    };
    return builder;
  });
  return repo;
}

const dto = (over: Partial<Record<string, unknown>> = {}) => ({
  key: "browser",
  kind: "skill",
  label: "Browser",
  visibility: "private",
  manifest: { name: "browser" },
  ...over,
});

const svcOf = (repo: ReturnType<typeof makeRepo>) =>
  new CapabilityService(repo as never, null);

/** 带 @UpdateDateColumn 的完整行，供条件写测试做前置版本快照。 */
const seedRow = (over: Partial<Row> = {}): Row => ({
  id: "cap-1",
  key: "browser",
  kind: "skill",
  label: "Browser",
  description: null,
  version: "1.0.0",
  source: { type: "builtin" },
  visibility: "private",
  scope: { mode: "supervised", guidance: "L2" },
  manifest: { name: "browser", version: "1.0.0" },
  enabled: true,
  createdBy: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  ...over,
});

describe("CapabilityService (ADR-040 / P1)", () => {
  it("合法 create：落库并返回带默认值的 capability", async () => {
    const repo = makeRepo();
    const svc = svcOf(repo);
    const created = await svc.create(dto() as never);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(created).toMatchObject({
      key: "browser",
      kind: "skill",
      version: "1.0.0",
      visibility: "private",
      source: { type: "builtin" },
      scope: { mode: "supervised", guidance: "L2" },
      enabled: true,
    });
  });

  it("非法 key（大写/空格）拒绝 VALIDATION_FAILED", async () => {
    const svc = svcOf(makeRepo());
    await expect(
      svc.create(dto({ key: "Bad Key!" }) as never),
    ).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
    });
  });

  it("非法 kind 拒绝 VALIDATION_FAILED", async () => {
    const svc = svcOf(makeRepo());
    await expect(
      svc.create(dto({ kind: "worm" }) as never),
    ).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
    });
  });

  it("scope.mode=managed + guidance=L3 拒绝", async () => {
    const svc = svcOf(makeRepo());
    await expect(
      svc.create(dto({ scope: { mode: "managed", guidance: "L3" } }) as never),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  });

  it("manifest 含 command 字段拒绝", async () => {
    const svc = svcOf(makeRepo());
    await expect(
      svc.create(
        dto({ manifest: { name: "x", command: "rm -rf /" } }) as never,
      ),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  });

  it("findAll 返回内存表中的全部行", async () => {
    const seed: Row[] = [
      {
        id: "c1",
        key: "browser",
        kind: "skill",
        label: "B",
        visibility: "private",
        scope: { mode: "supervised", guidance: "L2" },
        source: { type: "builtin" },
        manifest: { name: "browser" },
      },
    ];
    const repo = makeRepo(seed);
    const svc = svcOf(repo);
    await expect(svc.findAll()).resolves.toEqual(seed);
    expect(repo.find).toHaveBeenCalledWith({ order: { createdAt: "DESC" } });
  });

  it("remove 删除指定行，后续 findOne 404", async () => {
    const repo = makeRepo();
    const svc = svcOf(repo);
    const created = await svc.create(dto() as never);
    await svc.remove(created.id);
    expect(repo.remove).toHaveBeenCalledTimes(1);
    expect(repo.rows).toHaveLength(0);
    await expect(svc.findOne(created.id)).rejects.toBeDefined();
  });
});

/**
 * ADR-026 规则 6：条件写必须有「并发后到者不覆盖」用例 + 反证。
 * 反证：把 updatedAt 谓词去掉（或让写不带版本条件），第二条用例就会转红。
 */
describe("CapabilityService.update (ADR-026 条件写)", () => {
  it("① 只写 DTO 显式字段，其它列不变，且不再整行 save", async () => {
    const original = seedRow();
    const repo = makeRepo([original]);
    const svc = svcOf(repo);

    const out = await svc.update("cap-1", { visibility: "global" } as never);

    expect(repo.save).not.toHaveBeenCalled();
    expect(Object.keys(repo.lastSet ?? {}).sort()).toEqual([
      "updatedAt",
      "visibility",
    ]);
    // 未提供的字段保持原值（scope/manifest/policy 不被旧快照覆盖）
    expect(repo.rows[0]).toMatchObject({
      key: original.key,
      kind: original.kind,
      label: original.label,
      scope: original.scope,
      manifest: original.manifest,
      source: original.source,
      enabled: original.enabled,
    });
    expect(repo.rows[0].visibility).toBe("global");
    expect(out).toMatchObject({ id: "cap-1", visibility: "global" });
  });

  it("② 前置版本被并发推进 → 409 冲突，且不覆盖并发写", async () => {
    const repo = makeRepo([seedRow()]);
    // 模拟读快照之后、execute 之前的并发窗口：别人改了 scope/manifest 并推进版本
    repo.beforeExecute = () => {
      const row = repo.rows[0];
      row.scope = { mode: "managed", guidance: "L1" };
      row.manifest = { name: "browser-by-other" };
      row.updatedAt = new Date(
        new Date(row.updatedAt as Date).getTime() + 5_000,
      );
    };
    const svc = svcOf(repo);

    await expect(
      svc.update("cap-1", { visibility: "global" } as never),
    ).rejects.toMatchObject({ errorCode: "RESOURCE_EXISTS" });

    // 并发赢家的值原样保留，本次的 visibility 未落库
    expect(repo.rows[0].scope).toEqual({ mode: "managed", guidance: "L1" });
    expect(repo.rows[0].manifest).toEqual({ name: "browser-by-other" });
    expect(repo.rows[0].visibility).toBe("private");
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("③ affected=0（行已被并发删除）→ 抛错而非静默成功", async () => {
    const repo = makeRepo([seedRow()]);
    repo.beforeExecute = () => {
      repo.rows.length = 0;
    };
    const svc = svcOf(repo);

    await expect(
      svc.update("cap-1", { visibility: "global" } as never),
    ).rejects.toMatchObject({ errorCode: "CAPABILITY_NOT_FOUND" });
    expect(repo.save).not.toHaveBeenCalled();
  });
});

/**
 * N14：能力写操作 → capability.changed emit（DB 写成功之后）。
 * 只验事件契约与 fail-open，不依赖 Nest DI / 真总线（总线侧在
 * policy-generation.service.spec.ts 用真 DomainEventBus 覆盖）。
 */
describe("CapabilityService — capability.changed emit (N14)", () => {
  const fakeBus = (emitImpl?: jest.Mock) => ({
    emit: emitImpl ?? jest.fn(() => true),
  });
  const svcWithBus = (
    repo: ReturnType<typeof makeRepo>,
    bus: { emit: jest.Mock },
  ) => new CapabilityService(repo as never, null, bus as never);

  it("create 落库后 emit：key / operation / schemaVersion / occurredAt 齐全", async () => {
    const repo = makeRepo();
    const bus = fakeBus();
    await svcWithBus(repo, bus).create(dto() as never);

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledWith(
      DOMAIN_EVENTS.CAPABILITY_CHANGED,
      expect.objectContaining({
        key: "browser",
        operation: "create",
        schemaVersion: EVENT_SCHEMA_VERSION,
      }),
    );
    const payload = bus.emit.mock.calls[0][1] as { occurredAt: string };
    expect(payload.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("update（含 enable-disable 的 enabled 列）落库后 emit", async () => {
    const bus = fakeBus();
    await svcWithBus(makeRepo([seedRow()]), bus).update("cap-1", {
      enabled: false,
    } as never);

    expect(bus.emit).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledWith(
      DOMAIN_EVENTS.CAPABILITY_CHANGED,
      expect.objectContaining({ key: "browser", operation: "update" }),
    );
  });

  it("remove 落库后 emit（operation=remove）", async () => {
    const repo = makeRepo([seedRow()]);
    const bus = fakeBus();
    await svcWithBus(repo, bus).remove("cap-1");

    expect(repo.remove).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledWith(
      DOMAIN_EVENTS.CAPABILITY_CHANGED,
      expect.objectContaining({ key: "browser", operation: "remove" }),
    );
  });

  it("并发写失败（409）不 emit——事件只在 DB 写成功后发", async () => {
    const repo = makeRepo([seedRow()]);
    repo.beforeExecute = () => {
      const row = repo.rows[0];
      row.updatedAt = new Date(
        new Date(row.updatedAt as Date).getTime() + 5_000,
      );
    };
    const bus = fakeBus();
    await expect(
      svcWithBus(repo, bus).update("cap-1", { visibility: "global" } as never),
    ).rejects.toMatchObject({ errorCode: "RESOURCE_EXISTS" });
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it("bus 缺席不崩；emit 抛错也不阻断已提交的主链（fail-open）", async () => {
    await expect(
      svcOf(makeRepo()).create(dto() as never),
    ).resolves.toMatchObject({ key: "browser" });

    const throwing = fakeBus(
      jest.fn(() => {
        throw new Error("bus down");
      }),
    );
    const created = await svcWithBus(makeRepo(), throwing).create(
      dto() as never,
    );
    expect(created.key).toBe("browser");
    expect(throwing.emit).toHaveBeenCalledTimes(1);
  });
});

/** N16 发布背书：纯校验 + create/update 落库透传（内存替身级别）。 */
describe("CapabilityService — attestation / owner / backer / versionPin (N16)", () => {
  it("assertAttestationShape：封闭键且 signer 非空即合法", () => {
    expect(() =>
      assertAttestationShape({ signer: "user:42|alice" }),
    ).not.toThrow();
    expect(() =>
      assertAttestationShape({
        signer: "user:42|alice",
        at: "2026-11-26T00:00:00Z",
        scope: "global",
      }),
    ).not.toThrow();
  });

  it("assertAttestationShape：未知键 / 空 signer / 非对象拒绝", () => {
    const bad = [
      { signer: "x", extra: 1 },
      { signer: "   " },
      { at: "2026-11-26T00:00:00Z" },
      "not-an-object",
      [],
    ];
    for (const raw of bad) {
      expect(() => assertAttestationShape(raw)).toThrow(
        expect.objectContaining({ errorCode: "VALIDATION_FAILED" }),
      );
    }
  });

  it("create 缺省：四个新列显式落 NULL（不臆造背书）", async () => {
    const repo = makeRepo();
    const created = await svcOf(repo).create(dto() as never);
    expect(created).toMatchObject({
      owner: null,
      backer: null,
      versionPin: null,
      attestation: null,
    });
  });

  it("create 合法值原样透传落库", async () => {
    const repo = makeRepo();
    const attestation = {
      signer: "user:42|alice",
      at: "2026-11-26T00:00:00Z",
      scope: "global",
    };
    const created = await svcOf(repo).create(
      dto({
        owner: "user:42|alice",
        backer: "role:platform-eng",
        versionPin: "1.2.3-rc.1+build.7",
        attestation,
      }) as never,
    );
    expect(created).toMatchObject({
      owner: "user:42|alice",
      backer: "role:platform-eng",
      versionPin: "1.2.3-rc.1+build.7",
      attestation,
    });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "user:42|alice",
        backer: "role:platform-eng",
        versionPin: "1.2.3-rc.1+build.7",
        attestation,
      }),
    );
  });

  it("create 非法 owner/backer/versionPin/attestation 拒绝且不落库", async () => {
    const svc = svcOf(makeRepo());
    const invalidDtos = [
      dto({ owner: "x".repeat(129) }),
      dto({ backer: "x".repeat(129) }),
      dto({ versionPin: "latest" }),
      dto({ versionPin: "v1.2.3" }),
      dto({ attestation: { signer: "x", injected: true } }),
      dto({ attestation: { signer: "" } }),
    ];
    for (const bad of invalidDtos) {
      await expect(svc.create(bad as never)).rejects.toMatchObject({
        errorCode: "VALIDATION_FAILED",
      });
    }
  });

  it("update 四个新列按显式字段写库并返回库内值", async () => {
    const repo = makeRepo([seedRow()]);
    const hash = "a".repeat(64);
    const attestation = { signer: "user:7|bob", scope: "project" };
    const out = await svcOf(repo).update("cap-1", {
      owner: "user:7|bob",
      backer: "role:security",
      versionPin: hash,
      attestation,
    } as never);

    expect(repo.lastSet).toEqual(
      expect.objectContaining({
        owner: "user:7|bob",
        backer: "role:security",
        versionPin: hash,
        attestation,
      }),
    );
    expect(repo.rows[0]).toMatchObject({
      owner: "user:7|bob",
      backer: "role:security",
      versionPin: hash,
      attestation,
    });
    expect(out).toMatchObject({ id: "cap-1", owner: "user:7|bob" });
  });

  it("update 合并后校验：非法背书拒绝，且不产生条件写", async () => {
    const repo = makeRepo([seedRow()]);
    await expect(
      svcOf(repo).update("cap-1", {
        attestation: { signer: "x", extra: 1 },
      } as never),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
    expect(repo.lastSet).toBeNull();
  });

  it("update 显式 null 清空背书字段（列可空）", async () => {
    const repo = makeRepo([
      seedRow({
        owner: "user:42|alice",
        backer: "role:platform-eng",
        versionPin: "1.2.3",
        attestation: { signer: "user:42|alice" },
      }),
    ]);
    const out = await svcOf(repo).update("cap-1", {
      owner: null,
      backer: null,
      versionPin: null,
      attestation: null,
    } as never);
    expect(out).toMatchObject({
      owner: null,
      backer: null,
      versionPin: null,
      attestation: null,
    });
  });
});
