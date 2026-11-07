#!/usr/bin/env node
/**
 * A2（`causedBySeq`）**因果边写入守卫** —— 让「事件流是因果图」这句话可被证伪。
 *
 * ## 由来（为什么需要一条守卫，而不是一段注释）
 *
 * 迁移 1790000000093 给 `agent_events` 加了 `causedBySeq`，写入侧从此有 `n` 个
 * 调用点要把「这条事件是谁引起的」填进去。这类「每个调用点都要多传一个字段」的
 * 改动有一个**结构性**腐烂方式：新加一个写入点、或复制一段既有代码时**漏传**，
 * 而漏传的后果不是报错，是**静默变成 NULL**——读侧会诚实地回落启发式，
 * 一切看起来都正常，直到某天需要回答「这条状态变化是被谁引起的」时才发现
 * 半个库都没有因果。这与本仓既有守卫（`check-agent-write-sanitize` /
 * `check-conditional-writes`）要防的是同一种病：**纪律在、守卫不在，所以它腐烂了**。
 *
 * ## 判据（三条，逐条对应任务书）
 *
 *   ① **该传的传了**：`apps/admin-api/src/modules/agent/` 下每个
 *      `.tryAppendEvent(` / `.appendEvents(` 调用点，若它的 `kind` 字面量属于
 *      `required: true` 的那几种（`AGENT_EVENT_CAUSATION_RULES`），就必须在同一个
 *      对象字面量里出现 `causedBySeq:`；且**不允许写死 `null`**（那等于明确说
 *      「规则要求有因果，我不给」）。
 *   ② **「同会话 + 更早」这条静态判不出来** ⇒ 判据改由**运行期断言**承担：投影
 *      （`agent-event-projection.ts`）遇到 `causedBySeq >= seq` 或指向本会话不存在
 *      的前驱必须记缺口。本脚本对那条断言做**结构核对**（缺了就红）——静态闸
 *      管「有没有传」，运行期闸管「传得对不对」，两者缺一不可。
 *   ③ **结构红**：找不到写入点 / 找不到 kind 闭集 / 扫描面塌陷 / 规则表与闭集
 *      不一致 ⇒ 红。**绝不「读不到就算过」**——那是本仓最熟悉的假绿。
 *
 * ## 豁免必须可证（而不是一张可以随手加名字的白名单）
 *
 * 两类豁免，都要求「理由 + 可核对的事实」：
 *   · `wired-centrally`：调用点确实没传，但**由事件表的拥有者统一补齐**（例如
 *     `approval_decided` 的因果要跨表解引用 `approvalKey → agent_tool_calls.approvalId`，
 *     审批服务不认识台账）。这类豁免必须给 `proof: {file, marker}`，本脚本核对
 *     那个 marker **真的在**那个文件里；marker 消失（有人删了补齐逻辑）⇒ 红。
 *   · `pending`：写入点在本项**足迹之外**、或写侧拿不到精确前驱 ⇒ 如实留 NULL。
 *     这类**不算通过**：每次跑都会用醒目的一段打印出来（`--strict` 下直接红），
 *     接线后必须回来删掉这一条。
 *   · `unattributed`：`kind` 由入参决定的**透传**调用（`tryAppendEvent(sessionId,
 *     event)` 这种包装），本脚本无从判定 ⇒ 判据移交给它的调用方。同样要求理由。
 *   · 任何豁免都必须**还能匹配到一个真实调用点**：陈旧豁免（代码已改、豁免还在）
 *     ⇒ 红（豁免必须回收，否则白名单会越滚越大，最后把守卫吃掉）。
 *
 * ## 已知盲区（如实）
 *
 *   · 只认 `.<方法>(` 形态（`this.sessions.tryAppendEvent(` / `sink.tryAppendEvent(`）：
 *     `const s = this.sessions; s.tryAppendEvent(...)` 或被 `apply` 调用时整段消失。
 *     缓解：另有一条**扫描面下界**（站点数与必需 kind 的覆盖数），塌陷即结构红。
 *   · 只看**同一个对象字面量窗口**（从 `(` 到配对 `)`）：把事件先放进变量再传
 *     （`const e = {...}; tryAppendEvent(id, e)`）会判成 unattributed。
 *   · 不做跨文件的因果**语义**校验（谁指向谁是运行期的事，见判据 ②）。
 *   · 模板字符串里的 `${}` 被当作不透明文本（窗口内若出现不平衡括号，可能截错；
 *     本仓的写入点目前没有这种形态）。
 *
 * ## 用法与退出码
 *
 *   node scripts/check-agent-event-causation.mjs            # 主跑
 *   node scripts/check-agent-event-causation.mjs --strict   # 把「待接线」也算红
 *   node scripts/check-agent-event-causation.mjs --selftest # 判据自检（含正例控制组）
 *   node scripts/check-agent-event-causation.mjs --root <dir> [--strict]  # 换仓库根（自检/排查用）
 *
 *   0 = 通过（可能带「待接线」警告，打印在末尾）
 *   1 = 违规（含结构红与陈旧豁免）
 *   2 = 用法错误
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R160：覆盖计数出口。**必须在任何 require/依赖之前**打印（本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看）。helper = 本文件真实的用例注册函数名
// （`push(name, fn)` = 本文件 selftest 里注册一条用例的那个函数）。
printCoverageBanner(import.meta.url, "push");

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");

/** agent 模块的源码根（相对仓库根）。 */
export const AGENT_SRC_REL = "apps/admin-api/src/modules/agent";
export const ENTITY_REL = `${AGENT_SRC_REL}/entities/agent-event.entity.ts`;
export const PROJECTION_REL = `${AGENT_SRC_REL}/runtime/agent-event-projection.ts`;

