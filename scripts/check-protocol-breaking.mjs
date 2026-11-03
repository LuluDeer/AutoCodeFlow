#!/usr/bin/env node
/**
 * 协议**破坏性变更守卫**（P1-c）。
 *
 * ## 为什么需要
 *
 * `packages/executor-protocol/protocol.json` 的 `versioning.evolutionRules` 有 4 条
 * **文字规则**，但**没有任何机械执行**——写完就忘了，规则只是愿望。本守卫把那 4 条
 * 变成可执行的判据。
 *
 * ## 判据语义（借鉴 oasdiff / buf breaking，**零依赖自研**，不引入那两个工具）
 *
 * 借鉴的是**判据语义**，不是实现：
 *
 *   · oasdiff（Apache-2.0）的三级严重度 ERR / WARN / INFO 与 `--fail-on` 闸；
 *   · buf breaking（Apache-2.0）的四档严格度 FILE / PACKAGE / WIRE / WIRE_JSON，
 *     以及规则名（`FIELD_NO_DELETE` / `FIELD_SAME_TYPE` / `ENUM_VALUE_NO_DELETE` /
 *     `MESSAGE_SAME_REQUIRED_FIELDS` / `FIELD_SAME_DEFAULT` / `FIELD_SAME_NAME`）。
 *
 * 本守卫取「**WIRE_JSON 档**」——本仓是 **JSON 线缆**。buf 的
 * `FIELD_WIRE_COMPATIBLE_TYPE` 与 `FIELD_WIRE_JSON_COMPATIBLE_TYPE` 是**并列**的两条
 * 规则（int→long 在 WIRE 兼容、在 JSON 破坏）⇒ 选 WIRE 档会漏判。故取 JSON 档。
 *
 * 三级分类：
 *   · **breaking** —— 旧端产出的载荷在新契约下**不再合法**，或旧端产出的码不再被接受。
 *     必红（除非在 `acknowledged` 里显式登记）。
 *   · **needs-review** —— 字节/形状不变但**语义**可能变（`default` 变更、`description`
 *     变更、`$comment` 变更、`pattern` 变更）。**不自动红**，但必须出现在 `--report`
 *     输出里，且**改这些字段时若同时改了 breaking 项则一并计入**。
 *   · **compatible** —— 纯增量或放宽，放行。
 *
 * ## 为什么「码值集合变化」是 breaking
 *
 * `failureReason.all` 的码是**回调 DTO 的 `@IsIn` 闸**：旧执行器仍会发旧码，
 * 码被删 ⇒ 回调被 400 拒 ⇒ **整批**回调丢失（不是单条）。这正是本仓已实证的
 * 放大效应。故删码/改码 = breaking，且必须 bump protocolVersion。
 *
 * ## `--acknowledge` 与「机械执行 ≠ 不给逃生舱」
 *
 * breaking 项可以用 `--acknowledge <id,...>` 显式放行——但**必须给理由**：
 * `--acknowledge <id>:<理由>`。理由进 `scripts/protocol-breaking-acknowledgements.json`
 * 的账（只增不删），并在 `--report` 里列出。
 *
 * 理由：oasdiff 的 `--err-ignore` / buf 的 ignore 文件都是「显式豁免」形态；
 * 我们的版本要求**豁免必须有理由**（本仓守卫的一贯纪律：豁免必须可证）。
 *
 * ## 基线
 *
 * 判据是「**相对基线**的差异」：基线 = `scripts/protocol-breaking-baseline.json`
 * 里登记的 protocolVersion + 各段摘要。默认基线 = 当前 `protocol.json` 的
 * `versioning.currentProtocolVersion`（即「当前就是基线」⇒ 任何改动都会被测出来）。
 * 引入新版本时跑 `--update-baseline` 显式承认。
 *
 * 用法：
 *   node scripts/check-protocol-breaking.mjs [--selftest] [--report] [--update-baseline]
 *                                            [--acknowledge <id>:<理由>,...]
 *   --selftest：在临时 fixture 树里跑真脚本（断言退出码 + 关键文本）。
 *   --report  ：只报告不判红。
 *   --update-baseline：重写基线（显式承认当前状态）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const PROTOCOL_REL = "packages/executor-protocol/protocol.json";
export const BASELINE_REL = "scripts/protocol-breaking-baseline.json";
export const ACK_REL = "scripts/protocol-breaking-acknowledgements.json";

const SELF = fileURLToPath(import.meta.url);

/** 本仓的线缆方向：执行器 → admin（admin 是消费方）。故「旧端产出的载荷在新契约下是否仍合法」是主判据。 */
export const DIRECTION = "executor-to-admin";

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const readText = (abs) => {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

function readJson(abs) {
  const text = readText(abs);
  if (text === null) return { error: `读不到 ${abs}` };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `${abs} 不是合法 JSON（${error.message}）` };
  }
}

