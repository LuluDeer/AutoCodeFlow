#!/usr/bin/env node
/**
 * failureReason 分类器的**跨端一致性守卫**（P1-b）。
 *
 * ## 它判什么（按顺序）
 *
 * ① **跨语言等价**：把 `packages/contract-fixtures/generated/failure-classifier.{mjs,py}`
 *    两份生成物**真跑一遍**（node 进程 + python3 进程），对
 *    `packages/contract-fixtures/contract.json` 的 `failureClassification` 向量
 *    逐条比对两侧结果，并比对契约里的 `expected`。
 *    ⇒ 「同一批文本 ⇒ 两语言同一码」不是注释里的承诺，而是每次跑都验证的事实。
 *
 * ② **现状差异必须登记 + 登记必须可证**：
 *    本守卫从三端**现状**判据（admin 的 `classifyFailure`、node 的
 *    `prepareFailureReason`、python 的 `_refine_failure_reason`）里**静态抽出
 *    正则与分支顺序**，在 node 里**逐条真跑**（模拟器），于是「这三端对同一段
 *    文本给出什么码」是**可计算**的，而不是靠人读注释。
 *    每条已登记的差异都带一个 **probe**（一段文本 + 各端期望码）：
 *      · probe 的实际结果 == 期望 ⇒ 差异**仍然成立**（登记有效）；
 *      · probe 的实际结果 != 期望 ⇒ 差异**已经消失**（僵尸登记）⇒ 判红，
 *        逼人清理登记与基线（改代码 + 改基线两步走）。
 *    ⇒ 判据不是朴素的「防增长」，而是 Pact 的形态：
 *      **消费者声明的差异必须被显式登记，且登记必须被证明仍然存在**。
 *
 * ③ **结构禁令**：契约的 `matcherSubset.forbidden` 里每条禁用构造，生成器已经
 *    硬拒；本守卫**再验一遍**生成物的规则体里真的没有这些构造（防生成器被改坏
 *    后静默产出不等价物）。
 *
 * ④ **生成物无漂移**：重跑生成器应得到逐字相同的输出（drift 检测）。
 *
 * ## 为什么用「静态抽出 + 模拟」而不是「直接 import 三端实现」
 *
 * admin 侧的 `classifyFailure` 依赖 `task-execution.entity.ts`（TypeORM 装饰器），
 * 实测 ts-node 直接加载会因装饰器签名解析失败 ⇒ 引入编译期依赖会让这个守卫
 * 跑不起来（守卫必须零依赖、秒级、CI 可跑）。
 * 故本守卫**静态抽出**三端判据（正则 + 顺序），在 node 里重建求值。
 * 抽的是**行为语义**（哪些正则、按什么顺序），不是逐字源码。
 * 抽取的已知边界写在 `EXTRACTION_LIMITS` 里（不假装覆盖）。
 *
 * ## 棘轮
 *
 * `scripts/failure-classifier-divergence-baseline.json` 记着当前登记的 id 集合。
 * 新增一条登记 ⇒ 必须同时更新基线（显式承认）；
 * 删除一条登记（差异被修掉）⇒ 基线里的对应项变成「已消失」⇒ **也判红**，
 * 逼人清理基线。这条「只减不增 + 消失也要报」是 Pact pending → 非 pending
 * 棘轮的等价物。
 *
 * 用法：
 *   node scripts/check-failure-classifiers.mjs [--selftest] [--report] [--root <dir>]
 *   --selftest：在临时 fixture 树里跑真脚本（断言退出码 + 关键文本）。
 *   --report  ：只报告不判红（首次引入基线时用）。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const PROTOCOL_REL = "packages/executor-protocol/protocol.json";
export const FIXTURES_REL = "packages/contract-fixtures/contract.json";
export const BASELINE_REL = "scripts/failure-classifier-divergence-baseline.json";
export const GEN_MJS_REL = "packages/contract-fixtures/generated/failure-classifier.mjs";
export const GEN_PY_REL = "packages/contract-fixtures/generated/failure-classifier.py";

/** 现状三端（只读；写域属他人）。 */
export const ADMIN_CLS_REL = "apps/admin-api/src/common/failure-classification/failure-patterns.ts";
export const NODE_CLS_REL = "apps/executor-node/src/routes/execute.ts";
export const PY_CLS_REL = "apps/executor-python/routers/execute.py";

/**
 * 抽取的已知边界（**不假装覆盖**）。
 *
 *   · admin 的 `exitCodeNonZero` 判据（failure-patterns.ts classifyFailure 第 ⑧ 步）
 *     **不在**抽取范围内：它是**非文本**判据，需要 exitCode 入参，而本守卫的
 *     probe 只有文本。故 admin 的 `script_error` 在 probe 里只能由文本命中。
 *   · admin 的**码化优先**通道（`classifyFailureByCode` / `ERROR_CODE_FAILURE_REASON`）
 *     不在抽取范围内：它不依赖文本，probe 无从表达。
 *   · node 的 `runtimeSandboxStartupFailureReason`（运行期 bwrap 启动失败）与
 *     python 的 `_sandbox_startup_failure_reason` 是**独立入口**（输入是任务输出
 *     日志、且需 `TASK_SANDBOX=bwrap` 前置条件），不在 prepare/refine 抽取范围内。
 *   · node 的正则多为**多行字面量**，抽取按「if 条件里第一个正则字面量」取，
 *     取不到就跳过该分支（记入 `skipped`）。
 */
export const EXTRACTION_LIMITS = [
  "admin 的 exitCodeNonZero 判据（非文本，需 exitCode 入参）",
  "admin 的码化优先通道 classifyFailureByCode（不依赖文本）",
  "node 的 runtimeSandboxStartupFailureReason / python 的 _sandbox_startup_failure_reason（独立入口，输入是任务输出）",
  "node / python 中以变量拼出的正则（非字面量）",
];

