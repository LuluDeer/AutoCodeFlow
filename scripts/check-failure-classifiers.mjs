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
 * ## 棘轮基线里的条目「合法不合法」（2026-11-04 接入共用件）
 *
 * 上面那三条是**度量**（id 集合差 / 差异是否仍成立），仍由本守卫自己算。
 * 此外本守卫还判每条基线条目**登记得合不合法** —— 这部分接手了
 * `scripts/lib/ratchet-baseline.mjs` 的 `readRatchetBaseline` / `compareEntry` /
 * `renderExpired`（同一套纪律在本仓已有 6 个守卫在用，措辞不再各写一遍）：
 *
 *   · 读得到、能解析、顶层是对象、`entries` 是**数组** —— 否则结构红。
 *     接共用件之前这里是 `baseline?.entries ?? []`：**缺 `entries` 被静默当成「0 条」**
 *     （「基线坏了」于是表现为一条「棘轮增长」的漂移红，指向错误的修法），
 *     而 `entries` 是对象/字符串时 `.map` 直接抛 TypeError（无汇总、只有栈迹）。
 *   · 每条登记必须有 `id` / `owner` / `review_by`（缺一即结构红）——
 *     一条没有主也没有期限的登记 = 无限期豁免。
 *   · `review_by` 必须是可解析的 `YYYY-MM-DD`（否则结构红），且 **≥ 今天**：
 *     过期即红（`复核期限已过`）。过期的意思不是「判据错了」，是「当初答应复核的人
 *     没有复核」—— 降成 warn 等于让时间自动把豁免变成永久豁免。
 *   · 基线条目不是对象 ⇒ 结构红（共用件只保证 `entries` 是数组，不保证元素形状；
 *     旧实现在这里抛 `Cannot read properties of null`）。
 *
 * 用法：
 *   node scripts/check-failure-classifiers.mjs [--selftest] [--report] [--root <dir>]
 *   --selftest：在临时 fixture 树里跑真脚本（断言退出码 + 关键文本）。
 *   --report  ：只报告不判红（首次引入基线时用）。
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R160：覆盖计数出口。**必须在任何 require/依赖之前**打印（本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看）。helper = 本文件真实的用例注册函数名
// （`run(name, files, expect)` = 本文件 selftest 里注册一条用例的那个函数）。
printCoverageBanner(import.meta.url, "run");
// 棘轮基线的**登记合法性**（读 + 形状校验 / 必填字段 / 复核期限 / 到期文案）走共用件；
// **「怎么量」留在本守卫**：本守卫的度量是「基线 id 集合 vs 当前登记 id 集合」（见 ⑤）。
// ⚠️ 不要与 ④ 的 `REQUIRED = ["reason","owner","status"]` 混淆 —— 那一条校验的是
//    `packages/contract-fixtures/contract.json` 的 `divergenceRegistry.entries`，
//    不是本守卫的基线文件（两者是**两张不同的表**：登记 vs 基线）。
import {
  compareEntry,
  readRatchetBaseline,
  renderExpired,
  utcDay,
} from "./lib/ratchet-baseline.mjs";

export const PROTOCOL_REL = "packages/executor-protocol/protocol.json";
export const FIXTURES_REL = "packages/contract-fixtures/contract.json";
export const BASELINE_REL = "scripts/failure-classifier-divergence-baseline.json";
export const GEN_MJS_REL = "packages/contract-fixtures/generated/failure-classifier.mjs";
export const GEN_PY_REL = "packages/contract-fixtures/generated/failure-classifier.py";

/** 现状三端（只读；写域属他人）。 */
export const ADMIN_CLS_REL = "apps/admin-api/src/common/failure-classification/failure-patterns.ts";

/**
 * D-16：`xConsumption` 声明的**核对面**（哪些文件算「消费 protocol.json 的段」）。
 *
 * 判据口径：出现 `protocol.json` 字面量（或该段的已知锚点）**且不在** spec/
 * 测试文件里 ⇒ 算「非 spec 消费者」。
 *
 * ⚠️ 为什么用「锚点」而不是只搜 `protocol.json`：运行时读契约有**两种**形态 ——
 *   ① 直接 `require(".../protocol.json")` / `readFileSync(protocol.json)`（少）；
 *   ② 经**生成物**消费（`import { XSchema } from "../generated/protocol.schemas"`）——
 *      这是**本仓的主要形态**（schemas 段就是这一种）。
 * 只搜 ① 会把 `schemas` 误判成「零消费」；故 ② 用「段名 + 生成物路径」做锚点。
 */