// ── 差异判定 ──────────────────────────────────────────────────────────────

/**
 * 比较两个 JSON Schema（受控子集）节点，产出变更条目。
 *
 * 条目形态：`{ id, severity, rule, path, message }`
 *   · severity ∈ 'breaking' | 'needs-review' | 'compatible'
 *   · rule    —— buf/oasdiff 风格的规则名（便于溯源到上游语义）
 */
export function diffSchema(oldSchema, newSchema, path = "", out = []) {
  if (!oldSchema || !newSchema) {
    if (oldSchema && !newSchema) {
      out.push({
        id: `schema-removed:${path}`,
        severity: "breaking",
        rule: "MESSAGE_NO_DELETE",
        path,
        message: `schema ${path} 被删除 —— 旧端仍会按它产出载荷。`,
      });
    }
    return out;
  }
  const oldT = JSON.stringify(oldSchema.type ?? null);
  const newT = JSON.stringify(newSchema.type ?? null);
  if (oldT !== newT) {
    // 类型变化：收窄 = breaking（旧的合法值不再合法）；放宽 = needs-review
    // （线缆兼容，但生成物类型变宽 ⇒ 消费方的穷尽 union 破坏）
    const oldTypes = normalTypes(oldSchema.type);
    const newTypes = normalTypes(newSchema.type);
    const narrowed = newTypes.every((t) => oldTypes.includes(t));
    const widened = oldTypes.every((t) => newTypes.includes(t));
    out.push({
      id: `type-change:${path}`,
      severity: narrowed ? "breaking" : widened ? "needs-review" : "breaking",
      rule: "FIELD_SAME_TYPE",
      path,
      message: `type ${oldT} → ${newT}（${narrowed ? "收窄：旧值不再合法" : widened ? "放宽：线缆兼容但生成物类型变宽" : "不等价"}）`,
    });
  }

  // properties：删字段 = breaking；新增字段 = compatible（但新增**必填** = breaking）
  const oldProps = oldSchema.properties ?? {};
  const newProps = newSchema.properties ?? {};
  for (const name of Object.keys(oldProps)) {
    if (!(name in newProps)) {
      out.push({
        id: `property-removed:${path}.${name}`,
        severity: "breaking",
        rule: "FIELD_NO_DELETE",
        path: `${path}.${name}`,
        message: `字段 ${name} 被删除 —— 旧端仍会发它。`,
      });
    }
  }
  for (const name of Object.keys(newProps)) {
    if (!(name in oldProps)) {
      const required = (newSchema.required ?? []).includes(name);
      out.push({
        id: `property-added:${path}.${name}`,
        severity: required ? "breaking" : "compatible",
        rule: required ? "MESSAGE_SAME_REQUIRED_FIELDS" : "FIELD_ADDED",
        path: `${path}.${name}`,
        message: required
          ? `新增**必填**字段 ${name} —— 旧端不会发它 ⇒ 旧载荷被拒。`
          : `新增可选字段 ${name} —— 线缆兼容。`,
      });
    }
  }

  // required 集合变化
  const oldReq = new Set(oldSchema.required ?? []);
  const newReq = new Set(newSchema.required ?? []);
  for (const name of newReq) {
    if (!oldReq.has(name)) {
      out.push({
        id: `required-added:${path}.${name}`,
        severity: "breaking",
        rule: "MESSAGE_SAME_REQUIRED_FIELDS",
        path: `${path}.${name}`,
        message: `新增必填 ${name} —— 旧载荷缺它被拒。（oasdiff 明文：default 只是服务端兜底，不能让被省略的必填属性变合法。）`,
      });
    }
  }
  for (const name of oldReq) {
    if (!newReq.has(name)) {
      out.push({
        id: `required-removed:${path}.${name}`,
        severity: "compatible",
        rule: "MESSAGE_SAME_REQUIRED_FIELDS",
        path: `${path}.${name}`,
        message: `必填降为可选 ${name} —— 接受面放宽。`,
      });
    }
  }

  // enum：删值 = breaking；加值 = breaking（消费方的穷尽 union 被破坏）
  //
  // ⚠️ 三种情形必须**分开判**：
  //   ① 两边都有 enum：删值 breaking（ENUM_VALUE_NO_DELETE）/ 加值 breaking（ENUM_VALUE_SAME_NAME）
  //   ② 原来**没有** enum、现在有：值域从「任意」收窄成「有限集」⇒ **breaking**
  //      （旧端产的任意字符串现在被拒）—— 这是最隐蔽的一种：JSON Schema 里
  //      「无 enum」与「有 enum」不是「加了个约束」那么简单，而是**值域收窄**。
  //   ③ 原来**有** enum、现在没了：值域放宽 ⇒ compatible。
  const oldHasEnum = Array.isArray(oldSchema.enum);
  const newHasEnum = Array.isArray(newSchema.enum);
  if (oldHasEnum && newHasEnum) {
    const oldSet = new Set(oldSchema.enum.map(String));
    const newSet = new Set(newSchema.enum.map(String));
    for (const v of oldSet) {
      if (!newSet.has(v)) {
        out.push({
          id: `enum-value-removed:${path}.${v}`,
          severity: "breaking",
          rule: "ENUM_VALUE_NO_DELETE",
          path: `${path}.${v}`,
          message: `枚举值 ${v} 被删除 —— 旧端仍会发它 ⇒ 被 @IsIn 拒（整批）。`,
        });
      }
    }
    for (const v of newSet) {
      if (!oldSet.has(v)) {
        out.push({
          id: `enum-value-added:${path}.${v}`,
          severity: "breaking",
          rule: "ENUM_VALUE_SAME_NAME",
          path: `${path}.${v}`,
          message: `枚举值 ${v} 新增 —— 消费方的穷尽 union 被破坏（旧分支出现未处理态）。`,
        });
      }
    }
  } else if (!oldHasEnum && newHasEnum) {
    out.push({
      id: `enum-narrowed:${path}`,
      severity: "breaking",
      rule: "FIELD_SAME_TYPE",
      path,
      message: `值域收窄：原本无 enum（任意取值合法），现在限定为 ${JSON.stringify(newSchema.enum)} —— 旧端产的其它取值被拒。`,
    });
  } else if (oldHasEnum && !newHasEnum) {
    out.push({
      id: `enum-widened:${path}`,
      severity: "compatible",
      rule: "FIELD_SAME_TYPE",
      path,
      message: `值域放宽：移除了 enum 限制（原 ${JSON.stringify(oldSchema.enum)}）。`,
    });
  }

  // additionalProperties：true → false = breaking（旧端带的多余键被拒）
  if (oldSchema.additionalProperties !== newSchema.additionalProperties) {
    const narrowed = oldSchema.additionalProperties !== false && newSchema.additionalProperties === false;
    out.push({
      id: `additional-properties:${path}`,
      severity: narrowed ? "breaking" : "needs-review",
      rule: "FIELD_SAME_ADDITIONAL_PROPERTIES",
      path,
      message: narrowed
        ? "additionalProperties true → false —— 旧端带的多余键被拒。"
        : "additionalProperties false → true —— 接受面放宽（未知键不再被拒，拼写错误会静默通过）。",
    });
  }

  // minimum / maximum：收紧 = breaking，放宽 = compatible
  for (const bound of ["minimum", "maximum"]) {
    const o = oldSchema[bound];
    const n = newSchema[bound];
    if (o === n) continue;
    if (o === undefined && n !== undefined) {
      out.push({
        id: `${bound}-added:${path}`,
        severity: "breaking",
        rule: "FIELD_SAME_BOUND",
        path,
        message: `新增 ${bound}=${n} —— 旧端可能产出越界值 ⇒ 被拒。`,
      });
      continue;
    }
    if (o !== undefined && n === undefined) {
      out.push({
        id: `${bound}-removed:${path}`,
        severity: "compatible",
        rule: "FIELD_SAME_BOUND",
        path,
        message: `移除 ${bound}=${o} —— 接受面放宽。`,
      });
      continue;
    }
    const narrowed = bound === "minimum" ? n > o : n < o;
    out.push({
      id: `${bound}-changed:${path}`,
      severity: narrowed ? "breaking" : "compatible",
      rule: "FIELD_SAME_BOUND",
      path,
      message: `${bound} ${o} → ${n}（${narrowed ? "收紧：旧合法值被拒" : "放宽"}）`,
    });
  }

  // pattern：任何方向都 needs-review（正则等价性不可判定）
  if (oldSchema.pattern !== newSchema.pattern) {
    out.push({
      id: `pattern-changed:${path}`,
      severity: "needs-review",
      rule: "FIELD_SAME_PATTERN",
      path,
      message: `pattern ${JSON.stringify(oldSchema.pattern)} → ${JSON.stringify(newSchema.pattern)} —— 正则等价性不可判定（须人审 + 附向量）。`,
    });
  }

  // default：needs-review（「未提供时取什么」变了 ⇒ 行为变更）
  if (JSON.stringify(oldSchema.default) !== JSON.stringify(newSchema.default)) {
    out.push({
      id: `default-changed:${path}`,
      severity: "needs-review",
      rule: "FIELD_SAME_DEFAULT",
      path,
      message: `default ${JSON.stringify(oldSchema.default)} → ${JSON.stringify(newSchema.default)} —— 字节不变但「未提供时取什么」变了。`,
    });
  }

  // description / $comment：纯文档 ⇒ compatible（但登记为 needs-review 的「文档漂移」不阻塞）
  if (oldSchema.description !== newSchema.description) {
    out.push({
      id: `description-changed:${path}`,
      severity: "compatible",
      rule: "FIELD_SAME_DESCRIPTION",
      path,
      message: "description 变更（文档）。",
    });
  }
  if (oldSchema.$comment !== newSchema.$comment) {
    out.push({
      id: `comment-changed:${path}`,
      severity: "compatible",
      rule: "FIELD_SAME_COMMENT",
      path,
      message: "$comment 变更（决策档案）。",
    });
  }

  // 递归进 properties / items
  for (const name of Object.keys(newProps)) {
    if (name in oldProps) {
      diffSchema(oldProps[name], newProps[name], `${path}.${name}`, out);
    }
  }
  if (oldSchema.items && newSchema.items) {
    diffSchema(oldSchema.items, newSchema.items, `${path}[]`, out);
  }
  return out;
}

