import { createHash, randomBytes } from "crypto";
import { ApiKeyScope } from "./entities/api-key.entity";

/**
 * AUTH-03: pure API-Key helpers.
 *
 * Plaintext key format: `acf_<64 hex chars>` (32 random bytes).
 * Only the sha256 hash is persisted — the plaintext is returned exactly
 * once in the create-response and cannot be recovered afterwards.
 */

/** Prefix every plaintext key starts with (also the guard's dispatch marker). */
export const API_KEY_PLAINTEXT_PREFIX = "acf_";

/** Length of the display prefix (e.g. `acf_1a2b`) stored for identification. */
export const API_KEY_DISPLAY_PREFIX_LEN = 8;

export interface GeneratedApiKey {
  /** Full plaintext key — show once. */
  plaintext: string;
  /** First 8 chars — persisted for identification. */
  keyPrefix: string;
  /** sha256 hex of plaintext — persisted for lookup. */
  keyHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const plaintext = API_KEY_PLAINTEXT_PREFIX + randomBytes(32).toString("hex");
  return {
    plaintext,
    keyPrefix: plaintext.slice(0, API_KEY_DISPLAY_PREFIX_LEN),
    keyHash: hashApiKey(plaintext),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Does this bearer credential look like an API Key (dispatch marker)? */
export function looksLikeApiKey(
  credential: string | null | undefined,
): boolean {
  return (
    typeof credential === "string" &&
    credential.startsWith(API_KEY_PLAINTEXT_PREFIX)
  );
}

export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  "readonly",
  "trigger",
  "manage",
];
