/**
 * N19 能力调用 scope 闸：结构面 token + 纯判定，零 Nest/DB 依赖。
 *
 * `canInvokeWithScope` 收的是**已展开的 scope 词集**，不是单个 legacy tier：
 * 能力激活同时需要 readonly（读可见性）与 trigger（副作用授权）两个词；
 * readonly-only / trigger-only 都判拒，manage 按全集放行。
 * `requiredScopes` 为空时 fail-closed（空集合不构成授权证据）。
 *
 * `shouldDisableOnRevoke` 把 revoke 写入的 revokedAt 翻成能力停用判定：
 * 非 null 即停用；无效时间戳同样按已吊销处理。
 */
import type { ApiKeyScope } from "../api-keys/entities/api-key.entity";

export const CAPABILITY_SCOPE_GATE = Symbol("CAPABILITY_SCOPE_GATE");

/** 能力调用要求的 scope 词：两个都必须出现在持有集合里。 */
export const CAPABILITY_INVOKE_SCOPES: readonly ApiKeyScope[] = [
  "readonly",
  "trigger",
];

/** 单个 legacy scope 或已展开的 scope 词集；null/undefined = 无授权。 */
export type CapabilityScopeSet =
  ApiKeyScope | readonly ApiKeyScope[] | null | undefined;

export interface CapabilityScopeGate {
  canInvokeWithScope(
    scope: CapabilityScopeSet,
    requiredScopes?: readonly ApiKeyScope[],
  ): boolean;
  shouldDisableOnRevoke(revokedAt: Date | null | undefined): boolean;
}

/**
 * 持有集合是否覆盖全部必需 scope；manage 隐式覆盖任意必需集合。
 * 纯函数：不读 DB、不读配置、不抛异常。
 */
export function canInvokeWithScope(
  scope: CapabilityScopeSet,
  requiredScopes: readonly ApiKeyScope[] = CAPABILITY_INVOKE_SCOPES,
): boolean {
  if (scope == null || requiredScopes.length === 0) return false;
  const held: ReadonlySet<ApiKeyScope> = new Set(
    typeof scope === "string" ? [scope] : scope,
  );
  if (held.has("manage")) return true;
  return requiredScopes.every((required) => held.has(required));
}

/** revoke 联动判定：revokedAt 非 null 就停用该 key 关联的能力。 */
export function shouldDisableOnRevoke(
  revokedAt: Date | null | undefined,
): boolean {
  return revokedAt != null;
}

/** 供 useFactory / useValue 直接接线的纯实现。 */
export const capabilityScopeGate: CapabilityScopeGate = {
  canInvokeWithScope,
  shouldDisableOnRevoke,
};
