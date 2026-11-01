/**
 * S7-G1（第五阶段）：Agent 面的脱敏入口（从 `ToolExecutorService` 逐字搬出）。
 *
 * ## 规则本体不在这里
 * 第六阶段起，字符串规则**上移**到 `common/utils/sanitize-secrets.util.ts`：
 * 通知 / AI / SOP / Agent 四个面共用**同一份**实现（本文件只保留 agent 特有的
 * 结构递归 `sanitizeValue` 与薄封装 `sanitizeString`）。原因见那个文件的头注——上一次
 * `notification.service.ts` 的内联复制丢掉小写凭据规则，导致
 * `apiKey` 赋值形态（形如 `apiKey` 后接一个 `sk-live-…` 假值） 明文进通知正文；「一处规则、多处 import」是唯一能
 * 避免下一次漂移的形态。
 *
 * 本文件保留同名导出（`sanitizeString` 等）做**转发**，以免动 20+ 个调用点
 * ——与 `tool-result-shaping.ts` 的搬运先例一致（零行为变化的搬移，除规则集
 * 本身向共享实现看齐）。
 */

import { sanitizeSecrets } from "../../../common/utils/sanitize-secrets.util";

/** 凭据类键名（顶层与嵌套层一视同仁剥除）。 */
const SECRET_KEYS_RE =
  /token|password|passwd|secret|apikey|api_key|credential/i;

/**
 * 参数脱敏。
 *
 * 参数来自 LLM，可能包含它从上下文里抄来的凭据样式串。剥离的判据与
 * AiService.sanitizeLogs 同口径（项目已有 S-10 纪律），并额外按**键名**
 * 剥离凭据字段。
 *
 * 脱敏必须**递归**：嵌套对象/数组里的字符串同样落库（resultJson 进审计
 * 详情页）——只扫顶层会把 `{"params":{"password":"…"}}` 形态整个漏掉。
 * args 来自 JSON.parse（无环），深度钳位只是防御性收口。
 *
 * 与结果侧的 `sanitizeResult` 的**唯一**差别：args 侧不保留 digest（更
 * 严格）。参数是模型给的，没有「与源数据对账」的需求。
 */
export function sanitizeArgs(
  args: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!args) return null;
  return sanitizeValue(args, 0) as Record<string, unknown>;
}

/**
 * 结果侧脱敏（落库副本用）。
 *
 * 与 `sanitizeArgs` 同一套规则，唯一差别：**整体是 digest 的字符串原值
 * 保留**（共享实现里的 `DIGEST_ONLY_RE` / `preserveDigests`）。args 侧不
 * 启用——模型给的参数里没有对账需求，宁可多剥。
 */
export function sanitizeResult(data: unknown): unknown {
  return sanitizeValue(data, 0, { preserveDigests: true });
}

export function sanitizeValue(
  value: unknown,
  depth: number,
  opts: { preserveDigests: boolean } = { preserveDigests: false },
): unknown {
  if (depth > 32) return "[TRUNCATED_NESTED]";
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1, opts));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS_RE.test(k)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = sanitizeValue(v, depth + 1, opts);
    }
    return out;
  }
  return typeof value === "string"
    ? sanitizeString(value, opts.preserveDigests)
    : value;
}

/**
 * 单字符串脱敏（转发到全仓唯一实现）。
 * 4000 字符上限是 agent 侧策略：凭据脱敏的同时防止单字段撑爆行。
 */
export function sanitizeString(s: string, preserveDigests = false): string {
  return sanitizeSecrets(s, { preserveDigests, maxLength: 4000 });
}
