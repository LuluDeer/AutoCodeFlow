import type { ApiKeyScope } from "../../api-keys/entities/api-key.entity";
import {
  CAPABILITY_INVOKE_SCOPES,
  CAPABILITY_SCOPE_GATE,
  capabilityScopeGate,
  canInvokeWithScope,
  shouldDisableOnRevoke,
  type CapabilityScopeGate,
} from "../capability-scope.gate";

describe("N19 · capability-scope.gate", () => {
  it("token 是独立 Symbol，结构面接口由纯函数对象实现", () => {
    expect(typeof CAPABILITY_SCOPE_GATE).toBe("symbol");
    expect(String(CAPABILITY_SCOPE_GATE)).toBe("Symbol(CAPABILITY_SCOPE_GATE)");

    const gate: CapabilityScopeGate = capabilityScopeGate;
    expect(gate.canInvokeWithScope).toBe(canInvokeWithScope);
    expect(gate.shouldDisableOnRevoke).toBe(shouldDisableOnRevoke);
  });

  it("默认能力调用要求 readonly + trigger 两个 scope 词", () => {
    expect(CAPABILITY_INVOKE_SCOPES).toEqual(["readonly", "trigger"]);
    expect(canInvokeWithScope(["readonly", "trigger"])).toBe(true);
    expect(canInvokeWithScope(["readonly", "trigger", "manage"])).toBe(true);
  });

  it("反证：readonly-only 被拒（控制组：双 scope 放行）", () => {
    expect(canInvokeWithScope(["readonly"])).toBe(false);
    expect(canInvokeWithScope("readonly")).toBe(false);
    expect(canInvokeWithScope(["readonly", "trigger"])).toBe(true);
  });

  it("反证：trigger-only 被拒（单 legacy tier 不隐式展开 readonly）", () => {
    expect(canInvokeWithScope(["trigger"])).toBe(false);
    expect(canInvokeWithScope("trigger")).toBe(false);
  });

  it("控制组：manage 作为全集放行", () => {
    expect(canInvokeWithScope("manage")).toBe(true);
    expect(canInvokeWithScope(["manage"])).toBe(true);
  });

  it("空持有集、空必需集、未知 scope 词都 fail-closed", () => {
    expect(canInvokeWithScope([])).toBe(false);
    expect(canInvokeWithScope(null)).toBe(false);
    expect(canInvokeWithScope(undefined)).toBe(false);
    expect(canInvokeWithScope(["readonly", "trigger"], [])).toBe(false);
    expect(canInvokeWithScope(["admin"] as unknown as ApiKeyScope[])).toBe(
      false,
    );
    expect(canInvokeWithScope(["readonly", "trigger"], ["manage"])).toBe(false);
  });

  it("自定义必需 scope 集合按全包含判定", () => {
    expect(canInvokeWithScope(["readonly"], ["readonly"])).toBe(true);
    expect(canInvokeWithScope(["trigger"], ["trigger"])).toBe(true);
    expect(canInvokeWithScope(["readonly"], ["readonly", "trigger"])).toBe(
      false,
    );
    expect(canInvokeWithScope(["readonly", "trigger"], ["trigger"])).toBe(true);
  });

  it("revoke 联动：revokedAt 非 null 即停用能力", () => {
    expect(shouldDisableOnRevoke(null)).toBe(false);
    expect(shouldDisableOnRevoke(undefined)).toBe(false);
    expect(shouldDisableOnRevoke(new Date())).toBe(true);
    expect(shouldDisableOnRevoke(new Date(0))).toBe(true);
    expect(shouldDisableOnRevoke(new Date("invalid"))).toBe(true);
    expect(capabilityScopeGate.shouldDisableOnRevoke(new Date())).toBe(true);
  });

  it("组合口径：scope 过闸但 key 已吊销时不放行", () => {
    const active = {
      scopes: ["readonly", "trigger"] as const,
      revokedAt: null,
    };
    const revoked = { ...active, revokedAt: new Date() };

    expect(
      canInvokeWithScope(active.scopes) &&
        !shouldDisableOnRevoke(active.revokedAt),
    ).toBe(true);
    expect(
      canInvokeWithScope(revoked.scopes) &&
        !shouldDisableOnRevoke(revoked.revokedAt),
    ).toBe(false);
  });
});
