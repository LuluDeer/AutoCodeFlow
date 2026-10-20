/**
 * R110（SEC-MCP-REDACT）：工具出参的**凭据剥除**（防御纵深）。
 *
 * ## 为什么 MCP 侧要自己再挡一层
 *
 * 上游（admin-api）已经做了三件事：`webhookSecret` / `tokenHash` 的 `select: false`、响应 DTO 显式排除、
 * `env` 的 `maskReadSurface()`。R107-A1 逐项核对过，**当前是干净的**。
 *
 * 但 MCP 侧此前是 `JSON_CONTENT(data)` **逐字透传** —— 也就是说：干净的保证**完全依赖上游**。
 * 而上游的保证是三处彼此独立的约定（实体列、DTO、掩码函数），任何一处新增面时漏一次，
 * 凭据就**直接进 LLM 上下文**（然后可能被写进日志、被复述、被存进对话历史）。
 *
 * > 防御纵深的意义不是「上游会错」，而是「上游错了之后还有一层」。
 *
 * ## 判据
 *
 * - **整键删除**：键名命中敏感名单（大小写不敏感）⇒ 值替换为 `[redacted]`；
 * - **`env` 值选择性掩码**：`env` 是用户自己的配置（还可能是合法的非密值），所以只掩**键名像密钥**的那些，
 *   其余原样保留 —— 一刀切会把正常配置也涂掉，让 agent 失去排障能力；
 * - **有界递归**：深度上限 + 访问过集合（防循环引用把工具调用打挂）；
 * - **不改原对象**：返回新结构，避免影响调用方后续逻辑。
 */

/** 命中即整键替换为 `[redacted]` 的键名（大小写不敏感，精确匹配）。 */
const SENSITIVE_KEYS = new Set([
  'webhooksecret',
  'tokenhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'clientsecret',
  'secret',
  'secrets',
  'privatekey',
  'authorization',
]);

/** `env` 里「键名像密钥」的判据（值被掩码，键保留，便于排障时知道配了哪些键）。 */
const SECRETISH_ENV_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE)/i;

export const REDACTED = '[redacted]';

/** 递归深度上限：足够覆盖真实载荷，又不会在病态结构上打转。 */
const MAX_DEPTH = 12;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 剥除敏感字段，返回**新**结构（不改原对象）。
 */
export function redactSensitive(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.map((item) => redactSensitive(item, depth + 1, seen));
  }
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = raw === null || raw === undefined ? raw : REDACTED;
      continue;
    }
    if (key.toLowerCase() === 'env' && isPlainObject(raw)) {
      const env: Record<string, unknown> = {};
      for (const [envKey, envValue] of Object.entries(raw)) {
        env[envKey] = SECRETISH_ENV_KEY.test(envKey) && envValue !== null && envValue !== undefined
          ? REDACTED
          : redactSensitive(envValue, depth + 1, seen);
      }
      out[key] = env;
      continue;
    }
    out[key] = redactSensitive(raw, depth + 1, seen);
  }
  return out;
}
