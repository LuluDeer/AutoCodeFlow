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
 *   0. PEM 私钥块（完整多行/JSON 转义 `\n` 闭合块，以及 ≤200 字符截断未闭合块；
 *      不误伤 `-----BEGIN CERTIFICATE-----` 公钥证书，非贪婪保尾）。
 *   ① 全大写 env 赋值：`DB_PASSWORD=…`（要求键名 ≥3 且全大写，env 形态）
 *   ② `Bearer <token>` 与 `Authorization[:=] Basic <b64>`：必须排在 ④ 之前——
 *      若 ④ 先把 `Bearer`/`Basic` 当凭据词的值吃掉，后续 JWT / Basic 载荷会裸露。
 *   ③ 连接串内嵌凭据：`scheme://[user]:password@host/...`（含空用户名 `redis://:pass@host`）。
 *   ④ 凭据词表的赋值（大小写不敏感，含复数）：`token=…`、`api_key: …`、
 *      `"password": "…"`。词表限定在凭据名上而不是「任意 key=」，否则
 *      `retries=3`/`timeout=30` 这类正常参数会被一起打码，预览失去可读性。
 *   ⑤ 裸 JWT（无 `Bearer ` 前缀的三段式 `ey….ey….sig`）。
 *   ⑥ 已知前缀的密钥：`sk-…` / `gh[pousr]_…` / `github_pat_…` / `AKIA…` / `ASIA…` /
 *      `xox[baprs]-…` / `glpat-…` / Stripe / `AIza…` / `npm_…` / `hf_…`。
 *   ⑦ 32+ 连续 hex（随机密钥/哈希样式）。
 *   ⑧ 40+ 无斜杠 base64 样式串（`[A-Za-z0-9+]`）。
 *   ⑨ 词元级高熵检测（R289-C1）：ASCII 独立词元（通道 A 无斜杠 24+、通道 B 非 URL/非路径
 *      含斜杠 Base64 36+），要求 3 类字符齐全（a-z / A-Z / 0-9）+ 跳变密度 ≥ 0.25 +
 *      Shannon 熵达阈值，且显式排除 UUID / 纯 hex / 时间戳迁移名 / URL 与文件路径。
 *      `preserveDigests` 短路排在全部规则（含高熵）之前。
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

/**
 * 0a（R289-C1）完整闭合 PEM 私钥块（含多行与 JSON 转义 `\n` 形态）。
 * 非贪婪匹配：保证 `-----END ... PRIVATE KEY-----` 之后的正常文本不被吞掉；
 * 仅匹配 `PRIVATE KEY`，不误伤 `-----BEGIN CERTIFICATE-----` 公钥证书。
 */
const PEM_PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * 0b（R289-C1）截断/未闭合的 PEM 私钥头 + 紧邻的 base64 / PEM 护甲头行。
 * 必须排在 0a 之后；同时覆盖真实换行与 JSON 转义 `\\n`，遇空行或含空格的普通说明行即止。
 */
const PEM_PRIVATE_KEY_UNCLOSED_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:(?:(?:\\r)?\\n|\r?\n)(?:[A-Za-z0-9+/=]{1,120}(?:\.{3})?|(?:Proc-Type|DEK-Info|Version|Hash|Cipher|Comment):[ \t]*[^\r\n\\]+))*/g;

/** ① 全大写 env 赋值（`KEY=value`）。 */
const ENV_ASSIGN_RE = /([A-Z_]{3,}\s*=\s*)[^\s\n]+/g;

/** ② `Bearer <token>`。 */
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * ②b（R289-C1）`Authorization[:=] Basic <base64>`。
 * 必须锚定 `Authorization`（避免误伤英文短语 `"Basic configuration"`），
 * 且必须排在 ④ `SECRET_ASSIGN_RE` 之前（否则 `Basic` 被吃掉、base64 载荷裸露）。
 */
const BASIC_AUTH_RE =
  /(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi;

/**
 * ③（R41 → R289-C1 修复空用户名）**连接串内嵌凭据**：`scheme://[user]:password@host/...`。
 *
 * 为什么需要：上游错误里经常回显完整 DSN（`postgres://app:secret@db:5432/x`）或
 * Redis 无用户名密码串（`redis://:secret@cache:6379/0`），既有规则对短密码漏网。
 * `[^:/@\s]*:` 允许用户名为空（修复旧 `+:` 漏掉 `redis://:pass@host` 的缺陷），
 * 且 `[^@\s/]+` 禁止跨 `/`，确保 `https://host:8080/path`、`mailto:`、`git@host:repo` 不误伤。
 * 只掩码 **userinfo 里的密码**（保留 scheme/用户名/host/path），日志仍可定位目标库。
 */
const CONN_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)([^@\s/]+)(@)/gi;