const SELF = fileURLToPath(import.meta.url);

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

// ── 现状判据抽取 ──────────────────────────────────────────────────────────

/**
 * 从一段源码里抽「有序的 (code, pattern) 规则列表」。
 */
export function extractOrderedRules(src, { codeRe, testRe, toPattern }) {
  const out = [];
  const skipped = [];
  for (const m of src.matchAll(testRe)) {
    const cond = m[1];
    // 窗口要足够大：python 的两条规则后面跟着**大段中文注释**才到 return
    // （注释里也有 `return` 字样，但不在引号里 —— codeRe 要求带引号，故安全）。
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 2000);
    const codeM = codeRe.exec(after);
    if (!codeM) {
      skipped.push({ cond, why: "找不到 return 码" });
      continue;
    }
    const pattern = toPattern(cond);
    if (pattern === null) {
      skipped.push({ cond, why: "条件不是正则字面量" });
      continue;
    }
    out.push({ code: codeM[1], pattern });
  }
  return { rules: out, skipped };
}

/** node: `if (/<regex>/flags.test(message)) { return 'code'; }` */
export function extractNodeRules(src) {
  const s0 = src.indexOf("export function prepareFailureReason");
  if (s0 < 0) return { rules: [], skipped: [] };
  const s1 = src.indexOf("\nexport function ", s0 + 10);
  const body = src.slice(s0, s1 < 0 ? src.length : s1);
  const extracted = extractOrderedRules(body, {
    // 正则字面量：`/…/flags` —— 体里允许 `\\.`（转义）与 `[^/]`（非斜杠），
    // 但**不允许**未转义的 `/` 与裸换行。⚠️ 字符类里**不能**排除反斜杠：
    // 源码里的 `[^\\n]` 含一个反斜杠，排除它就抽不到这类多行字面量
    // （node 的 10 条规则里有 5 条是多行字面量，抽不到 = 判据静默失效）。
    testRe: /if\s*\(\s*(\/((?:[^/\\\n]|\\.)*)\/[a-z]*)\s*\.test\(\s*message\s*,?\s*\)\s*\)/g,
    codeRe: /return\s+'([a-z_]+)'/,
    toPattern: (cond) => {
      const m = /^\/((?:[^/\\]|\\.)*)\/([a-z]*)$/.exec(cond.trim());
      if (!m) return null;
      return { source: m[1], flags: m[2] };
    },
  });
  return { ...extracted, fallback: extractNodeFallback(body) };
}

/**
 * node 的兜底：函数体里**最后**一个 `return 'x'`（不是任何 if 里的）。
 *
 * ⚠️ 必须建模：node 的 prepareFailureReason 兜底返 `'unknown'`，python 的
 * _refine_failure_reason 兜底返 `None`（= 不设 reason）。若模拟器对「无规则命中」
 * 一律返 null，则 node 的兜底差异（CLS-03）就**看不见** ⇒ 登记失去依据。
 */
export function extractNodeFallback(body) {
  const rets = [...body.matchAll(/return\s+'([a-z_]+)'/g)].map((m) => m[1]);
  return rets.length > 0 ? rets[rets.length - 1] : null;
}

/**
 * python 抽取：**按行 + 按块**解析 `_refine_failure_reason` 的函数体。
 *
 * 为什么不用「一条正则扫全函数」：python 的判据有**三种形态**且**条件可跨行**：
 *   ① `if re.search(r"a" r"|b", lowered):`          —— 纯正则，字面量拼接
 *   ② `if "git" in lowered and (re.search(...) or re.search(...)):` —— 复合条件
 *   ③ `if 'x' in lowered or 'y' in message:`       —— 纯子串（无正则）
 * 用一条正则扫，要么漏掉 ②③，要么把字面量按空白切碎（**空格丢失** ⇒ 规则永不命中
 * ⇒ 判据静默失效）。故按行累积出「条件块」，再逐形态转换。
 *
 * 每条抽出来的规则都记 **源码位置**，最终按位置排序 —— 顺序即语义。
 */
export function extractPyRules(src) {
  const s0 = src.indexOf("def _refine_failure_reason");
  if (s0 < 0) return { rules: [], skipped: [] };
  const s1 = src.indexOf("\ndef ", s0 + 10);
  const body = src.slice(s0, s1 < 0 ? src.length : s1);
  const lines = body.split("\n");

  const rules = [];
  const skipped = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^(\s*)if\s+(.*)$/.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const indent = m[1].length;
    // 累积条件块：直到括号配平且行尾是 ':'
    let cond = m[2];
    let j = i + 1;
    let depth = countParens(cond);
    while (depth > 0 && j < lines.length) {
      cond += "\n" + lines[j];
      depth += countParens(lines[j]);
      j += 1;
    }
    // 条件块之后（跳过空行）应是 return
    let k = j;
    while (k < lines.length && lines[k].trim() === "") k += 1;
    const ret = k < lines.length ? /^\s*return\s+"([a-z_]+)"/.exec(lines[k]) : null;
    if (!ret) {
      skipped.push({ cond: cond.slice(0, 60), why: "条件块后没有 return \"code\"" });
      i = j;
      continue;
    }
    const pattern = pyConditionToPattern(cond);
    if (pattern === null) {
      skipped.push({ cond: cond.slice(0, 60), why: "条件形态未识别" });
    } else {
      rules.push({ code: ret[1], pattern, at: body.indexOf(lines[i]) });
    }
    i = k + 1;
  }
  rules.sort((a, b) => a.at - b.at);
  // 兜底：函数体里**最后**一个 `return X`（无规则的 if 之后那一条）。
  // python 的兜底是 `return None`（= 不设 reason，交给中台）——与 node 的
  // `return 'unknown'` 同义异形（CLS-03）。必须建模，否则该差异不可见。
  const rets = [...body.matchAll(/^\s*return\s+(None|"[a-z_]+")\s*$/gm)].map((m) => m[1]);
  const fallbackRaw = rets.length > 0 ? rets[rets.length - 1] : "None";
  const fallback = fallbackRaw === "None" ? null : fallbackRaw.replace(/"/g, "");
  return { rules: rules.map(({ code, pattern }) => ({ code, pattern })), skipped, fallback };
}

