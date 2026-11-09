import { Logger } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { timingSafeEqual } from "crypto";
import type { Repository } from "typeorm";
import { normalizeDeviceFingerprint } from "./executor-fingerprint.util";
import type { Executor } from "./entities/executor.entity";

/**
 * 执行器**凭据面**协作者（T1-B1b）。
 *
 * ## 职责边界（为什么是这一段）
 *
 * 本类只负责「一份呈现出来的凭据，能证明什么」：
 *
 * - **令牌校验**：per-executor bcrypt 哈希 OR 机队级共享令牌（timing-safe）
 * - **行归属解析**：这个凭据属于哪一行（回调面需要它做行身份判定）
 * - **回调 HMAC 密钥**：按地址/行 id 取候选哈希（同址多行时逐个试）
 * - **派生缓存**：校验正缓存 / 已签发令牌缓存的有界写入与逐出
 *
 * ## 刻意**不**收进来的东西（以及原因）
 *
 * | 留在 Facade | 原因 |
 * |---|---|
 * | `onModuleInit` / `broadcastTokenEviction` / `flushLocalTokenCaches` / `evictLocalTokenCaches` | **生命周期与跨实例 pub/sub 语义**：它们是 `ExecutorTokenCacheSyncService` 的回调与 Nest 模块装配，不是令牌业务逻辑。把生命周期搬进业务协作者是「拆分反而更乱」的典型。 |
 * | `resolveExecutorRow` | **被 3 处 spec 直接 spy**（`executor.service.spec.ts:9934/9955/9972` 的 `jest.spyOn(svcAny, "resolveExecutorRow")`）⇒ 必须留在 Facade，本类经 `resolveRow` 回调调用。被 spy 的私有方法是 Facade 必须保留的最小集，**不为搬干净去改 spec**。 |
 * | `getSharedToken` | 机队级共享令牌的**唯一解析入口**（DB-first + systemConfig 回退），被 application/task/本模块多处注入消费 ⇒ 留 Facade，本类经 `getSharedToken` 回调使用。 |
 * | `getInstallCmd` | 语义是「**凭据分发面**」（生成带明文 secret 的安装命令 + 高危审计），不是凭据校验；搬进来会把 `audit` 依赖带进本类 = 边界污染。 |
 * | `authenticateMachineRequest` | 86 行，核心是「自报行 id 的采纳规则」，需要 `resolveExecutorRow`；留在 Facade。 |
 * | `rotateToken` / `issueToken` | 签发动作同时改 DB（`repo.update tokenHash`）且与注册流程耦合（`issueTokenForDuplicateRegister`）；留在 Facade。 |
 *
 * ## 三个缓存 Map 为什么**按引用**共享（这不是省事）
 *
 * `tokenValidationCache` / `issuedTokenCache`（以及 Facade 侧的
 * `callbackSecretCache`）由 **Facade 持有**，本类接收**同一对象引用**并只做
 * 原地 mutate。
 *
 * **原因**：既有 spec 通过**私有字段**断言缓存语义——
 * - `executor.service.spec.ts:1575 / 1692 / 3935 / 3956`（`(svc as any).issuedTokenCache`）
 * - `executor.service.spec.ts:6415`（`(service as any).tokenValidationCache`）
 * - `security.spec.ts:481`（`(service as any).tokenValidationCache.keys()`）
 * - `:6776`（`(svc as any).callbackSecretCache.has(...)`）
 *
 * 若把 Map 的定义搬进本类，上述 8 处断言全部失效 ⇒ 必须改 spec。共享引用让
 * 「spec 读 Facade 上的字段」与「协作者改同一份数据」同时成立，**零 spec 改动**。
 *
 * ⚠️ **硬约束**：本类**不得重新赋值**这两个字段（不许 `this.x = new Map()`）。
 * 缓存实例的所有权在 Facade；本类只 mutate。构造函数只在**未传入**时才创建
 * 一个空 Map（便于独立单测），传入则原样使用。
 *
 * > **已知技术债（登记，本轮不做）**：「spec 通过私有字段断言缓存」本身是坏味道。
 * > 正确的收敛方向是「缓存行为通过 public API 的副作用断言」（例如
 * > `validateTokenByAddress` 命中后不再走 bcrypt 可由调用次数观测）。这是
 * > B1b 的已知尾巴，后续单独一轮清偿。
 */

