/**
 * S7-G1（第五阶段）：Agent 面的**唯一**脱敏实现（从 `ToolExecutorService` 逐字搬出）。
 *
 * ## 为什么要单独一个文件（而不是各服务各写一份）
 * 本轮给 `agent_events.payload` 加正文（`payload.body`），第二个消费方出现了：
 * `AgentSessionService` 要在写事件前脱敏步正文 / 工具结果 / 错误文案。
 *
 * 三条被**否掉**的做法，理由都是实测过的，不是洁癖：
 *   · **在 session 服务里再写一条正则链**：本仓上一次这么做的结果是
 *     `notification.service.ts` 里那份内联复制——它只保留了「全大写 env + Bearer +
 *     32+hex + 40+b64」，**丢掉了**小写凭据规则（`token=` / `apiKey=`），于是通知
 *     正文里的小写凭据至今是明文。安全控制上的复制 = 下一次漂移 = 某天一条密钥
 *     明文进了长期保留的审计表。
 *   · **让 session 服务 import tool-executor**：`tool-executor.service.ts` 已经
 *     `import { AgentSessionService } from "../runtime/agent-session.service"`，
 *     反向 import 会成 **ESM 环**（Nest 的 `forwardRef` 只解决 DI，解决不了模块图）。
 *   · **只放行引用、不落正文**：那正是本轮要关的缺口——被引用行是**就地更新**的，
 *     引用会漂（见 `agent-event.entity.ts` 的 payload 头注）。
 * 搬运方向与 `tool-result-shaping.ts` 同一先例：把「无状态规则」抽出成独立文件，
 * 两个消费者都 import 它，`ToolExecutorService` 保留同名 private 方法做**薄转发**
 * 以免动 20+ 个调用点（零行为变化的搬移）。
 *
 * ## 规则本体与原来逐字相同
 * 判据与 `AiService.sanitizeLogs` 同口径（项目已有 S-10 纪律），并额外按**键名**
 * 剥离凭据字段；单个字符串另有 4000 字符上限（凭据脱敏的同时防止单字段撑爆行）。
 * **只有一处**与「照抄 sanitizeLogs」不同：S1-C3 的小写/混合大小写凭据赋值规则
 * （`token=…` / `api_key: …` / `"password": "…"`）——通知侧那份复制丢的正是它。
 */

/**
 * 「整体就是一个 digest」的判据（sha1 40 / sha256 64 / sha512 128 位 hex）。
 *
 * 为什么要单独留一条口子：`sanitizeString` 的「32+ hex 全脱敏」规则是为了
 * 剥掉凭据样式的随机串，但它同样会命中 sha256、git commit id 这类**合法
 * digest**——而审计表里存 digest 正是为了与源数据对账（`sha256` 字段本身
 * 就按原文算）。因此结果侧增加「整体匹配 ⇒ 原值保留」；args 侧不启用这条
 * （模型给的参数没有对账需求，保持更严格）。
 */
const DIGEST_ONLY_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/;

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
 * 保留**（`DIGEST_ONLY_RE`）。args 侧不启用——模型给的参数里没有对账
 * 需求，宁可多剥。
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

export function sanitizeString(s: string, preserveDigests = false): string {
  // digest 保留必须**先**判：`0123…` 这类整体 digest 会命中下面的 32+ hex
  // 规则被整串剥掉（sha256/commit id 就废了）。仅对结果侧启用。
  if (preserveDigests && DIGEST_ONLY_RE.test(s)) return s;
  return (
    s
      .replace(/([A-Z_]{3,}\s*=\s*)[^\s\n]+/g, "$1[REDACTED]")
      // Bearer 必须**排在**下面的凭据赋值规则之前：`Authorization: Bearer sk-…`
      // 若先被赋值规则吃掉 `Bearer` 这个词，Bearer 规则就再也匹配不上，key 会裸露。
      .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]")
      // S1-C3 补：**小写/混合大小写**的凭据赋值（`token=…`、`api_key: …`、
      // `"password": "…"`）。上面第一条规则要求键名全大写（env 变量形态），而模型
      // 从上下文抄来的凭据常写成小写形态——审批预览落库前必须同样打码。
      // 判据限定在一张凭据词表内，而不是放宽成「任意 key=」：后者会把
      // `retries=3`/`timeout=30` 这类正常参数一起打码，预览就失去可读性
      // （审批人反而看不出来要动什么）。
      .replace(
        /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|authorization|auth)\b(["']?)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;\n]+)/gi,
        "$1$2$3[REDACTED]",
      )
      .replace(/[0-9a-fA-F]{32,}/g, "[REDACTED_HEX]")
      .slice(0, 4000)
  );
}
