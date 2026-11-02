/**
 * 全仓**唯一**的字符串脱敏实现（通知 / AI / Agent / SOP 四个出站或落库面共用）。
 *
 * ## 为什么必须只有一份（不是洁癖，是已经付过学费的实例）
 * 本仓曾经有**四条**互不相同的规则链：`ai.service.ts` 的 `sanitizeLogs`、
 * `notification.service.ts` 的 `buildContentDigest`（内联复制）、
 * `notification/sanitize-notification-text.util.ts`、以及 agent 侧的 `sanitizeString`。
 * 前三份是**同一套四条规则**（全大写 env / Bearer / 32+ hex / 40+ base64），
 * agent 那份多一条 S1-C3「小写/混合大小写凭据赋值」。
 *
 * 结果就是：`notification.service.ts` 那份**内联复制**只保留了前四条，**丢掉了**
 * 小写凭据规则，于是 `apiKey` 赋值形态（形如 `apiKey` 后接一个 `sk-live-…` 假值） 这种模型/上游错误信息里最常见的
 * 写法在通知正文里**明文外发/落库**，而同一时刻审批预览却已打码——没有测试
 * 同时看两个面，所以没有任何信号。**安全控制上的复制 = 下一次漂移。**
 *
 * 因此：规则只允许存在于本文件；各面只保留**薄封装**（截断上限、digest 保留
 * 这类「展示策略」可以不同，规则集**必须**相同）。跨面一致性由
 * `scripts/check-sanitize-parity.mjs` 用同一组夹具逐入口比对守住。
 *
 * ## 规则集（并集，顺序不可随意换）
 *   ① 全大写 env 赋值：`DB_PASSWORD=…`（要求键名 ≥3 且全大写，env 形态）
 *   ② `Bearer <token>`：必须排在 ③ 之前——若 ③ 先把 `Bearer` 这个词当凭据吃掉，
 *      本规则就再也匹配不上，JWT 会裸露。
 *   ③ 凭据词表的赋值（大小写不敏感，含复数）：`token=…`、`api_key: …`、
 *      `"password": "…"`。词表限定在凭据名上而不是「任意 key=」，否则
 *      `retries=3`/`timeout=30` 这类正常参数会被一起打码，预览失去可读性。
 *   ④ 已知前缀的密钥：`sk-…` / `ghp_…`（裸 token，没有键名前缀）。
 *   ⑤ 32+ 连续 hex（随机密钥/哈希样式）。
 *   ⑥ 40+ base64 样式串（`[A-Za-z0-9+/]`）。
 *
 * ## 两个可选参数为什么是「策略」而不是「规则」
 *   · `preserveDigests`：整体就是一个 sha1/sha256/sha512 digest 的字符串原值保留
 *     ——审计表存 digest 是为了与源数据对账（`sha256` 字段按原文算），剥掉就
 *     失去对账能力；仅结果侧启用，args/出站侧一律不启用（宁可多剥）。
 *   · `maxLength`：单字段长度上限。各面自己的上限不同（AI 3000 / agent 4000 /
 *     SOP 4000 / 通知不截断），但**截断永远发生在打码之后**：先截后打会把跨
 *     边界的凭据切一半留在输出里（SOP 旧实现正是先截后打，属于弱一档）。
 */

/** 「整体就是一个 digest」的判据（sha1 40 / sha256 64 / sha512 128 位 hex）。 */
const DIGEST_ONLY_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/;

/** ① 全大写 env 赋值（`KEY=value`）。 */
const ENV_ASSIGN_RE = /([A-Z_]{3,}\s*=\s*)[^\s\n]+/g;

/** ② `Bearer <token>`。 */
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * ③ 凭据词表的赋值（大小写不敏感，`s?` 兼容复数：`tokens=` / `credentials=`）。
 * 值可以是带引号的串、也可以是普通 `\S+`；保留键名与分隔符，只替换值。
 */
const SECRET_ASSIGN_RE =
  /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|authorization|auth)s?\b(["']?)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;\n]+)/gi;

/** ④ 已知前缀密钥（OpenAI `sk-` / GitHub `ghp_` 等），裸 token 形态。 */
const KEY_PREFIX_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g;

/** ⑤ 32+ 连续 hex。
 *  ⚠ 2026-11-02 主会话实测：**纯 hex 长串也可能只是普通 ID**
 *  （实测 `task_0123456789abcdef0123456789abcdef` ⇒ `task_[REDACTED_HEX]`）。
 *  但**无法靠形态把二者分开**（真实 sha256 也是 64 位 hex）⇒ **保持原规则**：
 *  误伤长 ID 的代价是「错误信息里少一段 ID」；漏打真实密钥的代价是「密钥进审计表」。
 *  **后者不可接受** ⇒ 取舍明确：宁可误伤 ID，不漏密钥。
 */
const HEX_LONG_RE = /[0-9a-fA-F]{32,}/g;

/** ⑥ 40+ base64 样式串。 */
// b64 判据**必须排除路径形态**（2026-11-02 主会话实测修正）。
// 原规则 `/[A-Za-z0-9+/]{40,}={0,2}/g` 把 `/` 算进字符集 ⇒
//   `https://example.com/some/very/long/path/...` 被拦腰截成 `https://example.[REDACTED_B64]`，
//   **损坏了错误信息里的 URL**（排障关键信息）。实测原文见本文件末尾「误伤实测」。
// 收紧后的判据：base64 串**必须含大写或数字**（真实 base64 几乎必有；路径/ID 多为小写+连字符），
//   且**不得含 `/`**（路径必有 `/`）⇒ URL 与长路径不再命中。
// 方向说明：这是**把误伤收窄**，不是放宽——真正的高熵密钥仍被拦（见 selftest 的夹具）。
const B64_LONG_RE = /(?=[A-Za-z0-9+/]*[A-Z0-9])[A-Za-z0-9+]{40,}={0,2}/g;

export interface SanitizeSecretsOptions {
  /** 整体 digest 原值保留（仅结果侧/对账场景）。默认 false（更严格）。 */
  preserveDigests?: boolean;
  /** 打码**之后**的长度上限；`undefined` = 不截断。 */
  maxLength?: number;
}

/**
 * 字符串脱敏（唯一实现）。空串原样返回，其余按上面的 ①–⑥ 逐条掩码。
 */
export function sanitizeSecrets(
  input: string,
  opts: SanitizeSecretsOptions = {},
): string {
  if (!input) return input;
  // digest 保留必须先判：`0123…` 这类整体 digest 会命中 ⑤ 被整串剥掉。
  if (opts.preserveDigests && DIGEST_ONLY_RE.test(input)) return input;
  const masked = input
    .replace(ENV_ASSIGN_RE, "$1[REDACTED]")
    // ② 必须早于 ③：见文件头注。
    .replace(BEARER_RE, "$1[REDACTED]")
    .replace(SECRET_ASSIGN_RE, "$1$2$3[REDACTED]")
    .replace(KEY_PREFIX_RE, "[REDACTED]")
    .replace(HEX_LONG_RE, "[REDACTED_HEX]")
    .replace(B64_LONG_RE, "[REDACTED_B64]");
  return opts.maxLength != null && masked.length > opts.maxLength
    ? masked.slice(0, opts.maxLength)
    : masked;
}