/**
 * 段 → 「承载它的**派生产物**」清单（相对仓库根的路径片段）。
 *
 * ⚠️ **判据的核心**：什么算「消费契约」？
 *
 *   ✓ 消费：① 运行时**直接**读 protocol.json（`readFileSync` / `require`）；或
 *            ② 运行时 **import** 一份**由契约生成的产物**（生成物按构造即源自契约）。
 *   ✗ **不**算消费：app 里有一份**同名本地常量**（如 `ENV_WHITELIST`、
 *            `SAFE_SECRET_NAME_RE`、`resolveTaskTimeoutRaw`）——那是**手抄副本**，
 *            恰恰是本轮要消灭的对象，不是「消费」。
 *
 * 实测（按段名/常量名搜会命中 ci.yml、openapi.json、app-error.ts …，全是噪音）；
 * 按**派生产物**搜才是真判据。
 */
export const SEGMENT_DERIVED_ARTIFACTS = {
  // 值 = 该段的**派生产物**在源码里被 import 时的**路径片段**（不含产物自身）。
  schemas: [
    "generated/protocol.schemas",
    "generated/protocol_schemas",
  ],
  failureReason: [
    "generated/failure-classifier",
    "generated/failure_classifier",
  ],
};

/** 派生产物**自身**（它就是契约的展开，不是「消费者」）。 */
export const DERIVED_ARTIFACT_FILES = [
  "apps/executor-node/src/generated/protocol.schemas.ts",
  "apps/executor-node/src/generated/failure-classifier.ts",
  "apps/executor-python/generated/protocol_schemas.py",
  "apps/executor-python/generated/failure_classifier.py",
  "packages/contract-fixtures/generated/failure-classifier.mjs",
  "packages/contract-fixtures/generated/failure-classifier.py",
];

/** 直接读 protocol.json 的形态（②之外的①）。 */
export const DIRECT_PROTOCOL_READ_PATTERNS = [
  /readFileSync\([^)]*protocol\.json/i,
  /require\([^)]*protocol\.json/i,
  /import\s+[^;]*from\s+["'][^"']*protocol\.json/i,
];

/** 非运行时载体（依赖清单 / 向量载体 / 工作流配置）—— 出现 import 路径也不算「运行时消费」。 */
export const NON_RUNTIME_FILES = [
  "package.json",
  "packages/contract-fixtures/contract.json",
  "packages/executor-protocol/device-identity.vectors.json",
  "packages/contract-fixtures/generated/failure-classifier.mjs",
  "packages/contract-fixtures/generated/failure-classifier.py",
];

export const SPEC_PATH_MARKERS = [
  ".spec.",
  ".test.",
  "__tests__",
  "/tests/",
  "test_",
  "_test.py",
];
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


/**
 * 递归列出仓内的源码文件（排除 node_modules / dist / .git / 生成物的 pycache）。
 *
 * 只扫**源码与配置**（.ts .tsx .js .mjs .py .json .yml），不扫 md（文档不算消费者）。
 */
export function listSourceFiles(root) {
  const skip = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".codegraph", "coverage"]);
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.(ts|tsx|js|mjs|py|json|ya?ml)$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** 该文件是否是「测试/spec」文件（测试里的消费**不算**运行时消费）。 */
export function isSpecFile(rel) {
  const base = rel.split("/").pop() ?? "";
  return SPEC_PATH_MARKERS.some((m) => rel.includes(m) || base.includes(m));
}

/**
 * D-16 判据：逐段核对 `xConsumption` 声明与**实际**消费面。
 *
 * · 声明 `runtime` ⇒ 必须存在**非 spec** 消费者（否则声明是假的）；
 * · 声明 `guard-only` ⇒ 必须**不存在**非 spec 消费者（否则声明漏了，
 *   而「漏了」正是本轮要消灭的那类失真——它让人以为该段不是事实源）。
 *
 * 返回 `{ declared, actual, mismatches }`。
 */
