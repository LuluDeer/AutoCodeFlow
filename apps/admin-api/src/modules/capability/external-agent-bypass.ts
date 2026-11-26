/**
 * N1 外部 agent 旁路接入的配置层（纯函数，零 fs / DB / Nest 依赖）。
 *
 * Workbench 是第三入口，本模块不替换任何 agent 内核：中台只下发
 * baseUrl + 凭据「指针」（{env:NAME}，不是明文），调用方拿改写后的文本
 * 自行落盘（本模块不碰文件）。{env:NAME} 的解析口径与 N13续
 * impl-n13-env-placeholder 一致：整串锚定、大写名、空值/畸形 fail-closed。
 */

/** 外部 agent 接入指针：baseUrl 为下发原文，keyRef 为环境变量指针名。 */
export interface BypassPointer {
  readonly baseUrl: string;
  readonly keyRef: string;
}

/** 中台下发的原始配置；字段交由运行时守卫，畸形值一律 fail-closed。 */
export interface BypassPointerConfig {
  readonly baseUrl: unknown;
  readonly keyRef: unknown;
}

/** 单 key 改写结果：changed=false 时 content 就是传入原文。 */
export interface SingleKeyRewriteResult {
  readonly content: string;
  readonly changed: boolean;
}

const ENV_PLACEHOLDER_RE = /^\{env:([A-Z0-9_]+)\}$/;
const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLAIN_SK_RE = /^sk[-_]/i;
const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const LONG_HEX_RE = /(?:^|[^0-9A-Fa-f])[0-9A-Fa-f]{32,}(?:[^0-9A-Fa-f]|$)/;

function looksLikePlainCredential(value: string): boolean {
  return (
    PLAIN_SK_RE.test(value) ||
    PEM_PRIVATE_KEY_RE.test(value) ||
    LONG_HEX_RE.test(value)
  );
}

/** 解析 {env:NAME}；非指针、空值、明文凭证一律 null。 */
function parseEnvRef(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const match = ENV_PLACEHOLDER_RE.exec(value);
  if (match !== null) {
    // JS 的 `$` 会在结尾换行前匹配：`{env:FOO}\n` 必须拒绝。
    if (match[0].length !== value.length) return null;
    return match[1];
  }
  if (looksLikePlainCredential(value)) return null;
  return null;
}

function safeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value !== value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  return value;
}

/**
 * 构造外挂指针。baseUrl 必须是无用户信息的 http(s) URL；keyRef 必须是
 * {env:NAME}。任一条件不成立返回 null，绝不把明文凭证带进指针。
 */
export function buildBypassPointer(
  config: BypassPointerConfig | null | undefined,
): BypassPointer | null {
  if (config === null || typeof config !== "object") return null;
  const baseUrl = safeBaseUrl(config.baseUrl);
  if (baseUrl === null) return null;
  if (parseEnvRef(config.keyRef) === null) return null;
  return Object.freeze({ baseUrl, keyRef: config.keyRef as string });
}

interface ValueOccurrence {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCommentLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const before = text.slice(lineStart, index);
  return before.includes("//") || before.includes("#");
}

/** 定位 keyName 的带引号字符串值；注释行不计入。 */
function findValueOccurrences(
  text: string,
  keyName: string,
): ValueOccurrence[] {
  const occurrences: ValueOccurrence[] = [];
  const key = escapeRegExp(keyName);
  for (const quote of ['"', "'"] as const) {
    const valuePattern =
      quote === '"' ? '(?:\\\\.|[^"\\\\])*' : "(?:\\\\.|[^'\\\\])*";
    const matcher = new RegExp(
      `((?:["']${key}["']|(?<![\\w.\\-"'])${key})\\s*[:=]\\s*\\${quote})(${valuePattern})\\${quote}`,
      "gm",
    );
    let match: RegExpExecArray | null = matcher.exec(text);
    while (match !== null) {
      if (!isCommentLine(text, match.index)) {
        const start = match.index + match[1].length;
        occurrences.push({
          start,
          end: start + match[2].length,
          value: match[2],
        });
      }
      match = matcher.exec(text);
    }
  }
  occurrences.sort((left, right) => left.start - right.start);
  return occurrences;
}

/**
 * 原子改写外部 agent 配置里的一个 key：只替换目标字符串值，其余字节不变。
 * 命中数不是恰好 1、key 名非法、指针非法或值已相同 ⇒ changed=false 且原文返回。
 * 落盘由调用方负责，本函数不产生任何 I/O。
 */
export function applySingleKeyRewrite(
  originalConfig: string,
  pointer: BypassPointer | null | undefined,
  keyName: string | null | undefined,
): SingleKeyRewriteResult {
  const unchanged = (): SingleKeyRewriteResult => ({
    content: originalConfig,
    changed: false,
  });
  try {
    if (typeof originalConfig !== "string")
      return { content: "", changed: false };
    if (typeof keyName !== "string" || !KEY_NAME_RE.test(keyName)) {
      return unchanged();
    }
    if (pointer === null || typeof pointer !== "object") return unchanged();
    if (parseEnvRef(pointer.keyRef) === null) return unchanged();
    const target = pointer.keyRef as string;

    const hits = findValueOccurrences(originalConfig, keyName);
    if (hits.length !== 1) return unchanged();
    const hit = hits[0];
    if (hit.value === target) return unchanged();
    const content =
      originalConfig.slice(0, hit.start) +
      target +
      originalConfig.slice(hit.end);
    return Object.freeze({ content, changed: true });
  } catch {
    return unchanged();
  }
}
