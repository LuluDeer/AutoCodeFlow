#!/usr/bin/env node
/**
 * A3（DEEP_REVIEW 0ef3bbe §七）完整形态：executor-protocol 的 **zod + pydantic 双生成**。
 *
 * 单一事实源 = `packages/executor-protocol/protocol.json` 的 `schemas` 段（JSON Schema
 * 2020-12 受控子集）。本脚本把它生成到两侧：
 *
 *   - apps/executor-node/src/generated/protocol.schemas.ts   （zod）
 *   - apps/executor-python/generated/protocol_schemas.py     （pydantic）
 *
 * 为什么生成而不是手写两份：此前 ExecuteRequest 在 node 是手写 TS interface、在 python
 * 是 autocodeflow_sdk 里的 pydantic model、在 admin 是拼接的字面量——三处各自演进，只靠
 * 注释互相引用（"见 node execute.ts:xxx parity"），即评审点名的"注释里的 parity"。
 *
 * 纪律（与本项目其它守卫同源）：
 *   ① **受控子集外的关键字必须报错退出**，绝不静默跳过——静默跳过等于契约悄悄失效，
 *      而且是那种永远不会变红的失效（第三次踩同类坑：check-consumer-routes 的规模
 *      下界、A5 的 TTL 语义守卫、A2-B 的落证对账）。
 *   ② 生成物随源码同 commit，由 CI 的 `executor-protocol-drift` job 重跑本脚本并
 *      `git diff --exit-code` 兜底（与 ADR-005 bundle 产物同款纪律）。
 *
 * 用法：node scripts/generate-executor-protocol.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL = resolve(
  ROOT,
  "packages/executor-protocol/protocol.json",
);
const NODE_OUT = resolve(
  ROOT,
  "apps/executor-node/src/generated/protocol.schemas.ts",
);
const PY_OUT = resolve(
  ROOT,
  "apps/executor-python/generated/protocol_schemas.py",
);

/** 受控子集。任何未列出的关键字都会让本脚本抛错（见头注纪律 ①）。 */
const SUPPORTED = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "pattern",
  "default",
  "description",
  "$ref",
  "$comment",
]);

const protocol = JSON.parse(readFileSync(PROTOCOL, "utf8"));
const schemas = protocol.schemas;
if (!schemas || typeof schemas !== "object") {
  throw new Error("protocol.json 缺少 schemas 段");
}

// ── 校验 + $ref 解析 ────────────────────────────────────────────────────────

function assertSupported(node, where) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) {
      throw new Error(
        `A3 生成器：${where} 使用了受控子集外的关键字 "${key}"——` +
          `请扩展 scripts/generate-executor-protocol.mjs 的 SUPPORTED 与两侧发射器` +
          `（静默跳过会让契约悄悄失效）`,
      );
    }
  }
}

/** 解析 `#/$defs/<Name>`，只认本 schemas 段内的顶层名字。 */
function resolveRef(ref, where) {
  const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!m) throw new Error(`A3 生成器：${where} 的 $ref "${ref}" 形态不受支持`);
  const name = m[1];
  if (!Object.prototype.hasOwnProperty.call(schemas, name)) {
    throw new Error(`A3 生成器：${where} 的 $ref 指向未定义的 schema "${name}"`);
  }
  return name;
}

/** 归一化：解 $ref、拆 nullable、校验关键字。返回 {kind, nullable, ...} */
function normalize(node, where) {
  assertSupported(node, where);
  if (node.$ref) return { kind: "ref", ref: resolveRef(node.$ref, where) };
  if (node.enum) {
    return { kind: "enum", values: node.enum, description: node.description };
  }
  const rawType = node.type;
  const types = Array.isArray(rawType) ? rawType : [rawType];
  const nullable = types.includes("null");
  const base = types.filter((t) => t !== "null");
  if (base.length !== 1) {
    throw new Error(
      `A3 生成器：${where} 的 type 必须恰好一个非 null 类型，实际 ${JSON.stringify(rawType)}`,
    );
  }
  const t = base[0];
  const common = {
    nullable,
    default: node.default,
    description: node.description,
  };
  if (t === "string") {
    return { kind: "string", pattern: node.pattern, ...common };
  }
  if (t === "integer" || t === "number") {
    return {
      kind: t === "integer" ? "integer" : "number",
      minimum: node.minimum,
      maximum: node.maximum,
      ...common,
    };
  }
  if (t === "boolean") return { kind: "boolean", ...common };
  if (t === "array") {
    if (!node.items) throw new Error(`A3 生成器：${where} 的 array 缺 items`);
    return {
      kind: "array",
      items: normalize(node.items, `${where}.items`),
      ...common,
    };
  }
  if (t === "object") {
    const props = node.properties ?? null;
    const children = {};
    if (props) {
      for (const [name, child] of Object.entries(props)) {
        assertSupported(child, `${where}.${name}`);
        children[name] = normalize(child, `${where}.${name}`);
      }
    }
    return {
      kind: "object",
      // 无 properties 的 object = 自由字典（zod: z.record / pydantic: dict[str, Any]），
      // 与「空对象类型」区分开——故用 null 而非 {}
      properties: props ? children : null,
      required: new Set(node.required ?? []),
      additionalProperties: node.additionalProperties !== false,
      ...common,
    };
  }
  throw new Error(`A3 生成器：${where} 的 type "${t}" 不受支持`);
}

