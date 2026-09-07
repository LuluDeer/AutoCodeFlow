import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  decryptSecretsObject,
  decryptSecretValue,
  encryptSecretsObject,
  encryptSecretValue,
  maskSecretsObject,
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
    if (!this.key && secrets && Object.keys(secrets).length > 0 && !this.warnOnce.fired) {
      this.warnOnce.fired = true;
      this.logger.warn(
        "Storing task secrets in plaintext (SEC_SECRETS_KEY unset) — set the key to encrypt at rest.",
      );
    }
    return encryptSecretsObject(secrets, this.key);
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
      throw new Error(
        "Cannot encrypt: SEC_SECRETS_KEY is not configured (SEC-02 degraded mode)",
      );
    }
    return encryptSecretValue(plaintext, this.key);
  }

  decryptValue(envelope: string): string {
    return decryptSecretValue(envelope, this.key);
  }
}
