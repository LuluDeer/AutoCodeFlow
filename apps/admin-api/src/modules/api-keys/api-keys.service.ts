import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ApiKey, ApiKeyScope } from "./entities/api-key.entity";
import { generateApiKey, hashApiKey } from "./api-key.util";
import { AuditService } from "../audit/audit.service";

export interface CreateApiKeyInput {
  userId: number;
  username?: string | null;
  name: string;
  scope: ApiKeyScope;
  /** Days until expiry; omit/0/null = never expires. */
  expiresInDays?: number | null;
  ip?: string | null;
}

export interface ApiKeyView {
  id: number;
  name: string;
  keyPrefix: string;
  scope: ApiKeyScope;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** Keys with a lastUsedAt older than this get their timestamp refreshed. */
const LAST_USED_THROTTLE_MS = 60_000;

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
  ) {}

  // ─── Management (JWT-only surface) ──────────────────────────────────────

  /** Create a key. The plaintext is part of the return value ONCE. */
  async create(
    input: CreateApiKeyInput,
  ): Promise<{ apiKey: ApiKeyView; plaintext: string }> {
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
      row.revokedAt = new Date();
      await this.repo.save(row);
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

  // ─── Authentication (guard branch) ──────────────────────────────────────

  /**
   * Validate a plaintext credential. Returns the row when it exists and is
   * neither expired nor revoked; otherwise null with a failure reason code.
   */
  async authenticate(plaintext: string): Promise<{
    apiKey: ApiKey | null;
    failure?: "unknown" | "expired" | "revoked";
  }> {
    const row = await this.repo.findOne({
      where: { keyHash: hashApiKey(plaintext) },
    });
    if (!row) return { apiKey: null, failure: "unknown" };
    if (row.revokedAt) return { apiKey: null, failure: "revoked" };
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return { apiKey: null, failure: "expired" };
    }
    await this.touchLastUsed(row);
    return { apiKey: row };
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

  /** Failed-authentication audit (unknown / expired / revoked). Fail-open. */
  async auditAuthFailure(
    keyPrefix: string,
    failure: "unknown" | "expired" | "revoked",
    ip?: string | null,
  ): Promise<void> {
    await this.safeAudit({
      action: "apikey.auth_failure",
      resource: "api_key",
      resourceId: keyPrefix,
      detail: { keyPrefix, failure },
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