/**
 * 扫描面下界（**只增不减**的实测值，2026-11-02 实测 10 个站点）。
 *
 * 为什么要有下界：「0 个站点 ⇒ 0 处漏传」是永真断言，目录改名 / 正则失配 / 方法
 * 改名都会让本守卫变成一句空话。塌到下界以下一律**结构红**。
 */
export const MIN_SITES = 8;
export const MIN_FILES = 20;

/**
 * 每种 kind 的因果规则（**本脚本自己的一份**，与实体里的
 * `AGENT_EVENT_CAUSATION_RULES` 由「kind 闭集必须相等」这一条对齐）。
 *
 * 为什么不在运行时 import 实体：本脚本必须零依赖、且不能把「被检查对象」
 * 当成「判据本体」——那会让「把规则改成 required:false」成为绕过守卫的最短路径。
 * 两份表的一致性由判据 ③（闭集相等）保证：实体新增 kind 而这里没登记 ⇒ 红。
 */
export const RULES = {
  session_context_recorded: {
    required: false,
    cause:
      "无（会话创建先于该会话的一切事件；上下文来自创建入参，不是某条事件的结果）⇒ 恒 NULL",
  },
  step_appended: {
    required: false,
    cause: "无（用户/scheduler 触发整轮运行）⇒ 恒 NULL",
  },
  tool_call_recorded: {
    required: true,
    cause: "请求它的那个 step 的 step_appended（按 stepId 精确解析）",
  },
  tool_call_status_changed: {
    required: true,
    cause:
      "该调用的 tool_call_recorded；deny settle 时指向那条 approval_decided(denied)",
  },
  prompt_fingerprint: {
    required: true,
    cause: "触发这轮 LLM 调用的 step_appended",
  },
  session_finished: {
    required: false,
    cause: "无（终态是整轮运行的结论 / 人工 abort）⇒ 恒 NULL",
  },
  approval_decided: {
    required: true,
    cause:
      "需要审批的那个调用的 tool_call_recorded；consumed 指向同 key 更早的 approval_decided(granted)",
  },
};

const CONFIG_SERVICE_REL = `${AGENT_SRC_REL}/runtime/agent-session.service.ts`;

/**
 * 豁免表（每条都必须能匹配到一个真实调用点，否则算**陈旧豁免** ⇒ 红）。
 *
 * `mode`：
 *   · `pending`       —— 如实留 NULL，**不算通过**（每次打印；`--strict` 下红）
 *   · `wired-centrally` —— 由事件表拥有者统一补齐（必须给可核对的 `proof`）
 *   · `unattributed`  —— kind 由入参决定，判据在调用方
 */
export const EXEMPTIONS = [
  {
    file: `${AGENT_SRC_REL}/runtime/agent-approvals.service.ts`,
    kind: "approval_decided",
    mode: "wired-centrally",
    reason:
      "审批服务只认 approvalKey，不知道「这张单对应哪次调用」；因果跨表解引用（approvalKey → agent_tool_calls.approvalId → toolCallId → 事件 seq）由事件表拥有者的端口统一补齐。",
    proof: { file: CONFIG_SERVICE_REL, marker: "enrichApprovalDecidedCausation" },
  },
  {
    file: CONFIG_SERVICE_REL,
    mode: "unattributed",
    reason:
      "端口包装：`tryAppendEvent(sessionId, await this.enrichApprovalDecidedCausation(...))` —— kind 由审批侧的入参决定，本处无从判定（判据在两者：调用点 + enrich 实现）。",
  },
  {
    file: CONFIG_SERVICE_REL,
    mode: "unattributed",
    reason:
      "`appendEvents(sessionId, [event])` 是 tryAppendEvent 的**透传**（kind 来自入参）：判据在每一个真正的调用点，不在这里重复判。",
  },
];

