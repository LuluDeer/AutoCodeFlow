/**
 * N25 + N21：capability source 策略判定层（纯函数，零 Nest / DB 依赖）。
 *
 * 本文件是 source 类型与来源白名单的**唯一事实源**：扩展源 8 类
 * （builtin/registry/git/folder + npm/github/server/mcp:）；entity 的
 * CapabilitySourceType 从第 67 轮起派生自 ExtendedSourceType，不再有第二份字面量。
 *
 * N21（ADR-044）：来源白名单是引擎级硬策略（fail-closed，不回退公网源）——
 * 禁 URL userinfo（凭据随 source 扩散）、禁 headers（magpie 实证不可移植）、
 * 禁白名单外 scheme；分级标签 public/internal/sensitive 与出域绑定，
 * sensitive 能力禁止公网 host（企业管控边界），客户端只能在白名单内自建。
 */

/** 扩展源全集：原 4 源 ∪ 新引入的五源外部面（npm/git/github/server/mcp:）。 */
export type ExtendedSourceType =
  | "builtin"
  | "registry"
  | "git"
  | "folder"
  | "npm"
  | "github"
  | "server"
  | "mcp:";

/** 闭包唯一事实源：判定全部合法源类型。 */
export const SUPPORTED_SOURCE_TYPES: readonly ExtendedSourceType[] = [
  "builtin",
  "registry",
  "git",
  "folder",
  "npm",
  "github",
  "server",
  "mcp:",
];

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_SOURCE_TYPES);

/** 五源外部面：明确支持自动更新的来源；builtin/registry/folder 不在其中。 */
const AUTO_UPDATE_TYPES: ReadonlySet<string> = new Set<ExtendedSourceType>([
  "npm",
  "git",
  "github",
  "server",
  "mcp:",
]);

/** 具备 marketplace 身份的来源；builtin/folder/server 不走 marketplace 启停。 */
const MARKETPLACE_TYPES: ReadonlySet<string> = new Set<ExtendedSourceType>([
  "registry",
  "git",
  "npm",
  "github",
  "mcp:",
]);

/** marketplace 引用形态：`<package>@marketplace`，package 名限小写标识字符。 */
const MARKETPLACE_REF = /^[a-z0-9][a-z0-9._-]*@marketplace$/;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 源类型闭包校验：只认 SUPPORTED_SOURCE_TYPES，未知类型一律 false。 */
export function isSupportedSourceType(
  type: unknown,
): type is ExtendedSourceType {
  return typeof type === "string" && SUPPORTED_SET.has(type);
}

/**
 * marketplace 启停资格：源类型合法、具备 marketplace 身份、ref 形态正确、
 * enabled 为布尔。任一条件缺失即 fail-closed。
 */
export function canToggleMarketplace(
  source: unknown,
  enabled: unknown,
): boolean {
  if (!isPlainRecord(source)) return false;
  if (!isSupportedSourceType(source.type)) return false;
  if (typeof enabled !== "boolean") return false;
  const ref = source.ref;
  if (typeof ref !== "string" || !MARKETPLACE_REF.test(ref)) return false;
  return MARKETPLACE_TYPES.has(source.type);
}

/**
 * autoUpdate 资格判定（P4 纯判定层，不含实际更新动作）：
 * 仅五源外部面放行；currentVersion / latestVersion 必须都是非空字符串且
 * 不相等。无版本信息一律 fail-closed 返回 false。
 */
export function canAutoUpdate(
  source: unknown,
  currentVersion: unknown,
  latestVersion: unknown,
): boolean {
  if (!isPlainRecord(source)) return false;
  if (!isSupportedSourceType(source.type)) return false;
  if (!AUTO_UPDATE_TYPES.has(source.type)) return false;
  if (typeof currentVersion !== "string" || currentVersion.trim().length === 0)
    return false;
  if (typeof latestVersion !== "string" || latestVersion.trim().length === 0)
    return false;
  return currentVersion.trim() !== latestVersion.trim();
}

/** 数据分级标签：public 可出公网；internal/sensitive 受来源白名单约束。 */
export type DataClassification = "public" | "internal" | "sensitive";

export const DATA_CLASSIFICATIONS: readonly DataClassification[] = [
  "public",
  "internal",
  "sensitive",
];

const DATA_CLASS_SET: ReadonlySet<string> = new Set(DATA_CLASSIFICATIONS);

/** 允许作为 source ref 的 URL scheme（白名单外一律 fail-closed）。 */
const ALLOWED_SOURCE_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "git:",
  "ssh:",
]);

/** 判定结果：ok=false 时 fail-closed，reason 供审计 detail 使用。 */
export interface OriginVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

const DENY = (reason: string): OriginVerdict => ({ ok: false, reason });

/**
 * N21 来源白名单 + 分级标签绑定（ADR-044 引擎级硬策略，fail-closed）。
 *
 * 校验顺序（任一命中即拒，不回退公网源）：
 * 1. source 必须是普通对象且 type 合法；
 * 2. 禁 headers 字段（magpie：带 headers 的 source 不可移植、会带出凭据）；
 * 3. ref 若是 URL：协议须在白名单、不得含 userinfo（user:pass@）、
 *    sensitive 分级不得指向公网 host；
 * 4. 分级标签须在封闭集合内（缺省 public 兼容存量）。
 */
export function assertOriginAllowed(
  source: unknown,
  classification: unknown = "public",
): OriginVerdict {
  if (!isPlainRecord(source)) return DENY("source must be a plain object");
  if (!isSupportedSourceType(source.type))
    return DENY("unsupported source type");
  if (source.headers !== undefined) return DENY("source.headers is forbidden");
  if (
    typeof classification !== "string" ||
    !DATA_CLASS_SET.has(classification)
  ) {
    return DENY("invalid data classification");
  }
  const ref = source.ref;
  if (ref === undefined) return { ok: true };
  if (typeof ref !== "string" || ref.trim().length === 0) {
    return DENY("source.ref must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    // 非 URL 的 ref（如 package@marketplace / 本地路径）由 type 层校验，不在此拒
    return { ok: true };
  }
  if (!ALLOWED_SOURCE_SCHEMES.has(url.protocol)) {
    return DENY(`source scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    return DENY("credentials in source URL are forbidden");
  }
  if (classification === "sensitive" && isPublicHost(url.hostname)) {
    return DENY("sensitive capability cannot use a public source host");
  }
  return { ok: true };
}

/** 公网 host 判定：IP 用私有/回环/链路本地段排除，域名按常见内网后缀排除。 */
function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(".internal.")
  )
    return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      a === 0
    )
      return false;
    return true;
  }
  // 非 IP 域名视为公网（保守：internal 场景应显式用 .internal/.local 后缀）
  return true;
}
