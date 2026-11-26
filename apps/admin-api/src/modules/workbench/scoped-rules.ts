/**
 * N14 scopedRules 在途策略失效判定（纯函数，零 Nest / DB 依赖）。
 *
 * 代际切换后：通配授权随旧方案卡作废；显式 ask/deny 保住；作用域不可判定时
 * ask/deny 一律保留（fail-closed），allow 一律作废（不静默放行被撤销的授权）。
 * any-deny 多资源聚合由主控接线，本文件只做逐条作用域分类。
 */

export type ScopedDecision = "allow" | "ask" | "deny";

export interface ScopedRule {
  resource: string;
  action: string;
  decision: ScopedDecision;
  /** 来源层，仅随判定结果回传供诊断，不参与判定。 */
  layer?: string;
}

export interface ScopedRulesScope {
  resources?: readonly string[];
  actions?: readonly string[];
}

export interface ScopedRulesInput {
  /** 旧方案卡快照中的规则集合。 */
  rules: readonly ScopedRule[];
  /** 方案卡生成时绑定的策略代际。 */
  cardGeneration: string | null | undefined;
  /** 提交/通知时读到的当前策略代际。 */
  currentGeneration: string | null | undefined;
  /** 受代际切换影响的作用域；null/undefined 表示不可判定。 */
  scope?: ScopedRulesScope | null;
}

export type ScopedRuleDisposition =
  | "retain-current-generation"
  | "retain-out-of-scope"
  | "retain-explicit-ask"
  | "retain-explicit-deny"
  | "retain-fail-closed-ask"
  | "retain-fail-closed-deny"
  | "invalidate-wildcard-allow"
  | "invalidate-stale-allow"
  | "invalidate-unknown-scope-allow";

export interface ScopedRuleVerdict {
  rule: ScopedRule;
  disposition: ScopedRuleDisposition;
  retained: boolean;
  reason: string;
}

export interface ScopedRulesVerdict {
  generationChanged: boolean;
  scopeResolved: boolean;
  retained: readonly ScopedRuleVerdict[];
  invalidated: readonly ScopedRuleVerdict[];
}

function isWildcard(rule: ScopedRule): boolean {
  return rule.resource === "*" || rule.action === "*";
}

function resolveScope(scope: ScopedRulesScope | null | undefined): boolean {
  if (!scope) return false;
  const hasResources =
    Array.isArray(scope.resources) && scope.resources.length > 0;
  const hasActions = Array.isArray(scope.actions) && scope.actions.length > 0;
  return hasResources || hasActions;
}

function inScope(rule: ScopedRule, scope: ScopedRulesScope): boolean {
  const resources = scope.resources;
  const actions = scope.actions;
  const resourceHit = resources
    ? resources.some((item) => item === "*" || item === rule.resource)
    : true;
  const actionHit = actions
    ? actions.some((item) => item === "*" || item === rule.action)
    : true;
  return resourceHit && actionHit;
}

function makeVerdict(
  rule: ScopedRule,
  disposition: ScopedRuleDisposition,
  reason: string,
): ScopedRuleVerdict {
  return {
    rule,
    disposition,
    retained: disposition.startsWith("retain-"),
    reason,
  };
}

/**
 * 逐条分类旧代际规则：返回保留面与作废面。
 * 代际缺失视为已变化；作用域缺失视为不可判定并走 fail-closed。
 */
export function classifyScopedRules(
  input: ScopedRulesInput,
): ScopedRulesVerdict {
  const card = input.cardGeneration;
  const current = input.currentGeneration;
  const generationChanged =
    typeof card !== "string" ||
    typeof current !== "string" ||
    card.length === 0 ||
    current.length === 0 ||
    card !== current;
  const scopeResolved = resolveScope(input.scope);
  const retained: ScopedRuleVerdict[] = [];
  const invalidated: ScopedRuleVerdict[] = [];

  for (const rule of input.rules ?? []) {
    let item: ScopedRuleVerdict;
    if (!generationChanged) {
      item = makeVerdict(
        rule,
        "retain-current-generation",
        "策略代际未变，旧卡规则继续有效",
      );
    } else if (!scopeResolved) {
      if (rule.decision === "ask") {
        item = makeVerdict(
          rule,
          "retain-fail-closed-ask",
          "作用域不可判定，ask 保留",
        );
      } else if (rule.decision === "deny") {
        item = makeVerdict(
          rule,
          "retain-fail-closed-deny",
          "作用域不可判定，deny 保留",
        );
      } else {
        item = makeVerdict(
          rule,
          "invalidate-unknown-scope-allow",
          "作用域不可判定，allow 作废以免静默放行被撤销的授权",
        );
      }
    } else if (!inScope(rule, input.scope!)) {
      item = makeVerdict(
        rule,
        "retain-out-of-scope",
        "规则不在受代际切换影响的作用域内",
      );
    } else if (rule.decision === "ask" && !isWildcard(rule)) {
      item = makeVerdict(rule, "retain-explicit-ask", "显式 ask 不随代际失效");
    } else if (rule.decision === "deny" && !isWildcard(rule)) {
      item = makeVerdict(
        rule,
        "retain-explicit-deny",
        "显式 deny 不随代际失效",
      );
    } else if (rule.decision === "ask") {
      item = makeVerdict(
        rule,
        "retain-fail-closed-ask",
        "通配 ask 按 fail-closed 保留",
      );
    } else if (rule.decision === "deny") {
      item = makeVerdict(
        rule,
        "retain-fail-closed-deny",
        "通配 deny 按 fail-closed 保留",
      );
    } else if (isWildcard(rule)) {
      item = makeVerdict(
        rule,
        "invalidate-wildcard-allow",
        "通配授权命中失效作用域，随旧代际作废",
      );
    } else {
      item = makeVerdict(rule, "invalidate-stale-allow", "旧代际精确授权作废");
    }

    if (item.retained) retained.push(item);
    else invalidated.push(item);
  }

  return { generationChanged, scopeResolved, retained, invalidated };
}