function countParens(text) {
  let d = 0;
  for (const c of text) {
    if (c === "(") d += 1;
    else if (c === ")") d -= 1;
  }
  return d;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 把一条 python 条件转成正则体（`{source, flags}`）或 null（未识别）。
 *
 * 三种形态（与 extractPyRules 的头注对应）：
 *   ① 纯 re.search          → 各字面量交替
 *   ② `"x" in Y and (…re…)` → `x.{0,40}(各分支交替)`
 *   ③ `'x' in Y or 'z' in W`→ 各子串交替
 */
export function pyConditionToPattern(cond) {
  const text = cond.replace(/\s*$/, "");
  // ② 复合：`"needle" in X and ( … )`
  const compound = /^["']([^"']+)["']\s+in\s+[a-z_]+\s+and\s*\(([\s\S]*)\)\s*:?$/.exec(text);
  if (compound) {
    const alts = [...compound[2].matchAll(/(?:[rRbBuUfF]{0,2})"((?:[^"\\]|\\.)*)"/g)]
      .map((x) => x[1])
      .map((a) => a.replace(/^\|/, ""))
      .filter((a) => a.length > 0);
    if (alts.length === 0) return null;
    // ⚠️ **不要**再加 `${needle}.{0,40}(…)` 前缀：python 的复合形态是
    //   `if "git" in lowered and (re.search(A) or re.search(B))`
    // 而 A 本身（`git.{0,40}(clone|fetch|checkout)`）**已经以 "git" 开头** ⇒
    // 再加一次前缀会变成 `git.{0,40}(?:git.{0,40}(…)|…)`，多出的 `.{0,40}` 会
    // 把匹配窗口推远 ⇒ `git clone failed` 反而**匹配不上**（实测 python 侧全 null）。
    // 正确语义：needle 前提已被各分支覆盖（分支以 needle 开头），故直接用分支交替。
    const needleEsc = escapeRe(compound[1]);
    const withNeedle = alts.some((a) => a.includes(needleEsc))
      ? alts
      : [needleEsc, ...alts];
    return { source: withNeedle.join("|"), flags: "" };
  }
  // ③ 纯子串：`'a' in X or 'b' in Y`
  const subs = [...text.matchAll(/["']([^"']+)["']\s+in\s+[a-z_]+/g)].map((x) => x[1]);
  const hasRegex = /re\.search\(/.test(text);
  if (subs.length > 0 && !hasRegex) {
    return { source: subs.map(escapeRe).join("|"), flags: "" };
  }
  // ① 纯 re.search
  if (hasRegex) {
    const alts = [...text.matchAll(/(?:[rRbBuUfF]{0,2})"((?:[^"\\]|\\.)*)"/g)]
      .map((x) => x[1])
      // ⚠️ python 的相邻字面量拼接 `r"a" r"|b"` 里，**后一段的内容自带前导 `|`**
      // （`"|b"` 的内容就是 `|b`）。逐字取内容后各段再以 `|` 交替会得到 `a||b`
      // —— 中间的空分支**匹配任何字符串** ⇒ 该规则恒真 ⇒ 判据静默失效
      // （实测：所有文本都被判成 interpreter_unavailable）。
      // 故：每段剥掉**前导**的 `|`（那是 python 拼接的分隔符，不是正则交替符），
      // 再过滤空段。
      .map((a) => a.replace(/^\|/, ""))
      .filter((a) => a.length > 0);
    if (alts.length === 0) return null;
    return { source: alts.join("|"), flags: "" };
  }
  return null;
}

/** admin: `if (CONST.test(text)) { return ExecutionFailureReason.CODE; }`（CONST → 正则常量） */
export function extractAdminRules(src) {
  const s0 = src.indexOf("export function classifyFailure");
  if (s0 < 0) return { rules: [], skipped: [] };
  const body = src.slice(s0);

  const consts = new Map();
  // 形态 ①：`export const X_PATTERN = /…/i;`
  for (const m of src.matchAll(/export const\s+([A-Z0-9_]+_PATTERN)\s*=\s*\/((?:[^/\\\n]|\\.)*)\/([a-z]*)\s*;/g)) {
    consts.set(m[1], { source: m[2], flags: m[3] });
  }
  // 形态 ②：`export const X_PATTERN = new RegExp([ "a", "b" ].join("|"), "i");`
  //
  // ⚠️ 必须**跳过**分隔符字面量（"|"）—— admin 的数组以 `"|"` 结尾（.join("|")
  // 的分隔符自身也是数组的一个元素）。把它并进正则体，正则就变成 `a|b||c`，
  // 中间的空分支会**匹配任何字符串**（`/a||b/.test("任意")` ⇒ true），
  // 于是 admin 侧的模拟结果会全部塌成第一条规则 —— 那是一个**静默失效**的抽取
  // （判据看起来在跑，实际恒真）。故这里显式过滤掉恰好等于 "|" 的元素。
  for (const m of src.matchAll(/export const\s+([A-Z0-9_]+_PATTERN)\s*=\s*new RegExp\(([\s\S]*?)\)\s*;/g)) {
    const alts = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((x) => x[1])
      .filter((a) => a !== "|");
    if (alts.length > 0) consts.set(m[1], { source: alts.join("|"), flags: "i" });
  }

  const out = [];
  const skipped = [];
  const branchRe = /if\s*\(\s*([A-Z0-9_]+_PATTERN)\s*\.test\([^)]*\)\s*\)\s*\{/g;
  for (const m of body.matchAll(branchRe)) {
    const name = m[1];
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const codeM = /return\s+ExecutionFailureReason\.([A-Z_]+)/.exec(after);
    if (!codeM) {
      skipped.push({ cond: name, why: "找不到 return 码" });
      continue;
    }
    const pattern = consts.get(name);
    if (!pattern) {
      skipped.push({ cond: name, why: "常量未解析" });
      continue;
    }
    out.push({ code: codeM[1].toLowerCase(), pattern });
  }
  // 兜底：最后一个 `return ExecutionFailureReason.X`（无规则的 if 之后那一条）
  const rets = [...body.matchAll(/return\s+ExecutionFailureReason\.([A-Z_]+)/g)].map((m) => m[1].toLowerCase());
  const fallback = rets.length > 0 ? rets[rets.length - 1] : null;
  return { rules: out, skipped, fallback };
}

