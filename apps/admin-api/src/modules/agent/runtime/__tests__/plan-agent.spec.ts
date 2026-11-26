import {
  classifyAllowedPrompt,
  enterPlanMode,
  exitPlanMode,
  InvalidPlanApprovalScopeError,
  type AllowedPrompt,
  type PlanState,
  type PlanToolTier,
} from "../plan-agent";

/**
 * N11 · plan 身份纯状态机规格。反证有牙：
 *   · plan 身份下 write / dangerous tier 仍可触达 ⇒ tier 收窄用例转红；
 *   · "all" 等长期 scope 被 exit 接受                 ⇒ scope 用例转红；
 *   · 未知意图按 granted 放行 / 模糊匹配命中          ⇒ allowedPrompts 用例转红；
 *   · 写权限在 plan 下未全拒 / 内存 FS 可写            ⇒ 身份切换用例转红。
 * 控制组（read tier 保留、once 放行、精确 granted/denied）证明不是「一律拒绝」的平凡实现。
 */

function executorState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    identity: "executor",
    baseToolTiers: ["read", "write", "dangerous"],
    toolTiers: ["read", "write", "dangerous"],
    fileSystem: "host",
    writePermission: "caller-decided",
    approvalScope: null,
    allowedPrompts: [],
    ...overrides,
  };
}

function planState(overrides: Partial<PlanState> = {}): PlanState {
  return enterPlanMode(executorState(overrides));
}

