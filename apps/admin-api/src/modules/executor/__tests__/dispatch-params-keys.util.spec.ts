import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Logger } from "@nestjs/common";
import {
  DISPATCH_PARAM_KEY_PATTERN,
  filterDispatchParamKeys,
  findDispatchParamKeyCollisions,
  isInjectableParamKey,
  summarizeRejectedParamKeys,
} from "../dispatch-params-keys.util";
import { ExecutorService } from "../executor.service";

/**
 * P2-2（2026-10-26 执行器域审计）：params 键名闸（源头主闸）的专项用例。
 *
 * 两层：
 *  1. 纯函数向量——直接加载 protocol.json 顶层 `params` 段的 vectors 对
 *     真实实现逐条断言（与 node executor-protocol-contract.spec / python
 *     test_executor_protocol_contract.py 三端同源，同一份协议文件）；
 *  2. 接线对账——ExecutorService.buildDispatchParams 真的过滤 + warn +
 *     secrets 合并不受影响（防止「util 存在但派发面忘接」的静默失效）。
 */

const PROTOCOL_RELATIVE = path.join(
  "packages",
  "executor-protocol",
  "protocol.json",
);

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, PROTOCOL_RELATIVE))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`executor-protocol/protocol.json not found above ${from}`);
}

const repoRoot = findRepoRoot(__dirname);
const protocol = JSON.parse(
  readFileSync(path.join(repoRoot, PROTOCOL_RELATIVE), "utf-8"),
) as {
  params: {
    keyPattern: string;
    onInvalidKey: string;
    injection: string;
    vectors: Array<{ name: string; key: string; injectable: boolean }>;
  };
};

describe("P2-2 — params 键名闸（纯函数向量，SSOT = protocol.json params 段）", () => {
  it("常量与协议段同源（keyPattern 逐字符一致，onInvalidKey/injection 语义钉住）", () => {
    expect(DISPATCH_PARAM_KEY_PATTERN).toBe(protocol.params.keyPattern);
    expect(protocol.params.onInvalidKey).toBe("skip-and-warn");
    expect(protocol.params.injection).toBe("AUTOFLOW_<KEY-uppercase>");
    // 宽松版差异（相对 secrets 的 keyPattern）：无首字符限制 + 64 上界。
    // 数字开头正是差异点——secrets 规则拒（原名注入要求合法 env 名）、
    // params 规则收（AUTOFLOW_ 前缀保证首字符合法）。
    const secretPattern = (
      protocol as unknown as {
        secrets: { keyPattern: string };
      }
    ).secrets.keyPattern;
    expect(secretPattern).toBe("^[A-Za-z_][A-Za-z0-9_]*$");
    expect(new RegExp(secretPattern).test("1ST_RETRY")).toBe(false);
    expect(isInjectableParamKey("1ST_RETRY")).toBe(true);
    // secrets 合法键在 params 闸下同样合法（secrets ∪ 宽松集 = 本段全收）。
    expect(isInjectableParamKey("AWS_ACCESS_KEY_ID")).toBe(true);
  });

  it("协议向量逐条对真实实现断言（isInjectableParamKey）", () => {
    const vectors = protocol.params.vectors;
    expect(vectors.length).toBeGreaterThanOrEqual(8);
    expect(vectors.some((v) => v.injectable)).toBe(true);
    expect(vectors.some((v) => !v.injectable)).toBe(true);
    for (const vec of vectors) {
      expect([vec.key, isInjectableParamKey(vec.key)]).toEqual([
        vec.key,
        vec.injectable,
      ]);
    }
  });

  it("filterDispatchParamKeys：合法键原值保留（含对象/数组值不改写），非法键进 rejected", () => {
    const { kept, rejected } = filterDispatchParamKeys({
      LIMIT: "3",
      region: "欧盟",
      nested: { a: [1, 2] },
      "A=B": 1,
      "MY-KEY": 2,
      "": 3,
      "bad.key.dot": 4,
    });
    expect(kept).toEqual({ LIMIT: "3", region: "欧盟", nested: { a: [1, 2] } });
    expect(rejected).toEqual(["A=B", "MY-KEY", "", "bad.key.dot"]);
  });

  it("filterDispatchParamKeys：null/undefined/非对象全兜住（返回空 kept）", () => {
    expect(filterDispatchParamKeys(null)).toEqual({ kept: {}, rejected: [] });
    expect(filterDispatchParamKeys(undefined)).toEqual({
      kept: {},
      rejected: [],
    });
    expect(filterDispatchParamKeys("nope" as never)).toEqual({
      kept: {},
      rejected: [],
    });
  });

  it("summarizeRejectedParamKeys：≤10 全列，>10 截断带溢出计数，超长键截断", () => {
    expect(summarizeRejectedParamKeys(["A=B", "C D"])).toBe('"A=B", "C D"');
    const many = Array.from({ length: 12 }, (_, i) => `k${i}=x`);
    const s = summarizeRejectedParamKeys(many);
    expect(s).toContain("(+2 more)");
    expect(s).not.toContain("k11");
    expect(summarizeRejectedParamKeys(["z".repeat(100)])).toBe(
      `"${"z".repeat(64)}"`,
    );
  });
});