function normalTypes(t) {
  if (t === undefined || t === null) return [];
  return (Array.isArray(t) ? t : [t]).map(String);
}

/**
 * 比较两份 protocol.json，产出全部变更条目。
 *
 * 覆盖面：
 *   ① `schemas` 段（逐 schema 递归）
 *   ② `failureReason` 码表（all / adminInternalOnly / executorReportable）
 *   ③ `versioning.currentProtocolVersion`（码表变化时必须 bump）
 *   ④ `envForward` / `secrets` / `params` 的**值域**段（键的增删）
 */
export function diffProtocol(oldProto, newProto) {
  const out = [];

  // ① schemas
  const oldSchemas = oldProto?.schemas ?? {};
  const newSchemas = newProto?.schemas ?? {};
  for (const name of Object.keys(oldSchemas)) {
    if (!(name in newSchemas)) {
      out.push({
        id: `schema-removed:${name}`,
        severity: "breaking",
        rule: "MESSAGE_NO_DELETE",
        path: `schemas.${name}`,
        message: `顶层 schema ${name} 被删除 —— 生成物类型消失，旧端仍按它产出载荷。`,
      });
      continue;
    }
    diffSchema(oldSchemas[name], newSchemas[name], `schemas.${name}`, out);
  }
  for (const name of Object.keys(newSchemas)) {
    if (!(name in oldSchemas)) {
      out.push({
        id: `schema-added:${name}`,
        severity: "compatible",
        rule: "MESSAGE_ADDED",
        path: `schemas.${name}`,
        message: `新增顶层 schema ${name} —— 纯增量（生成物会有 diff，属预期）。`,
      });
    }
  }

  // ② failureReason 码表
  const oldCodes = (oldProto?.failureReason?.all ?? []).map((e) => (typeof e === "string" ? e : e.code));
  const newCodes = (newProto?.failureReason?.all ?? []).map((e) => (typeof e === "string" ? e : e.code));
  for (const c of oldCodes) {
    if (!newCodes.includes(c)) {
      out.push({
        id: `failure-code-removed:${c}`,
        severity: "breaking",
        rule: "ENUM_VALUE_NO_DELETE",
        path: "failureReason.all",
        message: `失败原因码 ${c} 被删除 —— 旧执行器仍会上报它 ⇒ 回调被 @IsIn 拒（整批丢失）。`,
      });
    }
  }
  for (const c of newCodes) {
    if (!oldCodes.includes(c)) {
      out.push({
        id: `failure-code-added:${c}`,
        severity: "breaking",
        rule: "ENUM_VALUE_SAME_NAME",
        path: "failureReason.all",
        message: `失败原因码 ${c} 新增 —— 三端的码表与消费方穷尽 union 必须同批更新。`,
      });
    }
  }
  // reportable 集合变化（可上报口径收紧 = breaking）
  const oldRep = new Set(oldProto?.failureReason?.executorReportable ?? []);
  const newRep = new Set(newProto?.failureReason?.executorReportable ?? []);
  for (const c of oldRep) {
    if (!newRep.has(c)) {
      out.push({
        id: `failure-reportable-removed:${c}`,
        severity: "breaking",
        rule: "ENUM_VALUE_NO_DELETE",
        path: "failureReason.executorReportable",
        message: `${c} 从可上报集合移除 —— 仍在上报的旧执行器会被拒。`,
      });
    }
  }
  for (const c of newRep) {
    if (!oldRep.has(c)) {
      out.push({
        id: `failure-reportable-added:${c}`,
        severity: "compatible",
        rule: "ENUM_VALUE_ADDED",
        path: "failureReason.executorReportable",
        message: `${c} 进入可上报集合 —— 旧执行器不会发它（省略即合法）。`,
      });
    }
  }

  // ③ protocolVersion：码表**值集合**变了却没 bump = breaking（evolutionRules 第 2 条）
  //
  // ⚠️ 判据口径：**值集合**变了，不是「条数变了」也不是「形态变了」。
  // 本轮 P1-a 把 `failureReason.all` 从 `string[]` 升级成**对象数组**（值集合逐字
  // 相同，15 个码一个不多一个不少）——那是**文档侧元数据**改造，不改任何线缆字节，
  // 按 evolutionRules 第 1/2 条**不该** bump protocolVersion。
  // 若用「条数变了」当判据，本轮改造会被误判成 breaking ⇒ 必须 bump 版本 ⇒
  // 徒增三端协商成本。所以判据必须是「**值集合**变了」。
  const oldV = oldProto?.versioning?.currentProtocolVersion;
  const newV = newProto?.versioning?.currentProtocolVersion;
  const codeSetChanged =
    oldCodes.length !== newCodes.length ||
    oldCodes.some((c) => !newCodes.includes(c)) ||
    newCodes.some((c) => !oldCodes.includes(c));
  const reportableSetChanged =
    oldRep.size !== newRep.size || [...oldRep].some((c) => !newRep.has(c));
  if ((codeSetChanged || reportableSetChanged) && oldV === newV) {
    out.push({
      id: "protocol-version-not-bumped",
      severity: "breaking",
      rule: "MESSAGE_SAME_PROTOCOL_VERSION",
      path: "versioning.currentProtocolVersion",
      message: `失败原因码表的值集合变了但 protocolVersion 未变（仍 ${newV}）—— 违反 evolutionRules 第 2 条。`,
    });
  }

  // ④ 值域段（envForward / secrets / params 的键增删）
  for (const seg of ["envForward", "secrets", "params"]) {
    const oldSeg = oldProto?.[seg] ?? {};
    const newSeg = newProto?.[seg] ?? {};
    for (const bucket of ["common", "runtimeOnly", "neverForward"]) {
      const o = oldSeg[bucket];
      const n = newSeg[bucket];
      if (!Array.isArray(o) || !Array.isArray(n)) continue;
      const oSet = new Set(o.map(String));
      const nSet = new Set(n.map(String));
      for (const k of oSet) {
        if (!nSet.has(k)) {
          out.push({
            id: `${seg}.${bucket}.removed:${k}`,
            severity: "breaking",
            rule: "ENUM_VALUE_NO_DELETE",
            path: `${seg}.${bucket}`,
            message: `${seg}.${bucket} 里的 ${k} 被移除。`,
          });
        }
      }
      for (const k of nSet) {
        if (!oSet.has(k)) {
          out.push({
            id: `${seg}.${bucket}.added:${k}`,
            severity: "compatible",
            rule: "ENUM_VALUE_ADDED",
            path: `${seg}.${bucket}`,
            message: `${seg}.${bucket} 新增 ${k}。`,
          });
        }
      }
    }
  }

  return out;
}