describe("N11 · enterPlanMode：切换到只读执行身份", () => {
  it("executor → plan：内存 FS 只读 + 写权限全拒（控制组）", () => {
    const plan = planState();
    expect(plan.identity).toBe("plan");
    expect(plan.fileSystem).toBe("memory-readonly");
    expect(plan.writePermission).toBe("denied");
    expect(plan.approvalScope).toBeNull();
  });

  it("反证：write / dangerous tier 在 plan 身份下被放行 ⇒ 本用例转红", () => {
    const plan = planState();
    expect(plan.toolTiers).not.toContain("write");
    expect(plan.toolTiers).not.toContain("dangerous");
    expect(plan.toolTiers).toEqual(["read"]);
  });

  it("tier 判定而非工具名字符串：未知 tier 与大小写变体按 rank 全拒", () => {
    const base = [
      "read",
      "WRITE",
      "rm_rf_everything",
      "dangerous",
      42,
    ] as unknown as PlanToolTier[];
    const plan = enterPlanMode(executorState({ baseToolTiers: base }));
    expect(plan.toolTiers).toEqual(["read"]);
  });

  it("控制组：read tier 在 plan 下仍可触达（不是一律拒绝）", () => {
    const plan = enterPlanMode(
      executorState({ baseToolTiers: ["read", "read"] }),
    );
    expect(plan.toolTiers).toEqual(["read", "read"]);
  });

  it("base 里没有 read tier 时 plan 的工具面为空（fail-closed）", () => {
    const plan = enterPlanMode(
      executorState({ baseToolTiers: ["write", "dangerous"] }),
    );
    expect(plan.toolTiers).toEqual([]);
  });

  it("allowedPrompts 整段保留，本层不篡改意图规则", () => {
    const rules: AllowedPrompt[] = [
      { intent: "sop.review", decision: "granted" },
      { intent: "sop.publish", decision: "denied" },
    ];
    const plan = enterPlanMode(executorState({ allowedPrompts: rules }));
    expect(plan.allowedPrompts).toEqual(rules);
  });

  it("不修改入参：返回新对象，新旧 tier 数组互不共享", () => {
    const original = executorState();
    const snapshot = JSON.stringify(original);
    const plan = enterPlanMode(original);
    expect(plan).not.toBe(original);
    expect(plan.toolTiers).not.toBe(original.toolTiers);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("重复进入 plan 不累积、不丢失原始 tier 投影", () => {
    const twice = enterPlanMode(planState());
    expect(twice.baseToolTiers).toEqual(["read", "write", "dangerous"]);
    expect(twice.toolTiers).toEqual(["read"]);
  });

  it("状态只声明 tier 上限，不含工具名白名单字段", () => {
    expect(Object.keys(planState()).sort()).toEqual([
      "allowedPrompts",
      "approvalScope",
      "baseToolTiers",
      "fileSystem",
      "identity",
      "toolTiers",
      "writePermission",
    ]);
  });
});

describe("N11 · classifyAllowedPrompt：意图/类别级精确判定", () => {
  const rules: AllowedPrompt[] = [
    { intent: "sop.review", decision: "granted" },
    { intent: "sop.publish", decision: "denied" },
  ];

  it("精确命中 granted 规则 ⇒ granted（控制组）", () => {
    expect(classifyAllowedPrompt("sop.review", rules)).toBe("granted");
  });

  it("精确命中 denied 规则 ⇒ denied（控制组）", () => {
    expect(classifyAllowedPrompt("sop.publish", rules)).toBe("denied");
  });

  it.each(["sop.deploy", "review", "sop.review.extra", "SOP.REVIEW", "*"])(
    "未知/变形意图 %s ⇒ ask（无规则默认 ask）",
    (prompt) => {
      expect(classifyAllowedPrompt(prompt, rules)).toBe("ask");
    },
  );

  it("反证：包含匹配或通配展开命中 ⇒ 本用例转红", () => {
    expect(classifyAllowedPrompt("prefix:sop.review:suffix", rules)).toBe(
      "ask",
    );
    expect(
      classifyAllowedPrompt("anything", [{ intent: "*", decision: "granted" }]),
    ).toBe("ask");
  });

  it("空白名单 / 非数组白名单 ⇒ ask", () => {
    expect(classifyAllowedPrompt("sop.review", [])).toBe("ask");
    expect(
      classifyAllowedPrompt("sop.review", null as unknown as AllowedPrompt[]),
    ).toBe("ask");
  });

  it("prompt 非字符串或空串 ⇒ ask", () => {
    expect(classifyAllowedPrompt("", rules)).toBe("ask");
    expect(classifyAllowedPrompt(undefined as unknown as string, rules)).toBe(
      "ask",
    );
    expect(
      classifyAllowedPrompt(
        { intent: "sop.review" } as unknown as string,
        rules,
      ),
    ).toBe("ask");
  });

  it("同意图冲突判定 ⇒ ask，不随机放行", () => {
    expect(
      classifyAllowedPrompt("sop.review", [
        { intent: "sop.review", decision: "granted" },
        { intent: "sop.review", decision: "denied" },
      ]),
    ).toBe("ask");
  });

  it("未知 decision 值即使 intent 精确命中也 ⇒ ask", () => {
    expect(
      classifyAllowedPrompt("sop.review", [
        {
          intent: "sop.review",
          decision: "bypass",
        } as unknown as AllowedPrompt,
      ]),
    ).toBe("ask");
  });
});

describe("N11 · exitPlanMode：只发布 scope=once，无永久授权", () => {
  it("once ⇒ 恢复 executor 身份与原工具面，发布一次性 scope（控制组）", () => {
    const plan = planState({
      allowedPrompts: [{ intent: "sop.review", decision: "granted" }],
    });
    const exited = exitPlanMode(plan, "once");
    expect(exited.identity).toBe("executor");
    expect(exited.fileSystem).toBe("host");
    expect(exited.writePermission).toBe("caller-decided");
    expect(exited.toolTiers).toEqual(["read", "write", "dangerous"]);
    expect(exited.approvalScope).toBe("once");
    expect(exited.allowedPrompts).toEqual(plan.allowedPrompts);
  });

  it("反证：all 授权被接受 ⇒ 本用例转红", () => {
    expect(() => exitPlanMode(planState(), "all")).toThrow(
      InvalidPlanApprovalScopeError,
    );
  });

  it.each([
    "session",
    "ONCE",
    "once ",
    "",
    null,
    undefined,
    1,
    { scope: "once" },
  ])("非法 scope %p ⇒ 拒绝，状态不迁移", (scope) => {
    const plan = planState();
    const snapshot = JSON.stringify(plan);
    expect(() => exitPlanMode(plan, scope)).toThrow("invalid_approval_scope");
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it("拒绝时抛出的错误码固定为 invalid_approval_scope", () => {
    try {
      exitPlanMode(planState(), "all");
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPlanApprovalScopeError);
      expect((error as InvalidPlanApprovalScopeError).code).toBe(
        "invalid_approval_scope",
      );
    }
  });

  it("exit 只给一次性 scope：不产生 all / permanent 授权字段", () => {
    const exited = exitPlanMode(planState(), "once");
    expect(exited.approvalScope).toBe("once");
    expect(JSON.stringify(exited)).not.toContain('"all"');
    expect(JSON.stringify(exited)).not.toContain("permanent");
  });
});