export function auditSegmentConsumption(root, protocol) {
  const files = listSourceFiles(root);
  const segments = Object.keys(protocol).filter((k) => !k.startsWith("$"));
  const declared = {};
  const actual = {};
  for (const seg of segments) {
    declared[seg] = protocol[seg]?.xConsumption ?? null;
  }

  // 收集每个文件里出现的「契约段锚点」
  const perSegment = {};
  for (const seg of segments) {
    perSegment[seg] = [];
    const anchors = SEGMENT_DERIVED_ARTIFACTS[seg] ?? [];
    for (const f of files) {
      const rel = f.replace(root + "/", "");
      let src;
      try {
        src = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      // 契约文件自身不算消费者
      if (rel.endsWith("packages/executor-protocol/protocol.json")) continue;
      // 派生产物自身不算消费者（它就是契约的展开）
      if (DERIVED_ARTIFACT_FILES.includes(rel)) continue;
      // 非运行时载体不算消费者：package.json（依赖清单）、契约包内的向量文件、
      // 文档站配置等。
      if (NON_RUNTIME_FILES.includes(rel)) continue;
      // 本仓的守卫脚本不算「运行时消费者」（它们是「守卫面」）
      if (rel.startsWith("scripts/")) continue;
      // ① 运行时 import 了该段的**派生产物**；或 ② 运行时直接读了 protocol.json
      const derivedHit = anchors.some((a) => src.includes(a));
      const directHit = DIRECT_PROTOCOL_READ_PATTERNS.some((re) => re.test(src));
      const hit = derivedHit || directHit;
      if (!hit) continue;
      if (isSpecFile(rel)) continue;
      perSegment[seg].push(rel);
    }
    actual[seg] = perSegment[seg];
  }

  const mismatches = [];
  for (const seg of segments) {
    const d = declared[seg];
    const hasRuntime = actual[seg].length > 0;
    if (d === null) {
      mismatches.push({ seg, declared: d, actual: actual[seg], why: "缺 xConsumption 声明" });
    } else if (d === "runtime" && !hasRuntime) {
      mismatches.push({ seg, declared: d, actual: actual[seg], why: "声明 runtime 但找不到非 spec 消费者" });
    } else if (d === "guard-only" && hasRuntime) {
      mismatches.push({ seg, declared: d, actual: actual[seg], why: "声明 guard-only 但存在非 spec 消费者" });
    }
  }
  return { declared, actual, mismatches };
}


/**
 * D-13 的**行为探针集**：喂给两份 node 产物，比对它们的答案。
 *
 * 探针 = 共享向量（33 条）+ 一批**针对性探针**：
 *   · 每条规则的「代表性文本」（命中边界）；
 *   · 词边界的**两侧**（`enotfound` vs `modulenotfounderror`）——
 *     这是 sentinel 词边界最容易出错的地方；
 *   · astral 字符（`{n,m}` 计数单位差异的现场）；
 *   · 大小写（ASCII 折叠 vs Unicode 折叠的差异点）；
 *   · **重叠面探针**（见下）。
 *
 * ⚠️ 探针**不是**从契约生成的（那会与被测物同源 ⇒ 自证）⇒ 它们是**手写**的
 * 针对性样本，与共享向量**互补**（向量验「契约语义」，探针验「两份产物等价」）。
 *
 * ## ⭐ 「重叠面探针」：顺序即规格 ⇒ 顺序差异必须**可观测**
 *
 * 本轮反向实证（scripts/check-failure-classifiers-reverse-proof.mjs）踩到一个
 * **重要的负例**：最初选的规则对是 `terminal_timeout` × `git_fetch_failed`，
 * 实测**零重叠** ⇒ 两者的相对顺序在**任何**探针上都不可观测 ⇒
 * 人为对调它们之后，守卫**正确地**保持绿（破坏不产生可观测差异）。
 *
 * 那不是探针的缺陷，而是暴露了真问题：**探针集必须覆盖「规则对的重叠面」**，
 * 否则「顺序即规格」这一条**永远测不出来**（而顺序错乱的后果恰恰是
 * 「同一段文本被归到另一个码」——跨端分因的经典形态）。
 *
 * ⇒ 故本函数额外产出**重叠面探针**：对每对**在共享向量上同时命中**的规则，
 * 造一条**同时命中两者**的文本（取两条规则各自 alternative 的交集）⇒
 * 两份产物的**相对顺序**若不同，这条探针的答案就会不同。
 */
export function buildBehaviorProbes(vectors, rules = []) {
  const probes = [];
  for (const v of vectors) {
    probes.push({ id: `vec:${v.id}`, parts: v.parts });
  }

  // ── 重叠面探针：对「在共享向量上同时命中」的规则对，造一条同时命中的文本 ──
  if (Array.isArray(rules) && rules.length > 0) {
    const PAD = "\u0001";
    const hit = (rule, text) => {
      try {
        return new RegExp(rule.body, "u").test(PAD + text.toLowerCase() + PAD);
      } catch {
        return false;
      }
    };
    const texts = vectors.map((v) => v.parts.filter((x) => x).join("\n").toLowerCase());
    for (let i = 0; i < rules.length; i += 1) {
      for (let j = i + 1; j < rules.length; j += 1) {
        const a = rules[i];
        const b = rules[j];
        if (!a || !b || !a.body || !b.body) continue;
        const both = texts.filter((t) => hit(a, t) && hit(b, t));
        if (both.length === 0) continue;
        // 取一条**同时命中两者**的原文（用它自己的大小写，别用小写化后的）
        const idx = texts.findIndex((t) => hit(a, t) && hit(b, t));
        const original = vectors[idx].parts.filter((x) => x);
        probes.push({
          id: `overlap:${a.id}@${b.id}`,
          parts: original,
        });
      }
    }
  }
  const EXTRA = [
    ["edge:enotfound-standalone", ["getaddrinfo ENOTFOUND example.com"]],
    ["edge:enotfound-embedded", ["ModuleNotFoundError: No module named 'x'"]],
    ["edge:econnrefused", ["connect ECONNREFUSED 127.0.0.1:3105"]],
    ["edge:astral-in-counted-span", ["a😀😀b"]],
    ["edge:astral-single", ["😀"]],
    ["edge:uppercase-ascii", ["NO INTERPRETER FOUND FOR PYTHON"]],
    ["edge:uppercase-non-ascii", ["İNTERPRETER"]],
    ["edge:empty", [""]],
    ["edge:only-falsy", [null, undefined, ""]],
    ["edge:newline-in-text", ["line1\nNo interpreter found\nline3"]],
    ["edge:cr-only", ["a\rNo interpreter found"]],
    ["edge:leading-space", ["   No interpreter found"]],
    ["edge:trailing-space", ["No interpreter found   "]],
    ["edge:task-sandbox-token", ["task_sandbox=bwrap"]],
    ["edge:bwrap-binary", ["bwrap: setting up uid map: Permission denied"]],
    ["edge:sandbox-in-path", ["at /app/src/sandbox.ts:12"]],
    ["edge:git-failed", ["git clone failed: exit 128"]],
    ["edge:git-success", ["git clone 正在执行"]],
    ["edge:uv-venv-timeout", ["uv venv timed out after 600s"]],
    ["edge:task-timeout", ["任务执行超时（600s）"]],
    ["edge:modulenotfound", ["ModuleNotFoundError: No module named 'requests'"]],
    ["edge:invalid-npm-name", ["Invalid npm package name"]],
    ["edge:zh-sandbox", ["沙箱不可用"]],
    ["edge:zh-interpreter", ["解释器 3.9 无法获取"]],
    ["edge:zh-dependency", ["依赖安装失败"]],
    ["edge:zh-restart", ["执行器正在停机，该执行尚未开始"]],
    ["edge:task-launcher", ["资源限制启动器拒绝启动任务"]],
    ["edge:unrelated", ["some entirely unrelated failure text"]],
  ];
  for (const [id, parts] of EXTRA) probes.push({ id, parts });
  return probes;
}

/**
 * import 一个**可能是 .ts** 的模块，并静音 node 的类型剥离警告。
 *
 * 为什么要静音：node 见到「CommonJS 包里的 ESM 语法」会打
 * `MODULE_TYPELESS_PACKAGE_JSON` 警告。那是**警告不是错误**（node 24 能正常
 * 加载并剥离类型），但它会污染守卫的输出 —— 而守卫的输出应当**只有判据结果**
 * （人/脚本读的是「OK/FAIL」，不是环境噪音）。
 *
 * ⚠️ 只静音**这一条**警告（按 warning 名精确匹配），其它警告照常透出。
 */
async function importStrippedTypeScript(absPath) {
  const { stripTypeScriptTypes } = await import("node:module");
  // ⚠️ `stripTypeScriptTypes` 是 Experimental ⇒ node 会发一条 ExperimentalWarning。
  //    那条警告说的是「node 的这个 API 可能变」，不是「我们的产物有问题」⇒
  //    在守卫输出里它是**噪音**（守卫的输出应当只有判据结果）。精确静音它。
  const originalEmit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const name = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    const text = typeof warning === "string" ? warning : warning?.message ?? "";
    if (name === "ExperimentalWarning" && text.includes("stripTypeScriptTypes")) return;
    return originalEmit.call(process, warning, ...rest);
  };
  const { readFileSync } = await import("node:fs");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(absPath, "utf8");
  const stripped = stripTypeScriptTypes(src, { mode: "strip" });
  const tmp = join(tmpdir(), `dsh-failure-classifier-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(tmp, stripped, "utf8");
  try {
    return await import(`file://${tmp}`);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    process.emitWarning = originalEmit;
  }
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

  // ── ④-3 D-13：四处生成物必须**逐字节一致**（单一来源 ⇒ 派生产物无漂移）──
  //
  // 这是「各 app 各产一份」的安全前提：多份是**派生产物**，判据 =「每处 ≡ 一次
  // 全新生成的字节」。守卫已在本脚本里重跑生成器的 --check 模式（那会逐字比对
  // 每一处的**当前内容**与**新生成的内容**），故此处只需**额外**断言：
  //   · node 的两份（.ts 与 .mjs）的**判定逻辑**必须一致（类型标注是 TS 专有，
  //     故比对「去掉类型标注后的规范化文本」）；
  //   · python 的两份（app 内与契约包内）必须**逐字节相同**（同一发射器渲染）。
  {
    const nodeApp = join(root, "apps/executor-node/src/generated/failure-classifier.ts");
    const nodeGuard = join(root, GEN_MJS_REL);
    const pyApp = join(root, "apps/executor-python/generated/failure_classifier.py");
    const pyGuard = join(root, GEN_PY_REL);

    const nodeAppSrc = readText(nodeApp);
    const nodeGuardSrc = readText(nodeGuard);
    results.push({
      name: "D-13：node 两份生成物都在（app 运行时 .ts + 守卫 .mjs）",
      ok: nodeAppSrc !== null && nodeGuardSrc !== null,
      actual: nodeAppSrc === null ? [nodeApp] : nodeGuardSrc === null ? [nodeGuard] : [],
      expected: [],
    });

    const pyAppSrc = readText(pyApp);
    const pyGuardSrc = readText(pyGuard);
    results.push({
      name: "D-13：python 两份生成物都在（app 运行时 .py + 守卫 .py）",
      ok: pyAppSrc !== null && pyGuardSrc !== null,
      actual: pyAppSrc === null ? [pyApp] : pyGuardSrc === null ? [pyGuard] : [],
      expected: [],
    });

    if (pyAppSrc !== null && pyGuardSrc !== null) {
      results.push({
        name: "D-13：python 两份生成物逐字节一致",
        ok: pyAppSrc === pyGuardSrc,
        actual: pyAppSrc === pyGuardSrc ? [] : ["两份 .py 内容不同（app 那份被手改过？）"],
        expected: [],
      });
    }

    if (nodeAppSrc !== null && nodeGuardSrc !== null) {
      // ⚠️ 判据口径：**行为等价**，不是文本等价。
      //
      // 为什么不比文本：`.ts` 与 `.mjs` 是**各自手写**的发射器（不是一份派生），
      // 它们在**语法**上必然有差异（类型标注、TS 专有修饰、成员顺序）。把语法
      // 差异规范化掉再比文本，是一条**永远在维护**的脆弱规则（本轮实测它先后
      // 误判了 5 次：内联对象类型、形参类型、返回类型、`?? 0`、成员顺序）。
      //
      // 「行为等价」是**直接可比**的：同一批**探针文本**喂给两份产物，答案必须
      // 逐条相同。探针集 = 共享向量（33 条）+ 一批**针对性探针**（覆盖各规则的
      // 命中/不命中边界）。这既避开了语法噪音，又比文本比对**更强**（文本相同
      // 是行为相同的**充分**条件，但不是必要条件）。
      // 规则表取**生成物**里的（body 已 token 展开）—— 契约里的 alternatives
      // 还是 `{{TOKEN}}` 占位形态，不能直接编译。
      const guardMod = await import(`file://${join(root, GEN_MJS_REL)}?t=${Date.now()}`);
      const genRules = guardMod.RULES ?? [];
      const probes = buildBehaviorProbes(vectors, genRules);
      // ⚠️ `.ts` 产物用 node 的 `stripTypeScriptTypes`（node:module，node ≥ 22.6
      //    可用；本仓 CI 是 node 24）**剥离类型后**再 import。
      //    为什么不用「直接 import .ts」：那会打一条 MODULE_TYPELESS_PACKAGE_JSON
      //    警告（executor-node 的 package.json 没有 "type" ⇒ 该包是 CommonJS，
      //    而 node 见到 ESM 语法会重新解析），且该警告走 node 的内部路径、
      //    **绕过了** `process.emitWarning` 拦截（本轮实测拦不住）。
      //    剥离后再 import：零警告、零副作用、语义完全相同。
      const appMod = await importStrippedTypeScript(nodeApp);
      const mismatches = [];
      for (const probe of probes) {
        for (const stage of ["executor", "admin"]) {
          const a = appMod.classify(probe.parts, stage);
          const b = guardMod.classify(probe.parts, stage);
          if (a !== b) mismatches.push(`${probe.id}@${stage}: .ts=${a} .mjs=${b}`);
        }
      }
      results.push({
        name: `D-13：node 两份生成物行为等价（${probes.length} 条探针 × 2 阶段）`,
        ok: mismatches.length === 0,
        actual: mismatches.slice(0, 5),
        expected: [],
      });
    }
  }

  // ── ④-4 D-16：逐段核对 `xConsumption` 声明与实际消费面 ──────────────────
  {
    const audit = auditSegmentConsumption(root, proto);
    info.consumption = {
      declared: audit.declared,
      runtimeSegments: Object.entries(audit.actual)
        .filter(([, v]) => v.length > 0)
        .map(([k, v]) => ({ seg: k, files: v })),
    };
    for (const m of audit.mismatches) {
      results.push({
        name: `D-16：段 ${m.seg} 的 xConsumption 声明与实际一致`,
        ok: false,
        actual: [`${m.why}${m.actual.length ? `（消费点：${m.actual.slice(0, 3).join(", ")}）` : ""}`],
        expected: [],
      });
    }
    // 声明 runtime 的段必须**至少有一个**
    const runtimeDeclared = Object.values(audit.declared).filter((v) => v === "runtime").length;
    results.push({
      name: "D-16：至少一个段声明为 runtime（否则声明机制本身是死的）",
      ok: runtimeDeclared > 0,
      actual: runtimeDeclared > 0 ? [] : ["没有任何段声明 runtime"],
      expected: [],
    });
  }

  // ── ⑤ 棘轮：登记条数只减不增；已登记但「差异消失」也要报 ──────────────
  // 读基线交给共用件：文件缺失 / 不可解析 / 顶层非对象 / `entries` 不是数组 ⇒ 结构红。
  // ⚠️ 这替换掉了原来的 `const baseEntries = baseline?.entries ?? [];` —— 那是一个
  //    **静默降级点**：基线存在但缺 `entries`（或它不是数组）时被当成「0 条」，
  //    于是「基线文件坏了」表现为「棘轮：登记条数不超基线」的一条漂移红。
  //    现在是结构红（收紧方向：只可能把绿变红，不会把红变绿）。
  const baseB = readRatchetBaseline({
    root,
    rel: BASELINE_REL,
    kind: "array",
    entriesKey: "entries",
    label: "基线",
  });
  if (baseB.error) {
    structure.push(baseB.error);
    return { structure, results, info };
  }
  const baseEntries = baseB.list.map(({ entry }) => entry);
  info.baseline = { count: baseEntries.length, current: registry.length };

  // ── ⑤-0 基线登记「合法不合法」：必须有主（owner）+ 有期限（review_by）──────
  // 判据在共用件里（`compareEntry`）：谁负责、什么时候复核、期限到没到。
  // 这里**不动**下面的棘轮度量（集合差仍是本守卫自己算的）。
  // 分流口径：
  //   · 缺字段 / 期限不可解析 ⇒ **结构红**：一条没有主也没有期限的基线条目，
  //     等于「已知差异」变成一张永远不会过期的豁免名单 —— 判据本身已不可信；
  //   · 期限已过 ⇒ **漂移红**（results 里的一条）：基线形状是好的，是当初答应
  //     复核的人没有复核。措辞统一用共用件的 `复核期限已过`。
  const today = utcDay();
  const deadlineProblems = [];
  for (const { key, entry } of baseB.list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      // 共用件只保证「`entries` 是数组」，不保证元素是对象。这里必须自己拦：
      // 非对象条目会让下面的 `baseEntries.map((e) => e.id)` 抛 TypeError（未捕获 = 栈迹退出），
      // 且它本身也无法逐字段复核 ⇒ 结构红。
      structure.push(
        `基线条目 ${key} 不是对象（收到 ${entry === null ? "null" : Array.isArray(entry) ? "数组" : typeof entry}）—— ${BASELINE_REL} 腐烂了：条目必须能逐字段复核（谁负责 / 什么时候复核）。`,
      );
      continue;
    }
    const shape = compareEntry({
      at: `基线条目 ${key}`,
      noun: "登记",
      entry,
      rel: BASELINE_REL,
      label: "基线",
      requiredFields: ["id", "owner", "review_by"],
      today,
    });
    if (shape.incomplete !== null) {
      structure.push(
        `${shape.incomplete}` +
          `（${BASELINE_REL} 的每条登记都是「已知差异还没修」的豁免凭证 ⇒ 必须写清 owner 与 review_by。）`,
      );
    }
    if (shape.badDate !== null) structure.push(shape.badDate);
    if (shape.expired) {
      deadlineProblems.push(renderExpired({ at: `基线条目 ${key}`, noun: "登记", entry, today }));
    }
  }
  if (structure.length > 0) return { structure, results, info };
  results.push({
    name: "棘轮：登记必须有主有期限（到期即红）",
    ok: deadlineProblems.length === 0,
    actual: deadlineProblems,
    expected: [],
  });

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
    // D-16：fixture 的 protocol 也要带 xConsumption 声明（真实契约每个段都有）。
    // ⚠️ 这里声明 `guard-only`：fixture 里**没有**任何运行时消费该段的代码
    //（fixture 的三端现状判据都是手写的、只被「现状模拟器」读）⇒ 声明必须
    //  与事实一致，否则 D-16 判据会红（那正是它该做的事）。
    xConsumption: "guard-only",
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
  // D-16：fixture 里也要有一个声明 `runtime` 的段（否则「至少一个 runtime」
  // 那条判据在 fixture 上恒红）。`schemas` 段的派生产物是
  // `generated/protocol.schemas` ⇒ fixture 里放一个 import 它的消费者。
  schemas: {
    xConsumption: "runtime",
    S: { type: "object", properties: { a: { type: "string" } } },
  },
};

