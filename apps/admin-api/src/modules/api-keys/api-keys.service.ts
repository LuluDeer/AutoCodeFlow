import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError。
import { AppError } from "../../common/errors/app-error";
import {
  ApiKey,
  ApiKeyScope,
  parseApiKeyScopes,
} from "./entities/api-key.entity";
import { generateApiKey, hashApiKey } from "./api-key.util";
import { AuditService } from "../audit/audit.service";
// R32-A4: 属主账号状态（存在 / 未禁用）是 API Key 凭据的活性条件——
// 见 authenticate() 头注。
import { UsersService } from "../users/users.service";

export interface CreateApiKeyInput {
  userId: number;
  username?: string | null;
  name: string;
  scope: ApiKeyScope;
  /** NF-01: extra narrow-domain scopes (word list, e.g. "task:trigger"). */
  scopes?: string | null;
  /** Days until expiry; omit/0/null = never expires. */
  expiresInDays?: number | null;
  ip?: string | null;
}

/**
 * R32-A4: 认证失败原因（仅落审计，线上统一 401 防枚举）。
 * `owner_inactive` = 凭据本身未过期未吊销，但**属主账号**已被禁用或删除。
 */
export type ApiKeyFailure =
  "unknown" | "expired" | "revoked" | "owner_inactive";