/**
 * ④ 凭据词表的赋值（大小写不敏感，`s?` 兼容复数：`tokens=` / `credentials=`）。
 * 值可以是带引号的串、也可以是普通 `\S+`；保留键名与分隔符，只替换值。
 */
const SECRET_ASSIGN_RE =
  /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|authorization|auth)s?\b(["']?)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;\n]+)/gi;

/**
 * ⑤（R289-C1）裸 JWT（无 `Bearer ` 前缀的三段式 base64url）。
 * `ey` 覆盖 JSON `{` 起始后的常见编码（`eyJ`/`eyI`/`eyA` 等），`Bearer ` 排在其前保持既有输出。
 */
const JWT_RE =
  /(?<![A-Za-z0-9_-])ey[A-Za-z0-9_-]{4,}\.ey[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;

/** ⑥ 已知前缀密钥（OpenAI / GitHub / AWS / Slack / GitLab / Stripe / Google / npm / HF）。 */
const KEY_PREFIX_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})\b/g;

/** ⑦ 32+ 连续 hex。
 *  ⚠ 2026-11-02 主会话实测：**纯 hex 长串也可能只是普通 ID**
 *  （实测 `task_0123456789abcdef0123456789abcdef` ⇒ `task_[REDACTED_HEX]`）。
 *  但**无法靠形态把二者分开**（真实 sha256 也是 64 位 hex）⇒ **保持原规则**：
 *  误伤长 ID 的代价是「错误信息里少一段 ID」；漏打真实密钥的代价是「密钥进审计表」。
 *  **后者不可接受** ⇒ 取舍明确：宁可误伤 ID，不漏密钥。
 */
const HEX_LONG_RE = /[0-9a-fA-F]{32,}/g;

/** ⑧ 40+ base64 样式串。 */
// b64 判据**必须排除路径形态**（2026-11-02 主会话实测修正）。
// 原规则 `/[A-Za-z0-9+/]{40,}={0,2}/g` 把 `/` 算进字符集 ⇒
//   `https://example.com/some/very/long/path/...` 被拦腰截成 `https://example.[REDACTED_B64]`，
//   **损坏了错误信息里的 URL**（排障关键信息）。实测原文见本文件末尾「误伤实测」。
// 收紧后的判据：base64 串**必须含大写或数字**（真实 base64 几乎必有；路径/ID 多为小写+连字符），
//   且**不得含 `/`**（路径必有 `/`）⇒ URL 与长路径不再命中。
// 方向说明：这是**把误伤收窄**，不是放宽——真正的高熵密钥仍被拦（见 selftest 的夹具）。
const B64_LONG_RE = /(?=[A-Za-z0-9+/]*[A-Z0-9])[A-Za-z0-9+]{40,}={0,2}/g;

/** ⑨（R289-C1）词元级高熵检测常量与判据（绝不做整串熵判，防止误伤中英文句/URL/路径）。 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_OR_DASH_RE = /^[0-9a-fA-F-]+$/;
const TIMESTAMP_PREFIXED_ID_RE = /^\d{10,14}-[A-Za-z]/;
const URL_OR_PATH_WORD_RE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/|\.{0,2}\/|~\/|[A-Za-z]:\\)/i;
const COMMON_FILE_EXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md|ya?ml|sh|log|zip|gz|tgz|png|svg|html|css|txt|sql)$/i;
const ENTROPY_TOKEN_NO_SLASH_RE =
  /(?<![A-Za-z0-9_+-])([A-Za-z0-9_+-]{24,}={0,2})(?![A-Za-z0-9_+-])/g;
const ENTROPY_TOKEN_WITH_SLASH_RE =
  /(?<![A-Za-z0-9_/+=\\-])([A-Za-z0-9+][A-Za-z0-9+/]{35,}={0,2})(?![A-Za-z0-9_/+=-])/g;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClassOf(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 97 && code <= 122) return 1; // a-z
  if (code >= 65 && code <= 90) return 2; // A-Z
  if (code >= 48 && code <= 57) return 3; // 0-9
  return 4;
}

function charClassTransitionRatio(s: string): number {
  if (s.length < 2) return 0;
  let transitions = 0;
  let prev = charClassOf(s[0]);
  for (let i = 1; i < s.length; i += 1) {
    const cur = charClassOf(s[i]);
    if (cur !== prev) transitions += 1;
    prev = cur;
  }
  return transitions / (s.length - 1);
}

function hasThreeAlnumClasses(s: string): boolean {
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

function redactHighEntropyTokens(text: string): string {
  return text.replace(/\S+/g, (word) => {
    let next = word;
    // 通道 B：非 URL / 非路径语境下的独立含 `/` Base64 密钥（如 40 位 AWS Secret Access Key）。
    const isUrlOrPath =
      URL_OR_PATH_WORD_RE.test(word) ||
      word.includes("://") ||
      word.includes("//") ||
      COMMON_FILE_EXT_RE.test(word.replace(/[)"'.,;:]+$/, ""));
    if (!isUrlOrPath && word.includes("/")) {
      next = next.replace(ENTROPY_TOKEN_WITH_SLASH_RE, (tok) => {
        if (!tok.includes("/")) return tok;
        if (tok.split("/").length > 5) return tok;
        if (!hasThreeAlnumClasses(tok)) return tok;
        if (charClassTransitionRatio(tok) < 0.25) return tok;
        if (shannonEntropy(tok) < 4.5) return tok;
        return "[REDACTED_HIGH_ENTROPY]";
      });
    }
    // 通道 A：无斜杠随机 base64url / 字母数字凭据（24–39 位等绕过 HEX_LONG_RE / B64_LONG_RE 的形态）。
    return next.replace(ENTROPY_TOKEN_NO_SLASH_RE, (tok) => {
      if (UUID_RE.test(tok)) return tok;
      if (HEX_OR_DASH_RE.test(tok)) return tok;
      if (TIMESTAMP_PREFIXED_ID_RE.test(tok)) return tok;
      if (!hasThreeAlnumClasses(tok)) return tok;
      if (charClassTransitionRatio(tok) < 0.25) return tok;
      if (shannonEntropy(tok) < 4.4) return tok;
      return "[REDACTED_HIGH_ENTROPY]";
    });
  });
}

export interface SanitizeSecretsOptions {
  /** 整体 digest 原值保留（仅结果侧/对账场景）。默认 false（更严格）。 */
  preserveDigests?: boolean;
  /** 打码**之后**的长度上限；`undefined` = 不截断。 */
  maxLength?: number;
}