/* ── 词法工具 ───────────────────────────────────────────────────── */

/**
 * 剥掉注释（行/块），把注释字符替换成**空格并保留换行**。
 *
 * 为什么先剥注释：注释里必须能写出 `tryAppendEvent(...)` 这种例子（否则没法解释
 * 纪律），而「注释里的调用点」会把判据变成假红。保留换行是为了下面还能算行号。
 * 字符串（单引号/双引号/模板串）**原样保留**——里面的 `//` 不是注释。
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = src[i];
        if (c === "\\") {
          out += c + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 第 `index` 个字符所在的行号（1 起）。 */
function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

/**
 * 从 `(` 处向后找配对的 `)`（跳过字符串），返回窗口文本。
 *
 * 窗口上限 `MAX_WINDOW` 是防呆：畸形源码（少一个 `)`）会让扫描一路吃到文件尾，
 * 那时「窗口里有什么」就毫无意义——直接返回 null，由调用方记为可疑站点。
 */
const MAX_WINDOW = 6000;
function windowAt(src, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < src.length && i - openParenIndex < MAX_WINDOW; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(openParenIndex, i + 1);
    }
  }
  return null;
}

/* ── 扫描 ───────────────────────────────────────────────────────── */

/** 递归列出 agent 模块下的 `.ts`（排除 spec 与 `__tests__`）。 */
export function listAgentSources(root) {
  const base = join(root, AGENT_SRC_REL);
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "__tests__" || ent.name === "node_modules") continue;
        walk(abs);
        continue;
      }
      if (!ent.name.endsWith(".ts")) continue;
      if (ent.name.endsWith(".spec.ts") || ent.name.endsWith(".d.ts")) continue;
      out.push(abs);
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

/** `AGENT_EVENT_KINDS` 的闭集（读不到 = 结构红，绝不「读不到就算过」）。 */
export function parseKindClosure(root) {
  const file = join(root, ENTITY_REL);
  if (!existsSync(file)) return { kinds: [], error: `找不到实体文件 ${ENTITY_REL}` };
  const src = stripComments(readFileSync(file, "utf8"));
  const m = /AGENT_EVENT_KINDS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
  if (!m) {
    return { kinds: [], error: "解析不到 AGENT_EVENT_KINDS 闭集（as const 数组被改写？）" };
  }
  const kinds = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (kinds.length === 0) {
    return { kinds: [], error: "AGENT_EVENT_KINDS 里一个 kind 都没解析到" };
  }
  return { kinds, error: null };
}

/**
 * 找所有 `.tryAppendEvent(` / `.appendEvents(` 调用点。
 *
 * 只认带点号的形态：定义（`async tryAppendEvent(`）与接口声明（`tryAppendEvent(`
 * 单独成行）都不带点，天然被排除——这是本判据能用一行正则就分清「定义/声明/调用」
 * 的全部原因。
 */
export function findCallSites(root) {
  const sites = [];
  for (const abs of listAgentSources(root)) {
    const raw = readFileSync(abs, "utf8");
    const src = stripComments(raw);
    const re = /\.(tryAppendEvent|appendEvents)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const open = m.index + m[0].length - 1;
      const win = windowAt(src, open);
      const rel = relative(root, abs).split(sep).join("/");
      if (win === null) {
        sites.push({ file: rel, line: lineOf(src, m.index), method: m[1], kind: null, hasCausation: false, nullLiteral: false, suspicious: true });
        continue;
      }
      const kindMatch = /kind\s*:\s*"([^"]+)"/.exec(win);
      // `causedBySeq` 的两种合法写法都必须认：
      //   · `causedBySeq: <expr>`   —— 显式键值（`null` 也要能看出来）；
      //   · `causedBySeq,`          —— **属性简写**（本仓写入点用的是这种）。
      // 只认带冒号的那种会把「用简写传了」判成「没传」——那是**假红**，而假红
      // 会让人去改实现来迎合守卫，比漏判更危险。
      const keyed = /(?:^|[{,\s])causedBySeq\s*:\s*([^\n,}]*)/.exec(win);
      const shorthand = /(?:^|[{,\s])causedBySeq\s*(?=[,}\n])/.test(win);
      const value = keyed ? keyed[1].trim() : shorthand ? "<简写>" : null;
      sites.push({
        file: rel,
        line: lineOf(src, m.index),
        method: m[1],
        kind: kindMatch ? kindMatch[1] : null,
        hasCausation: value !== null && value.length > 0,
        nullLiteral: value === "null",
        suspicious: false,
      });
    }
  }
  return sites.sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line));
}

