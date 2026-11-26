/**
 * ADR-040 / P1：resolve / dump 查询面单测（内存替身 repo）。
 *
 * 沿用 capability.service.spec.ts 的 jest.mock 框架边界风格：只替换 Nest/TypeORM/
 * AppError/DTO 常量，让 service 的校验 + scope 引擎（纯函数）真实执行。
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

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { CapabilityService, DEFAULT_FIELD_RULES } from "../capability.service";
import { ResolveCapabilityDto } from "../dto/resolve-capability.dto";
import { REDACTED } from "../scope/scope-engine";

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

function makeRepo(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  return {
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
  };
}

const SECRET = "sk-PLAINTEXT-SECRET-7788";

const SEED: Row[] = [
  {
    id: "cap-1",
    key: "browser",
    kind: "skill",
    label: "Browser",
    visibility: "private",
    scope: { mode: "managed", guidance: "L2" },
    source: { type: "builtin" },
    manifest: {
      name: "browser",
      timeout: 100,
      providers: { openai: { model: "gpt", apiKey: SECRET } },
      mcpServers: [{ name: "fs", command: "old.sh", apiKey: SECRET }],
      policy: { rules: { browser: "deny" } },
    },
  },
];

const svcOf = (repo: ReturnType<typeof makeRepo>) =>
  new CapabilityService(repo as never, null);

describe("CapabilityService resolve / dump (ADR-040 / P1)", () => {
  it("默认字段族规则表覆盖标量/keyMerge/append/replaceIfSameKey/policyTighten", () => {
    expect(DEFAULT_FIELD_RULES).toMatchObject({
      timeout: "replace",
      providers: "keyMerge",
      permissions: "append",
      skills: "append",
      plugins: "append",
      command: "replaceIfSameKey",
      commands: "replaceIfSameKey",
      mcpServers: "replaceIfSameKey",
      policy: "policyTighten",
    });
  });

  it("resolve 正常合并：标量 replace + 默认字段族规则全部生效", async () => {
    const svc = svcOf(makeRepo(SEED));
    const res = await svc.resolveFor({
      key: "browser",
      layers: [
        {
          name: "managed",
          config: {
            timeout: 100,
            providers: {
              openai: { model: "gpt" },
              anthropic: { model: "claude" },
            },
            permissions: ["read", "write"],
            skills: [{ name: "a" }],
            mcpServers: [{ name: "fs", command: "old.sh", legacy: true }],
            policy: { rules: { browser: "deny" } },
          },
        },
        {
          name: "project",
          config: {
            timeout: 150,
            providers: { openai: { model: "gpt-4" } },
            permissions: ["write", "exec"],
            skills: [{ name: "a" }, { name: "b" }],
            mcpServers: [{ name: "fs", url: "http://new" }],
            policy: { rules: { browser: "allow" } },
          },
        },
      ],
    } as never);

    expect(res.key).toBe("browser");
    expect(res.effective.timeout).toBe(150); // 标量 replace（下层覆盖）
    expect(res.effective.providers).toEqual({
      openai: { model: "gpt-4" },
      anthropic: { model: "claude" },
    }); // keyMerge：改一个 key 不丢另一个
    expect(res.effective.permissions).toEqual(["read", "write", "exec"]); // append + 去重
    expect(res.effective.skills).toEqual([{ name: "a" }, { name: "b" }]);
    expect(res.effective.mcpServers).toEqual([
      { name: "fs", url: "http://new" },
    ]); // 同名整替换，旧字段零残留
  });

  it("显式 fieldRules 覆盖默认规则表（keyMerge → replace）", async () => {
    const svc = svcOf(makeRepo(SEED));
    const res = await svc.resolveFor({
      key: "browser",
      layers: [
        { name: "managed", config: { providers: { a: 1, b: 2 } } },
        { name: "private", config: { providers: { a: 9 } } },
      ],
      fieldRules: { providers: "replace" },
    } as never);
    expect(res.effective.providers).toEqual({ a: 9 });
  });

  it("key 未注册 → VALIDATION_FAILED", async () => {
    const svc = svcOf(makeRepo(SEED));
    await expect(
      svc.resolveFor({
        key: "ghost",
        layers: [{ name: "managed", config: {} }],
      } as never),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  });

  it("层数超限（>8）→ VALIDATION_FAILED", async () => {
    const svc = svcOf(makeRepo(SEED));
    const layers = Array.from({ length: 9 }, (_, i) => ({
      name: `L${i}`,
      config: {},
    }));
    await expect(
      svc.resolveFor({ key: "browser", layers } as never),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  });

  it("空层 / 每层 config 非对象 → VALIDATION_FAILED", async () => {
    const svc = svcOf(makeRepo(SEED));
    await expect(
      svc.resolveFor({ key: "browser", layers: [] } as never),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
    await expect(
      svc.resolveFor({
        key: "browser",
        layers: [{ name: "managed", config: ["not", "object"] }],
      } as never),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  });

  it("managed deny 不被下层 allow 放行；无匹配默认 ask", async () => {
    const svc = svcOf(makeRepo(SEED));
    const denied = await svc.resolveFor({
      key: "browser",
      layers: [
        { name: "managed", config: { policy: { rules: { browser: "deny" } } } },
        {
          name: "project",
          config: { policy: { rules: { browser: "allow" } } },
        },
      ],
    } as never);
    expect(denied.decision).toBe("deny");

    const asked = await svc.resolveFor({
      key: "browser",
      layers: [
        { name: "managed", config: { policy: { rules: { other: "allow" } } } },
      ],
    } as never);
    expect(asked.decision).toBe("ask");
  });

  it("dump 三栏结构：分层来源 / 生效值 / source，managed 取记录 manifest+scope", async () => {
    const svc = svcOf(makeRepo(SEED));
    const out = await svc.dumpFor(
      "browser",
      JSON.stringify({ timeout: 200 }),
      JSON.stringify({ timeout: 300 }),
    );
    expect(out.key).toBe("browser");
    expect(Array.isArray(out.dump)).toBe(true);
    expect(out.dump.find((r) => r.field === "timeout")).toMatchObject({
      layers: [
        { name: "managed", value: 100 },
        { name: "project", value: 200 },
        { name: "private", value: 300 },
      ],
      effective: 300,
      source: "private",
    });
    expect(out.dump.find((r) => r.field === "mode")!.layers[0]).toEqual({
      name: "managed",
      value: "managed",
    });
  });

  it("dump 脱敏反证：注入 apiKey 明文后响应 JSON 不含该明文", async () => {
    const svc = svcOf(makeRepo(SEED));
    const out = await svc.dumpFor(
      "browser",
      JSON.stringify({
        providers: { openai: { apiKey: SECRET, model: "gpt-4" } },
      }),
      JSON.stringify({ apiKey: SECRET }),
    );
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const providers = out.dump.find((r) => r.field === "providers")!;
    expect(providers.layers[0].value).toEqual({
      openai: { apiKey: REDACTED, model: "gpt" },
    });
    expect(providers.layers[1].value).toEqual({
      openai: { apiKey: REDACTED, model: "gpt-4" },
    });
    expect(out.dump.find((r) => r.field === "apiKey")!.effective).toBe(
      REDACTED,
    );
  });

  it("dump：key 未注册 / 下层 query 非法 JSON → VALIDATION_FAILED", async () => {
    const svc = svcOf(makeRepo(SEED));
    await expect(svc.dumpFor("ghost")).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
    });
    await expect(svc.dumpFor("browser", "{not-json")).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
    });
  });

  it("N3 接线反证：restrict 层 deny 不被下层 override 撤销，旧路径同 layers 为 allow", async () => {
    const svc = svcOf(makeRepo(SEED));
    const layers = [
      {
        name: "managed",
        config: { timeout: 100, policy: { rules: { browser: "allow" } } },
      },
      {
        name: "private",
        config: { timeout: 200, policy: { rules: { browser: "allow" } } },
      },
    ];

    // 控制组：不传 semanticLayers ⇒ 旧 evaluatePolicy ⇒ allow。
    const legacy = await svc.resolveFor({ key: "browser", layers } as never);
    expect(legacy.decision).toBe("allow");

    const wired = await svc.resolveFor({
      key: "browser",
      layers,
      semanticLayers: [
        {
          name: "managed",
          semantic: "restrict",
          config: { policy: { rules: { browser: "deny" } } },
        },
        {
          name: "private",
          semantic: "override",
          config: { policy: { rules: { browser: "allow" } } },
        },
      ],
    } as never);
    // 若 lockedDeny 被 override 撤销，或 decision 仍走旧路径，本例转 allow ⇒ 红。
    expect(wired.decision).toBe("deny");
    expect(wired.effective.timeout).toBe(200); // effective 仍来自 mergeConfig
  });

  it("N3 向后兼容反证：不传 semanticLayers 时旧 decision 逐字不变", async () => {
    const svc = svcOf(makeRepo(SEED));
    const layers = [
      { name: "managed", config: { policy: { rules: { browser: "deny" } } } },
      { name: "project", config: { policy: { rules: { browser: "allow" } } } },
    ];
    const denied = await svc.resolveFor({ key: "browser", layers } as never);
    expect(denied.decision).toBe("deny");

    const asked = await svc.resolveFor({
      key: "browser",
      layers: [
        { name: "managed", config: { policy: { rules: { other: "allow" } } } },
      ],
    } as never);
    expect(asked.decision).toBe("ask");

    // 同一 layers 上叠加 override allow：旧路径 deny，四语义路径 allow（真接管）。
    const overridden = await svc.resolveFor({
      key: "browser",
      layers,
      semanticLayers: [
        {
          name: "project",
          semantic: "override",
          config: { policy: { rules: { browser: "allow" } } },
        },
      ],
    } as never);
    expect(overridden.decision).toBe("allow");
  });

  it("N3 控制组：四语义各层全 allow ⇒ decision=allow", async () => {
    const svc = svcOf(makeRepo(SEED));
    const res = await svc.resolveFor({
      key: "browser",
      layers: [
        { name: "managed", config: { timeout: 150 } },
        { name: "private", config: { timeout: 300 } },
      ],
      semanticLayers: [
        {
          name: "managed",
          semantic: "restrict",
          config: { policy: { rules: { browser: "allow" } } },
        },
        {
          name: "project",
          semantic: "override",
          config: { policy: { rules: { browser: "allow" } } },
        },
        {
          name: "private",
          semantic: "fallback",
          config: { policy: { rules: { browser: "allow" } } },
        },
        {
          name: "bounds",
          semantic: "rules",
          config: { policy: { rules: { browser: "allow" } } },
        },
      ],
    } as never);
    expect(res.decision).toBe("allow");
    expect(res.effective.timeout).toBe(300);
  });

  it("N3 非法 semanticLayers → VALIDATION_FAILED（空数组 / semantic 越界 / config 非对象）", async () => {
    const svc = svcOf(makeRepo(SEED));
    const base = { key: "browser", layers: [{ name: "managed", config: {} }] };
    await expect(
      svc.resolveFor({ ...base, semanticLayers: [] } as never),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
    await expect(
      svc.resolveFor({
        ...base,
        semanticLayers: [{ name: "managed", semantic: "bogus", config: {} }],
      } as never),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
    await expect(
      svc.resolveFor({
        ...base,
        semanticLayers: [
          { name: "managed", semantic: "restrict", config: ["bad"] },
        ],
      } as never),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  });

  it("N3 DTO 反证：semantic 越界 / config 非对象经装饰器校验报错", () => {
    const dto = plainToInstance(ResolveCapabilityDto, {
      key: "browser",
      layers: [{ name: "managed", config: {} }],
      semanticLayers: [{ name: "managed", semantic: "bogus", config: [] }],
    });
    const errors = validateSync(dto);
    const layersError = errors.find((e) => e.property === "semanticLayers");
    expect(layersError).toBeDefined();
    expect(layersError!.children![0].children!.map((c) => c.property)).toEqual(
      expect.arrayContaining(["semantic", "config"]),
    );
  });
});