/**
 * 字符串脱敏（唯一实现）。空串原样返回，其余按上面的 0–⑨ 逐条掩码。
 */
export function sanitizeSecrets(
  input: string,
  opts: SanitizeSecretsOptions = {},
): string {
  if (!input) return input;
  // digest 保留必须先判（早于全部规则含高熵）：`0123…` 这类整体 digest 会命中 HEX_LONG_RE 被剥掉。
  if (opts.preserveDigests && DIGEST_ONLY_RE.test(input)) return input;
  const masked = redactHighEntropyTokens(
    input
      .replace(PEM_PRIVATE_KEY_BLOCK_RE, "[REDACTED_PEM]")
      .replace(PEM_PRIVATE_KEY_UNCLOSED_RE, "[REDACTED_PEM]")
      .replace(ENV_ASSIGN_RE, "$1[REDACTED]")
      // ② / ②b 必须早于 ④：见文件头注。
      .replace(BEARER_RE, "$1[REDACTED]")
      .replace(BASIC_AUTH_RE, "$1[REDACTED]")
      .replace(CONN_USERINFO_RE, "$1[REDACTED]$3")
      .replace(SECRET_ASSIGN_RE, "$1$2$3[REDACTED]")
      .replace(JWT_RE, "[REDACTED_JWT]")
      .replace(KEY_PREFIX_RE, "[REDACTED]")
      .replace(HEX_LONG_RE, "[REDACTED_HEX]")
      .replace(B64_LONG_RE, "[REDACTED_B64]"),
  );
  return opts.maxLength != null && masked.length > opts.maxLength
    ? masked.slice(0, opts.maxLength)
    : masked;
}