/** 投影/读路径里的**运行期断言**（判据 ② 的结构核对）。 */
export function checkRuntimeAssertion(root) {
  const file = join(root, PROJECTION_REL);
  if (!existsSync(file)) {
    return { ok: false, why: `找不到投影文件 ${PROJECTION_REL}` };
  }
  const src = stripComments(readFileSync(file, "utf8"));
  const required = [
    ["causation_invalid", "`causedBySeq >= seq` / 非正整数 必须记缺口"],
    ["causation_missing", "指向本会话不存在的前驱（跨会话 / 已清理）必须记缺口"],
    ["CAUSATION_ALLOWED_PARENTS", "规则表（读侧镜像）必须存在，供 mismatch 判定"],
  ];
  const missing = required.filter(([marker]) => !src.includes(marker));
  if (missing.length > 0) {
    return {
      ok: false,
      why: `投影侧缺少运行期断言：${missing.map(([m, why]) => `${m}（${why}）`).join("、")}`,
    };
  }
  return { ok: true, why: null };
}

/* ── 判定 ───────────────────────────────────────────────────────── */

/**
 * 跑一遍判据（**纯函数**：不打印、不退出，便于自检与复用）。
 *
 * @returns {{ok: boolean, issues: string[], warnings: string[], rows: object[],
 *            pending: object[], stats: object}}
 */
