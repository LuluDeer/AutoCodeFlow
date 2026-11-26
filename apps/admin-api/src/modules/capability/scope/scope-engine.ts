/**
 * ADR-040 Scope 合并引擎（纯函数 + 类型，零 Nest / PG 依赖）。
 * - layers 从高到低：[managed, project, private]；下标越大越"下层"。
 * - 未声明字段族 → 'default-replace'（scalar replace 语义）。
 * - dump 三栏：分层来源 / 生效值 / 凭据占位符；凭据明文绝不出现在输出里。
 * - managed 硬策略由策略引擎执行，不读 scope.locked（ADR-040 决策 2 明确否决）。
 */
import {
  aggregateDecisions,
  effectivePolicyMap,
  isPlainObject,
  mergeAppend,
  mergeKeyMerge,
  mergeReplace,
  mergeReplaceIfSameKey,
  matchesPolicyEntry,
  normalizePolicy,
  policySource,
  lookupDecisions,
  tighterDecision,
} from "./merge-rules";

export { aggregateDecisions } from "./merge-rules";

export type FieldRule =
  "replace" | "keyMerge" | "append" | "replaceIfSameKey" | "policyTighten";

export type FieldRules = Record<string, FieldRule>;

export type Decision = "allow" | "ask" | "deny";

export interface ConfigLayer {
  name: string;
  config: Record<string, unknown>;
}

/** 规范化后的单条策略（保留层信息，managed deny 因此可硬识别）。 */
export interface PolicyEntry {
  layer: string;
  resource: string;
  action: string;
  decision: Decision;
}

export interface PolicyRef {
  resource: string;
  action: string;
}

/**
 * 分层策略的合并语义，对齐 opencode policy.ts 的四类 rule：
 * restrict 单调（本层 deny 不可撤销）、override 同名替换、fallback 上层缺省才生效、rules 走规则表。
 */
export type PolicySemantic = "override" | "restrict" | "fallback" | "rules";

/** 带语义标签的策略层：数组从高到低排列，semantic 决定本层与已解析上层的合并方式。 */
export interface SemanticPolicyLayer {
  name: string;
  semantic: PolicySemantic;
  config: Record<string, unknown>;
}

export interface DumpLayerValue {
  name: string;
  value: unknown;
}

export interface DumpField {
  field: string;
  /** 三栏之一：每一层的原值（凭据已脱敏）。 */
  layers: DumpLayerValue[];
  /** 三栏之一：最终生效值（凭据已脱敏）。 */
  effective: unknown;
  /** 三栏之一：生效值来自哪一层。 */
  source: string;
  /** 未声明字段族标记为 'default-replace'。 */
  rule: FieldRule | "default-replace";
}

export const REDACTED = "<redacted>";
export const NO_SOURCE = "(default)";
export const MANAGED_LAYER = "managed";
export const DEFAULT_POLICY_FIELD = "policy";

/** 凭据键匹配：大小写不敏感，并把 _/-/空格 归一，使 API_KEY 也命中 apiKey。 */
const CREDENTIAL_KEY = /(?:apikey|secret|token|password|credential)/i;

export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key.replace(/[-_\s]/g, ""));
}

/** 深度脱敏：凭据键的值一律替换为 <redacted>，非凭据兄弟字段原样保留。 */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isCredentialKey(key) ? REDACTED : redactValue(item);
  }
  return out;
}

function applyFieldRule(
  rule: FieldRule,
  upper: unknown,
  lower: unknown,
): unknown {
  switch (rule) {
    case "keyMerge":
      return mergeKeyMerge(upper, lower);
    case "append":
      return mergeAppend(upper, lower);
    case "replaceIfSameKey":
      return mergeReplaceIfSameKey(upper, lower);
    case "policyTighten":
      // policy 必须在全部层上一次性收紧，见 mergeField 的专用分支。
      return mergeReplace(upper, lower);
    case "replace":
    default:
      return mergeReplace(upper, lower);
  }
}

export interface FieldResolution {
  effective: unknown;
  source: string;
}

/** 单字段族解析：返回生效值 + 生效层。 */
export function mergeField(
  layers: readonly ConfigLayer[],
  field: string,
  rule: FieldRule,
): FieldResolution {
  const defining = layers.filter(
    (layer) => layer.config != null && layer.config[field] !== undefined,
  );
  if (defining.length === 0) return { effective: undefined, source: NO_SOURCE };

  if (rule === "policyTighten") {
    const entries = defining.flatMap((layer) =>
      normalizePolicy(layer.config[field], layer.name),
    );
    return {
      effective: effectivePolicyMap(entries),
      source: policySource(entries, defining[defining.length - 1].name),
    };
  }

  let effective = defining[0].config[field];
  let source = defining[0].name;
  for (let i = 1; i < defining.length; i += 1) {
    effective = applyFieldRule(rule, effective, defining[i].config[field]);
    source = defining[i].name; // 下层最后落地
  }
  return { effective, source };
}

function collectFields(layers: readonly ConfigLayer[]): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    for (const field of Object.keys(layer.config ?? {})) {
      if (seen.has(field)) continue;
      seen.add(field);
      fields.push(field);
    }
  }
  return fields;
}

