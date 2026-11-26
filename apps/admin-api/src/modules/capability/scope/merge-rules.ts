/**
 * ADR-040 §决策 1：逐字段族合并规则（纯函数层，零 Nest / IO 依赖）。
 *
 * layers 约定：数组从高到低（如 [managed, project, private]），下标越大越"下层"。
 * 除 policyTighten（单调收紧）外，所有规则都是"下层覆盖上层"。
 *
 * stableStringify 思路复用自
 * apps/admin-api/src/modules/workbench/preview-validator.ts:63 的 stableStringify：
 * 递归按键排序，使对象插入顺序不影响去重 / 比较结果。此处不 import 该文件，
 * 保持本模块零跨模块依赖。
 */
import type { Decision, PolicyEntry, PolicyRef } from "./scope-engine";

/** 收紧度：allow 最松，deny 最紧。 */
export const DECISION_SEVERITY: Readonly<Record<Decision, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

export function isDecision(value: unknown): value is Decision {
  return value === "allow" || value === "ask" || value === "deny";
}

export function tighterDecision(a: Decision, b: Decision): Decision {
  return DECISION_SEVERITY[a] >= DECISION_SEVERITY[b] ? a : b;
}

/**
 * any-deny 聚合：任一 deny → deny；否则任一 ask → ask；全 allow → allow；
 * 空列表 → ask（ADR-040 决策 1 第 6 条：无规则默认 ask，fail-closed）。
 */
export function aggregateDecisions(
  decisions: readonly (Decision | undefined | null)[],
): Decision {
  let result: Decision = "ask";
  let seen = false;
  for (const decision of decisions) {
    if (!isDecision(decision)) continue;
    result = seen ? tighterDecision(result, decision) : decision;
    seen = true;
  }
  return result;
}

/** 规范化 JSON key：对象递归排序，数组保序；用于确定性去重。 */
export function stableKey(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableKey(obj[key])}`)
    .join(",")}}`;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/** 标量 replace：下层同名整值覆盖上层。 */
export function mergeReplace(_upper: unknown, lower: unknown): unknown {
  return lower;
}

/** map keyMerge：按 key 合并；只改一个 key 不影响其他 key，同 key 下层覆盖。 */
export function mergeKeyMerge(
  upper: unknown,
  lower: unknown,
): Record<string, unknown> {
  const base = isPlainObject(upper) ? upper : {};
  const incoming = isPlainObject(lower) ? lower : {};
  return { ...base, ...incoming };
}

/** permission / skill / plugin：上层在前追加，下层新项在后；稳定去重。 */
export function mergeAppend(upper: unknown, lower: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const item of [...toArray(upper), ...toArray(lower)]) {
    const key = stableKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** command / MCP server 的同名键：name 优先，id 兜底，再退化为稳定全值。 */
export function resourceKey(item: unknown): string {
  if (isPlainObject(item)) {
    if (typeof item.name === "string") return `name:${item.name}`;
    if (typeof item.id === "string") return `id:${item.id}`;
  }
  return `value:${stableKey(item)}`;
}

/**
 * command / MCP server：同名**整对象替换**（不合并字段），不同名追加。
 * 支持两种载荷：数组 [{name,...}] 与以 name 为 key 的 map。
 */
export function mergeReplaceIfSameKey(upper: unknown, lower: unknown): unknown {
  if (isPlainObject(upper) && isPlainObject(lower)) {
    const out: Record<string, unknown> = { ...upper };
    for (const [key, value] of Object.entries(lower)) {
      out[key] = value; // 整值替换，绝不 {...upper[key], ...value}
    }
    return out;
  }

  const order: string[] = [];
  const byKey = new Map<string, unknown>();
  for (const item of [...toArray(upper), ...toArray(lower)]) {
    const key = resourceKey(item);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, item); // 整对象替换；旧字段不残留
  }
  return order.map((key) => byKey.get(key));
}

/** 把 'resource:action' / 'resource.action' / 'resource' 解析成引用。 */
export function parsePolicyRef(ref: string): PolicyRef {
  const trimmed = ref.trim();
  const colon = trimmed.indexOf(":");
  if (colon >= 0) {
    return {
      resource: trimmed.slice(0, colon),
      action: trimmed.slice(colon + 1) || "*",
    };
  }
  const dot = trimmed.indexOf(".");
  if (dot >= 0) {
    return {
      resource: trimmed.slice(0, dot),
      action: trimmed.slice(dot + 1) || "*",
    };
  }
  return { resource: trimmed, action: "*" };
}