const names = Object.keys(schemas).filter((k) => !k.startsWith("$"));
const normalized = {};
for (const name of names) {
  assertSupported(schemas[name], name);
  const n = normalize(schemas[name], name);
  if (n.kind !== "object") {
    throw new Error(`A3 生成器：顶层 schema "${name}" 必须是 object`);
  }
  normalized[name] = n;
}

/**
 * 拓扑序：$ref 指向的 schema 必须先定义（Python 侧直接写目标类名引用，
 * TS 侧引用 `${Name}Schema` 常量——两者都要求被引用者先出现）。
 */
function topoOrder() {
  const seen = new Set();
  const out = [];
  const visit = (name, stack) => {
    if (seen.has(name)) return;
    if (stack.includes(name)) {
      throw new Error(
        `A3 生成器：schemas 存在循环 $ref：${[...stack, name].join(" -> ")}`,
      );
    }
    for (const child of Object.values(normalized[name].properties ?? {})) {
      const refs = [
        child.kind === "ref" ? child.ref : null,
        child.kind === "array" && child.items.kind === "ref"
          ? child.items.ref
          : null,
      ].filter(Boolean);
      for (const r of refs) visit(r, [...stack, name]);
    }
    seen.add(name);
    out.push(name);
  };
  for (const name of names) visit(name, []);
  return out;
}

const orderedNames = topoOrder();

// ── 发射：TypeScript / zod ──────────────────────────────────────────────────

const lit = (v) => JSON.stringify(v);

function zodExpr(node) {
  let expr;
  switch (node.kind) {
    case "ref":
      expr = `${node.ref}Schema`;
      break;
    case "enum":
      expr = `z.enum([${node.values.map(lit).join(", ")}])`;
      break;
    case "string":
      // zod 的 .regex() 只收 RegExp（不收字符串），故包一层 new RegExp
      expr = node.pattern
        ? `z.string().regex(new RegExp(${lit(node.pattern)}))`
        : "z.string()";
      break;
    case "integer":
      expr = "z.number().int()";
      if (node.minimum !== undefined) expr += `.min(${node.minimum})`;
      if (node.maximum !== undefined) expr += `.max(${node.maximum})`;
      break;
    case "number":
      expr = "z.number()";
      if (node.minimum !== undefined) expr += `.min(${node.minimum})`;
      if (node.maximum !== undefined) expr += `.max(${node.maximum})`;
      break;
    case "boolean":
      expr = "z.boolean()";
      break;
    case "array":
      expr = `z.array(${zodExpr(node.items)})`;
      break;
    case "object": {
      if (node.properties === null) {
        expr = "z.record(z.unknown())";
        break;
      }
      const fields = Object.entries(node.properties).map(([name, child]) => {
        let expr = zodExpr(child);
        const hasDefault = child.default !== undefined;
        // 有 default 时 .default() 已让字段可选，再叠 .optional() 会把它变成
        // `T | undefined` 的输入类型（语义变松），故二选一。
        if (hasDefault) expr += `.default(${lit(child.default)})`;
        const optional = !node.required.has(name) && !hasDefault;
        return `  ${JSON.stringify(name)}: ${expr}${optional ? ".optional()" : ""},`;
      });
      expr = `z.object({\n${fields.join("\n")}\n})`;
      expr += node.additionalProperties ? ".passthrough()" : ".strict()";
      break;
    }
    default:
      throw new Error(`A3 生成器：未知节点 kind ${node.kind}`);
  }
  if (node.nullable) expr += ".nullable()";
  return expr;
}

function zodField(node) {
  let expr = zodExpr(node);
  if (node.default !== undefined) expr += `.default(${lit(node.default)})`;
  return expr;
}

const tsLines = [];
tsLines.push("/**");
tsLines.push(" * GENERATED — DO NOT EDIT.");
tsLines.push(" *");
tsLines.push(" * 来源：`packages/executor-protocol/protocol.json` 的 `schemas` 段（A3 完整形态，");
tsLines.push(" * DEEP_REVIEW 0ef3bbe §七）。由 `node scripts/generate-executor-protocol.mjs` 生成，");
tsLines.push(" * CI 的 executor-protocol-drift job 会重跑并 `git diff --exit-code` 兜底。");
tsLines.push(" *");
tsLines.push(" * 手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。");
tsLines.push(" */");
tsLines.push('import { z } from "zod";');
tsLines.push("");
for (const name of orderedNames) {
  const node = normalized[name];
  tsLines.push(`export const ${name}Schema = ${zodField(node)};`);
  tsLines.push(`export type ${name} = z.infer<typeof ${name}Schema>;`);
  tsLines.push("");
}