/** 全量合并：按字段族规则产出生效配置（不脱敏，供运行时消费）。 */
export function mergeConfig(
  layers: readonly ConfigLayer[],
  fieldRules: FieldRules,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of collectFields(layers)) {
    const declared = Object.prototype.hasOwnProperty.call(fieldRules, field);
    const rule: FieldRule = declared ? fieldRules[field] : "replace";
    result[field] = mergeField(layers, field, rule).effective;
  }
  return result;
}

/** mergeConfig 的语义别名，便于调用方按旧习惯引用。 */
export const mergeLayerConfigs = mergeConfig;

/**
 * 三栏 dump：field / layers[{name,value}] / effective / source，附 rule。
 * 脱敏发生在最后一步：先按原值合并（保证身份键、去重语义不受影响），
 * 再对 field 名与每个对象键递归替换凭据值为 <redacted>。
 */
export function dumpConfig(
  layers: readonly ConfigLayer[],
  fieldRules: FieldRules,
): DumpField[] {
  return collectFields(layers).map((field) => {
    const declared = Object.prototype.hasOwnProperty.call(fieldRules, field);
    const rule: FieldRule = declared ? fieldRules[field] : "replace";
    const { effective, source } = mergeField(layers, field, rule);
    const credentialField = isCredentialKey(field);
    return {
      field,
      layers: layers.map((layer) => ({
        name: layer.name,
        value: credentialField ? REDACTED : redactValue(layer.config?.[field]),
      })),
      effective: credentialField ? REDACTED : redactValue(effective),
      source,
      rule: declared ? rule : "default-replace",
    };
  });
}

/**
 * managed 硬策略求值：managed 层 deny 不可被任何下层放行；
 * 其余条目 any-deny 聚合；无匹配 / 无规则 → 'ask'（fail-closed）。
 *
 * 显式不读 scope.locked：ADR-040 决策 2 认定该标记挡不住用户新增同名项。
 */
export function evaluatePolicy(
  layers: readonly ConfigLayer[],
  resource: string,
  action: string,
  field: string = DEFAULT_POLICY_FIELD,
): Decision {
  const entries = layers.flatMap((layer) =>
    normalizePolicy(layer.config?.[field], layer.name),
  );
  const managedDeny = entries.some(
    (entry) =>
      entry.layer === MANAGED_LAYER &&
      entry.decision === "deny" &&
      matchesPolicyEntry(entry, resource, action),
  );
  if (managedDeny) return "deny";
  return aggregateDecisions(lookupDecisions(entries, resource, action));
}

export const evaluateManagedPolicy = evaluatePolicy;

/**
 * 单资源四语义分层求值。layers 从高到低；同一层内多条命中先 any-deny 收紧。
 * restrict 层产生的 deny 单调锁定，后续任何语义都不得撤销；
 * override 在本层命中时替换上层决策（锁定 deny 除外）；
 * fallback 仅在上层无任何命中规则时生效；rules 与上层取更紧（fail-closed）。
 * 无命中规则 / 非法入参 → 'ask'。
 */
export function evaluateSemanticPolicy(
  layers: readonly SemanticPolicyLayer[],
  resource: string,
  action: string,
  field: string = DEFAULT_POLICY_FIELD,
): Decision {
  if (
    !Array.isArray(layers) ||
    typeof resource !== "string" ||
    typeof action !== "string"
  ) {
    return "ask";
  }
  let current: Decision | undefined;
  let lockedDeny = false;
  for (const layer of layers) {
    if (layer == null || typeof layer.config !== "object") continue;
    const entries = normalizePolicy(layer.config?.[field], layer.name);
    const hits = lookupDecisions(entries, resource, action);
    if (hits.length === 0) continue;
    const local = aggregateDecisions(hits);
    switch (layer.semantic) {
      case "restrict":
        current =
          current === undefined ? local : tighterDecision(current, local);
        if (local === "deny") lockedDeny = true;
        break;
      case "override":
        if (!lockedDeny) current = local;
        break;
      case "fallback":
        if (current === undefined) current = local;
        break;
      case "rules":
      default:
        current =
          current === undefined ? local : tighterDecision(current, local);
        break;
    }
  }
  return current ?? "ask";
}

/**
 * 多资源聚合：每个 (resource, action) 独立走四语义求值，再 any-deny 聚合。
 * 任一资源 deny ⇒ 整体 deny；无规则 / 空 refs / 非法入参 ⇒ 'ask'（fail-closed）。
 */
export function evaluateAll(
  layers: readonly SemanticPolicyLayer[],
  refs: readonly PolicyRef[],
  field: string = DEFAULT_POLICY_FIELD,
): Decision {
  if (!Array.isArray(layers) || !Array.isArray(refs) || refs.length === 0) {
    return "ask";
  }
  const decisions: Decision[] = refs.map((ref) =>
    ref != null &&
    typeof ref.resource === "string" &&
    typeof ref.action === "string"
      ? evaluateSemanticPolicy(layers, ref.resource, ref.action, field)
      : "ask",
  );
  return aggregateDecisions(decisions);
}