export function judge(root, opts = {}) {
  const extraExempt = opts.extraExempt ?? [];
  const issues = [];
  const warnings = [];
  const rows = [];
  // `opts.exemptions` 只给自检用（正例控制组必须**零豁免**地通过）；主跑永远用
  // 文件内那张 EXEMPTIONS 表。
  const exemptions = opts.exemptions ?? [...EXEMPTIONS, ...extraExempt];

  const closure = parseKindClosure(root);
  if (closure.error) issues.push(`【结构红】${closure.error}`);

  // 判据 ③：闭集 vs 规则表（新增 kind 必须登记因果规则，否则它会悄悄恒为 NULL）
  const ruleKinds = Object.keys(RULES);
  const onlyInCode = closure.kinds.filter((k) => !ruleKinds.includes(k));
  const onlyInRules = ruleKinds.filter((k) => !closure.kinds.includes(k));
  if (onlyInCode.length > 0) {
    issues.push(
      `【结构红】kind 闭集里有未登记因果规则的 kind：${onlyInCode.join("、")} —— 新增 kind 必须在 AGENT_EVENT_CAUSATION_RULES 与本脚本的 RULES 里各登记一条。`,
    );
  }
  if (onlyInRules.length > 0) {
    issues.push(
      `【结构红】本脚本的规则表里有闭集中不存在的 kind：${onlyInRules.join("、")} —— 规则表已陈旧（kind 被删但规则还在）。`,
    );
  }

  // 判据 ②：运行期断言必须在位
  const assertion = checkRuntimeAssertion(root);
  if (!assertion.ok) issues.push(`【结构红】${assertion.why}`);

  const sites = findCallSites(root);
  const files = listAgentSources(root).length;
  if (files < MIN_FILES) {
    issues.push(
      `【结构红】扫描面塌陷：agent 模块只扫到 ${files} 个 .ts（下界 ${MIN_FILES}）—— 目录改名或过滤器写坏了，「0 处漏传」不能算通过。`,
    );
  }
  if (sites.length < MIN_SITES) {
    issues.push(
      `【结构红】只找到 ${sites.length} 个事件写入点（下界 ${MIN_SITES}）—— 判据瞎了：要么方法/文件被改名，要么调用点被写成不认的形态。`,
    );
  }
  for (const required of ["tool_call_recorded", "tool_call_status_changed", "prompt_fingerprint", "approval_decided"]) {
    if (!sites.some((s) => s.kind === required)) {
      issues.push(
        `【结构红】规则要求有因果的 kind「${required}」在扫描面上**一个写入点都没有** —— 判据覆盖不到它（这类 kind 消失/改名都要人来确认，不能默认它是 0 处违规）。`,
      );
    }
  }

  const usedExemptions = new Set();
  for (const site of sites) {
    if (site.suspicious) {
      issues.push(
        `${site.file}:${site.line} 【结构红】${site.method}( 的括号不配对（窗口超长截断）—— 源码可能被改坏，判据无法判定该站点。`,
      );
      continue;
    }
    const rule = site.kind ? RULES[site.kind] : null;
    let verdict;
    let why = "";
    if (site.kind === null) {
      const idx = exemptions.findIndex(
        (e, i) => e.mode === "unattributed" && e.file === site.file && !usedExemptions.has(i),
      );
      if (idx >= 0) {
        usedExemptions.add(idx);
        verdict = "exempt";
        why = exemptions[idx].reason;
      } else {
        verdict = "fail";
        why = "调用点没有 kind 字面量 ⇒ 无法判定它属于哪种事件（先放进变量再传的形态）。要么写成字面量，要么在 EXEMPTIONS 里登记 unattributed 并说明判据在哪。";
      }
    } else if (!rule) {
      verdict = "fail";
      why = `kind「${site.kind}」没有因果规则（先登记 RULES，再决定 required）`;
    } else if (!site.hasCausation) {
      const idx = exemptions.findIndex(
        (e, i) =>
          e.kind === site.kind &&
          e.file === site.file &&
          // `wired-centrally` 是**机制级**豁免（同一文件的同类写入点由同一处补：
          // `decide` 与 `consume` 两条 approval_decided 都由端口统一补齐），因此可
          // 覆盖多处；`pending` / `unattributed` 是**站点级**的，一条只抵一处——
          // 否则「一处未接线」会被另一处的豁免顺手盖掉（本仓明令禁止的那种假绿）。
          (e.mode === "wired-centrally" || !usedExemptions.has(i)),
      );
      if (idx >= 0) {
        const ex = exemptions[idx];
        usedExemptions.add(idx);
        verdict = ex.mode === "pending" ? "pending" : "exempt";
        why = ex.reason;
        if (ex.proof) {
          const pf = join(root, ex.proof.file);
          const ok = existsSync(pf) && readFileSync(pf, "utf8").includes(ex.proof.marker);
          if (!ok) {
            verdict = "fail";
            why = `豁免声称由 ${ex.proof.file} 的「${ex.proof.marker}」统一补齐，但那个标记不在文件里 ⇒ 理由与事实不符（补齐逻辑被删了？），豁免作废。`;
          }
        }
      } else {
        verdict = rule.required ? "fail" : "exempt-optional";
        why = rule.required
          ? `规则要求有因果（${rule.cause}），该调用点**没有** causedBySeq`
          : `规则说这种 kind 没有单一前驱（${rule.cause}），但调用点也没写出来 —— 建议显式写 \`causedBySeq: null\`，让「这里没有前驱」成为代码里的陈述`;
      }
    } else if (site.nullLiteral && rule.required) {
      verdict = "fail";
      why = `规则要求有因果（${rule.cause}），这里却写死了 \`causedBySeq: null\` —— 那等于明确说「规则要，我不给」`;
    } else {
      verdict = "pass";
      why = rule.cause;
    }
    if (verdict === "exempt-optional") verdict = "warn";
    if (verdict === "fail") {
      issues.push(`${site.file}:${site.line} [${site.kind ?? "?"}] ${why}`);
    }
    if (verdict === "pending" && opts.strict) {
      issues.push(
        `${site.file}:${site.line} [${site.kind}] 待接线（--strict 下算红）：${why}`,
      );
    }
    if (verdict === "pending" || verdict === "warn") {
      warnings.push(`${site.file}:${site.line} [${site.kind ?? "?"}] ${why}`);
    }
    rows.push({ ...site, verdict, why });
  }

  // 陈旧豁免：一条都没匹配上 ⇒ 红（白名单必须回收）
  exemptions.forEach((ex, i) => {
    if (usedExemptions.has(i)) return;
    issues.push(
      `【结构红】陈旧豁免：${ex.file}${ex.kind ? ` [${ex.kind}]` : ""} 已匹配不到任何调用点 —— 代码改完请把这条豁免删掉（否则白名单会越长越松）。`,
    );
  });

  const pending = rows.filter((r) => r.verdict === "pending");
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    rows,
    pending,
    stats: {
      files,
      sites: sites.length,
      pass: rows.filter((r) => r.verdict === "pass").length,
      pending: pending.length,
      exempt: rows.filter((r) => r.verdict === "exempt").length,
      warn: rows.filter((r) => r.verdict === "warn").length,
      fail: rows.filter((r) => r.verdict === "fail").length,
      kinds: closure.kinds.length,
    },
  };
}

/* ── 打印 ───────────────────────────────────────────────────────── */