// ── 接线对账：buildDispatchParams 真的过滤 + warn ──────────────────────────

const TASK_ID = "task-1";
const EXEC_ID = "exec-1";

const buildService = (): ExecutorService => {
  // 直接 new（与 executor.register-takeover-cas.spec 同款 22 位置参数形态）
  // ——只挂 buildDispatchParams 走到的依赖（secretsCrypto + logger）。
  const svc = new ExecutorService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { add: jest.fn() } as never,
    { get: () => "http" } as never,
    {
      notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
      notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
      notifyFailure: jest.fn().mockResolvedValue(undefined),
      notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
      sendAll: jest.fn().mockResolvedValue(undefined),
    } as never,
    { findOne: jest.fn().mockRejectedValue(new Error("not found")) } as never,
    // decryptForDispatch(secrets)：secrets=null → null（未配置）；对象原样回。
    {
      decryptForDispatch: jest.fn((secrets: unknown) =>
        secrets == null ? null : (secrets as Record<string, unknown>),
      ),
    } as never,
    null as never, // eventBus
    null as never, // tracing
    null as never, // audit
    null as never, // leaderGate
    null as never, // pullService
    null as never, // applicationRepo
    null as never, // deployment repo
    null as never, // tokenCacheSync
    null as never, // mutexGroupRepo
    null as never, // applicationVersionRepo
    null as never, // executorAppVersionRepo
    {
      transaction: async (fn: any) => fn({ getRepository: () => null }),
    } as never, // DataSource
  );
  return svc;
};

const callBuild = (
  svc: ExecutorService,
  task: Record<string, unknown>,
  execution: Record<string, unknown>,
): Record<string, unknown> =>
  (
    svc as unknown as {
      buildDispatchParams: (t: never, e: never) => Record<string, unknown>;
    }
  ).buildDispatchParams(task as never, execution as never);