// ── 现状模拟器 ────────────────────────────────────────────────────────────

/**
 * 用抽出的规则在 node 里**真跑**一次判定。
 *
 * 归一口径与三端一致：admin / python 都把输入小写化（admin 的 `.toLowerCase()`、
 * python 的 `.lower()`）；node 的正则带 `i` 标志。为了让三端可比，本模拟器
 * 统一把输入**小写化**并把 node 的 `i` 标志去掉 —— 于是 node 的 `i` 标志
 * 行为与 admin/python 的小写化行为在 ASCII 范围内等价（差异只在 Unicode
 * 大小写折叠上，而那正是 CLS-10 登记的内容）。
 */
export function simulate(rules, parts, fallback = null) {
  const text = parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .join("\n")
    .toLowerCase();
  for (const r of rules) {
    let re;
    try {
      // ⚠️ **统一加 `i` 标志**（不是去掉）：三端的大小写处理不同 ——
      // node 传原始 message + 正则带 `i`；admin 把输入小写化 + 正则带 `i`；
      // python 把输入小写化 + 正则**不带**标志（字面量本身已是小写）。
      // 若去掉 `i`，node 的 `Invalid npm package name`（含大写 I）就再也匹配不到
      // 小写化后的输入 —— 抽取器会**静默地**判成「node 没这条规则」。
      // 加 `i` 则三端在 ASCII 范围内等价（Unicode 大小写折叠差异由 CLS-10 登记）。
      const flags = r.pattern.flags.includes("i") ? r.pattern.flags : `${r.pattern.flags}i`;
      re = new RegExp(r.pattern.source, flags);
    } catch {
      continue;
    }
    if (re.test(text)) return r.code;
  }
  return fallback;
}

// ── 生成物规则体抽取 ──────────────────────────────────────────────────────

/**
 * 从生成物里抽出「规则体」列表。
 *
 * mjs 侧：规则表是 JS 字面量（`"body": "…"`）。
 * py 侧：规则表是 `json.loads("…")` 的**字符串**载荷（整个 RULES 是一段 JSON 文本）。
 */