// ── 发射：Python / pydantic ─────────────────────────────────────────────────

const pyBlocks = [];
let needsLiteral = false;

function pyType(node, required) {
  let t;
  switch (node.kind) {
    case "ref":
      t = node.ref;
      break;
    case "enum": {
      needsLiteral = true;
      t = `Literal[${node.values.map(lit).join(", ")}]`;
      break;
    }
    case "string":
      t = "str";
      break;
    case "integer":
      t = "int";
      break;
    case "number":
      t = "float";
      break;
    case "boolean":
      t = "bool";
      break;
    case "array":
      t = `list[${pyType(node.items, true)}]`;
      break;
    case "object":
      // 内联嵌套对象在上层已被拒绝（见下方发射循环），此处只可能是无 properties 的字典
      t = "dict[str, Any]";
      break;
    default:
      throw new Error(`A3 生成器：未知节点 kind ${node.kind}`);
  }
  return node.nullable || !required ? `${t} | None` : t;
}

function pyFieldAttrs(node, required) {
  const attrs = [];
  if (node.kind === "integer" || node.kind === "number") {
    if (node.minimum !== undefined) attrs.push(`ge=${node.minimum}`);
    if (node.maximum !== undefined) attrs.push(`le=${node.maximum}`);
  }
  if (node.kind === "string" && node.pattern) {
    attrs.push(`pattern=${lit(node.pattern)}`);
  }
  const hasDefault = node.default !== undefined;
  // 列表等可变默认值必须用 default_factory，否则 pydantic 直接报错（共享可变默认值）
  if (hasDefault && Array.isArray(node.default)) {
    attrs.push(
      node.default.length === 0 ? "default_factory=list" : `default_factory=lambda: ${lit(node.default)}`,
    );
  } else if (hasDefault) {
    attrs.push(`default=${lit(node.default)}`);
  } else if (!required) {
    attrs.push("default=None");
  }
  return attrs;
}

for (const name of orderedNames) {
  const node = normalized[name];
  const block = [];
  block.push(`class ${name}(BaseModel):`);
  if (node.description) block.push(`    """${node.description}"""`);
  block.push(
    `    model_config = ConfigDict(extra=${node.additionalProperties ? '"allow"' : '"forbid"'})`,
  );
  for (const [field, child] of Object.entries(node.properties ?? {})) {
    // 有 default 的字段恒有值，不加 `| None`（与 zod 的 .default() 语义对齐）
    const required = node.required.has(field) || child.default !== undefined;
    let annotation;
    if (child.kind === "ref") {
      annotation = required ? child.ref : `${child.ref} | None`;
    } else if (child.kind === "object" && child.properties !== null) {
      throw new Error(
        `A3 生成器：内联嵌套对象（${name}.${field}）不受支持——请抽成顶层 schema 再用 $ref` +
          `（内联会在 zod 侧生成匿名类型、两侧形状无法对齐）`,
      );
    } else {
      annotation = pyType(child, required);
    }
    const attrs = pyFieldAttrs(child, required);
    block.push(
      `    ${field}: ${annotation}${attrs.length ? ` = Field(${attrs.join(", ")})` : ""}`,
    );
  }
  // 无字段的 schema（全 passthrough 的空对象）也要有 body，否则语法错误
  if (Object.keys(node.properties ?? {}).length === 0) block.push("");
  pyBlocks.push(block.join("\n"));
}

const pyHeader = [];
pyHeader.push('"""GENERATED — DO NOT EDIT.');
pyHeader.push("");
pyHeader.push("来源：`packages/executor-protocol/protocol.json` 的 `schemas` 段（A3 完整形态，");
pyHeader.push("DEEP_REVIEW 0ef3bbe §七）。由 `node scripts/generate-executor-protocol.mjs` 生成，");
pyHeader.push("CI 的 executor-protocol-drift job 会重跑并 `git diff --exit-code` 兜底。");
pyHeader.push("");
pyHeader.push("手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。");
pyHeader.push('"""');
pyHeader.push("from __future__ import annotations");
pyHeader.push("");
pyHeader.push("from typing import Any" + (needsLiteral ? ", Literal" : ""));
pyHeader.push("");
pyHeader.push("from pydantic import BaseModel, ConfigDict, Field");

// ── 写出 ────────────────────────────────────────────────────────────────────

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  console.log(`A3 生成：${path.replace(ROOT + "\\", "").replace(ROOT + "/", "")}`);
}

write(NODE_OUT, tsLines.join("\n"));
// 类之间空两行（PEP8）；header 与首个类之间同样空两行
write(PY_OUT, `${pyHeader.join("\n")}\n\n\n${pyBlocks.join("\n\n\n")}\n`);
console.log(`A3 生成完成：${names.length} 个 schema（${names.join(", ")}）`);
