/**
 * ADR-044 / provider.use 出域硬开关的纯逻辑层（零 Nest / DB 依赖）。
 *
 * 从 system_configs 的 value 解析中台 managed deny 名单；畸形一律 fail-open
 * 视为空名单（不把所有 provider 都 deny）。判据本身在 ai-providers.ts 的
 * providerUseVerdict，本文件只做配置形态归一化。
 */

/** 从 system_config value（string JSON / 数组 / 其它）解析 deny 名单。 */
export function parseDeniedProviderIds(value: unknown): readonly string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.trim().length === 0) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim().toLowerCase());
}

/** 设置页 provider 视图行（含出域 deny 标记），供 AiService 返回类型复用。 */
export type ProviderViewWithDeny = {
  hasApiKey: boolean;
  legacy: boolean;
  deniedForUse: boolean;
};

/** 出域 deny 审计 detail（只含 id/用途，不含 apiKey/baseUrl 明文）。 */
export function providerDeniedAuditDetail(
  providerId: string,
  purpose: string,
): Record<string, unknown> {
  return {
    providerId: providerId.trim().toLowerCase(),
    purpose,
    reason: "provider_denied",
  };
}

/** deniedForUse 标记计算（大小写/空格归一化）。 */
export function isDeniedForUse(
  id: string,
  deniedSet: ReadonlySet<string>,
): boolean {
  return deniedSet.has(id.trim().toLowerCase());
}
