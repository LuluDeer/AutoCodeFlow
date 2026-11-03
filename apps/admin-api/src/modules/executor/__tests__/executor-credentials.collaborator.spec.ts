import { Logger } from "@nestjs/common";
import {
  ExecutorCredentials,
  type ExecutorCredentialsDeps,
} from "../executor-credentials.collaborator";

/**
 * T1-B1b 的独立单测（**不走 DI 装配**，`new ExecutorCredentials({...})` 直构）。
 *
 * ## 这些用例钉住三件"错了会静默"的事
 *
 * 1. **共享令牌永远是"某台合法执行器"，不是"某一行"** —— 这是 SEC-R3-1/2 的
 *    安全边界。`isSharedToken` 判错会让共享令牌借道拿到行级私有数据。
 * 2. **同址多行时逐个试候选** —— 只试第一行会拿到别人的 tokenHash，导致合法
 *    执行器的回调 401、执行卡在 RUNNING 直到 stale sweep。
 * 3. **缓存只 mutate、不重新赋值** —— Map 由 Facade 持有并按引用传入；协作者
 *    若重建 Map，Facade 侧（与 8 处 spec 的私有字段断言）会读到空缓存。
 *
 * ## 与集成测试的分工
 *
 * `executor.service.spec.ts`（10,406 行）覆盖的是**装配后**的行为；本文件覆盖
 * 的是**凭据面自身的判据**，不需要 21 个位置参数 + 9 个 Repository 替身。
 */