/**
 * Policy 配置形状（宽松输入，统一规范化成 PolicyEntry[]）：
 *   - 整个值是 'allow'|'ask'|'deny'：对该层全量生效
 *   - { default, rules: { 'res' | 'res:act' | 'res.act' | '*': decision | {act: decision} },
 *       allow?: string[], ask?: string[], deny?: string[] }
 *   - rules 也接受 [{ resource, action?, decision }]
 *   - 顶层除保留键外直接写资源名也按 rules 处理
 * 同一层内多条命中也取最紧者（fail-closed）。
 */
export function normalizePolicy(value: unknown, layer: string): PolicyEntry[] {
  const entries: PolicyEntry[] = [];
  const push = (ref: string, decision: Decision) => {
    const parsed = parsePolicyRef(ref);
    entries.push({
      layer,
      resource: parsed.resource,
      action: parsed.action,
      decision,
    });
  };

  const addRuleValue = (ref: string | undefined, raw: unknown): void => {
    if (isDecision(raw)) {
      if (ref) push(ref, raw);
      return;
    }
    if (Array.isArray(raw)) {
      for (const item of raw) addRuleValue(ref, item);
      return;
    }
    if (!isPlainObject(raw)) return;
    if (typeof raw.resource === "string" && isDecision(raw.decision)) {
      const action = typeof raw.action === "string" ? raw.action : "*";
      push(`${raw.resource}:${action}`, raw.decision);
      return;
    }
    if (ref) {
      for (const [action, decision] of Object.entries(raw)) {
        addRuleValue(`${ref}:${action}`, decision);
      }
      return;
    }
    for (const [key, item] of Object.entries(raw)) addRuleValue(key, item);
  };

  if (isDecision(value)) {
    push("*", value);
    return entries;
  }
  if (Array.isArray(value)) {
    for (const item of value) addRuleValue(undefined, item);
    return entries;
  }
  if (!isPlainObject(value)) return entries;

  if (isDecision(value.default)) push("*", value.default);
  addRuleValue(undefined, value.rules);
  for (const decision of ["deny", "ask", "allow"] as const) {
    const list = value[decision];
    if (Array.isArray(list)) {
      for (const ref of list) if (typeof ref === "string") push(ref, decision);
    }
  }
  const reserved = new Set(["default", "rules", "allow", "ask", "deny"]);
  for (const [ref, raw] of Object.entries(value)) {
    if (!reserved.has(ref)) addRuleValue(ref, raw);
  }
  return entries;
}

export function matchesPolicyEntry(
  entry: PolicyEntry,
  resource: string,
  action: string,
): boolean {
  return (
    (entry.resource === "*" || entry.resource === resource) &&
    (entry.action === "*" || entry.action === action)
  );
}

export function lookupDecisions(
  entries: readonly PolicyEntry[],
  resource: string,
  action: string,
): Decision[] {
  return entries
    .filter((entry) => matchesPolicyEntry(entry, resource, action))
    .map((entry) => entry.decision);
}

/** 把全部层的策略条目收紧成一张可读的生效表（供 dump 的 effective 使用）。 */
export function effectivePolicyMap(
  entries: readonly PolicyEntry[],
): Record<string, unknown> {
  const refs = new Set<string>();
  for (const entry of entries) refs.add(`${entry.resource}:${entry.action}`);
  const rules: Record<string, Decision> = {};
  for (const ref of [...refs].sort()) {
    const parsed = parsePolicyRef(ref);
    rules[ref] = aggregateDecisions(
      lookupDecisions(entries, parsed.resource, parsed.action),
    );
  }
  return {
    default: aggregateDecisions(lookupDecisions(entries, "*", "*")),
    rules,
  };
}

/** 生效来源：最紧决策的层；同紧度取更上层（先出现者），没有条目则回退。 */
export function policySource(
  entries: readonly PolicyEntry[],
  fallback: string,
): string {
  if (entries.length === 0) return fallback;
  let best = entries[0];
  for (const entry of entries) {
    if (DECISION_SEVERITY[entry.decision] > DECISION_SEVERITY[best.decision]) {
      best = entry;
    }
  }
  return best.layer;
}