function printReport(report) {
  const s = report.stats;
  for (const row of report.rows) {
    const mark =
      row.verdict === "pass"
        ? "✔"
        : row.verdict === "pending"
          ? "…"
          : row.verdict === "exempt"
            ? "~"
            : row.verdict === "warn"
              ? "!"
              : "✖";
    console.log(
      `${mark} ${row.file}:${row.line}  [${row.kind ?? "透传"}]  causedBySeq=${row.hasCausation ? (row.nullLiteral ? "null" : "有") : "无"}`,
    );
  }
  console.log("");
  console.log(
    `判据计数：站点 ${s.sites}（通过 ${s.pass} · 待接线 ${s.pending} · 豁免 ${s.exempt} · 提示 ${s.warn} · 违规 ${s.fail}）· ` +
      `kind 闭集 ${s.kinds} · 扫描 ${s.files} 个文件`,
  );
  if (report.warnings.length > 0) {
    console.log("");
    console.log("warn（不阻断，但必须被人看见）：");
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
  if (report.pending.length > 0) {
    console.log("");
    console.log(
      `⚠ 待接线 ${report.pending.length} 处：这些写入点的因果**如实为 NULL**（不猜），读侧会标 resolvedBy=heuristic。`,
    );
    console.log(
      "   接线之后必须回来删掉 EXEMPTIONS 里对应的 pending 条目（否则下一次跑会报「陈旧豁免」）。",
    );
  }
  if (report.issues.length > 0) {
    console.log("");
    for (const issue of report.issues) console.log(`【违规】${issue}`);
  }
}

/* ── 自检 ───────────────────────────────────────────────────────── */

/**
 * 在临时目录里造一个**最小但完整**的仓库镜像（判据要读的东西都在）。
 *
 * 为什么必须「完整」：正例控制组的意义是证明判据**不是永假**。只造一个调用点的
 * 话，结构红（扫描面下界 / 必需 kind 覆盖 / 运行期断言）会先把这份正例判死，
 * 于是「正例通过」这件事根本测不到。
 *
 * @param {{kindLine?: string, causedBySeqLine?: string | null}} o
 *   `kindLine`：第一个站点的 kind 字面量（含引号的源码文本）；
 *   `causedBySeqLine`：第一个站点的 `causedBySeq` 那一行（`null` = 故意漏传）。
 */
function makeFixtureRepo(o = {}) {
  const kindLine = o.kindLine ?? `"tool_call_status_changed"`;
  const causedBySeqLine =
    o.causedBySeqLine === undefined ? "causedBySeq" : o.causedBySeqLine;
  const dir = mkdtempSync(join(tmpdir(), "acf-causation-fx-"));
  const ent = join(dir, ENTITY_REL);
  mkdirSync(dirname(ent), { recursive: true });
  writeFileSync(
    ent,
    `export const AGENT_EVENT_KINDS = [\n  "session_context_recorded",\n  "step_appended",\n  "tool_call_recorded",\n  "tool_call_status_changed",\n  "prompt_fingerprint",\n  "session_finished",\n  "approval_decided",\n] as const;\n`,
  );
  const proj = join(dir, PROJECTION_REL);
  mkdirSync(dirname(proj), { recursive: true });
  // 三个必须在位的运行期断言标记（判据 ②）。必须写成**代码里的字符串字面量**：
  // 判据先剥注释再找标记，写在注释里等于没写（这一点本身也是判据的一部分）。
  writeFileSync(
    proj,
    [
      `export const CAUSATION_ALLOWED_PARENTS = { step_appended: [] };`,
      `export const MARK_INVALID = "causation_invalid";`,
      `export const MARK_MISSING = "causation_missing";`,
      ``,
    ].join("\n"),
  );
  const svc = join(dir, CONFIG_SERVICE_REL);
  mkdirSync(dirname(svc), { recursive: true });
  const site = (kind, cbs) =>
    [
      `await this.tryAppendEvent(sessionId, {`,
      `  kind: ${kind},`,
      cbs ? `  ${cbs},` : null,
      `  payload: {},`,
      `});`,
    ]
      .filter(Boolean)
      .join("\n");
  const lines = [
    // ① 被参数化的那个站点（正例/反例共用）
    site(kindLine, causedBySeqLine),
    // ②–⑨ 固定的合法站点：覆盖全部「规则要求有因果」的 kind + 两个可选 kind
    site(`"step_appended"`, "causedBySeq: null"),
    site(`"session_finished"`, "causedBySeq: null"),
    site(`"tool_call_recorded"`, "causedBySeq"),
    site(`"tool_call_recorded"`, "causedBySeq"),
    site(`"tool_call_status_changed"`, "causedBySeq"),
    site(`"prompt_fingerprint"`, "causedBySeq"),
    site(`"approval_decided"`, "causedBySeq"),
    site(`"approval_decided"`, "causedBySeq"),
  ];
  writeFileSync(svc, lines.join("\n"));
  // 凑扫描面下界（判据 ③ 要的「不是空目录」）：造 20 个空壳 .ts
  for (let i = 0; i < 20; i += 1) {
    const f = join(dir, AGENT_SRC_REL, `filler-${i}.ts`);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `export const x${i} = ${i};\n`);
  }
  return dir;
}