// fixture 的两份「生成物」：**必须与真实生成物同形**（含 `body` 字段）——
// 否则守卫的「结构禁令」那一层会因「抽不到规则体」而结构红，掩盖掉其它判据
// （那是**假红**，不是被测行为）。
// fixture 的 .mjs 必须与 fixture 的 .ts **行为等价**（D-13 判据要比对它们）⇒
// 两份用同一套逻辑（真实产物里 .ts 与 .mjs 也是各自手写但行为等价，
// 由守卫在探针上验证）。
const GEN_MJS_FIXTURE = [
  `export const RULES = [`,
  `  { "id": "r1", "order": 10, "code": "unknown", "appliesTo": ["executor", "admin"], "body": "nothing matches this" },`,
  `];`,
  `export function classify(parts, stage = "executor") {`,
  `  const text = parts.filter((p) => p !== null && p !== undefined && p !== "").join("\\n").toLowerCase();`,
  `  for (const rule of RULES) {`,
  `    if (stage === "admin" || rule.appliesTo.includes(stage)) {`,
  `      if (new RegExp(rule.body, "u").test(text)) return rule.code;`,
  `    }`,
  `  }`,
  `  return stage === "admin" ? "unknown" : null;`,
  `}`,
  `export function ruleIds(stage) { return []; }`,
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

/** fixture 用的 app 侧生成物（与真实产物同形：D-13 判定要比对它们）。 */
const NODE_APP_TS_FIXTURE = [
  `export const TOKENS = { WS: "[ ]" };`,
  `export const NORMALIZE = { joinWith: \"\\n\", dropFalsyParts: true, caseFold: \"ascii-lower\", astralFold: \"replace-with-U+FFFD\" };`,
  `export const RULES = [{ id: \"r1\", order: 10, code: \"unknown\", appliesTo: [\"executor\", \"admin\"], body: \"nothing matches this\" }];`,
  `export function classify(parts: readonly (string | null | undefined)[], stage: \"executor\" | \"admin\" = \"executor\"): string | null {`,
  `  const text = parts.filter((p): p is string => p !== null && p !== undefined && p !== \"\").join(\"\\n\").toLowerCase();`,
  `  for (const rule of RULES) {`,
  `    if (stage === \"admin\" || rule.appliesTo.includes(stage)) {`,
  `      if (new RegExp(rule.body, \"u\").test(text)) return rule.code;`,
  `    }`,
  `  }`,
  `  return stage === \"admin\" ? \"unknown\" : null;`,
  `}`,
].join("\n");

// fixture 的 python 产物必须与**真实产物同形**：规则表是 `json.loads("…")`
// 的载荷（守卫的「结构禁令」那一层要从中抽 `"body"` 字段）。
const PY_APP_FIXTURE = [
  `import json`,
  `import re`,
  ``,
  `RULES = json.loads(${JSON.stringify(
    JSON.stringify([
      { id: "r1", order: 10, code: "unknown", appliesTo: ["executor", "admin"], body: "nothing matches this" },
    ]),
  )})`,
  ``,
  `def classify(parts, stage='executor'):`,
  `    text = '\\n'.join(p for p in parts if p).lower()`,
  `    for rule in RULES:`,
  `        if stage == 'admin' or stage in rule['appliesTo']:`,
  `            if re.search(rule['body'], text):`,
  `                return rule['code']`,
  `    return 'unknown' if stage == 'admin' else None`,
].join("\n");

/**
 * fixture 用的基线条目：**形状必须合法**（`id` + `owner` + `review_by`）。
 *
 * ⑤⑥⑨ 测的是棘轮本身（集合差 / 证据仍在），不该因为「fixture 的基线缺主」先在
 * 结构红里短路 —— 短路后断言就不再指向它要证的那件事（**假通过**）。
 * 缺主/过期这两条**新判据**有它们自己的用例（⑬⑭⑮）。
 */
const fixtureBaselineEntry = (id) => ({ id, owner: "executor-parity", review_by: "2026-12-15" });

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
    [GEN_PY_REL]: PY_APP_FIXTURE,
    // D-13：app 侧两份（node .ts + python .py）
    "apps/executor-node/src/generated/failure-classifier.ts": NODE_APP_TS_FIXTURE,
    // D-16 fixture：`schemas` 段的运行时消费者（import 派生产物）
    "apps/executor-node/src/consumer.ts": [
      `import { SSchema } from "./generated/protocol.schemas";`,
      `export const used = SSchema;`,
    ].join("\n"),
    "apps/executor-node/src/generated/protocol.schemas.ts": `export const SSchema = { type: "object" };`,
    // ⚠️ python 的 app 侧与守卫侧**必须是同一份内容**（真实产物由同一个发射器
    //    渲染 ⇒ 逐字节相同）⇒ fixture 里也用同一个常量。
    "apps/executor-python/generated/failure_classifier.py": PY_APP_FIXTURE,
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
      [BASELINE_REL]: JSON.stringify({ entries: [fixtureBaselineEntry("D1")] }, null, 2),
    }),
    { code: 1, contains: ["登记可证", "node 期望 script_error"], absent: ["全部通过"] },
  );

  run(
    "⑥ 【反证·棘轮·消失】基线里有登记而当前没了 → 判红（差异被修掉要同步基线）",
    baseFixture({
      [BASELINE_REL]: JSON.stringify({ entries: [fixtureBaselineEntry("D1")] }, null, 2),
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
      [BASELINE_REL]: JSON.stringify({ entries: [fixtureBaselineEntry("KD-1")] }, null, 2),
      // 证据文件**存在**但标记串已被改掉 ⇒ 走「证据仍在」那条判据（不是「文件缺失」）
      "apps/executor-python/routers/config.py": "# 注释里的标记串已被改写\n",
    }),
    { code: 1, contains: ["登记可证（证据仍在）", "KD-1"], absent: ["全部通过"] },
  );

  run(
    "⑩ 【反证·D-13 行为漂移】app 的 .ts 与守卫的 .mjs 行为不一致 ⇒ 判红",
    baseFixture({
      "apps/executor-node/src/generated/failure-classifier.ts": [
        `export const RULES = [{ id: "r1", order: 10, code: "unknown", appliesTo: ["executor", "admin"], body: "nothing matches this" }];`,
        `export function classify(parts: readonly (string | null | undefined)[], stage: "executor" | "admin" = "executor"): string | null {`,
        `  return stage === "admin" ? "unknown" : null;`,
        `}`,
      ].join("\n"),
    }),
    { code: 1, contains: ["D-13：node 两份生成物行为等价"], absent: ["全部通过"] },
  );

  run(
    "⑪ 【反证·D-16 声明失真】声明 runtime 但没有非 spec 消费者 ⇒ 判红",
    baseFixture({
      [PROTOCOL_REL]: JSON.stringify(
        {
          ...SAMPLE_PROTOCOL,
          schemas: { xConsumption: "runtime", S: { type: "object" } },
          failureReason: { ...SAMPLE_PROTOCOL.failureReason },
        },
        null,
        2,
      ),
      // 移除 schemas 段的消费者 ⇒ 声明变成假的
      "apps/executor-node/src/consumer.ts": `export const used = 1;`,
    }),
    { code: 1, contains: ["D-16：段 schemas 的 xConsumption 声明与实际一致"], absent: ["全部通过"] },
  );

  run(
    "⑫ 【反证·D-16 漏声明】段缺 xConsumption ⇒ 判红",
    baseFixture({
      [PROTOCOL_REL]: JSON.stringify(
        (() => {
          const p = { ...SAMPLE_PROTOCOL };
          delete p.schemas.xConsumption;
          return p;
        })(),
        null,
        2,
      ),
    }),
    { code: 1, contains: ["D-16：段 schemas 的 xConsumption 声明与实际一致"], absent: ["全部通过"] },
  );

  // ── ⑬⑭⑮⑯：基线**登记合法性**这一层（共用件接管后新成立的判据）──────────
  run(
    "⑬ 【反证·基线缺主】基线条目只有 id，缺 owner / review_by → 结构红",
    baseFixture({
      [BASELINE_REL]: JSON.stringify({ entries: [{ id: "D1" }] }, null, 2),
    }),
    { code: 1, contains: ["结构错误", "缺 owner、review_by", "基线条目 D1"], absent: ["全部通过"] },
  );

  run(
    "⑭ 【反证·基线复核过期】review_by 已过期 → 判红（措辞「复核期限已过」）",
    baseFixture({
      [BASELINE_REL]: JSON.stringify(
        { entries: [{ ...fixtureBaselineEntry("D1"), review_by: "2020-01-01" }] },
        null,
        2,
      ),
    }),
    { code: 1, contains: ["棘轮：登记必须有主有期限", "复核期限已过", "D1"], absent: ["全部通过"] },
  );

  run(
    "⑮ 【反证·基线缺 entries】基线存在但 entries 不是数组 → 结构红（不许静默当 0 条）",
    baseFixture({
      // 旧实现在这里是 `baseline?.entries ?? []` ⇒ 静默降级成「0 条基线」，
      // 只报一条「棘轮：登记条数不超基线」的漂移红；现在必须是**结构红**。
      [BASELINE_REL]: JSON.stringify({ entries: {} }, null, 2),
    }),
    { code: 1, contains: ["结构错误", "entries 必须是数组"], absent: ["棘轮：登记条数不超基线"] },
  );

  run(
    "⑯ 【反证·基线条目不是对象】entries 里塞 null → 结构红（旧实现会抛 TypeError）",
    baseFixture({
      [BASELINE_REL]: JSON.stringify({ entries: [null] }, null, 2),
    }),
    { code: 1, contains: ["结构错误", "不是对象"], absent: ["全部通过"] },
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