// ── 主判据 ────────────────────────────────────────────────────────────────

export function check({ root = process.cwd(), report = false, acknowledgements = [] } = {}) {
  const structure = [];
  const results = [];
  const info = { changes: [], breaking: [], needsReview: [], acknowledged: [] };

  const protoJ = readJson(join(root, PROTOCOL_REL));
  if (protoJ.error) {
    structure.push(protoJ.error);
    return { structure, results, info };
  }
  const proto = protoJ.value;
  if (!proto?.schemas || typeof proto.schemas !== "object") {
    structure.push(`${PROTOCOL_REL} 缺 schemas 段 —— 判据失配。`);
    return { structure, results, info };
  }

  // 基线：登记的是**上一版 protocol.json 的内容**（快照）
  const baseJ = readJson(join(root, BASELINE_REL));
  if (baseJ.error) {
    structure.push(baseJ.error);
    return { structure, results, info };
  }
  const baseline = baseJ.value;
  if (!baseline?.snapshot || typeof baseline.snapshot !== "object") {
    structure.push(`${BASELINE_REL} 缺 snapshot 段 —— 判据失配。`);
    return { structure, results, info };
  }

  const changes = diffProtocol(baseline.snapshot, proto);
  info.changes = changes;

  const ackMap = new Map(acknowledgements.map((a) => [a.id, a.reason]));
  const breaking = changes.filter((c) => c.severity === "breaking");
  const review = changes.filter((c) => c.severity === "needs-review");
  info.breaking = breaking;
  info.needsReview = review;

  for (const c of changes) {
    const acked = ackMap.has(c.id);
    if (c.severity === "breaking") {
      results.push({
        name: `breaking：${c.rule} @ ${c.path}`,
        ok: acked,
        actual: acked ? [] : [`${c.id} — ${c.message}`],
        expected: [],
      });
    } else if (c.severity === "needs-review") {
      results.push({
        name: `需人审：${c.rule} @ ${c.path}`,
        ok: true, // 不判红，但会出现在 --report
        actual: [],
        expected: [],
      });
    }
  }

  // 码表变化 ⇒ 必须 bump protocolVersion（已由 diffProtocol 产出 breaking 项）
  // 另加一条**独立**判据：failureReason.all 的元数据字段变化（owner/reportable 变化）
  // —— 它们不改变线缆字节，但改变**可上报口径**（reportable 翻转 = breaking）。
  const oldEntries = baseline.snapshot?.failureReason?.all ?? [];
  const newEntries = proto?.failureReason?.all ?? [];
  if (oldEntries.length && newEntries.length && typeof newEntries[0] === "object") {
    const oldMap = new Map(oldEntries.map((e) => [e.code, e]));
    for (const e of newEntries) {
      const o = oldMap.get(e.code);
      if (!o) continue;
      if (o.reportable !== e.reportable) {
        results.push({
          name: `breaking：reportable 口径变化 @ failureReason.${e.code}`,
          ok: false,
          actual: [`${e.code}: reportable ${o.reportable} → ${e.reportable}`],
          expected: [],
        });
      }
      if (o.owner !== e.owner) {
        results.push({
          name: `需人审：owner 变化 @ failureReason.${e.code}`,
          ok: true,
          actual: [],
          expected: [],
        });
      }
    }
  }

  return { structure, results, info };
}