export function extractRuleBodies(src) {
  for (const pyM of src.matchAll(/json\.loads\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
    try {
      const parsed = JSON.parse(JSON.parse(`"${pyM[1]}"`));
      if (Array.isArray(parsed) && parsed.some((r) => typeof r?.body === "string")) {
        return parsed.map((r) => r.body).filter((b) => typeof b === "string");
      }
    } catch {
      /* 落到 ② */
    }
  }
  return [...src.matchAll(/"body":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  });
}

// ── 主判据 ────────────────────────────────────────────────────────────────

export async function check({ root = process.cwd(), report = false } = {}) {
  const structure = [];
  const results = [];
  const info = { vectors: 0, crossOk: 0, crossBad: [], currentCounts: {}, skipped: {} };

  const protoJ = readJson(join(root, PROTOCOL_REL));
  if (protoJ.error) {
    structure.push(protoJ.error);
    return { structure, results, info };
  }
  const proto = protoJ.value;
  const classifiers = proto?.failureReason?.classifiers;
  if (!classifiers || typeof classifiers !== "object") {
    structure.push(`${PROTOCOL_REL} 缺 failureReason.classifiers 段 —— 判据失配。`);
    return { structure, results, info };
  }
  const rules = classifiers.rules?.items ?? [];
  if (!Array.isArray(rules) || rules.length === 0) {
    structure.push(`${PROTOCOL_REL} 的 classifiers.rules.items 为空 —— 判据失配。`);
    return { structure, results, info };
  }
  const codes = new Set((proto.failureReason.all ?? []).map((e) => e.code));

  const fixJ = readJson(join(root, FIXTURES_REL));
  if (fixJ.error) {
    structure.push(fixJ.error);
    return { structure, results, info };
  }
  const fixtures = fixJ.value;
  const vectors = fixtures?.failureClassification?.vectors ?? [];
  if (!Array.isArray(vectors) || vectors.length === 0) {
    structure.push(`${FIXTURES_REL} 缺 failureClassification.vectors —— 没有向量可验证跨语言等价。`);
    return { structure, results, info };
  }
  info.vectors = vectors.length;

  // ── ① 生成物存在且无漂移 ───────────────────────────────────────────────
  const genMjsPath = join(root, GEN_MJS_REL);
  const genPyPath = join(root, GEN_PY_REL);
  if (!existsSync(genMjsPath)) {
    structure.push(`读不到 ${GEN_MJS_REL} —— 生成物不存在（跑 node scripts/generate-failure-classifiers.mjs）。`);
    return { structure, results, info };
  }
  if (!existsSync(genPyPath)) {
    structure.push(`读不到 ${GEN_PY_REL} —— 生成物不存在（跑 node scripts/generate-failure-classifiers.mjs）。`);
    return { structure, results, info };
  }
  const drift = spawnSync(
    process.execPath,
    [join(root, "scripts/generate-failure-classifiers.mjs"), "--check", "--no-selfcheck"],
    { cwd: root, encoding: "utf8" },
  );
  results.push({
    name: "生成物无漂移（generate-failure-classifiers --check）",
    ok: drift.status === 0,
    actual: drift.status === 0 ? [] : [(drift.stdout || "") + (drift.stderr || "")].filter(Boolean),
    expected: [],
  });

  // ── ② 结构禁令：只查生成物的**规则体** ────────────────────────────────
  const bannedInGen = [
    { re: /\\b/, name: "\\b" },
    { re: /\\A|\\Z/, name: "\\A/\\Z" },
    { re: /\(\?<[=!]/, name: "lookbehind" },
    { re: /\\[dDsSwW]/, name: "\\d/\\w/\\s" },
    { re: /\\[pP]\{/, name: "\\p{…}" },
  ];
  for (const [rel, src] of [
    [GEN_MJS_REL, readFileSync(genMjsPath, "utf8")],
    [GEN_PY_REL, readFileSync(genPyPath, "utf8")],
  ]) {
    const bodies = extractRuleBodies(src);
    if (bodies.length === 0) {
      structure.push(`生成物 ${rel} 里抽不到规则体（"body" 字段）—— 判据失配。`);
      continue;
    }
    for (const b of bannedInGen) {
      const hit = bodies.some((body) => b.re.test(body));
      results.push({
        name: `生成物 ${rel} 的规则体不含禁用构造 ${b.name}`,
        ok: !hit,
        actual: hit ? [b.name] : [],
        expected: [],
      });
    }
  }

  // ── ③ 跨语言等价：真跑两侧 ───────────────────────────────────────────
  const pyProbePath = join(root, "packages/contract-fixtures/generated/.__guard_probe.py");
  const pyCode =
    readFileSync(genPyPath, "utf8") +
    "\n\nimport json, sys\n" +
    "_V = json.loads(sys.argv[1])\n" +
    "_out = []\n" +
    "for _v in _V:\n" +
    '    _out.append({"id": _v["id"], "executor": classify(_v["parts"], "executor"), "admin": classify(_v["parts"], "admin")})\n' +
    "print(json.dumps(_out, ensure_ascii=False))\n";
  writeFileSync(pyProbePath, pyCode, "utf8");
  const pyRun = spawnSync("python3", [pyProbePath, JSON.stringify(vectors)], { cwd: root, encoding: "utf8" });
  try {
    unlinkSync(pyProbePath);
  } catch {
    /* ignore */
  }
  if (pyRun.status !== 0) {
    structure.push(`python 侧生成物求值失败：\n${pyRun.stderr}`);
    return { structure, results, info };
  }

  const pyResults = JSON.parse(pyRun.stdout.trim().split("\n").pop());
  const mjsMod = await import(`file://${genMjsPath}?t=${Date.now()}`);
  const jsResults = vectors.map((v) => ({
    id: v.id,
    executor: mjsMod.classify(v.parts, "executor"),
    admin: mjsMod.classify(v.parts, "admin"),
  }));

  for (let i = 0; i < vectors.length; i += 1) {
    const v = vectors[i];
    const j = jsResults[i];
    const p = pyResults[i];
    const exp = v.expected ?? {};
    const same = j.executor === p.executor && j.admin === p.admin;
    const okExp =
      (exp.executor === undefined || exp.executor === j.executor) &&
      (exp.admin === undefined || exp.admin === j.admin);
    const ok = same && okExp;
    if (ok) info.crossOk += 1;
    else {
      info.crossBad.push({
        id: v.id,
        node: { executor: j.executor, admin: j.admin },
        python: { executor: p.executor, admin: p.admin },
        expected: exp,
      });
    }
    results.push({
      name: `跨语言一致 + 符合契约期望：${v.id}`,
      ok,
      actual: ok
        ? []
        : [`node=(${j.executor}/${j.admin}) python=(${p.executor}/${p.admin}) expected=${JSON.stringify(exp)}`],
      expected: [],
    });
  }

  // ── ④ 现状差异：登记完整性 + 登记可证 ────────────────────────────────
  const registry = fixtures?.divergenceRegistry?.entries ?? [];
  if (!Array.isArray(registry)) {
    structure.push(`${FIXTURES_REL} 的 divergenceRegistry.entries 不是数组 —— 判据失配。`);
    return { structure, results, info };
  }
  const REQUIRED = ["reason", "owner", "status"];
  for (const e of registry) {
    for (const f of REQUIRED) {
      if (typeof e?.[f] !== "string" || e[f].trim() === "") {
        structure.push(
          `divergenceRegistry 条目 ${JSON.stringify(e?.id)} 缺必填字段 "${f}" —— ` +
            `「差异必须登记 + 登记必须有主」，缺主 = 没人负责修。`,
        );
      }
    }
    if (e && e.code && !codes.has(e.code)) {
      structure.push(`divergenceRegistry 条目 ${e.id} 的 code "${e.code}" 不在 failureReason.all 里。`);
    }
    // 登记的「可证」形态按 kind 分两类：
    //   · classifier —— 带 probe（文本 + 各端期望码），由现状模拟器**真跑**验证；
    //   · capability —— 带 verify（file + mustContain），由守卫**真读文件**验证
    //     「证据还在」。capability 类差异（端点全集、字段实现与否）没有「一段文本
    //     能触发它」的形态，硬套 probe 只会逼人编造文本 ⇒ 判据必须按 kind 分流。
    const kind = e?.kind;
    if (kind !== "classifier" && kind !== "capability") {
      structure.push(
        `divergenceRegistry 条目 ${e.id} 的 kind 必须是 "classifier" 或 "capability"（实际 ${JSON.stringify(kind)}）—— ` +
          `不分流就无法定义「这条登记怎么算可证」。`,
      );
    } else if (kind === "classifier" && !Array.isArray(e.probe?.parts)) {
      structure.push(
        `divergenceRegistry 条目 ${e.id}（classifier）缺 probe.parts —— ` +
          `登记必须**可证**：每条分类器差异要带一段能触发它的文本，否则「登记」只是一句声明。`,
      );
    } else if (kind === "capability") {
      const v = e.verify;
      if (!v || typeof v.file !== "string" || typeof v.mustContain !== "string" || v.mustContain === "") {
        structure.push(
          `divergenceRegistry 条目 ${e.id}（capability）缺 verify.file / verify.mustContain —— ` +
            `能力差异也要可证：证据文件里必须有一个能断言「差异仍在」的标记串。`,
        );
      }
    }
  }
  if (structure.length > 0) return { structure, results, info };

  const adminSrc = readText(join(root, ADMIN_CLS_REL));
  const nodeSrc = readText(join(root, NODE_CLS_REL));
  const pySrc = readText(join(root, PY_CLS_REL));
  const present = { admin: adminSrc !== null, node: nodeSrc !== null, python: pySrc !== null };
  const extracted = {
    admin: adminSrc ? extractAdminRules(adminSrc) : { rules: [], skipped: [] },
    node: nodeSrc ? extractNodeRules(nodeSrc) : { rules: [], skipped: [] },
    python: pySrc ? extractPyRules(pySrc) : { rules: [], skipped: [] },
  };
  info.currentCounts = {
    admin: extracted.admin.rules.length,
    node: extracted.node.rules.length,
    python: extracted.python.rules.length,
  };
  info.skipped = {
    admin: extracted.admin.skipped.length,
    node: extracted.node.skipped.length,
    python: extracted.python.skipped.length,
  };

  // ④-1 每条登记的 probe 必须**仍然复现**该差异
  for (const e of registry) {
    if (e.kind !== "classifier") continue;
    const probe = e.probe;
    const expected = probe.expected ?? {};
    const actual = {};
    for (const side of ["admin", "node", "python"]) {
      if (!present[side]) continue;
      actual[side] = simulate(extracted[side].rules, probe.parts, extracted[side].fallback);
    }
    const mismatched = Object.entries(expected).filter(([side, want]) => actual[side] !== want);
    results.push({
      name: `登记可证（probe 仍复现该差异）：${e.id}`,
      ok: mismatched.length === 0,
      actual: mismatched.map(([side, want]) => `${side} 期望 ${want} 实际 ${actual[side]}`),
      expected: [],
    });
    const distinct = new Set(Object.values(actual).map((v) => v ?? "<none>"));
    results.push({
      name: `登记可证（probe 确实制造差异）：${e.id}`,
      ok: distinct.size > 1,
      actual: distinct.size > 1 ? [] : [`各端结果一致：${JSON.stringify(actual)}`],
      expected: [],
    });
  }

  // ④-1b capability 类登记：verify 指向的证据文件里必须**仍有**那个标记串。
  // 这是能力差异的「僵尸登记」检测——差异被修掉后，标记串通常也会被改写/删除，
  // 于是这条会红，逼人清理登记与基线。
  for (const e of registry) {
    if (e.kind !== "capability") continue;
    const src = readText(join(root, e.verify.file));
    if (src === null) {
      results.push({
        name: `登记可证（证据文件存在）：${e.id}`,
        ok: false,
        actual: [`读不到 ${e.verify.file}`],
        expected: [],
      });
      continue;
    }
    const hit = src.includes(e.verify.mustContain);
    results.push({
      name: `登记可证（证据仍在）：${e.id}`,
      ok: hit,
      actual: hit ? [] : [`${e.verify.file} 里已找不到 ${JSON.stringify(e.verify.mustContain)}`],
      expected: [],
    });
  }

  // ④-2 三端现状对「每条契约规则的代表性文本」的行为差异，必须在登记里找得到
  const byCode = new Map();
  for (const v of vectors) {
    const exp = v.expected ?? {};
    const code = exp.executor ?? exp.admin;
    if (code && !byCode.has(code)) byCode.set(code, v);
  }
  const diffs = [];
  for (const [code, v] of byCode) {
    const actual = {};
    for (const side of ["admin", "node", "python"]) {
      if (!present[side]) continue;
      actual[side] = simulate(extracted[side].rules, v.parts, extracted[side].fallback);
    }
    const values = Object.values(actual);
    const distinct = new Set(values.map((x) => x ?? "<none>"));
    const expectedCode = v.expected?.executor ?? v.expected?.admin;
    const differsFromContract = values.some((x) => (x ?? null) !== (expectedCode ?? null));
    if (distinct.size > 1 || differsFromContract) {
      diffs.push({ code, vector: v.id, actual, expected: expectedCode });
      const registeredForCode = registry.some((e) => e.code === code);
      results.push({
        name: `现状差异已登记（code=${code}，向量 ${v.id}）：${JSON.stringify(actual)}`,
        ok: registeredForCode,
        actual: registeredForCode ? [] : [`${code} 未登记`],
        expected: [],
      });
    }
  }
  info.diffs = diffs;

  // ── ⑤ 棘轮：登记条数只减不增；已登记但「差异消失」也要报 ──────────────
  const baseJ = readJson(join(root, BASELINE_REL));
  if (baseJ.error) {
    structure.push(baseJ.error);
    return { structure, results, info };
  }
  const baseline = baseJ.value;
  const baseEntries = baseline?.entries ?? [];
  info.baseline = { count: baseEntries.length, current: registry.length };

  const baseIds = new Set(baseEntries.map((e) => e.id));
  const currentIds = new Set(registry.map((e) => e.id));
  const added = [...currentIds].filter((id) => !baseIds.has(id));
  const removed = [...baseIds].filter((id) => !currentIds.has(id));

  results.push({
    name: "棘轮：登记条数不超基线（只减不增）",
    ok: added.length === 0,
    actual: added,
    expected: [],
  });
  results.push({
    name: "棘轮：基线里的登记不得消失（差异被修掉 ⇒ 同步更新基线）",
    ok: removed.length === 0,
    actual: removed,
    expected: [],
  });

  return { structure, results, info };
}

// ── 自检 ──────────────────────────────────────────────────────────────────

const SAMPLE_PROTOCOL = {
  failureReason: {
    all: [{ code: "unknown", zh: "未知", en: "Unknown", remediationKey: "k", owner: "platform-ops", reportable: true }],
    classifiers: {
      matcherSubset: { tokens: { WORD: "[A-Za-z0-9_]" } },
      normalize: { joinWith: "\n", dropFalsyParts: true, caseFold: "ascii-lower", astralFold: "replace-with-U+FFFD" },
      sentinel: { pad: "\u0001" },
      rules: {
        items: [
          { id: "r1", order: 10, code: "unknown", appliesTo: ["executor", "admin"], alternatives: ["nothing matches this"] },
        ],
      },
      fallbacks: { executor: null, admin: "unknown" },
    },
  },
};

// fixture 的两份「生成物」：**必须与真实生成物同形**（含 `body` 字段）——
// 否则守卫的「结构禁令」那一层会因「抽不到规则体」而结构红，掩盖掉其它判据
// （那是**假红**，不是被测行为）。
const GEN_MJS_FIXTURE = [
  "export const RULES = [",
  '  { "id": "r1", "order": 10, "code": "unknown", "appliesTo": ["executor", "admin"], "body": "nothing matches this" },',
  "];",
  "export function classify(parts, stage) { return 'unknown'; }",
  "export function ruleIds(stage) { return []; }",
].join("\n");
// python 侧 fixture：用 **repr** 形态的载荷（与真实生成物同形：json.loads 一个
// 转义后的 JSON 字符串）。手工拼转义容易出错，故这里用 JSON.stringify 生成。
const GEN_PY_FIXTURE = [
  "import json",
  "",
  `RULES = json.loads(${JSON.stringify(
    JSON.stringify([
      { id: "r1", order: 10, code: "unknown", appliesTo: ["executor", "admin"], body: "nothing matches this" },
    ]),
  )})`,
  "",
  "def classify(parts, stage='executor'):",
  "    return 'unknown'",
  "def rule_ids(stage):",
  "    return []",
].join("\n");

const ADMIN_SRC_FIXTURE =
  'export const X_PATTERN = /nothing matches this/;\n' +
  "export function classifyFailure(input) {\n" +
  "  if (X_PATTERN.test(input.errorMessage)) {\n" +
  "    return ExecutionFailureReason.UNKNOWN;\n" +
  "  }\n" +
  "  return ExecutionFailureReason.UNKNOWN;\n" +
  "}\n";
const NODE_SRC_FIXTURE =
  "export function prepareFailureReason(message) {\n" +
  "  if (/nothing matches this/.test(message)) {\n" +
  "    return 'unknown';\n" +
  "  }\n" +
  "  return 'unknown';\n" +
  "}\n";
const PY_SRC_FIXTURE =
  "import re\n" +
  "def _refine_failure_reason(message):\n" +
  '    if re.search(r"nothing matches this", message):\n' +
  '        return "unknown"\n' +
  "    return None\n";

function baseFixture(overrides = {}) {
  return {
    [PROTOCOL_REL]: JSON.stringify(SAMPLE_PROTOCOL, null, 2),
    [FIXTURES_REL]: JSON.stringify(
      {
        failureClassification: {
          vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
        },
        divergenceRegistry: { entries: [] },
      },
      null,
      2,
    ),
    [BASELINE_REL]: JSON.stringify({ entries: [] }, null, 2),
    [GEN_MJS_REL]: GEN_MJS_FIXTURE,
    [GEN_PY_REL]: GEN_PY_FIXTURE,
    [ADMIN_CLS_REL]: ADMIN_SRC_FIXTURE,
    [NODE_CLS_REL]: NODE_SRC_FIXTURE,
    [PY_CLS_REL]: PY_SRC_FIXTURE,
    "scripts/generate-failure-classifiers.mjs": "process.exit(0);\n",
    ...overrides,
  };
}

export function selftest() {
  const cases = [];
  const run = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "failure-classifiers-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 8000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  run("① 一致树：两侧生成物逐条相等、无未登记差异 → 绿", baseFixture(), {
    code: 0,
    contains: ["跨语言一致", "棘轮"],
    absent: ["FAIL ", "结构错误"],
  });

  run(
    "② 【反证·差异未登记】三端现状分因 ⇒ 判红并点名该 code",
    baseFixture({
      [NODE_CLS_REL]:
        "export function prepareFailureReason(message) {\n" +
        "  if (/nothing matches this/.test(message)) {\n" +
        "    return 'script_error';\n" +
        "  }\n" +
        "  return 'unknown';\n" +
        "}\n",
    }),
    { code: 1, contains: ["现状差异已登记", "未登记"], absent: ["全部通过"] },
  );

  run(
    "③ 【反证·登记缺主】divergenceRegistry 条目缺 owner → 结构红",
    baseFixture({
      [FIXTURES_REL]: JSON.stringify(
        {
          failureClassification: {
            vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
          },
          divergenceRegistry: {
            entries: [
              {
                id: "D1",
                kind: "classifier",
                code: "unknown",
                side: "node",
                reason: "x",
                status: "open",
                probe: { parts: ["zzz"], expected: { node: "script_error" } },
              },
            ],
          },
        },
        null,
        2,
      ),
    }),
    { code: 1, contains: ["结构错误", '缺必填字段 "owner"'], absent: ["全部通过"] },
  );

  run(
    "④ 【反证·登记缺 probe】登记没有可复现的文本 → 结构红",
    baseFixture({
      [FIXTURES_REL]: JSON.stringify(
        {
          failureClassification: {
            vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
          },
          divergenceRegistry: {
            entries: [
              { id: "D1", kind: "classifier", code: "unknown", side: "node", reason: "x", owner: "platform-ops", status: "open" },
            ],
          },
        },
        null,
        2,
      ),
    }),
    { code: 1, contains: ["结构错误", "probe.parts"], absent: ["全部通过"] },
  );

  run(
    "⑤ 【反证·僵尸登记】probe 已不复现该差异 ⇒ 判红（逼人清理登记与基线）",
    baseFixture({
      [FIXTURES_REL]: JSON.stringify(
        {
          failureClassification: {
            vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
          },
          divergenceRegistry: {
            entries: [
              {
                id: "D1",
                kind: "classifier",
                code: "unknown",
                side: "node",
                reason: "x",
                owner: "platform-ops",
                status: "open",
                probe: { parts: ["zzz"], expected: { node: "script_error" } },
              },
            ],
          },
        },
        null,
        2,
      ),
      [BASELINE_REL]: JSON.stringify({ entries: [{ id: "D1" }] }, null, 2),
    }),
    { code: 1, contains: ["登记可证", "node 期望 script_error"], absent: ["全部通过"] },
  );

  run(
    "⑥ 【反证·棘轮·消失】基线里有登记而当前没了 → 判红（差异被修掉要同步基线）",
    baseFixture({
      [BASELINE_REL]: JSON.stringify({ entries: [{ id: "D1" }] }, null, 2),
    }),
    { code: 1, contains: ["棘轮：基线里的登记不得消失", "D1"], absent: ["全部通过"] },
  );

  run(
    "⑦ 【反证·棘轮·增长】登记多于基线 → 判红（新增登记必须显式更新基线）",
    baseFixture({
      [FIXTURES_REL]: JSON.stringify(
        {
          failureClassification: {
            vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
          },
          divergenceRegistry: {
            entries: [
              {
                id: "D2",
                kind: "classifier",
                code: "unknown",
                side: "node",
                reason: "x",
                owner: "platform-ops",
                status: "open",
                probe: { parts: ["zzz"], expected: { node: "unknown", admin: "unknown", python: "unknown" } },
              },
            ],
          },
        },
        null,
        2,
      ),
    }),
    { code: 1, contains: ["棘轮：登记条数不超基线", "D2"], absent: ["全部通过"] },
  );

  run(
    "⑧ 【反证·能力类登记缺 verify】capability 登记没有「证据文件 + 标记串」→ 结构红",
    baseFixture({
      [FIXTURES_REL]: JSON.stringify(
        {
          failureClassification: {
            vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
          },
          divergenceRegistry: {
            entries: [
              {
                id: "KD-1",
                kind: "capability",
                code: null,
                side: "python",
                reason: "x",
                owner: "platform-ops",
                status: "open",
              },
            ],
          },
        },
        null,
        2,
      ),
    }),
    { code: 1, contains: ["结构错误", "verify.file"], absent: ["全部通过"] },
  );

  run(
    "⑨ 【反证·能力类登记僵尸】证据文件里的标记串已被改掉 ⇒ 判红",
    baseFixture({
      [FIXTURES_REL]: JSON.stringify(
        {
          failureClassification: {
            vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
          },
          divergenceRegistry: {
            entries: [
              {
                id: "KD-1",
                kind: "capability",
                code: null,
                side: "python",
                reason: "x",
                owner: "platform-ops",
                status: "open",
                verify: { file: "apps/executor-python/routers/config.py", mustContain: "一个已被改掉的标记串" },
              },
            ],
          },
        },
        null,
        2,
      ),
      [BASELINE_REL]: JSON.stringify({ entries: [{ id: "KD-1" }] }, null, 2),
      // 证据文件**存在**但标记串已被改掉 ⇒ 走「证据仍在」那条判据（不是「文件缺失」）
      "apps/executor-python/routers/config.py": "# 注释里的标记串已被改写\n",
    }),
    { code: 1, contains: ["登记可证（证据仍在）", "KD-1"], absent: ["全部通过"] },
  );

  const failed = reportCases(cases, { title: "check-failure-classifiers selftest" });
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
    const { structure, results, info } = await check({ root, report });

    if (structure.length > 0) {
      console.error("");
      console.error("✖ 分类器守卫结构错误（判据本身不可信）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    let failed = 0;
    for (const r of results) {
      if (r.ok) {
        if (!r.name.startsWith("跨语言一致")) console.log(`OK   ${r.name}`);
      } else {
        failed += 1;
        console.log(`FAIL ${r.name}`);
        for (const a of r.actual) console.log(`     actual  : ${a}`);
      }
    }
    console.log("");
    console.log(
      `向量 ${info.vectors} 条，跨语言一致 ${info.crossOk} 条；现状判据 admin ${info.currentCounts.admin} / node ${info.currentCounts.node} / python ${info.currentCounts.python} 条（未抽到 admin ${info.skipped.admin} / node ${info.skipped.node} / python ${info.skipped.python} 条）`,
    );
    if (report) {
      console.log("");
      console.log("（--report 模式：只报告不判红）");
      process.exit(0);
    }
    if (failed) {
      console.error(`\n${failed} failure-classifier drift(s) detected`);
      process.exit(1);
    }
    console.log("failure-classifier consistency OK");
  }
}
