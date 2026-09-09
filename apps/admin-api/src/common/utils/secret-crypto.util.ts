import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

/**
 * SEC-02: task-level secrets at-rest encryption (AES-256-GCM).
 *
 * Design (docs/DEVELOPMENT-PLAN-2026-09.md §8):
 * - Key material comes from env (KMS semantics: the deployment injects the
 *   32-byte key via `SEC_SECRETS_KEY`; rotation = re-write rows with the new
 *   key, the self-describing `enc:v1:` prefix leaves room for a future
 *   `enc:v2:` under a different key id).
 * - Wire format: `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>` — a value that
 *   does not carry the prefix is treated as plaintext and passed through
 *   untouched, so ciphertext and legacy plaintext rows can coexist during the
 *   zero-downtime upgrade window (no data migration required: a row written
 *   before the key was configured re-encrypts naturally on its next update).
 * - Degraded mode: when no key is configured the util stores plaintext and
 *   warns once (zero-breakage upgrade path for existing deployments — the
 *   rest of the platform behaves identically). Decryption of an `enc:v1:`
 *   value without a key throws so callers can surface a clear configuration
 *   error instead of silently dispatching a broken payload.
 *
 * Consumers (all through SecretCryptoService, never these raw functions):
 * - TaskService.create/update → encrypt task.secrets before persistence;
 * - TaskService.findOne/all reads → mask secrets in API responses;
 * - ExecutorService.dispatch/dispatchBroadcast → decrypt + merge into the
 *   dispatch payload (never into TaskExecution.params — the plaintext must
 *   not re-enter the database via a second jsonb column).
 */

/** Prefix marking an encrypted-at-rest value; kept in sync with v1 below. */
export const SECRET_ENC_PREFIX = "enc:v1:";

/** Shape of an encrypted envelope: `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`. */
export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SECRET_ENC_PREFIX);
}

/**
 * Parse a raw key env value into exactly 32 bytes. Accepts:
 * - 64 hex chars (openssl rand -hex 32)
 * - 44 base64 chars (openssl rand -base64 32 | tr -d '\n') or 43 unpadded
 * - any other non-empty string → stretched via sha-256 so short passphrases
 *   still yield a 32-byte key (documented convenience, not best practice).
 */
export function parseSecretsKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("SEC_SECRETS_KEY is empty");
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  if (padded.length === 44 && /^[A-Za-z0-9+/]+={0,2}$/.test(padded)) {
    const buf = Buffer.from(padded, "base64");
    if (buf.length === 32) return buf;
  }
  // Convenience fallback: deterministic stretch of arbitrary passphrases.
  return createHash("sha256").update(trimmed, "utf8").digest();
}

/** Encrypt a plaintext value into the `enc:v1:...` envelope. */
export function encryptSecretValue(plaintext: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error(
      `SEC-02 secret key must be 32 bytes (AES-256), got ${key.length}`,
    );
  }
  const iv = randomBytes(12); // GCM standard nonce size
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "enc:v1",
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt an `enc:v1:...` envelope. Throws on wrong key (GCM auth failure),
 * malformed envelopes, or truncated fields — callers must treat decryption
 * failure as a configuration/deployment error, never as "no secrets".
 */
export function decryptSecretValue(envelope: string, key: Buffer): string {
  if (!isEncryptedSecret(envelope)) {
    throw new Error("Value is not an enc:v1 secret envelope");
  }
  const parts = envelope.slice(SECRET_ENC_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error(
      "Malformed secret envelope (expected enc:v1:<iv>:<tag>:<ciphertext>)",
    );
  }
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(parts[0], "base64");
    tag = Buffer.from(parts[1], "base64");
    ciphertext = Buffer.from(parts[2], "base64");
  } catch {
    throw new Error("Malformed secret envelope (invalid base64 field)");
  }
  if (iv.length === 0 || tag.length === 0) {
    throw new Error("Malformed secret envelope (empty iv/tag)");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Recursively encrypt every leaf string of a secrets object. Empty objects
 * pass through as-is (still valid jsonb), but nothing sensitive survives in
 * the clear: any string leaf (including nested objects) gets the envelope.
 */
export function encryptSecretsObject(
  secrets: Record<string, unknown> | null | undefined,
  key: Buffer | null,
): Record<string, unknown> | null | undefined {
  if (secrets === null || secrets === undefined || !key) return secrets;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (typeof v === "string") {
      // Idempotent: an already-encrypted value is never double-wrapped.
      out[k] = isEncryptedSecret(v) ? v : encryptSecretValue(v, key);
    } else if (typeof v === "object" && !Array.isArray(v)) {
      out[k] = encryptSecretsObject(v as Record<string, unknown>, key) ?? {};
    } else {
      // Numbers/booleans/arrays: secrets are credential-shaped by contract,
      // stringify so a `{"port": 5432}`-style non-secret does not crash.
      out[k] = encryptSecretValue(String(v), key);
    }
  }
  return out;
}

/**
 * Recursively decrypt an encrypted secrets object. Plaintext leaves (rows
 * written before the key was configured) pass through untouched, so the
 * dispatch path is format-agnostic. With key=null the plaintext passthrough
 * still works; envelope leaves throw (caller decides how to surface it).
 */
export function decryptSecretsObject(
  secrets: Record<string, unknown> | null | undefined,
  key: Buffer | null,
): Record<string, unknown> | null | undefined {
  if (secrets === null || secrets === undefined) return secrets;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === "string" && isEncryptedSecret(v)) {
      if (!key) {
        throw new Error(
          `SEC-02: task secret "${k}" is encrypted but SEC_SECRETS_KEY is not configured`,
        );
      }
      out[k] = decryptSecretValue(v, key);
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = decryptSecretsObject(v as Record<string, unknown>, key) ?? {};
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Shape-independent mask used by API read paths: never leak leaf values. */
export function maskSecretsObject(
  secrets: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (secrets === null || secrets === undefined) return secrets;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (typeof v === "object" && !Array.isArray(v)) {
      out[k] = maskSecretsObject(v as Record<string, unknown>) ?? {};
    } else {
      out[k] = "******";
    }
  }
  return out;
}