/** 把真实树的相关目录复制到 /tmp（**绝不在共享文件上做变异**）。 */
function copyRealTree() {
  const dir = mkdtempSync(join(tmpdir(), "acf-causation-copy-"));
  cpSync(join(ROOT, AGENT_SRC_REL), join(dir, AGENT_SRC_REL), { recursive: true });
  return dir;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => {
    try {
      fn();
      cases.push({ name, ok: true, why: "" });
    } catch (err) {
      cases.push({ name, ok: false, why: err instanceof Error ? err.message : String(err) });
    }
  };
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  push("① 真实树：判据通过（含「待接线」如实打印，不算违规）", () => {
    const r = judge(ROOT);
    expect(
      r.ok,
      `真实树应通过，实际违规 ${r.issues.length} 条：\n  ${r.issues.join("\n  ")}`,
    );
    expect(r.stats.sites >= MIN_SITES, `站点数 ${r.stats.sites} < 下界 ${MIN_SITES}`);
    expect(r.stats.kinds >= 6, `kind 闭集只有 ${r.stats.kinds} 个`);
    // 零「待接线」：六条规则全部在真实写入点落地（`--strict` 与主跑等价）。
    // 这条断言是「不许再往表里塞 pending」的闸——真要加 pending，必须连这句一起改，
    // 而改动会被 review 看见。
    expect(r.pending.length === 0, `真实树仍有 ${r.pending.length} 处「待接线」`);
    expect(judge(ROOT, { strict: true }).ok, "--strict 下应零违规（零待接线）");
  });

  push("② 正例控制组：一个**该传且传了**的写入点 ⇒ 判据不误杀（不是永假）", () => {
    // `exemptions: []`：控制组必须**自带完整合规**，不能借真实树的豁免过关。
    const dir = makeFixtureRepo({ kindLine: `"tool_call_recorded"` });
    try {
      const r = judge(dir, { exemptions: [] });
      expect(r.ok, `正例被判红：${r.issues.join(" / ")}`);
      expect(r.stats.pass >= 1, "正例站点没有被判成通过");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  push("③ 反例：把 causedBySeq 去掉 ⇒ 红（不是永真）", () => {
    const dir = makeFixtureRepo({
      kindLine: `"tool_call_recorded"`,
      causedBySeqLine: null,
    });
    try {
      const r = judge(dir, { exemptions: [] });
      expect(!r.ok, "去掉 causedBySeq 后判据仍然通过");
      expect(
        r.issues.some((i) => i.includes("tool_call_recorded")),
        `违规文本没有点名 kind：${r.issues.join(" / ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  push("④ 真实树的 /tmp 副本：删掉 tool_call_recorded 那处的 causedBySeq ⇒ 红（有牙）", () => {
    const dir = copyRealTree();
    try {
      const file = join(dir, CONFIG_SERVICE_REL);
      const src = readFileSync(file, "utf8");
      const next = src.replace(
        /(kind: "tool_call_recorded",\n\s*)causedBySeq,/,
        "$1",
      );
      expect(next !== src, "副本里没找到 tool_call_recorded 的 causedBySeq（正则失配）");
      writeFileSync(file, next);
      const r = judge(dir);
      expect(!r.ok, "删掉一处的 causedBySeq 后判据仍然通过（守卫没牙）");
      expect(
        r.issues.some((i) => i.includes("tool_call_recorded")),
        `违规文本没有点名 tool_call_recorded：${r.issues.join(" / ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  push("⑤ 真实树的 /tmp 副本：把控制器那处改成写死 null ⇒ 红", () => {
    const dir = copyRealTree();
    try {
      const file = join(dir, `${AGENT_SRC_REL}/agent.controller.ts`);
      const src = readFileSync(file, "utf8");
      const next = src.replace("causedBySeq,\n          payload: {", "causedBySeq: null,\n          payload: {");
      expect(next !== src, "副本里没找到控制器写入点的 causedBySeq（正则失配）");
      writeFileSync(file, next);
      const r = judge(dir);
      expect(!r.ok, "写死 null 后判据仍然通过");
      expect(
        r.issues.some((i) => i.includes("写死")),
        `违规文本没有指出「写死 null」：${r.issues.join(" / ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  push("⑥ 结构红：空仓库（找不到写入点）⇒ 红，不是绿", () => {
    const dir = mkdtempSync(join(tmpdir(), "acf-causation-empty-"));
    try {
      const r = judge(dir);
      expect(!r.ok, "空目录被判成通过（判据瞎了）");
      expect(
        r.issues.some((i) => i.includes("扫描面塌陷") || i.includes("找不到")),
        `没有结构红文本：${r.issues.join(" / ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  push("⑦ 结构红：kind 闭集读不到 ⇒ 红", () => {
    const dir = copyRealTree();
    try {
      writeFileSync(join(dir, ENTITY_REL), "export const NOTHING = 1;\n");
      const r = judge(dir);
      expect(!r.ok, "闭集读不到却仍然通过");
      expect(
        r.issues.some((i) => i.includes("AGENT_EVENT_KINDS")),
        `没有点名闭集：${r.issues.join(" / ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  push("⑧ 结构红：新增 kind 却没登记因果规则 ⇒ 红", () => {
    const dir = copyRealTree();
    try {
      const file = join(dir, ENTITY_REL);
      const src = readFileSync(file, "utf8");
      writeFileSync(file, src.replace(`"approval_decided",`, `"approval_decided",\n  "brand_new_kind",`));
      const r = judge(dir);
      expect(!r.ok, "新增 kind 未登记规则却仍然通过");
      expect(
        r.issues.some((i) => i.includes("brand_new_kind")),
        `没有点名新 kind：${r.issues.join(" / ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  push("⑨ 陈旧豁免 ⇒ 红（白名单必须回收）", () => {
    const r = judge(ROOT, {
      extraExempt: [
        {
          file: `${AGENT_SRC_REL}/runtime/agent-session.service.ts`,
          kind: "no_such_kind",
          mode: "pending",
          reason: "自检用：这条断言必须被判成陈旧豁免。",
        },
      ],
    });
    expect(!r.ok, "陈旧豁免没有判红");
    expect(
      r.issues.some((i) => i.includes("陈旧豁免")),
      `没有「陈旧豁免」文本：${r.issues.join(" / ")}`,
    );
  });

  push("⑩ 运行期断言缺失（投影里删掉 causation_invalid）⇒ 红", () => {
    const dir = copyRealTree();
    try {
      const file = join(dir, PROJECTION_REL);
      const src = readFileSync(file, "utf8");
      writeFileSync(file, src.replace(/causation_invalid/g, "removed"));
      const r = judge(dir);
      expect(!r.ok, "运行期断言被删却仍然通过");
      expect(
        r.issues.some((i) => i.includes("causation_invalid")),
        `没有点名缺少的断言：${r.issues.join(" / ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  push("⑪ wired-centrally 豁免的 proof 标记不存在 ⇒ 红（理由必须可核对）", () => {
    const dir = copyRealTree();
    try {
      const file = join(dir, CONFIG_SERVICE_REL);
      writeFileSync(file, readFileSync(file, "utf8").replace(/enrichApprovalDecidedCausation/g, "removed"));
      const r = judge(dir);
      expect(!r.ok, "补齐逻辑被删却仍然通过");
      expect(
        r.issues.some((i) => i.includes("理由与事实不符")),
        `没有「理由与事实不符」文本：${r.issues.join(" / ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log("check-agent-event-causation · --selftest");
  console.log("");
  let failed = 0;
  for (const c of cases) {
    console.log(`${c.ok ? "✔" : "✖"} ${c.name}`);
    if (!c.ok) {
      failed += 1;
      console.log(`    ${c.why.split("\n").join("\n    ")}`);
    }
  }
  console.log("");
  console.log(`自检：${cases.length - failed}/${cases.length} 通过`);
  return failed === 0 ? 0 : 1;
}

/* ── CLI ────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { selftest: false, strict: false, root: ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--selftest") out.selftest = true;
    else if (a === "--strict") out.strict = true;
    else if (a === "--root") {
      i += 1;
      if (!argv[i]) return { error: "--root 需要一个目录参数" };
      out.root = resolve(argv[i]);
    } else if (a === "--help" || a === "-h") out.help = true;
    else return { error: `未知参数 ${a}` };
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 2;
  }
  if (args.help) {
    console.log("用法：node scripts/check-agent-event-causation.mjs [--selftest] [--strict] [--root <dir>]");
    return 0;
  }
  if (args.selftest) return runSelftest();

  const report = judge(args.root, { strict: args.strict });
  printReport(report);
  console.log("");
  if (report.ok) {
    console.log(
      `✔ A2 因果边守卫通过：${report.stats.pass} 处写入点传了因果 · ${report.stats.pending} 处待接线（如实为 NULL）· ${report.stats.exempt} 处豁免（理由可核对）· 运行期断言在位。`,
    );
    return 0;
  }
  console.log(
    `✖ A2 因果边守卫未通过：${report.issues.length} 条违规（该传的没传 / 豁免陈旧 / 结构红）。详见上面的【违规】行。`,
  );
  return 1;
}

// `import` 时不执行（自检里 import 本文件取 judge/EXEMPTIONS）。
if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF)) {
  process.exit(main(process.argv.slice(2)));
}
