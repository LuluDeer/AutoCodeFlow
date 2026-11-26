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

// ─── N19: spend limit over the existing `scopes` word list ─────────────────
//
// 不新增实体列、不建迁移：spendLimit 作为 `spend:<n>` 词复用 `scopes`
// varchar(128) 可空列（NF-01 已把它定义为空格分隔词表）。缺省（无该词）= 无限。
// 该词与 `task:trigger` 等真实 scope 词正交，认证分流只查具体词，不受影响。
/** Word prefix marking the spend cap inside the `scopes` word list. */
export const SPEND_LIMIT_SCOPE_PREFIX = "spend:";

/** Upper bound accepted by setSpendLimit — beyond it is a validation error. */
export const MAX_SPEND_LIMIT = 1_000_000_000;

/** Parse the `spend:<n>` word out of a scopes word list. null = unlimited. */
export function parseSpendLimit(
  scopes: string | null | undefined,
): number | null {
  if (!scopes) return null;
  for (const word of scopes.split(/\s+/)) {
    if (!word.startsWith(SPEND_LIMIT_SCOPE_PREFIX)) continue;
    const raw = word.slice(SPEND_LIMIT_SCOPE_PREFIX.length);
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

/** Scopes word list with the spend-cap word removed (view projection / rewrite). */
export function withoutSpendLimit(
  scopes: string | null | undefined,
): string | null {
  if (!scopes) return null;
  const rest = scopes
    .split(/\s+/)
    .filter((w) => w && !w.startsWith(SPEND_LIMIT_SCOPE_PREFIX));
  return rest.length ? rest.join(" ") : null;
}

/** Set (or clear with null) the spend-cap word, preserving other scope words. */
export function withSpendLimit(
  scopes: string | null | undefined,
  spendLimit: number | null | undefined,
): string | null {
  const base = withoutSpendLimit(scopes);
  if (spendLimit === null || spendLimit === undefined) return base;
  const token = `${SPEND_LIMIT_SCOPE_PREFIX}${spendLimit}`;
  return base ? `${base} ${token}` : token;
}