/** 缓存条目：校验正缓存（键 = sha256(address|token) 的单向哈希）。 */
interface TokenValidationEntry {
  address: string;
  cachedAt: number;
}

/** 缓存条目：已签发令牌（键 = 定位身份，即指纹优先）。 */
interface IssuedTokenEntry {
  token: string;
  startupId: string | null;
  issuedAt: number;
  address: string;
}

/** 协作者依赖（全部最小面；不含整个 service）。 */
export interface ExecutorCredentialsDeps {
  /** 执行器仓库（按 id / address / deviceFingerprint 取行与 tokenHash）。 */
  repo: Repository<Executor>;
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
  /** 共享令牌解析（Facade 的 `getSharedToken`；DB-first）。 */
  getSharedToken: () => Promise<string>;
  /** 行解析（Facade 的 `resolveExecutorRow`；指纹优先/地址兜底，歧义 fail-closed）。 */
  resolveRow: (
    address: string,
    deviceFingerprint?: string | null,
    opts?: { withTokenHash?: boolean; reportedExecutorId?: string | null },
  ) => Promise<Executor | null>;
  /**
   * 窗口键派生（Facade 的 `tokenCacheIdentityKey`）。
   * 留在 Facade 是因为它同时服务 `callbackSecretCache` 与 `issuedTokenCache`，
   * 属「缓存键口径」这一横切关注点。
   */
  identityKey: (address: string, deviceFingerprint?: string | null) => string;
  /**
   * 校验正缓存（**Facade 持有，按引用传入**；本类只 mutate，不得重新赋值）。
   * 缺省时自建一个空 Map（仅供独立单测使用）。
   */
  tokenValidationCache?: Map<string, TokenValidationEntry>;
  /**
   * 已签发令牌缓存（**Facade 持有，按引用传入**；本类只 mutate）。
   * 缺省时自建一个空 Map（仅供独立单测使用）。
   */
  issuedTokenCache?: Map<string, IssuedTokenEntry>;
  /**
   * 回调密钥正缓存（**Facade 持有，按引用传入**；本类只 mutate）。
   * 缺省时自建一个空 Map（仅供独立单测使用）。
   */
  callbackSecretCache?: Map<
    string,
    { hash: string; cachedAt: number; address: string }
  >;
  /** 校验正缓存 TTL（ms）。值来自 Facade 的静态常量，保持单一事实源。 */
  tokenCacheTtlMs: number;
  /** 校验正缓存条目上限。 */
  tokenCacheMax: number;
  /** 已签发令牌缓存 TTL（ms）。 */
  tokenIssueCacheTtlMs: number;
  /** 已签发令牌缓存条目上限。 */
  tokenIssueCacheMax: number;
  /** 同地址候选行上限（防病态数据把验签退化成 O(全表)）。 */
  maxCallbackSecretCandidates: number;
}

export class ExecutorCredentials {
  private readonly repo: Repository<Executor>;
  private readonly logger: Logger;
  private readonly getSharedToken: () => Promise<string>;
  private readonly resolveRow: ExecutorCredentialsDeps["resolveRow"];
  private readonly identityKey: ExecutorCredentialsDeps["identityKey"];
  /**
   * ⚠️ 这两个 Map 的**所有权在 Facade**（见类头注）。本类只做原地 mutate：
   * `set` / `delete` / 遍历，**绝不重新赋值**——重新赋值会让 Facade 持有旧引用
   * 而本类往新 Map 写，两边看到不同的缓存（且 spec 的私有字段断言会读到空）。
   */
  private readonly tokenValidationCache: Map<string, TokenValidationEntry>;
  private readonly issuedTokenCache: Map<string, IssuedTokenEntry>;
  private readonly callbackSecretCache: Map<
    string,
    { hash: string; cachedAt: number; address: string }
  >;
  private readonly tokenCacheTtlMs: number;
  private readonly tokenCacheMax: number;
  private readonly tokenIssueCacheTtlMs: number;
  private readonly tokenIssueCacheMax: number;
  private readonly maxCallbackSecretCandidates: number;