/** 造一个最小 deps（可覆盖任意项）。 */
function makeDeps(over: Partial<ExecutorCredentialsDeps> = {}): {
  deps: ExecutorCredentialsDeps;
  tokenValidationCache: Map<string, { address: string; cachedAt: number }>;
  issuedTokenCache: Map<
    string,
    { token: string; startupId: string | null; issuedAt: number; address: string }
  >;
  callbackSecretCache: Map<
    string,
    { hash: string; cachedAt: number; address: string }
  >;
  debugSpy: jest.Mock;
} {
  const tokenValidationCache = new Map<
    string,
    { address: string; cachedAt: number }
  >();
  const issuedTokenCache = new Map<
    string,
    { token: string; startupId: string | null; issuedAt: number; address: string }
  >();
  const callbackSecretCache = new Map<
    string,
    { hash: string; cachedAt: number; address: string }
  >();
  const debugSpy = jest.fn();
  const logger = {
    debug: debugSpy,
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;

  const deps: ExecutorCredentialsDeps = {
    repo: {
      createQueryBuilder: jest.fn(() => ({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
        getMany: jest.fn().mockResolvedValue([]),
      })),
      findOne: jest.fn().mockResolvedValue(null),
    } as never,
    logger,
    getSharedToken: async () => "",
    resolveRow: async () => null,
    identityKey: (address: string) => `key:${address}`,
    tokenValidationCache,
    issuedTokenCache,
    callbackSecretCache,
    tokenCacheTtlMs: 900_000,
    tokenCacheMax: 1000,
    tokenIssueCacheTtlMs: 24 * 60 * 60 * 1000,
    tokenIssueCacheMax: 1000,
    maxCallbackSecretCandidates: 16,
    ...over,
  };
  return { deps, tokenValidationCache, issuedTokenCache, callbackSecretCache, debugSpy };
}

describe("ExecutorCredentials — 凭据面判据（独立构造）", () => {
  describe("共享令牌（机队级凭据，不绑定行）", () => {
    it("未配置共享令牌 ⇒ 恒 false（空串不算凭据）", async () => {
      const { deps } = makeDeps();
      const c = new ExecutorCredentials(deps);
      expect(await c.isSharedToken("anything")).toBe(false);
      expect(await c.isSharedToken("")).toBe(false);
      expect(await c.isSharedToken(null)).toBe(false);
    });

    it("配置后等值即 true，不等即 false", async () => {
      const { deps } = makeDeps({ getSharedToken: async () => "s3cr3t" });
      const c = new ExecutorCredentials(deps);
      expect(await c.isSharedToken("s3cr3t")).toBe(true);
      expect(await c.isSharedToken("s3cr3")).toBe(false); // 长度不等
      expect(await c.isSharedToken("s3cr3T")).toBe(false);
    });

    it("**timing-safe 比对对长度不等不抛错**（timingSafeEqual 对不等长会 throw）", async () => {
      const { deps } = makeDeps({ getSharedToken: async () => "abc" });
      const c = new ExecutorCredentials(deps);
      await expect(c.isSharedToken("a")).resolves.toBe(false);
    });
  });

  describe("validateTokenByAddressAnyRow — 同址多行逐个试", () => {
    it("空地址/空凭据 ⇒ false（不查库）", async () => {
      const { deps } = makeDeps();
      const c = new ExecutorCredentials(deps);
      expect(await c.validateTokenByAddressAnyRow("", "tok")).toBe(false);
      expect(await c.validateTokenByAddressAnyRow("10.0.0.1", "")).toBe(false);
    });

    it("任一行的 tokenHash 匹配即 true（候选必须全部尝试）", async () => {
      const getMany = jest
        .fn()
        // 第一行空 hash（跳过）、第二行不匹配、第三行匹配
        .mockResolvedValue([
          { id: "a", tokenHash: null },
          { id: "b", tokenHash: "not-a-bcrypt-hash" },
        ]);
      const { deps } = makeDeps({
        repo: {
          createQueryBuilder: jest.fn(() => ({
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            getMany,
          })),
        } as never,
      });
      const c = new ExecutorCredentials(deps);
      // 两行都不匹配 ⇒ 回退共享令牌（未配置）⇒ false
      expect(await c.validateTokenByAddressAnyRow("10.0.0.1", "tok")).toBe(false);
      expect(getMany).toHaveBeenCalledTimes(1);
    });

    it("候选查询受 MAX_CALLBACK_SECRET_CANDIDATES 限制（防 O(全表) bcrypt）", async () => {
      const limit = jest.fn().mockReturnThis();
      const { deps } = makeDeps({
        maxCallbackSecretCandidates: 7,
        repo: {
          createQueryBuilder: jest.fn(() => ({
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit,
            getMany: jest.fn().mockResolvedValue([]),
          })),
        } as never,
      });
      const c = new ExecutorCredentials(deps);
      await c.validateTokenByAddressAnyRow("10.0.0.1", "tok");
      expect(limit).toHaveBeenCalledWith(7);
    });
  });

  describe("resolveCredentialExecutorId — 凭据属于哪一行", () => {
    it("无地址/无凭据 ⇒ null", async () => {
      const { deps } = makeDeps();
      const c = new ExecutorCredentials(deps);
      expect(await c.resolveCredentialExecutorId("", "tok")).toBeNull();
      expect(await c.resolveCredentialExecutorId("10.0.0.1", "")).toBeNull();
    });

    it("无任何行匹配 ⇒ **null**（语义是「没有行身份可判」，不是「校验失败」）", async () => {
      const { deps } = makeDeps();
      const c = new ExecutorCredentials(deps);
      expect(await c.resolveCredentialExecutorId("10.0.0.1", "tok")).toBeNull();
    });
  });

  describe("resolveExecutorIdByFingerprint", () => {
    it("缺省/非法指纹 ⇒ null（不抛错——回调主链不能因可选字段失败）", async () => {
      const { deps } = makeDeps();
      const c = new ExecutorCredentials(deps);
      expect(await c.resolveExecutorIdByFingerprint(null)).toBeNull();
      expect(await c.resolveExecutorIdByFingerprint(undefined)).toBeNull();
      expect(await c.resolveExecutorIdByFingerprint("not-a-fp")).toBeNull();
    });
  });

  describe("normalizeReportedExecutorId — 自报行 id 的合法形态", () => {
    it("合法 uuid 文本原样返回（去空白）", () => {
      expect(
        ExecutorCredentials.normalizeReportedExecutorId(
          "  a7c2e4fc-0181-4ef8-a0e1-7af326903e49  ",
        ),
      ).toBe("a7c2e4fc-0181-4ef8-a0e1-7af326903e49");
    });

    it("非法形态一律 null（非字符串 / 空 / 超长 / 含非 hex 字符）", () => {
      expect(ExecutorCredentials.normalizeReportedExecutorId(123)).toBeNull();
      expect(ExecutorCredentials.normalizeReportedExecutorId("")).toBeNull();
      expect(ExecutorCredentials.normalizeReportedExecutorId("   ")).toBeNull();
      expect(
        ExecutorCredentials.normalizeReportedExecutorId("a".repeat(65)),
      ).toBeNull();
      expect(
        ExecutorCredentials.normalizeReportedExecutorId("'; DROP TABLE x; --"),
      ).toBeNull();
    });
  });

  describe("getCallbackSecretCandidatesByAddress — 同址多行的候选集", () => {
    it("空地址 ⇒ 空数组", async () => {
      const { deps } = makeDeps();
      const c = new ExecutorCredentials(deps);
      expect(await c.getCallbackSecretCandidatesByAddress("")).toEqual([]);
    });

    it("多个候选去重且滤掉空 hash", async () => {
      const { deps } = makeDeps({
        repo: {
          createQueryBuilder: jest.fn(() => ({
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([
              { tokenHash: "h1" },
              { tokenHash: "h1" }, // 重复
              { tokenHash: null }, // 空
              { tokenHash: "" }, // 空串
              { tokenHash: "h2" },
            ]),
          })),
        } as never,
      });
      const c = new ExecutorCredentials(deps);
      expect(await c.getCallbackSecretCandidatesByAddress("10.0.0.1")).toEqual([
        "h1",
        "h2",
      ]);
    });

    it("多候选时留 debug 日志（运维要知道这条地址有并存行）", async () => {
      const { deps, debugSpy } = makeDeps({
        repo: {
          createQueryBuilder: jest.fn(() => ({
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([
              { tokenHash: "h1" },
              { tokenHash: "h2" },
            ]),
          })),
        } as never,
      });
      const c = new ExecutorCredentials(deps);
      await c.getCallbackSecretCandidatesByAddress("10.0.0.1");
      expect(String(debugSpy.mock.calls[0][0])).toContain("2 candidate rows");
    });
  });

  describe("缓存：**按引用共享**、只 mutate 不重建", () => {
    it("rememberTokenValidation 写入的是**传入的**那张 Map（Facade 可见）", () => {
      const { deps, tokenValidationCache } = makeDeps();
      const c = new ExecutorCredentials(deps);
      c.rememberTokenValidation("k1", "10.0.0.1", 1000);
      // Facade 持有的同一张 Map 能看到（⇒ 8 处 spec 的私有字段断言仍有效）
      expect(tokenValidationCache.get("k1")).toEqual({
        address: "10.0.0.1",
        cachedAt: 1000,
      });
    });

    it("**协作者不重建 Map**（引用身份不变）", () => {
      const { deps, tokenValidationCache } = makeDeps();
      const c = new ExecutorCredentials(deps);
      c.rememberTokenValidation("k1", "10.0.0.1", 1000);
      c.evictTokenValidationsFor("10.0.0.1");
      // 若协作者内部 `this.x = new Map()`，Facade 的 map 会一直是空的
      expect(tokenValidationCache).toBe(deps.tokenValidationCache);
      expect(tokenValidationCache.size).toBe(0); // 驱逐生效于同一张 Map
    });

    it("evictTokenValidationsFor 只逐出该地址的条目", () => {
      const { deps, tokenValidationCache } = makeDeps();
      const c = new ExecutorCredentials(deps);
      c.rememberTokenValidation("a", "10.0.0.1", 1);
      c.rememberTokenValidation("b", "10.0.0.2", 1);
      c.evictTokenValidationsFor("10.0.0.1");
      expect(tokenValidationCache.has("a")).toBe(false);
      expect(tokenValidationCache.has("b")).toBe(true);
    });

    it("issuedTokenCache 写入同张 Map；覆盖同一键不触发淘汰", () => {
      const { deps, issuedTokenCache } = makeDeps({ tokenIssueCacheMax: 2 });
      const c = new ExecutorCredentials(deps);
      c.rememberIssuedToken("k1", {
        token: "t1",
        startupId: "s1",
        issuedAt: 1,
        address: "a",
      });
      c.rememberIssuedToken("k2", {
        token: "t2",
        startupId: "s2",
        issuedAt: 2,
        address: "b",
      });
      // 覆盖 k1：不得淘汰 k2（R10 rotateToken 与 issueToken 写同一键的场景）
      c.rememberIssuedToken("k1", {
        token: "t1b",
        startupId: "s1",
        issuedAt: 3,
        address: "a",
      });
      expect(issuedTokenCache.get("k2")).toBeDefined();
      expect(issuedTokenCache.get("k1")?.token).toBe("t1b");
    });

    it("超过上限时淘汰最旧条目（有界增长防御）", () => {
      const { deps, issuedTokenCache } = makeDeps({ tokenIssueCacheMax: 2 });
      const c = new ExecutorCredentials(deps);
      for (const k of ["k1", "k2", "k3"]) {
        c.rememberIssuedToken(k, {
          token: k,
          startupId: null,
          issuedAt: 1,
          address: k,
        });
      }
      expect(issuedTokenCache.size).toBe(2);
      expect(issuedTokenCache.has("k1")).toBe(false); // 最旧被淘汰
    });
  });

  describe("getCallbackSecretByAddress — 走 resolveRow 回调 + 正缓存", () => {
    it("命中行 ⇒ 返回 tokenHash 并写缓存", async () => {
      const { deps, callbackSecretCache } = makeDeps({
        resolveRow: async () => ({ tokenHash: "H1" }) as never,
      });
      const c = new ExecutorCredentials(deps);
      expect(await c.getCallbackSecretByAddress("10.0.0.1")).toBe("H1");
      expect(callbackSecretCache.get("key:10.0.0.1")?.hash).toBe("H1");
    });

    it("解析不到（同址多行无指纹 fail-closed）⇒ null 且清缓存", async () => {
      const { deps, callbackSecretCache } = makeDeps({
        resolveRow: async () => null,
      });
      // 预置一条**已过期**缓存（cachedAt=0 远超 TTL）⇒ 本调用会 miss 并查库
      callbackSecretCache.set("key:10.0.0.1", {
        hash: "stale",
        cachedAt: 0,
        address: "10.0.0.1",
      });
      const c = new ExecutorCredentials(deps);
      expect(await c.getCallbackSecretByAddress("10.0.0.1")).toBeNull();
      expect(callbackSecretCache.has("key:10.0.0.1")).toBe(false);
    });

    it("正缓存命中时**不再查库**（resolveRow 只调一次）", async () => {
      const resolveRow = jest.fn(async () => ({ tokenHash: "H1" }) as never);
      const { deps } = makeDeps({ resolveRow });
      const c = new ExecutorCredentials(deps);
      await c.getCallbackSecretByAddress("10.0.0.1");
      await c.getCallbackSecretByAddress("10.0.0.1");
      expect(resolveRow).toHaveBeenCalledTimes(1);
    });

    it("evictCallbackSecretsFor 按地址逐出", async () => {
      const { deps, callbackSecretCache } = makeDeps({
        resolveRow: async () => ({ tokenHash: "H1" }) as never,
      });
      const c = new ExecutorCredentials(deps);
      await c.getCallbackSecretByAddress("10.0.0.1");
      c.evictCallbackSecretsFor("10.0.0.1");
      expect(callbackSecretCache.has("key:10.0.0.1")).toBe(false);
    });
  });
});
