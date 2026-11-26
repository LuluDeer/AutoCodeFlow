import {
  aggregateDecisions,
  evaluateAll,
  evaluatePolicy,
  evaluateSemanticPolicy,
  type ConfigLayer,
  type PolicyRef,
  type PolicySemantic,
  type SemanticPolicyLayer,
} from "../scope-engine";

const layer = (
  name: string,
  semantic: PolicySemantic,
  policy: Record<string, unknown>,
): SemanticPolicyLayer => ({ name, semantic, config: { policy } });

const ref = (resource: string, action = "*"): PolicyRef => ({
  resource,
  action,
});

describe("N3 四语义显式分层", () => {
  describe("rules：规则表判定", () => {
    it("命中取更紧：下层 allow 不得放松上层 deny", () => {
      // 控制组（禁止项）：把 rules 分支改成 current = local ⇒ 本例转 allow ⇒ 红。
      const layers: SemanticPolicyLayer[] = [
        layer("managed", "rules", { shell: "deny" }),
        layer("project", "rules", { shell: "allow" }),
      ];
      expect(evaluateSemanticPolicy(layers, "shell", "read")).toBe("deny");
    });

    it("无命中默认 ask", () => {
      // 控制组（禁止项）：把末尾 current ?? 'ask' 改成 current ?? 'allow' ⇒ 本例转红。
      expect(
        evaluateSemanticPolicy([layer("managed", "rules", {})], "unknown", "x"),
      ).toBe("ask");
    });
  });

  describe("override：下层同名替换", () => {
    it("本层命中时 allow 替换上层 deny", () => {
      // 控制组（禁止项）：把 override 分支改成 tighterDecision ⇒ 本例转 deny ⇒ 红。
      const layers: SemanticPolicyLayer[] = [
        layer("managed", "rules", { shell: "deny" }),
        layer("project", "override", { shell: "allow" }),
      ];
      expect(evaluateSemanticPolicy(layers, "shell", "read")).toBe("allow");
    });
  });

  describe("fallback：仅上层缺省时生效", () => {
    it("上层已命中时整层跳过", () => {
      // 控制组（禁止项）：去掉 current === undefined 守卫 ⇒ 本例转 deny ⇒ 红。
      const layers: SemanticPolicyLayer[] = [
        layer("managed", "rules", { shell: "allow" }),
        layer("project", "fallback", { shell: "deny" }),
      ];
      expect(evaluateSemanticPolicy(layers, "shell", "read")).toBe("allow");
    });

    it("上层无命中时本层生效", () => {
      const layers: SemanticPolicyLayer[] = [
        layer("managed", "rules", { shell: "deny" }),
        layer("project", "fallback", { net: "deny" }),
      ];
      expect(evaluateSemanticPolicy(layers, "net", "write")).toBe("deny");
    });
  });

  describe("restrict：deny 单调锁定", () => {
    it("restrict 层 deny 不可被下层 override 撤销", () => {
      // 控制组（禁止项）：删除 lockedDeny = true ⇒ 本例转 allow ⇒ 红。
      const layers: SemanticPolicyLayer[] = [
        layer("managed", "restrict", { shell: "deny" }),
        layer("project", "override", { shell: "allow" }),
      ];
      expect(evaluateSemanticPolicy(layers, "shell", "read")).toBe("deny");
    });

    it("restrict 层 allow 仍可被下层 rules 收紧", () => {
      const layers: SemanticPolicyLayer[] = [
        layer("managed", "restrict", { shell: "allow" }),
        layer("project", "rules", { shell: "deny" }),
      ];
      expect(evaluateSemanticPolicy(layers, "shell", "read")).toBe("deny");
    });
  });

  describe("evaluateAll：多资源 any-deny 聚合", () => {
    const layers: SemanticPolicyLayer[] = [
      layer("managed", "restrict", { shell: "deny", net: "allow" }),
      layer("project", "rules", { db: "allow" }),
    ];

    it("任一资源 deny ⇒ 整体 deny", () => {
      // 控制组（禁止项）：把聚合改成 refs.every(allow) ⇒ 本例转 allow ⇒ 红。
      expect(evaluateAll(layers, [ref("net"), ref("shell"), ref("db")])).toBe(
        "deny",
      );
    });

    it("全部 allow ⇒ 整体 allow；含 ask ⇒ 整体 ask", () => {
      expect(evaluateAll(layers, [ref("net"), ref("db")])).toBe("allow");
      expect(evaluateAll(layers, [ref("net"), ref("unknown")])).toBe("ask");
    });

    it("空 refs / 非法 ref / 空层 ⇒ ask（fail-closed）", () => {
      expect(evaluateAll(layers, [])).toBe("ask");
      expect(evaluateAll([], [ref("shell")])).toBe("ask");
      expect(
        evaluateAll(layers, [
          null,
          undefined,
          { resource: 1, action: "*" },
        ] as any),
      ).toBe("ask");
    });

    it("支持自定义 policy 字段名", () => {
      const custom: SemanticPolicyLayer[] = [
        {
          name: "managed",
          semantic: "restrict",
          config: { customPolicy: { shell: "deny" } },
        },
      ];
      expect(evaluateAll(custom, [ref("shell")], "customPolicy")).toBe("deny");
      expect(evaluateAll(custom, [ref("shell")])).toBe("ask");
    });
  });

  describe("向后兼容：既有导出逐字不变", () => {
    const legacy: ConfigLayer[] = [
      { name: "managed", config: { policy: { rules: { shell: "deny" } } } },
      { name: "project", config: { policy: { rules: { shell: "allow" } } } },
    ];

    it("evaluatePolicy 仍是 managed 硬 deny + any-deny", () => {
      expect(evaluatePolicy(legacy, "shell", "write")).toBe("deny");
      expect(evaluatePolicy(legacy, "unknown", "x")).toBe("ask");
    });

    it("aggregateDecisions 仍是 any-deny 且空集 ask", () => {
      expect(aggregateDecisions([])).toBe("ask");
      expect(aggregateDecisions(["allow", "ask", "deny"])).toBe("deny");
      expect(aggregateDecisions([undefined, null, "allow"])).toBe("allow");
    });
  });
});
