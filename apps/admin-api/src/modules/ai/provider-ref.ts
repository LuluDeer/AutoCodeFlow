/**
 * provider 引用与凭据占位的纯解析层（N13 续）。
 *
 * 两个互不混淆的语义：
 *  - 凭据只以 `{env:NAME}` 占位出现在配置里，本层负责识别，不负责取值；
 *  - 方案卡引用写作 `provider/model#variant`，variant 承载 reasoningEffort。
 *
 * 零 Nest / DB 依赖；脏值一律返回 null，不抛错、不猜测、不回显原串。
 */

/** `{env:NAME}`：NAME 仅大写字母/数字/下划线，整体锚定、大小写敏感。 */
const ENV_PLACEHOLDER_RE = /^\{env:([A-Z0-9_]+)\}$/;

/**
 * provider id 沿用注册表形态闸（ai-providers.ts 的 ID_RE）：
 * 小写字母/数字开头，后续仅小写字母数字与 `-_.`，1..64。
 * model / variant 仅字母数字与 `._:-`——`/`、`#`、空白、花括号都不在字符集内，
 * 于是多段斜杠、空段、尾部换行等畸形 ref 一律落空。
 */
const PROVIDER_MODEL_VARIANT_RE =
  /^([a-z0-9][a-z0-9._-]{0,63})\/([A-Za-z0-9._:-]+)(?:#([A-Za-z0-9._:-]+))?$/;

/**
 * 解析 `{env:NAME}` 凭据占位。
 *
 * 只认严格形态：`env:` 与花括号大小写敏感，NAME 至少一位且仅 `[A-Z0-9_]`。
 * 空串、非字符串、小写名、连字符/点号、带空白、明文密钥（sk- / PEM / 长 hex）
 * 以及结尾换行（JS `$` 会在尾换行前匹配）全部返回 null（fail-closed）。
 */
export function parseEnvPlaceholder(value: unknown): { name: string } | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const match = ENV_PLACEHOLDER_RE.exec(value);
  // JS 的 `$` 在结尾换行符之前也会匹配；长度全等确保整串被消费。
  if (!match || match[0].length !== value.length) return null;
  return { name: match[1] };
}

/**
 * 拆分 `provider/model#variant`。
 *
 * provider / model 均非空；`#variant` 可省略（此时 variant 为 undefined），
 * 但一旦出现 `#` 则 variant 必须非空。畸形 ref 返回 null，不猜、不补默认值。
 */
export function parseProviderModelVariant(
  ref: unknown,
): { provider: string; model: string; variant?: string } | null {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const match = PROVIDER_MODEL_VARIANT_RE.exec(ref);
  if (!match || match[0].length !== ref.length) return null;
  const [, provider, model, variant] = match;
  return variant === undefined
    ? { provider, model }
    : { provider, model, variant };
}

/**
 * 从 variant 提取 reasoningEffort 语义。
 *
 * 仅三个明确取值做恒等映射：low / medium / high。其余（未知词、大小写变体、
 * 空值、非字符串）返回 null——不推断、不套近似词。
 */
export function resolveReasoningEffort(
  variant?: string,
): "low" | "medium" | "high" | null {
  if (typeof variant !== "string") return null;
  if (variant === "low" || variant === "medium" || variant === "high")
    return variant;
  return null;
}