describe("P2-2 — buildDispatchParams 接线（源头主闸真的过滤）", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("非法键 skip + warn（带 taskId/executionId），合法键与好键照常合并", () => {
    const svc = buildService();
    const warnSpy = jest.spyOn(Logger.prototype, "warn");

    const merged = callBuild(
      svc,
      { id: TASK_ID, secrets: null },
      {
        id: EXEC_ID,
        params: { LIMIT: "3", "A=B": 1, "MY-KEY": 2 },
      },
    );

    // 跳过坏键、保留好键（不 400——params 来自用户配置面）。
    expect(merged).toEqual({ LIMIT: "3" });
    const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warnText).toContain("Dispatch params key gate (P2-2)");
    expect(warnText).toContain(`[task ${TASK_ID} execution ${EXEC_ID}]`);
    expect(warnText).toContain('"A=B"');
    expect(warnText).toContain('"MY-KEY"');
  });

  it("全部键非法 → 空参数合并；键全部合法 → 零 warn（好路径零噪音）", () => {
    const svc = buildService();
    const warnSpy = jest.spyOn(Logger.prototype, "warn");

    expect(
      callBuild(svc, { id: TASK_ID }, { id: EXEC_ID, params: { "X Y": 1 } }),
    ).toEqual({});
    expect(
      callBuild(svc, { id: TASK_ID }, { id: EXEC_ID, params: { OK: 1 } }),
    ).toEqual({ OK: 1 });
    // 构造器有 4 条 R-26 装配 warn（eventBus/audit/部署仓等 @Optional 缺席）
    // ——只统计本闸的 warn（好路径零噪音）。
    expect(
      warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("Dispatch params key gate"),
      ),
    ).toHaveLength(1);
  });

  it("secrets 合并不受 params 键名闸影响（解密产物键按原形态合并、同名覆盖 params）", () => {
    const svc = buildService();

    const merged = callBuild(
      svc,
      // secrets 键名走自己的更严规则（secret-env 闸在执行器侧）——params 闸
      // 不碰它们：解密产物原样进合并面（含同名覆盖语义保持 SEC-02 既有行为）。
      { id: TASK_ID, secrets: { AWS_ACCESS_KEY_ID: "sk", LIMIT: "secret" } },
      { id: EXEC_ID, params: { LIMIT: "param", REGION: "eu" } },
    );

    expect(merged).toEqual({
      LIMIT: "secret", // secrets 覆盖 params（SEC-02 既有语义，不受本闸影响）
      REGION: "eu",
      AWS_ACCESS_KEY_ID: "sk",
    });
  });

  it("secrets 解密失败仍抛 TASK_SECRET_DECRYPT_FAILED（本闸不吞上游错误）", async () => {
    const svc = new ExecutorService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { add: jest.fn() } as never,
      { get: () => "http" } as never,
      {
        notifyExecutorOnline: jest.fn(),
        notifyExecutorOffline: jest.fn(),
        notifyFailure: jest.fn(),
        notifyFailureWithConfig: jest.fn(),
        sendAll: jest.fn(),
      } as never,
      { findOne: jest.fn() } as never,
      {
        decryptForDispatch: jest.fn(() => {
          throw new Error("key rotated away");
        }),
      } as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      {
        transaction: async (fn: any) => fn({ getRepository: () => null }),
      } as never,
    );

    expect(() =>
      callBuild(svc, { id: TASK_ID, secrets: {} }, { id: EXEC_ID }),
    ).toThrow(
      expect.objectContaining({ errorCode: "TASK_SECRET_DECRYPT_FAILED" }),
    );
  });
});

/**
 * EXEC-07b（第 3 轮审计残差）：折叠冲突判定的 admin 侧实现必须与
 * protocol.json `params.keyUniqueness` 的 8 条向量逐条一致（执行器两端用
 * 同一份向量；admin 在保存/触发边界前置同一判据，不能各写一套）。
 */
describe("findDispatchParamKeyCollisions · 与协议向量逐条对账", () => {
  // 向上找仓库根（jest rootDir 是 apps/admin-api，数 `..` 会随配置漂移）
  const findRoot = (from: string): string => {
    let dir = from;
    for (let i = 0; i < 12; i++) {
      if (existsSync(path.join(dir, "packages", "executor-protocol"))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    throw new Error(`repo root not found above ${from}`);
  };
  const protocol = JSON.parse(
    readFileSync(
      path.join(
        findRoot(__dirname),
        "packages",
        "executor-protocol",
        "protocol.json",
      ),
      "utf-8",
    ),
  ) as {
    params: {
      keyUniqueness: {
        vectors: Array<{
          name: string;
          params: Record<string, unknown>;
          expectCollisions: Array<{ envKey: string; keys: string[] }>;
        }>;
      };
    };
  };

  it.each(
    protocol.params.keyUniqueness.vectors.map((v) => [v.name, v] as const),
  )("%s", (_name, vector) => {
    expect(findDispatchParamKeyCollisions(vector.params)).toEqual(
      vector.expectCollisions,
    );
  });

  it("非对象/空/null/数组 → 无冲突（畸形载荷不抛错）", () => {
    expect(findDispatchParamKeyCollisions(null)).toEqual([]);
    expect(findDispatchParamKeyCollisions(undefined)).toEqual([]);
    expect(findDispatchParamKeyCollisions({})).toEqual([]);
    expect(
      findDispatchParamKeyCollisions([] as unknown as Record<string, unknown>),
    ).toEqual([]);
  });
});
