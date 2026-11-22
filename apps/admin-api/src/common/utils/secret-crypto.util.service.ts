import { createHmac } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  decryptSecretsObject,
  decryptSecretValue,
  encryptSecretsObject,
  encryptSecretValue,
  maskSecretsObject,
  mergeSecretsOnUpdate,
  parseSecretsKey,
} from "./secret-crypto.util";

/**
 * SEC-02: injectable wrapper around the raw secret-crypto util. Owns the
 * key lifecycle: the key is resolved once from `secrets.key` (env
 * `SEC_SECRETS_KEY`, mapped in configuration.ts, Joi-registered in
 * app.module.ts) — the KMS-semantic boundary of this deployment.
 *
 * Degraded mode: key = null when `SEC_SECRETS_KEY` is unset (or blank).
 * Write paths then store plaintext and warn ONCE per process (zero-breakage
 * upgrade path — an existing deployment without the env var behaves exactly
 * as before). Setting the var switches every subsequent write to encrypted
 * storage; plaintext rows re-encrypt naturally on their next update.
 */
@Injectable()
export class SecretsCryptoService {
  private readonly logger = new Logger(SecretsCryptoService.name);
  private readonly key: Buffer | null;
  private readonly warnOnce = { fired: false };

  constructor(configService: ConfigService) {
    const raw = configService.get<string>("secrets.key") ?? "";
    if (raw.trim() === "") {
      this.key = null;
      // One warn per process (not per write) — degraded mode is a
      // deployment-level state, not a per-request anomaly.
      this.logger.warn(
        "SEC_SECRETS_KEY is not configured — task secrets are stored in PLAINTEXT " +
          "(SEC-02 degraded mode). Set a 32-byte key (hex/base64) to enable at-rest encryption.",
      );
    } else {
      this.key = parseSecretsKey(raw);
    }
  }

  /** True when at-rest encryption is active (key configured). */
  get encryptionEnabled(): boolean {
    return this.key !== null;
  }

  /** Encrypt a secrets object for persistence; null/undefined passthrough. */
  encryptForStorage(
    secrets: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null | undefined {
    if ((secrets === null || secrets === undefined) && !this.key) {
      return secrets;
    }
    if (
      !this.key &&
      secrets &&
      Object.keys(secrets).length > 0 &&
      !this.warnOnce.fired
    ) {
      this.warnOnce.fired = true;
      this.logger.warn(
        "Storing task secrets in plaintext (SEC_SECRETS_KEY unset) — set the key to encrypt at rest.",
      );
    }
    return encryptSecretsObject(secrets, this.key);
  }

  /**
   * SEC-02 follow-up (production incident): apply a PATCH to stored secrets
   * **per key** instead of replacing the object wholesale.
   *
   * The read path masks every leaf (`******`), so a console that shows the
   * existing keys necessarily holds those masked values. Under replace
   * semantics, saving that view persists the mask AS the credential: the real
   * value is destroyed, and the task then fails with "missing credential"
   * while the UI still shows the key. Per-key merge removes the hazard at the
   * persistence boundary (the authoritative place) instead of relying on every
   * client to never send what it was given:
   *   · key absent  → kept;
   *   · leaf = mask → kept (echo of the read path);
   *   · leaf = null → deleted;
   *   · otherwise   → encrypted and written.
   * Callers pass `incoming = null` for the documented "clear all" signal.
   */
  applyPatch(
    stored: Record<string, unknown> | null | undefined,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged = mergeSecretsOnUpdate(stored, incoming, this.key);
    if (!this.key && Object.keys(merged).length > 0 && !this.warnOnce.fired) {
      this.warnOnce.fired = true;
      this.logger.warn(
        "Storing task secrets in plaintext (SEC_SECRETS_KEY unset) — set the key to encrypt at rest.",
      );
    }
    return merged;
  }

  /**
   * Decrypt for dispatch. Envelope leaves throw when the key is missing —
   * a task written under encryption must never dispatch silently-degraded.
   */
  decryptForDispatch(
    secrets: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null | undefined {
    return decryptSecretsObject(secrets, this.key);
  }

  /** Mask leaf values for API responses (never leak secrets to the UI). */
  maskForResponse(
    secrets: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null | undefined {
    return maskSecretsObject(secrets);
  }

  // Exposed for tests and advanced callers (e.g. future key-rotation jobs).
  encryptValue(plaintext: string): string {
    if (!this.key) {
      throw new Error("无法加密：未配置 SEC_SECRETS_KEY（SEC-02 降级模式）");
    }
    return encryptSecretValue(plaintext, this.key);
  }

  decryptValue(envelope: string): string {
    return decryptSecretValue(envelope, this.key);
  }

  /**
   * 从任意输入派生稳定匿名 ID，用于 TTFV 埋点（install_id / task_id_hash /
   * execution_id_hash），复用本服务的 `secrets.key` 作为 HMAC 密钥，不向调用方
   * 暴露原始 key（符合方案 §3.2 "复用 SecretsCryptoService 信封体系"的意图）。
   *
   * `purpose` 做域分离：`ttfv-install` / `ttfv-task` / `ttfv-execution`
   * 保证同一个设备指纹或 UUID 在不同用途下生成不同 ID，防止跨语境关联
   * （否则一个 install_id 会与 task_id_hash 相等，形成可追踪的统一标识）。
   *
   * 无 key（degraded 模式）时返回 null 而不是臆造 ID —— 隐私姿态是
   * "无密钥不采集"：没有稳定的派生密钥时，任何"匿名 ID"都不具备稳定性与
   * 不可预测性，宁可缺失也不能写入伪匿名标识。
   *
   * 取 HMAC 前 16 字节（32 hex chars）：在碰撞概率（2^128 空间，远低于
   * 实际事件量级）与存储成本之间取得平衡；截断后的输出不含 input 子串。
   *
   * 拼接格式 `${purpose}:${input}` 的取值域假设：purpose 为固定枚举
   * （ttfv-install / ttfv-task / ttfv-execution），input 为设备指纹或 UUID
   * （hex / 固定格式，不含冒号），故无冒号歧义碰撞风险。
   */
  deriveAnonymousId(input: string, purpose: string): string | null {
    if (this.key === null) return null;
    return createHmac("sha256", this.key)
      .update(`${purpose}:${input}`)
      .digest("hex")
      .slice(0, 32);
  }
}
