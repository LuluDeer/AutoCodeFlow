import {
  classifyScopedRules,
  ScopedRule,
  ScopedRuleDisposition,
} from "../scoped-rules";

function rule(
  resource: string,
  action: string,
  decision: ScopedRule["decision"],
): ScopedRule {
  return { resource, action, decision };
}

function dispositions(
  items: readonly { disposition: ScopedRuleDisposition }[],
) {
  return items.map((item) => item.disposition);
}

describe("classifyScopedRules (N14 scopedRules 在途失效)", () => {
  it("控制组：代际未变时全部规则保留，不触发任何作废", () => {
    const result = classifyScopedRules({
      rules: [
        rule("*", "*", "allow"),
        rule("browser", "open", "ask"),
        rule("filesystem", "write", "deny"),
      ],
      cardGeneration: "gen-1",
      currentGeneration: "gen-1",
      scope: { resources: ["*"] },
    });

    expect(result.generationChanged).toBe(false);
    expect(result.scopeResolved).toBe(true);
    expect(result.invalidated).toEqual([]);
    expect(result.retained).toHaveLength(3);
    expect(dispositions(result.retained)).toEqual([
      "retain-current-generation",
      "retain-current-generation",
      "retain-current-generation",
    ]);
  });

  it("代际切换：通配 allow 作废、显式 ask/deny 保住（通配误判为显式即转红）", () => {
    const result = classifyScopedRules({
      rules: [
        rule("*", "*", "allow"),
        rule("browser", "open", "allow"),
        rule("browser", "open", "ask"),
        rule("filesystem", "write", "deny"),
      ],
      cardGeneration: "gen-old",
      currentGeneration: "gen-new",
      scope: { resources: ["*"], actions: ["*"] },
    });

    expect(result.generationChanged).toBe(true);
    expect(result.scopeResolved).toBe(true);

    const wildcardAllow = result.invalidated.find(
      (item) => item.rule.resource === "*" && item.rule.action === "*",
    );
    expect(wildcardAllow).toBeDefined();
    expect(wildcardAllow!.disposition).toBe("invalidate-wildcard-allow");
    expect(wildcardAllow!.retained).toBe(false);

    const preciseAllow = result.invalidated.find(
      (item) =>
        item.rule.resource === "browser" && item.rule.decision === "allow",
    );
    expect(preciseAllow!.disposition).toBe("invalidate-stale-allow");

    const explicitAsk = result.retained.find(
      (item) => item.rule.decision === "ask",
    );
    const explicitDeny = result.retained.find(
      (item) => item.rule.decision === "deny",
    );
    expect(dispositions([explicitAsk!, explicitDeny!])).toEqual([
      "retain-explicit-ask",
      "retain-explicit-deny",
    ]);
    expect(result.invalidated).toHaveLength(2);
    expect(result.retained).toHaveLength(2);
  });

  it("作用域不可判定时 ask/deny 保留、allow 作废（fail-closed）", () => {
    const result = classifyScopedRules({
      rules: [
        rule("browser", "open", "ask"),
        rule("filesystem", "write", "deny"),
        rule("http", "fetch", "allow"),
      ],
      cardGeneration: "gen-old",
      currentGeneration: "gen-new",
      scope: null,
    });

    expect(result.scopeResolved).toBe(false);
    expect(result.retained.map((item) => item.rule.decision)).toEqual([
      "ask",
      "deny",
    ]);
    expect(result.invalidated.map((item) => item.rule.decision)).toEqual([
      "allow",
    ]);
    expect(dispositions(result.retained)).toEqual([
      "retain-fail-closed-ask",
      "retain-fail-closed-deny",
    ]);
    expect(dispositions(result.invalidated)).toEqual([
      "invalidate-unknown-scope-allow",
    ]);
  });

  it("空作用域对象同样不可判定，ask 仍保留", () => {
    const result = classifyScopedRules({
      rules: [rule("browser", "open", "ask")],
      cardGeneration: "gen-old",
      currentGeneration: "gen-new",
      scope: {},
    });

    expect(result.scopeResolved).toBe(false);
    expect(dispositions(result.retained)).toEqual(["retain-fail-closed-ask"]);
    expect(result.invalidated).toEqual([]);
  });

  it("作用域可判定但规则不在作用域内时保留", () => {
    const result = classifyScopedRules({
      rules: [rule("browser", "open", "allow"), rule("http", "fetch", "allow")],
      cardGeneration: "gen-old",
      currentGeneration: "gen-new",
      scope: { resources: ["browser"] },
    });

    expect(result.scopeResolved).toBe(true);
    expect(dispositions(result.retained)).toEqual(["retain-out-of-scope"]);
    expect(dispositions(result.invalidated)).toEqual([
      "invalidate-stale-allow",
    ]);
  });

  it("代际缺失视为已变化，ask 保住而 allow 作废", () => {
    const result = classifyScopedRules({
      rules: [rule("browser", "open", "ask"), rule("browser", "open", "allow")],
      cardGeneration: undefined,
      currentGeneration: "gen-new",
      scope: { resources: ["browser"] },
    });

    expect(result.generationChanged).toBe(true);
    expect(dispositions(result.retained)).toEqual(["retain-explicit-ask"]);
    expect(dispositions(result.invalidated)).toEqual([
      "invalidate-stale-allow",
    ]);
  });
});
