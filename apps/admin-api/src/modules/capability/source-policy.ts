/**
 * N25：capability source 策略判定层（纯函数，零 Nest / DB 依赖）。
 *
 * 过渡说明：本文件独立定义「扩展源类型」字面量联合——原 4 源
 * （builtin/registry/git/folder）加 npm/github/server/mcp:。实体
 * capability.entity.ts 的 CapabilitySourceType 本批次不改，是否回填该枚举
 * 由主控统一裁决；接线时以本文件的判据为准，避免两处定义漂移。
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