  constructor(deps: ExecutorCredentialsDeps) {
    this.repo = deps.repo;
    this.logger = deps.logger;
    this.getSharedToken = deps.getSharedToken;
    this.resolveRow = deps.resolveRow;
    this.identityKey = deps.identityKey;
    // 只在**未传入**时创建；传入则原样使用（共享引用语义）。
    this.tokenValidationCache = deps.tokenValidationCache ?? new Map();
    this.issuedTokenCache = deps.issuedTokenCache ?? new Map();
    this.callbackSecretCache = deps.callbackSecretCache ?? new Map();
    this.tokenCacheTtlMs = deps.tokenCacheTtlMs;
    this.tokenCacheMax = deps.tokenCacheMax;
    this.tokenIssueCacheTtlMs = deps.tokenIssueCacheTtlMs;
    this.tokenIssueCacheMax = deps.tokenIssueCacheMax;
    this.maxCallbackSecretCandidates = deps.maxCallbackSecretCandidates;
  }

  /**
   * 自报行 id 的合法形态（uuid 文本；长度上限防病态输入）。
   * 非法/缺省 → null（等同于未上报，行为与引入工单 11 前一致）。
   */
  static normalizeReportedExecutorId(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64) return null;
    return /^[0-9a-fA-F-]+$/.test(trimmed) ? trimmed : null;
  }

  /**
   * 共享令牌比对（timing-safe；未配置即不可用，与既有语义一致）。
   *
   * 公开而非 private：Facade 的 `authenticateMachineRequest` 仍在本机保留
   * （它依赖被 spy 的 `resolveExecutorRow`），需要直接调用本方法。
   */
  async compareSharedToken(presented: string): Promise<boolean> {
    const shared = await this.getSharedToken();
    if (shared.length === 0) return false;
    const sharedBuf = Buffer.from(shared, "utf8");
    const presentedBuf = Buffer.from(presented, "utf8");
    // timingSafeEqual 对长度不等会抛错，故先比长度（长度本身不是秘密）。
    if (sharedBuf.length !== presentedBuf.length) return false;
    return timingSafeEqual(sharedBuf, presentedBuf);
  }

  /**
   * 是否为集群共享令牌（SEC-R3-1/2，审计 P1）。
   *
   * 共享令牌证明「某台合法执行器」，不证明「你就是某一行」——调用方在
   * **凭据外发/私有数据读取**面必须据此收紧。空串/未配置恒 false。
   */
  async isSharedToken(presented?: string | null): Promise<boolean> {
    if (!presented) return false;
    return this.compareSharedToken(presented);
  }

  /**
   * 按 id 校验令牌：per-executor bcrypt 哈希优先，回退机队级共享令牌。
   */
  async validateExecutorToken(id: string, presented: string): Promise<boolean> {
    const executor = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.id = :id", { id })
      .getOne();
    if (!executor) return false;
    if (executor.tokenHash) {
      return bcrypt.compare(presented, executor.tokenHash);
    }
    const shared = await this.getSharedToken();
    if (shared.length === 0) return false;
    // SEC-FIX: use timingSafeEqual to prevent timing attacks on shared token comparison
    const sharedBuf = Buffer.from(shared, "utf8");
    const presentedBuf = Buffer.from(presented, "utf8");
    if (sharedBuf.length !== presentedBuf.length) return false;
    return timingSafeEqual(sharedBuf, presentedBuf);
  }

  /**
   * ADR-017 阶段 3：**同地址任一行**匹配即通过（用于执行回调等「只带地址、
   * 无法携带指纹」的机器面）。
   *
   * 与 `validateTokenByAddress` 的分工：后者用于**能带指纹**的面（心跳/注册/
   * pull/config），指纹优先、同址多行无指纹时 fail-closed——因为那些面要
   * **定位到具体一行**去做副作用。本方法用于**只做凭据校验、不需要定位行**的
   * 面（回调上报）。逐个试全部候选既不会误拒合法执行器，也不放宽任何判定
   * （每个候选都走完整 bcrypt/共享 token 比对）。
   */
  async validateTokenByAddressAnyRow(
    address: string,
    presented: string,
  ): Promise<boolean> {
    if (!presented) return false;
    if (!address) return false;
    const rows = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address })
      .limit(this.maxCallbackSecretCandidates)
      .getMany();
    for (const row of rows) {
      if (!row.tokenHash) continue;
      // 每个候选都走完整比对；任一命中即持有该地址上某台的凭据。
      if (await bcrypt.compare(presented, row.tokenHash)) {
        return true;
      }
    }
    // 回退共享 token（与原实现同序：per-executor 优先，共享兜底）。
    const shared = await this.getSharedToken();
    if (shared.length === 0) return false;
    const sharedBuf = Buffer.from(shared, "utf8");
    const presentedBuf = Buffer.from(presented, "utf8");
    if (sharedBuf.length !== presentedBuf.length) return false;
    return timingSafeEqual(sharedBuf, presentedBuf);
  }

  /**
   * ADR-017 阶段 3（协议 v6，方案 C 补口）：按**回调自报的指纹**解析行 id。
   *
   * 语义（**刻意极简**）：规范化 → 缺省/非法返回 null（不抛错，回调主链不能
   * 因可选字段的形态问题失败）→ 按 deviceFingerprint 命中行则返回其 id。
   * **不做鉴权判定**：指纹是自报值，本方法只回答「这个自报值对应哪一行」。
   */
  async resolveExecutorIdByFingerprint(
    deviceFingerprint?: string | null,
  ): Promise<string | null> {
    const fp = normalizeDeviceFingerprint(deviceFingerprint);
    if (!fp) return null;
    const row = await this.repo.findOne({
      where: { deviceFingerprint: fp },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * ADR-017 阶段 3（复查补口）：解析**所持凭据属于哪一行**。
   *
   * 与 `validateTokenByAddressAnyRow` 的分工：后者只回答「能不能通过」，本方法
   * 回答「属于哪一行」。无任何行使 per-executor 令牌匹配（共享令牌、或已轮换/
   * 无效）→ 返回 `null`，语义是「没有行身份可判」而非「校验失败」。
   */
  async resolveCredentialExecutorId(
    address: string,
    presented: string,
  ): Promise<string | null> {
    if (!address || !presented) return null;
    const rows = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address })
      .limit(this.maxCallbackSecretCandidates)
      .getMany();
    for (const row of rows) {
      if (!row.tokenHash) continue;
      if (await bcrypt.compare(presented, row.tokenHash)) return row.id;
    }
    return null;
  }

  /**
   * ADR-017 阶段 3：**同地址全部行的**回调密钥候选（去重、非空）。
   *
   * 为什么需要「全部」而不是「第一行」：pull 模式允许同地址多行并存，而
   * `task_executions.executorAddress` 只记地址、不记行身份——按地址取第一行会
   * 拿到**别人的** tokenHash ⇒ 合法执行器的 v1 HMAC 验签失败 → 401 → 执行卡在
   * RUNNING 直到 stale sweep。试全部候选**不降低安全性**（每个候选都仍须通过
   * 完整签名校验，且候选来自同一地址、数量受同址行数约束）。
   */
  async getCallbackSecretCandidatesByAddress(
    address: string,
  ): Promise<string[]> {
    if (!address) return [];
    const rows = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address })
      // 同址并存的合法行数很小（真实碰撞场景是 2~3 台）；设上限防病态数据
      // 让回调验签退化成 O(全表)。
      .limit(this.maxCallbackSecretCandidates)
      .getMany();
    if (rows.length > 1) {
      this.logger.debug(
        `Callback secret resolution for "${address}" returned ${rows.length} ` +
          `candidate rows (pull-mode duplicate address); all candidates are ` +
          `tried, ownership is proven by the HMAC match.`,
      );
    }
    const hashes = rows
      .map((r) => r.tokenHash)
      .filter((h): h is string => typeof h === "string" && h.length > 0);
    return [...new Set(hashes)];
  }

  /**
   * ADR-017 阶段 3：按 `executors.id` 取回调密钥候选——注册响应回显用。
   *
   * 不缓存：register 是启动/低频路径，单次 DB 查询可忽略（也免去 rotateToken
   * 对 id 键的额外驱逐逻辑）。
   */
  async getCallbackSecretById(id: string): Promise<string | null> {
    const executor = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.id = :id", { id })
      .getOne();
    return executor?.tokenHash ?? null;
  }

  /**
   * N26 (round-8)：按地址取**单条**回调密钥（缓存版）。
   *
   * 与 `getCallbackSecretCandidatesByAddress` 的区别：本方法只取**一条**
   * （指纹优先定位到的行），供「已知是哪一行」的面使用；同址多行且无指纹时
   * 返回 null（fail-closed，调用方继续试共享密钥）。正结果缓存
   * `tokenCacheTtlMs`（与令牌校验正缓存同 TTL）。
   */
  async getCallbackSecretByAddress(
    address: string,
    deviceFingerprint?: string | null,
  ): Promise<string | null> {
    const now = Date.now();
    // 缓存键 = 定位身份（指纹优先），与 validateTokenByAddress /
    // issuedTokenCache 同口径（共用 Facade 的 identityKey）。
    const cacheKey = this.identityKey(address, deviceFingerprint);
    const cached = this.callbackSecretCache.get(cacheKey);
    if (cached && now - cached.cachedAt < this.tokenCacheTtlMs) {
      return cached.hash;
    }
    const executor = await this.resolveRow(address, deviceFingerprint, {
      withTokenHash: true,
    });
    const hash = executor?.tokenHash ?? null;
    if (hash) {
      this.callbackSecretCache.set(cacheKey, { hash, cachedAt: now, address });
    } else {
      this.callbackSecretCache.delete(cacheKey);
    }
    return hash;
  }

  /** 逐出某 address 在回调密钥正缓存里的全部条目（rotate/remove 用）。 */
  evictCallbackSecretsFor(address: string): void {
    for (const [k, entry] of this.callbackSecretCache) {
      if (entry.address === address) this.callbackSecretCache.delete(k);
    }
  }

  /** F-5: store a successful validation, evicting expired/oldest entries. */
  rememberTokenValidation(
    cacheKey: string,
    address: string,
    now: number,
  ): void {
    if (this.tokenValidationCache.size >= this.tokenCacheMax) {
      for (const [k, entry] of this.tokenValidationCache) {
        if (now - entry.cachedAt >= this.tokenCacheTtlMs) {
          this.tokenValidationCache.delete(k);
        }
      }
      while (this.tokenValidationCache.size >= this.tokenCacheMax) {
        const oldest = this.tokenValidationCache.keys().next().value;
        if (oldest === undefined) break;
        this.tokenValidationCache.delete(oldest);
      }
    }
    this.tokenValidationCache.set(cacheKey, { address, cachedAt: now });
  }

  /**
   * 逐出某 address 在 F-5 正缓存里的全部条目。
   *
   * 为什么必须存在：键是 sha256(address|token) 单向哈希，无法按地址前缀删除，
   * 只能按值里的 address 扫描。不驱逐会让 rotateToken 之后旧 token 仍命中正缓存
   * ⇒「撤销凭据」出现最长 TTL 的失效窗口。
   */
  evictTokenValidationsFor(address: string): void {
    for (const [k, entry] of this.tokenValidationCache) {
      if (entry.address === address) this.tokenValidationCache.delete(k);
    }
  }

  /**
   * N34 (round-9): store an issued plaintext token, evicting expired/oldest
   * entries past the cap. An OVERWRITE of an existing key skips eviction
   * entirely (the map does not grow): R10's rotateToken seeding and
   * issueToken's startupId refinement both write the same key, and the
   * second write must not evict an unrelated executor's entry.
   */
  rememberIssuedToken(
    identityKey: string,
    entry: {
      token: string;
      startupId: string | null;
      issuedAt: number;
      address: string;
    },
  ): void {
    if (
      !this.issuedTokenCache.has(identityKey) &&
      this.issuedTokenCache.size >= this.tokenIssueCacheMax
    ) {
      for (const [k, v] of this.issuedTokenCache) {
        if (entry.issuedAt - v.issuedAt >= this.tokenIssueCacheTtlMs) {
          this.issuedTokenCache.delete(k);
        }
      }
      while (this.issuedTokenCache.size >= this.tokenIssueCacheMax) {
        const oldest = this.issuedTokenCache.keys().next().value;
        if (oldest === undefined) break;
        this.issuedTokenCache.delete(oldest);
      }
    }
    this.issuedTokenCache.set(identityKey, entry);
  }
}