export interface ApiKeyView {
  id: number;
  name: string;
  keyPrefix: string;
  scope: ApiKeyScope;
  /** NF-01: extra narrow-domain scopes (word list, e.g. "task:trigger"). */
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** Keys with a lastUsedAt older than this get their timestamp refreshed. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * A-9（R3-A 审计）: 每用户活跃（未吊销）API Key 的默认上限。key 本体是
 * sha256 哈希行，无界签发虽不直接泄露凭据，但会让「凭据卫生」失去抓手
 * （遗忘/遗留 key 永久有效）。运维可经配置节 apiKeys.maxActivePerUser 覆盖；
 * 未配置（含既有单测裸装配不提供 ConfigService）回落本常量。
 */
const MAX_ACTIVE_KEYS_PER_USER = 20;

/**
 * AUTH-03: CRUD + authentication lookup for limited API Keys.
 *
 * Management endpoints are JWT-only (guard enforces); this service is also
 * consumed by the guard branch for sha256 lookup + expiry/revocation checks.
 * Audit points: create / revoke / first-use-and-every-throttled-refresh /
 * failed-auth (unknown key / expired / revoked) — fail-open on audit errors.
 */
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @InjectRepository(ApiKey)
    private readonly repo: Repository<ApiKey>,
    private readonly auditService: AuditService,
    // R32-A4: 每次认证都要复核 key 属主的账号状态（禁用/删除即失效）。
    private readonly usersService: UsersService,
    // A-9: @Optional —— 既有单测直接 new/Test 装配只给 repo+audit，ConfigService
    // 缺席时 maxActiveKeysPerUser() 回落常量（先例同 auth.service 的 LeaderGate）。
    @Optional()
    private readonly configService?: ConfigService | null,
  ) {}

  /** A-9: 生效的每用户活跃 key 上限（配置优先，无配置回落常量）。 */
  private maxActiveKeysPerUser(): number {
    const configured = this.configService?.get<number>(
      "apiKeys.maxActivePerUser",
    );
    return configured && configured > 0
      ? Math.floor(configured)
      : MAX_ACTIVE_KEYS_PER_USER;
  }

  // ─── Management (JWT-only surface) ──────────────────────────────────────

  /** Create a key. The plaintext is part of the return value ONCE. */
  async create(
    input: CreateApiKeyInput,
  ): Promise<{ apiKey: ApiKeyView; plaintext: string }> {
    // A-9: 配额闸——按属主 userId 统计活跃（未吊销）key，超限 409。判定与
    // 写入非同一原子操作（无「计数」唯一约束可用），极端并发下可能短暂超额，
    // 属可接受的软限（审计面记录每次创建，可事后清理）。
    const activeCount = await this.repo.count({
      where: { userId: input.userId, revokedAt: IsNull() },
    });
    const maxKeys = this.maxActiveKeysPerUser();
    if (activeCount >= maxKeys) {
      throw new AppError("API_KEY_QUOTA_CONFLICT", { max: maxKeys });
    }
    const { plaintext, keyPrefix, keyHash } = generateApiKey();
    let expiresAt: Date | null = null;
    if (input.expiresInDays && input.expiresInDays > 0) {
      expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
    }
    const row = await this.repo.save(
      this.repo.create({
        userId: input.userId,
        name: input.name,
        keyPrefix,
        keyHash,
        scope: input.scope,
        // NF-01: normalized word list (whitespace-collapsed, trimmed).
        scopes: input.scopes
          ? input.scopes.split(/\s+/).filter(Boolean).join(" ")
          : null,
        expiresAt,
      }),
    );
    await this.safeAudit({
      userId: input.userId,
      username: input.username ?? undefined,
      action: "apikey.create",
      resource: "api_key",
      resourceId: String(row.id),
      detail: {
        name: input.name,
        scope: input.scope,
        scopes: parseApiKeyScopes(input.scopes ?? null),
        keyPrefix,
        expiresInDays: input.expiresInDays ?? null,
      },
      ip: input.ip ?? undefined,
    });
    return { apiKey: this.toView(row), plaintext };
  }

  /** List keys owned by one user (hash never leaves the service). */
  async listForUser(userId: number): Promise<ApiKeyView[]> {
    const rows = await this.repo.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
    return rows.map((r) => this.toView(r));
  }

  /** Soft-revoke: sets revokedAt. Only the owner may revoke (checked here). */
  async revoke(
    id: number,
    userId: number,
    username?: string | null,
    ip?: string | null,
  ): Promise<ApiKeyView | null> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row || row.userId !== userId) return null;
    if (!row.revokedAt) {
      const revokedAt = new Date();
      // R32-C1（类别 2，同型漏改）：**列级 UPDATE，只写 revokedAt**。
      //
      // 此前是 `row.revokedAt = new Date(); await this.repo.save(row)`——整行
      // 回写（TypeORM save 无脏检查，row 是 findOne 读到的**快照**，其
      // lastUsedAt/keyHash/expiresAt 全带值）。而同一个文件的另一半
      // （touchLastUsed:234）**刻意**用列级 update 只写 lastUsedAt，两处口径
      // 相反，于是整行写会把 touchLastUsed 刚落的 lastUsedAt 覆盖回快照值
      // （null 或旧时间）→ 下一次 authenticate 又判「首次使用」，重复落
      // `apikey.used` firstUse 审计行——凭据卫生审计的证据被污染（R32-A4 刚
      // 把「哪一把 key / 属于谁」做成可追溯，这里会把该证据打回旧值）。
      //
      // 更根本的口径：api_keys 是**凭据实体**，写面只应触碰自己要改的列。
      // 与 R32-A4 把 totp 三处（auth.service:255/282/317）从 saveUser 改成
      // 列级 UPDATE 是同一纪律——那次只修了 auth 域，本处属同型漏改。
      // adr-026-exempt: 只写 revokedAt 一列，且「吊销」是幂等语义——并发重复吊销写的是
      // 同一语义值（先后相差毫秒），不存在「谁赢」的判定；真正的状态闸在 authenticate()
      // 里按 revokedAt 判（R32-A4 的属主闸 + 本列共同构成活性条件）。
      await this.repo.update({ id }, { revokedAt });
      // 返回值仍是「吊销后的视图」：显式回填刚写入的值（不是重新查库——
      // 与改动前 save() 返回同一对象语义一致，且少一次往返）。
      row.revokedAt = revokedAt;
      await this.safeAudit({
        userId,
        username: username ?? undefined,
        action: "apikey.revoke",
        resource: "api_key",
        resourceId: String(id),
        detail: { name: row.name, keyPrefix: row.keyPrefix, scope: row.scope },
        ip: ip ?? undefined,
      });
    }
    return this.toView(row);
  }

  /**
   * Hard delete（永久删除）：只允许删**已失效**的行（已吊销 / 已过期）。
   *
   * 为什么不让活跃 key 一步删掉：吊销与删除是两种语义——吊销是「立即止血」，
   * 会留下 `apikey.revoke` 审计行；删除是「清理不再有活性的行」。把两者合成
   * 一次点击，会让在用凭据被静默抹掉，且审计链里只剩一条 delete，事后无法
   * 区分「先吊销后清理」与「直接删掉一把在用的 key」。
   *
   * 属主校验与 revoke 同口径（非属主一律 null → 上层 404，不泄露存在性）。
   * 审计 detail 里保留 name / keyPrefix / 删除时的状态，行虽删除但证据可追溯。
   */
  async remove(
    id: number,
    userId: number,
    username?: string | null,
    ip?: string | null,
  ): Promise<ApiKeyView | null> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row || row.userId !== userId) return null;
    const expired =
      !!row.expiresAt && row.expiresAt.getTime() <= Date.now();
    if (!row.revokedAt && !expired) {
      throw new AppError("API_KEY_DELETE_ACTIVE_FORBIDDEN", { apiKeyId: id });
    }
    // 按主键删除：属主与状态已在上面判定，where 只需 id（避免装配出的
    // `{ id, userId }` 形态被 ADR-026 守卫误读成「多键但无状态谓词」）。
    await this.repo.delete({ id });
    await this.safeAudit({
      userId,
      username: username ?? undefined,
      action: "apikey.delete",
      resource: "api_key",
      resourceId: String(id),
      detail: {
        name: row.name,
        keyPrefix: row.keyPrefix,
        scope: row.scope,
        // 删除时的失效依据（二者其一非空），供凭据卫生审计回溯。
        revokedAt: row.revokedAt,
        expiresAt: row.expiresAt,
      },
      ip: ip ?? undefined,
    });
    return this.toView(row);
  }

  // ─── Authentication (guard branch) ──────────────────────────────────────

  /**
   * Validate a plaintext credential. Returns the row when it exists and is
   * neither expired nor revoked; otherwise null with a failure reason code.
   */
  async authenticate(plaintext: string): Promise<{
    apiKey: ApiKey | null;
    failure?: ApiKeyFailure;
    /** 命中的行（含过期/吊销/属主失活）——审计要指向**具体** key 而不是前缀。 */
    row?: ApiKey | null;
  }> {
    const row = await this.repo.findOne({
      where: { keyHash: hashApiKey(plaintext) },
    });
    if (!row) return { apiKey: null, failure: "unknown" };
    if (row.revokedAt) return { apiKey: null, failure: "revoked", row };
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return { apiKey: null, failure: "expired", row };
    }
    // R32-A4: 属主账号状态闸。
    //
    // 缺陷现场：key 的活性此前只看**自身**两列（revokedAt / expiresAt），
    // 完全不看属主。于是「禁用用户」与「删除用户」这两个最常用的收敛动作对
    // API Key 完全无效：被禁用账号的 key 仍能继续认证，直到 30 天/永不过期
    // 的 expiresAt 或手工吊销为止（users.service.remove 只回收 refresh_tokens，
    // 不回收 api_keys）——禁用账号本该是「立即止血」，却留下一条长效旁路。
    // JWT 面早已有同款闸（jwt.strategy.validate：用户不存在 → TOKEN_USER_NOT_FOUND，
    // isActive=false → ACCOUNT_INACTIVE），凭据面必须对齐。
    //
    // 每次请求都现读（无缓存）——禁用/删除在**下一个请求**即生效，与
    // revokedAt/expiresAt 的即时性同档。失败原因只落审计，线上仍是统一 401，
    // 不给「key 有效但账号被禁用」留枚举口。
    const owner = await this.usersService.findByIdOrNull(row.userId);
    if (!owner || !owner.isActive) {
      return { apiKey: null, failure: "owner_inactive", row };
    }
    await this.touchLastUsed(row);
    return { apiKey: row, row };
  }

  /** Throttled lastUsedAt refresh (≤1 write/min/key) to avoid write amplification. */
  private async touchLastUsed(row: ApiKey): Promise<void> {
    const now = Date.now();
    if (
      row.lastUsedAt &&
      now - row.lastUsedAt.getTime() < LAST_USED_THROTTLE_MS
    ) {
      return;
    }
    const first = !row.lastUsedAt;
    try {
      await this.repo.update(row.id, { lastUsedAt: new Date(now) });
      if (first) {
        await this.safeAudit({
          userId: row.userId,
          action: "apikey.used",
          resource: "api_key",
          resourceId: String(row.id),
          detail: { name: row.name, keyPrefix: row.keyPrefix, firstUse: true },
        });
      }
    } catch (err) {
      // Non-fatal: usage tracking must never break authentication.
      this.logger.warn(`apikey lastUsedAt update failed: ${String(err)}`);
    }
  }

  /**
   * Failed-authentication audit (unknown / expired / revoked / owner_inactive).
   * Fail-open.
   *
   * R32-A4: 命中的行（`hit`）存在时必须落到**具体 key**：旧实现只记
   * `credential.slice(0, 8)`（`acf_` + 4 位 hex = 16 bit，既不唯一也不
   * 可反查属主）。安全排查的第一个问题恰恰是「哪一把 key / 属于谁」——
   * 例如吊销后仍有人在用的那把，现在是 resourceId=行 id + userId + name，
   * 只有**未命中**（unknown，库里没有这一行）才退化为前缀。
   */
  async auditAuthFailure(
    keyPrefix: string,
    failure: ApiKeyFailure,
    ip?: string | null,
    hit?: ApiKey | null,
  ): Promise<void> {
    await this.safeAudit({
      userId: hit?.userId,
      action: "apikey.auth_failure",
      resource: "api_key",
      resourceId: hit ? String(hit.id) : keyPrefix,
      detail: {
        keyPrefix,
        failure,
        apiKeyId: hit?.id ?? null,
        name: hit?.name ?? null,
        ownerId: hit?.userId ?? null,
      },
      result: "failure",
      ip: ip ?? undefined,
    });
  }

  // ─── Housekeeping ───────────────────────────────────────────────────────

  /** Daily cron: purge expired keys soft-revoked >30 days ago is NOT done
   *  (audit trail); instead expire-mark keys whose expiresAt passed. */
  // (no cron — expiry is evaluated lazily at authenticate(); avoids another
  //  scheduled job for zero behavioral gain)

  private toView(row: ApiKey): ApiKeyView {
    return {
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      scope: row.scope,
      scopes: parseApiKeyScopes(row.scopes),
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    };
  }

  /** Audit must never break the main flow (established fail-open pattern). */
  private async safeAudit(
    payload: Parameters<AuditService["log"]>[0],
  ): Promise<void> {
    try {
      await this.auditService.log(payload);
    } catch (err) {
      this.logger.warn(`apikey audit write failed: ${String(err)}`);
    }
  }
}