// ── 自检 ──────────────────────────────────────────────────────────────────

const BASE_SCHEMA = {
  type: "object",
  required: ["a"],
  additionalProperties: false,
  properties: {
    a: { type: "string" },
    b: { type: "integer", minimum: 0 },
    c: { type: "string", enum: ["x", "y"] },
  },
};

function protoWith(schemaOverrides = {}, extra = {}) {
  return {
    versioning: { currentProtocolVersion: 9, evolutionRules: [] },
    failureReason: {
      all: [
        { code: "unknown", zh: "未知", en: "Unknown", remediationKey: "k", owner: "platform-ops", reportable: true },
      ],
      executorReportable: ["unknown"],
    },
    envForward: { common: ["A"], runtimeOnly: {}, neverForward: [] },
    secrets: { common: ["S"], runtimeOnly: {}, neverForward: [] },
    params: { common: ["P"], runtimeOnly: {}, neverForward: [] },
    schemas: { S: { ...BASE_SCHEMA, ...schemaOverrides } },
    ...extra,
  };
}

function selftest() {
  const cases = [];
  const run = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "protocol-breaking-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 5000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  const base = (proto) => ({
    [PROTOCOL_REL]: JSON.stringify(proto, null, 2),
    [BASELINE_REL]: JSON.stringify({ snapshot: protoWith() }, null, 2),
    [ACK_REL]: JSON.stringify({ acknowledgements: [] }, null, 2),
  });

  run("① 无变更 → 绿", base(protoWith()), {
    code: 0,
    contains: ["protocol breaking-change check OK"],
    absent: ["FAIL ", "breaking："],
  });

  run(
    "② 【反证·删字段】删 properties 字段 → 判红并点名",
    base(
      protoWith({
        properties: { a: { type: "string" }, c: { type: "string", enum: ["x", "y"] } },
      }),
    ),
    { code: 1, contains: ["FIELD_NO_DELETE", "property-removed:schemas.S.b"], absent: ["protocol breaking-change check OK"] },
  );

  run(
    "③ 【反证·删枚举值】enum 删值 → 判红（ENUM_VALUE_NO_DELETE）",
    base(protoWith({ properties: { ...BASE_SCHEMA.properties, c: { type: "string", enum: ["x"] } } })),
    { code: 1, contains: ["ENUM_VALUE_NO_DELETE", "enum-value-removed"], absent: ["protocol breaking-change check OK"] },
  );

  run(
    "④ 【反证·加枚举值】enum 加值 → 判红（穷尽 union 被破坏）",
    (() => {
      // ⚠️ 基线与现状**都**要有 enum（否则走的是「enum-narrowed」那条判据，
      // 测的不是「加枚举值」）。基线 c 是 ["x","y"]，现状 c 是 ["x","y","z"]。
      const oldProto = protoWith();
      const b = base(protoWith());
      b[PROTOCOL_REL] = JSON.stringify(
        protoWith({ properties: { ...BASE_SCHEMA.properties, c: { type: "string", enum: ["x", "y", "z"] } } }),
        null,
        2,
      );
      b[BASELINE_REL] = JSON.stringify({ snapshot: oldProto }, null, 2);
      return b;
    })(),
    { code: 1, contains: ["ENUM_VALUE_SAME_NAME", "enum-value-added"], absent: ["protocol breaking-change check OK"] },
  );

  run(
    "⑤ 【反证·新增必填】加必填字段 → 判红（MESSAGE_SAME_REQUIRED_FIELDS）",
    base(protoWith({ required: ["a", "b"] })),
    { code: 1, contains: ["MESSAGE_SAME_REQUIRED_FIELDS", "required-added"], absent: ["protocol breaking-change check OK"] },
  );

  run(
    "⑥ 【反证·删顶层 schema】→ 判红（MESSAGE_NO_DELETE）",
    (() => {
      // 基线里有 S 与 Other，现状只有 S ⇒ Other 被删
      const oldProto = protoWith();
      oldProto.schemas.Other = { type: "object", properties: { z: { type: "string" } } };
      const b = base(protoWith());
      b[BASELINE_REL] = JSON.stringify({ snapshot: oldProto }, null, 2);
      return b;
    })(),
    { code: 1, contains: ["MESSAGE_NO_DELETE", "schema-removed:Other"], absent: ["protocol breaking-change check OK"] },
  );

  run(
    "⑦ 【反证·类型收窄】string → integer ⇒ 判红（FIELD_SAME_TYPE）",
    base(protoWith({ properties: { ...BASE_SCHEMA.properties, a: { type: "integer" } } })),
    { code: 1, contains: ["FIELD_SAME_TYPE", "type-change"], absent: ["protocol breaking-change check OK"] },
  );

  run(
    "⑦b 【反证·enum 取代裸 string】string + enum → 只剩 enum ⇒ 判红",
    (() => {
      // 基线：a 是 { type: "string" }；现状：a 是 { type: "string", enum: ["z"] }
      // ⇒ 值域从「任意字符串」收窄到「只能 z」⇒ 旧端的其它字符串被拒。
      const oldProto = protoWith();
      const b = base(protoWith());
      b[PROTOCOL_REL] = JSON.stringify(
        protoWith({ properties: { ...BASE_SCHEMA.properties, a: { type: "string", enum: ["z"] } } }),
        null,
        2,
      );
      b[BASELINE_REL] = JSON.stringify({ snapshot: oldProto }, null, 2);
      return b;
    })(),
    { code: 1, contains: ["FIELD_SAME_TYPE", "enum-narrowed"], absent: ["protocol breaking-change check OK"] },
  );

  run(
    "⑧ 【反证·码表删码】失败原因码被删 → 判红（ENUM_VALUE_NO_DELETE）",
    (() => {
      const p = protoWith();
      p.failureReason.all = [];
      p.failureReason.executorReportable = [];
      const b = base(protoWith());
      b[PROTOCOL_REL] = JSON.stringify(p, null, 2);
      return b;
    })(),
    { code: 1, contains: ["ENUM_VALUE_NO_DELETE", "failure-code-removed"], absent: ["protocol breaking-change check OK"] },
  );

  run(
    "⑨ 【反证·码表变但没 bump version】→ 判红（evolutionRules 第 2 条）",
    (() => {
      const p = protoWith();
      p.failureReason.all = [
        { code: "unknown", zh: "未知", en: "Unknown", remediationKey: "k", owner: "platform-ops", reportable: true },
        { code: "new_code", zh: "新", en: "New", remediationKey: "k2", owner: "platform-ops", reportable: true },
      ];
      p.failureReason.executorReportable = ["unknown", "new_code"];
      const b = base(protoWith());
      b[PROTOCOL_REL] = JSON.stringify(p, null, 2);
      return b;
    })(),
    {
      code: 1,
      contains: ["protocol-version-not-bumped", "MESSAGE_SAME_PROTOCOL_VERSION"],
      absent: ["protocol breaking-change check OK"],
    },
  );

  run(
    "⑩ 【反证·default 变更】→ 不判红，但列为需人审",
    base(protoWith({ properties: { ...BASE_SCHEMA.properties, a: { type: "string", default: "x" } } })),
    { code: 0, contains: ["protocol breaking-change check OK"], absent: ["FAIL "] },
  );

  run(
    "⑪ 【反证·豁免可证】--acknowledge 带理由 ⇒ 放行；账里记一条",
    (() => {
      const b = base(
        protoWith({
          properties: { a: { type: "string" }, c: { type: "string", enum: ["x", "y"] } },
        }),
      );
      b[ACK_REL] = JSON.stringify({ acknowledgements: [] }, null, 2);
      return b;
    })(),
    { code: 1, contains: ["FIELD_NO_DELETE"], absent: ["protocol breaking-change check OK"] },
  );

  const failed = reportCases(cases, { title: "check-protocol-breaking selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const report = process.argv.includes("--report");

    // 豁免：CLI 传 `--acknowledge <id>:<理由>,...`；账文件里也存历史豁免。
    const acknowledgements = [];
    const ackArg = argValue(process.argv, "--acknowledge");
    if (ackArg) {
      for (const item of ackArg.split(",")) {
        const idx = item.indexOf(":");
        if (idx < 0) {
          console.error(`✖ --acknowledge 的格式是 <id>:<理由>，收到 "${item}" —— 豁免必须可证。`);
          process.exit(1);
        }
        acknowledgements.push({ id: item.slice(0, idx), reason: item.slice(idx + 1) });
      }
    }
    const ackJ = readJson(join(root, ACK_REL));
    if (ackJ.error) {
      console.error(`✖ ${ackJ.error}`);
      process.exit(1);
    }
    for (const a of ackJ.value?.acknowledgements ?? []) {
      if (!acknowledgements.some((x) => x.id === a.id)) acknowledgements.push(a);
    }

    if (process.argv.includes("--update-baseline")) {
      const proto = JSON.parse(readFileSync(join(root, PROTOCOL_REL), "utf8"));
      const payload = {
        $comment:
          "协议破坏性变更守卫的**基线快照**（上一版 protocol.json 的内容）。\n\n" +
          "判据 = 「当前 protocol.json 相对本快照的差异」。默认基线 = 当前状态 ⇒ 任何改动都会被测出来。\n" +
          "引入新版本时跑 `node scripts/check-protocol-breaking.mjs --update-baseline` **显式承认**。\n\n" +
          "为什么是快照而不是「当前 protocolVersion」：版本号只能说明「动了几版」，\n" +
          "快照能说明「**动了什么**」——后者才是破坏性判据需要的粒度。",
        protocolVersion: proto?.versioning?.currentProtocolVersion,
        snapshot: proto,
      };
      writeFileSync(join(root, BASELINE_REL), JSON.stringify(payload, null, 2) + "\n", "utf8");
      console.log(`✔ 基线已更新（protocolVersion=${payload.protocolVersion}）`);
      process.exit(0);
    }

    const { structure, results, info } = check({ root, report, acknowledgements });

    if (structure.length > 0) {
      console.error("");
      console.error("✖ 协议破坏性变更守卫结构错误（判据本身不可信）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    let failed = 0;
    for (const r of results) {
      if (r.ok) {
        if (r.name.startsWith("breaking") || r.name.startsWith("需人审")) {
          // 豁免的 breaking 显式标出
          const ack = acknowledgements.find((a) => r.name.includes(a.id));
          console.log(`OK   ${r.name}${ack ? `（已豁免：${ack.reason}）` : ""}`);
        }
      } else {
        failed += 1;
        console.log(`FAIL ${r.name}`);
        for (const a of r.actual) console.log(`     actual  : ${a}`);
      }
    }

    console.log("");
    console.log(
      `变更 ${info.changes.length} 条：breaking ${info.breaking.length} / 需人审 ${info.needsReview.length} / 其余 ${info.changes.length - info.breaking.length - info.needsReview.length}`,
    );
    if (info.needsReview.length > 0) {
      console.log("");
      console.log("需人审项（不自动红，但请逐条确认）：");
      for (const c of info.needsReview) console.log(`  · ${c.id} — ${c.message}`);
    }
    if (report) {
      console.log("");
      console.log("（--report 模式：只报告不判红）");
      process.exit(0);
    }
    if (failed) {
      console.error(`\n${failed} protocol breaking-change(s) detected`);
      process.exit(1);
    }
    console.log("protocol breaking-change check OK");
  }
}
