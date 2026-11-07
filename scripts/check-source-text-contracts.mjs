#!/usr/bin/env node
/**
 * 「源码文本契约」守卫 —— 治「**spec 用正则读实现源码文本**」这一**类**。
 *
 * ## 为什么这一类需要守卫（而不是任凭它长）
 *
 * 有些 spec 不 import 符号，而是 `readFileSync` 读**实现文件源码**再用正则/
 * `toMatch` 断言实现形态。这类约束让「搬常量 / 搬函数 / 改别名 / 拆文件」从
 * **零风险重构**变成**破坏测试**，而且**在类型系统里完全静默**：
 * tsc 绿、运行时也绿，只有恰好跑到那条 spec 才红。
 *
 * B0 拆分时实测撞到过一次（`protocol-version-consistency.spec.ts` 的
 * `readTsCap()` 用正则从 `executor.service.ts` 原件里抠
 * `MAX_RUNNING_EXECUTION_IDS = <n>`）——那条 spec 是**故意的**源码级契约闸，
 * 不能改，只能把常量留在原处。
 *
 * ## 判据（四条，全部 fail-closed）
 *
 *   ① **登记表自身有效**：每条必填 `id / tier / spec / specLine / needle /
 *      reads / asserts / disposition / owner / reviewBy`；`tier ∈ {P0,P1,P2}`；
 *      `disposition ∈ {fix-before-B4, fix-before-B5, defer, keep-and-accept, no-debt}`。
 *   ② **漂移即红**：`spec` 文件必须存在；`needle` 必须仍在 `specLine` 附近
 *      （±`NEEDLE_SEARCH_RADIUS` 行）。行号漂走后登记表就烂了，这条防它。
 *   ③ **过期即红**：`reviewBy` 早于今天 ⇒ 红（与 `check-dependency-review.mjs`
 *      的 `reviewBy` 语义同款：**到点必须有人重新签字**，不能永久挂着）。
 *   ④ **新增即红（棘轮）**：扫全仓 `*.spec.ts` / `*.test.ts`，凡是「读了实现源码
 *      形态」的 spec 必须已在登记表里；扫到未登记的 ⇒ 红。
 *      —— 这条是本守卫的主价值：**不许静默新增**一类会让重构变脆的断言。
 *
 * ## 新增一条怎么办
 *
 * 在 `scripts/source-text-contracts.json` 的 `entries` 里加一条，填 `specLine`
 * 与 `needle`（该行的一小段**唯一**文本），跑 `--report` 确认命中。加条目本身
 * 就是一次「我知道这里绑了实现」的显式签字。
 *
 * ## 用法
 *
 *   node scripts/check-source-text-contracts.mjs            # 判据（CI 用）
 *   node scripts/check-source-text-contracts.mjs --root <dir>  # 以 <dir> 为仓库根（夹具用）
 *   node scripts/check-source-text-contracts.mjs --report   # 人读清单（按档位分组）
 *   node scripts/check-source-text-contracts.mjs --selftest # 自检（真仓库对照组 + 黑盒夹具）
 *
 * ## 自检覆盖了什么 / 没覆盖什么（R148 补黑盒夹具后如实登记）
 *
 * **覆盖**：`--selftest` 现在有 **41** 条用例（R148 前是 35），其中 **6** 条是**黑盒 CLI 夹具**
 * （`runGuard(SELF, ["--root=<mkdtemp 夹具>"])`，spawn 真脚本、断言退出码 + 文本）：
 *   · 合规夹具（**自带两张登记表**：`scripts/source-text-contracts.json` +
 *     `scripts/guard-source-text-contracts.json`，各 1 条、spec 真实存在、needle 命中）⇒ 0；
 *   · 夹具里多一个**未登记的读源码 spec** ⇒ 1，点名那个文件（棘轮在 CLI 面也生效）；
 *   · `needle` 从 spec 里被改掉 ⇒ 1，点名条目 id 与 `±20 行`（漂移判据在 CLI 面生效）；
 *   · 夹具里**没有两张登记表** ⇒ 1 结构红并打印**实际查找路径**（不是 ENOENT 栈）；
 *   · `--root` 指向**存在但不是本仓形状**的树 ⇒ 1（两侧都读不到登记表）；
 *   · `--root` 指向不存在的目录 ⇒ 2（用法错误，不静默回落真仓库）。
 *
 * **为什么必须走 CLI**：`applyRoot()` 是**唯一**会把两张登记表路径切到 `<root>` 的地方。
 * 在进程内直调 `check({ repoRoot, registry })` 永远测不到它 —— 把 `applyRoot` 里的
 * 一行删掉，30 条既有用例**会全绿**，而夹具会**静默读真仓库**（最坏的那种假绿）。
 *
 * **没覆盖**（盲区，别把这里读成「拦得住一切」）：
 *   · 夹具的 spec 是**本自检手写的最小样本**，不是从真实 spec 生成的 ⇒ 只证明
 *     「判据在这棵小树上对」，不证明「判据在真仓的 123 条登记上仍对」（那由主跑兜底）；
 *   · `looksLikeImplementationRead` 的启发式边界（`LOOKBACK` / `LOOKAHEAD` 魔法数、
 *     多行正向写法、`SRC_ROOT` 拼接）由 ⑯–㉓a 的纯函数用例承担，**没有**一条夹具
 *     把「跨 9 行以上的实参」这类越界形态灌进假仓库（见该常量的头注：越界=漏报不误报）；
 *   · 不覆盖 `--generate` / `--generate --write` 的落盘行为（那是生成器，不是判据；
 *     写盘面刻意不进夹具，避免自检往仓库写文件）。
 *
 * ## ⚠️ 未覆盖（已知边界，显式记录不静默）
 *
 * 只扫 `apps/**`、`packages/**` 下的 `*.spec.ts` / `*.test.ts`。
 * **不扫** `scripts/check-*.mjs` 类守卫脚本 —— 它们同样读源码文本，但属
 * guard-smith 的足迹，另行登记（见 `docs/` 台账）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A9-① 端到端有牙用例（㉓a）要造 fixture 树。这是**纯 ESM 静态 import**（顶层语句，
// 主跑也会加载）——如实说明：它不是「只在 selftest 生效」的懒加载。
//
// ⚠️ 这意味着**主跑路径多了一个文件级依赖**：`scripts/lib/guard-selftest.mjs`。
// 该文件缺失/被改名时，这个守卫会在 import 阶段抛 ERR_MODULE_NOT_FOUND ——
// **连判据都跑不起来**（不是「报告里少一条」）。CI 上 `scripts/lib/` 必定存在，
// 但本地单文件拷贝/裁剪目录时会踩。下面这条断言把它变成**可读的失败**而不是栈。
import { expectExit, makeFixtureRepo, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R160：覆盖计数出口。**必须在任何 require/依赖之前**打印（本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看）。helper = 本文件真实的用例注册函数名
// （`ok(name, fn)` = 本文件 selftest 里注册一条用例的那个函数）。
printCoverageBanner(import.meta.url, "ok");

// 显式自证依赖可用（Lead 2026-11-04 要求：别让主跑在缺该文件的目录下崩得莫名其妙）。
if (typeof makeFixtureRepo !== "function") {
  throw new Error(
    "scripts/lib/guard-selftest.mjs 未导出 makeFixtureRepo —— 该模块是 selftest 的 fixture 工具，" +
      "本守卫在 ESM import 阶段就依赖它（无懒加载）。请确认 scripts/lib/ 完整。",
  );
}

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 缺省**仓库根**（按脚本位置锚定，不用 `process.cwd()`）。
 *
 * ## 仓库根从哪来（`--root`）
 *
 * 两张登记表里的 `spec` 全是**仓库相对路径**，所以「根」是本守卫唯一的输入口径：
 *
 *   · 不传 `--root` ⇒ 根 = `REPO_ROOT`（`<repo>/scripts/` 的上一级），
 *     **与引入 `--root` 之前逐字节等价**；
 *   · `--root <dir>` / `--root=<dir>` 两种形态都认 ⇒ 根换成 `<dir>`，**两张登记表
 *     也按 `<dir>` 解析**（`<dir>/scripts/source-text-contracts.json` 与
 *     `<dir>/scripts/guard-source-text-contracts.json`）——夹具要自带登记表，
 *     否则「登记表是脚本旁边的常量」会让整棵树搬不走，自检只能测纯函数；
 *   · `--root` 缺值 / 空值 / 指向不存在的目录 ⇒ **exit 2**（用法错误）。
 *     **不许静默回落到真仓库**——「以为在跑夹具、实际跑的是真仓库」是最坏的假绿；
 *   · `--selftest` 与 `--root` **互斥** ⇒ exit 2：自检的对照组就是真仓库
 *     （多条用例读真登记表、真 spec），换根会让对照组失去意义。
 *
 * 结构红（不是判据）：`--root` 树下读不到登记表 ⇒ exit 1 并打印**实际查找的路径**
 * （而不是崩一个 ENOENT 栈，让人以为守卫自己坏了）。
 *
 * 只读：本守卫不写盘（`--report` 只打 stdout），所以 `--root` 不需要写盘重定向。
 */
const REPO_ROOT = resolve(HERE, "..");
/** 两张登记表都按**仓库根**解析（夹具自带登记表 ⇒ 判据可整树搬到临时目录）。 */
const registryPath = (root) => join(root, "scripts", "source-text-contracts.json");
const guardRegistryPath = (root) => join(root, "scripts", "guard-source-text-contracts.json");
/** R164：判据⑥ 的「存量不一致」基线（棘轮：只许变小）。 */
const READS_BASELINE_REL = "scripts/source-text-reads-baseline.json";
let REGISTRY_PATH = registryPath(REPO_ROOT);
/**
 * **第二登记表**：守卫脚本（`scripts/check-*.mjs`）读实现源码的登记。
 *
 * 为什么是同一张守卫里的第二个分支、而不是另写一个并列守卫（2026-11-04 Lead 裁定）：
 *   · 两份表的**字段与档位口径完全同构**（P0/P1/P2 + disposition + reviewBy）；
 *   · 并排写两个守卫会让两套校验逻辑各自演化 —— 改一处忘一处，最后两份表「看起来都被校验」；
 *   · 扩展同一个守卫还带来一个副作用好处：**一份报告能同时看见两侧的未登记项**，
 *     而不是「这边的绿」掩盖「那边的红」。
 *
 * 边界：本分支**只校验第二张表自身**（结构/漂移/过期/回收），不重新扫描守卫脚本
 * （那需要另一套「什么算读实现源码」的判定，由 `scripts/guard-source-text-contracts.json`
 * 的 `scannedTotals` 记口径，避免两套扫描器互相打架）。
 */
let GUARD_REGISTRY_PATH = guardRegistryPath(REPO_ROOT);

/** 档位 → 允许的处置方式。 */
const TIERS = new Set(["P0", "P1", "P2"]);
const DISPOSITIONS = new Set([
  "fix-before-B4",
  "fix-before-B5",
  "defer",
  "keep-and-accept",
  "no-debt",
]);

/** `needle` 允许漂移的搜索半径（行）。行号小幅变动不报警，大改才红。 */
const NEEDLE_SEARCH_RADIUS = 20;

/** 扫描范围（相对仓库根）。 */
const SCAN_ROOTS = ["apps", "packages"];

/** 扫描时跳过的目录。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "generated",
  "__pycache__",
  ".venv",
  "assets",
]);

// ───────────────────────────────────────────────────────────────────────────
// 工具
// ───────────────────────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split("\\").join("/");
}

function daysBetween(fromISO, toISO) {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

function todayISO() {
  // 允许测试注入固定日期（自检用）
  return process.env.STC_TODAY ?? new Date().toISOString().slice(0, 10);
}

/** `spec` 字段是否含 glob（P2 类用 `migrations/__tests__/*.spec.ts` 形态）。 */
function isGlob(spec) {
  return spec.includes("*");
}

/** 极简 glob：只支持 `*`（匹配除 `/` 外任意字符）。 */
function globToRegExp(pattern) {
  const escaped = toPosix(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (
      (e.name.endsWith(".spec.ts") || e.name.endsWith(".test.ts")) &&
      !e.name.endsWith(".d.ts")
    ) {
      out.push(p);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 「读实现源码」的启发式判据
// ───────────────────────────────────────────────────────────────────────────

/**
 * 一行 `readFileSync(...)` 是否在**读实现源码**（而不是读 fixture / json / 输出产物）。
 *
 * 判据（满足任一即算「读实现源码」）：
 *   · 该行或其上 `LOOKBACK` 行内出现 `__dirname` 且出现 `.ts'` / `.ts"` / `.py'` / `.py"`
 *     （同目录源码文件的典型写法）；
 *   · **多行正向写法**（A9-①，2026-11-04 补）：`readFileSync(` 的括号在该行**没有闭合**时，
 *     把**后续行**（至多 `LOOKAHEAD` 行，直到括号配平）一并纳入同一窗口再判。
 *     为什么必须补：`const src = readFileSync(` 换行后才是
 *     `join(__dirname, "..", "task.service.ts"),` —— 只往前看 6 行的旧实现**整个漏掉**
 *     （实测：sched-precision 的 T2-B4 第二刀 spec 就是这么写的，扫描器未命中，
 *     他只好手工补登 STC-103）。这类漏报最坏：**新写的脆断言恰好是看不见的那种**。
 *   · 出现 `SRC_ROOT` / `SRC_DIR` / `src` 路径拼接；
 *   · 变量名以 `_TS` / `_PY` / `SRC` 结尾且该行出现 `.ts`/`.py` 字面量；
 *   · 出现 `MIGRATION` 且出现 `.ts`/`.sql`（迁移 spec 的典型写法）。
 *
 * **刻意读 JSON / .log / 输出目录的**不算（那是「读数据」不是「读实现」）。
 */
const LOOKBACK = 6;

/**
 * 多行**正向**回溯：`readFileSync(` 之后最多再看这么多行（A9-①）。
 *
 * 不是无脑往后看 —— 只在**该行的括号没闭合**时才启用（见 `closesOnSameLine`）：
 * 括号没闭合 = 实参还没写完，后续行**属于这次调用**，是这次读的一部分；
 * 括号已闭合还往后看，就会把「下一句无关代码里的 `.ts`」算进来 ⇒ 误报。
 *
 * ## ⚠️ 这不是一个精确常量，是**经验值**
 *
 * `8` 来自 2026-11-04 的实测：本仓 117 个读实现源码的 spec 里，实参最长的
 * 跨行写法是 **8 行**（`executor-protocol-contract.spec.ts` 的 `path.join` 展开
 * 9 层参数后才出现 `executor.service.ts`）。
 *
 * **越界形态待观察**：实参跨 9 行以上会漏报（不会误报 —— 见下面的括号闭合条件）。
 * 若将来出现更长的写法，症状是「新 spec 读了实现源码但守卫没红」，那时把这个值
 * 调大的同时**必须补一条对应的 selftest**（否则就是凭感觉改魔法数）。
 * 不要把它读成「8 行以内一定命中、8 行以外一定不命中」的精确边界。
 */
const LOOKAHEAD = 8;

/**
 * 从 `line` 里的 `readFileSync(` / `readFile(` 起算，括号是否在本行内**配平**。
 *
 * 剥掉字符串字面量再数，避免 `"a(b"` 这种把括号数乱。找不到调用返回 `true`
 * （视为「本行自带完整实参」，不启用正向回溯 —— 方向安全：只会少报，不会误报）。
 */
function closesOnSameLine(line) {
  const at = Math.max(line.indexOf("readFileSync("), line.indexOf("readFile("));
  if (at < 0) return true;
  // 剥字符串（单/双/模板），保留括号
  let code = "";
  let q = null;
  for (let i = at; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; continue; }
    if (ch === "/" && line[i + 1] === "/") break; // 行尾注释不算
    code += ch;
  }
  let depth = 0;
  for (const ch of code) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  return depth <= 0;
}

export function looksLikeImplementationRead(lines, idx) {
  // 多行正向：只在调用未在本行闭合时，把后续行纳入同一窗口（A9-①）
  const multiline = !closesOnSameLine(lines[idx] ?? "");
  const forwardEnd = multiline ? Math.min(lines.length, idx + 1 + LOOKAHEAD) : idx + 1;
  const window = lines
    .slice(Math.max(0, idx - LOOKBACK), forwardEnd)
    .join("\n");
  // 明确排除：读 json / 日志 / 产出目录
  if (/readFileSync\([^)]*\.json/i.test(lines[idx] ?? "")) return false;
  const implLiteral = /\.(ts|tsx|css|py)['"]/.test(window);
  const hasMigration = /MIGRATION|\.sql['"]/.test(window);
  const hasSrcRoot =
    /SRC_ROOT|SRC_DIR|SRC_FILES|SERVICE_SRC|PY_EXECUTE_PATH|REPO_ROOT/.test(window);
  const hasDirname = /__dirname/.test(window);
  if (hasMigration && /\.sql['"]|\.ts['"]/.test(window)) return true;
  if (implLiteral && (hasDirname || hasSrcRoot)) return true;
  // 变量名本身就是源码路径（const SRC = readFileSync(p, "utf8") 之类的间接读）
  if (/const\s+SRC\s*=/.test(window) && /readFileSync/.test(window)) return true;
  // 间接形态：读的是**文件级常量**（`PAGE_PATH` / `EXECUTE_TS` / `MIGRATION_FILE`…），
  // 常量的定义在文件别处 ⇒ 单看窗口看不出来。故做**文件级**判定：
  // 若该文件任意位置定义了一个「指向源码后缀」的大写常量，且本行 readFileSync
  // 引用了「某个全大写标识符」，即视为读实现源码。
  // 为什么需要这一条：admin-web 的 UX/i18n 类 spec 普遍写成
  //   `const PAGE_PATH = resolve(__dirname, '../pages/TaskListPage.tsx')`
  //   `readFileSync(PAGE_PATH, 'utf-8')`
  // 只用窗口启发式会**漏掉一半**（实测 30 个里漏 15 个）。
  if (/readFileSync\(\s*[A-Z][A-Z0-9_]*\s*[,)]/.test(lines[idx] ?? "")) {
    return true;
  }
  return false;
}

/** 扫出「读了实现源码」的 spec 清单（相对仓库根，去重）。 */
export function discoverSourceTextReaders(repoRoot = REPO_ROOT) {
  const found = new Set();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      let text;
      try {
        text = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      if (!text.includes("readFileSync") && !text.includes("readFile(")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.includes("readFileSync") && !line.includes("readFile(")) {
          continue;
        }
        if (looksLikeImplementationRead(lines, i)) {
          found.add(toPosix(relative(repoRoot, file)));
          break; // 同一 spec 命中一次即可
        }
      }
    }
  }
  return [...found].sort();
}

// ───────────────────────────────────────────────────────────────────────────
// 判据
// ───────────────────────────────────────────────────────────────────────────

export function check({
  repoRoot = REPO_ROOT,
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")),
  today = todayISO(),
} = {}) {
  const failures = [];
  const notes = [];
  const entries = Array.isArray(registry.entries) ? registry.entries : [];

  if (entries.length === 0) {
    failures.push("登记表 entries 为空 —— 空登记表等于守卫被关灯");
  }

  // ── ① 结构与档位 ──
  const seenIds = new Set();
  for (const [i, e] of entries.entries()) {
    const tag = e?.id ?? `entries[${i}]`;
    for (const k of [
      "id",
      "tier",
      "spec",
      "specLine",
      "needle",
      "reads",
      "asserts",
      "disposition",
      "owner",
      "reviewBy",
    ]) {
      if (e?.[k] === undefined || e?.[k] === null || e?.[k] === "") {
        failures.push(`${tag} 缺必填字段 ${k}`);
      }
    }
    if (seenIds.has(e?.id)) failures.push(`${tag} id 重复`);
    seenIds.add(e?.id);
    if (e?.tier !== undefined && !TIERS.has(e.tier)) {
      failures.push(`${tag} tier=${e.tier} 不在 {P0,P1,P2} 内`);
    }
    if (e?.disposition !== undefined && !DISPOSITIONS.has(e.disposition)) {
      failures.push(
        `${tag} disposition=${e.disposition} 不在允许集合内（${[...DISPOSITIONS].join("/")}）`,
      );
    }
    // P0 + defer 允许（Lead 的档位表里 sop/audit 就是「P0 但本轮暂缓」），
    // 但必须写清「什么时候必须修」，否则 defer 就成了无限期豁免。
    if (
      e?.tier === "P0" &&
      e?.disposition === "defer" &&
      !String(e?.dispositionNote ?? "").trim()
    ) {
      failures.push(
        `${tag} 是 P0 却处置为 defer 且没写 dispositionNote —— P0+defer 必须说明「何时必须修」，否则 defer 是无限期豁免`,
      );
    }
    if (!Array.isArray(e?.reads) || (Array.isArray(e?.reads) && e.reads.length === 0)) {
      failures.push(`${tag} reads 必须是非空数组`);
    }
    if (
      e?.disposition === "keep-and-accept" &&
      !String(e?.dispositionNote ?? "").trim()
    ) {
      failures.push(`${tag} disposition=keep-and-accept 必须写 dispositionNote（说明为何接受）`);
    }
  }

  // ── ② 漂移：spec 文件存在 + needle 仍在附近 ──
  for (const e of entries) {
    if (isGlob(e.spec)) continue; // glob 条目在 ④ 里按覆盖关系校验
    const abs = join(repoRoot, e.spec);
    if (!existsSync(abs)) {
      failures.push(`${e.id} 登记的 spec 不存在：${e.spec}`);
      continue;
    }
    const lines = readFileSync(abs, "utf-8").split("\n");
    const center = Number(e.specLine);
    if (!Number.isInteger(center) || center < 1) {
      failures.push(`${e.id} specLine 不是正整数：${e.specLine}`);
      continue;
    }
    const lo = Math.max(0, center - 1 - NEEDLE_SEARCH_RADIUS);
    const hi = Math.min(lines.length, center - 1 + NEEDLE_SEARCH_RADIUS + 1);
    const window = lines.slice(lo, hi).join("\n");
    if (!window.includes(e.needle)) {
      failures.push(
        `${e.id} needle 在 ${e.spec}:${center} ±${NEEDLE_SEARCH_RADIUS} 行内找不到 —— ` +
          `spec 已漂走，请更新 specLine/needle（原文：${e.needle}）`,
      );
    }
  }

  // ── ③ 过期 ──
  for (const e of entries) {
    // d = reviewBy - today（正数 = 尚未到期）。⚠️ 方向别搞反：
    // 曾经写成 daysBetween(reviewBy, today)，于是「未来到期」被误报成「已到期」。
    const d = daysBetween(today, String(e.reviewBy));
    if (Number.isNaN(d)) {
      failures.push(`${e.id} reviewBy 不是合法 YYYY-MM-DD：${e.reviewBy}`);
      continue;
    }
    if (d < 0) {
      failures.push(
        `${e.id} reviewBy=${e.reviewBy} 已到期 ${-d} 天 —— ` +
          `要么处置掉（改 spec），要么重新签字（更新 reviewBy）`,
      );
    } else if (d <= 30) {
      notes.push(`${e.id} 距复查 ${e.reviewBy} 还有 ${d} 天`);
    }
  }

  // ── ⑥（R164）`reads` 的事实一致性：登记就是判据 ──
  //
  // ## 为什么需要这条（R163 只读审计的结论）
  //
  // `reads` 是本表里**唯一没有判据的必填字段** —— 判据①只查「非空数组」，
  // 而 `spec` 存在性（②）、`needle` 漂移（②）、`reviewBy` 过期（③）**都有判据**。
  // 后果实测（R163 审计）：**A 档 15 条**「`reads` 指向该 spec 根本不读的目标」
  // + **B 档 29 条**「spec 实际读了、但登记里漏了」。**登记与事实不一致 ⇒ 这张表
  // 就只是「有人填过」而不是「有人核过」。**
  //
  // ## 判据（双向，保守口径）
  //
  // 只从**含 `read(` / `readFileSync` 的行**里抽字符串字面量当作「spec 真读了什么」：
  //   · **正向**：每个 `reads` 条目必须在 spec 源码里**被提到**（子串）——
  //     否则「登记了一个它不读的文件」（A 档）；
  //   · **反向**：每处「读调用行」里的**源码路径字面量**必须**被某个 `reads` 条目覆盖**
  //     （条目以该字面量结尾，或字面量以条目结尾）—— 否则「读了但没登记」（B 档）。
  // 只认**源码扩展名**（`.ts/.tsx/.js/.mjs/.py/.json/.vue/.css`）的字面量，
  // 避免把「日志名 / 断言里的业务字符串」误判成路径。
  //
  // ⚠️ 保守面：只做**字面量级**匹配，不解析变量（`const f = 'a.ts'; read(f)` 抓不到）。
  // 这是**刻意的**：宁可漏报一部分，也不要制造一堆「猜路径」的假红。
  // **棘轮**：存量（R163 审计已确认的 20 个条目 / 53 条不一致）进基线文件，
  // **新增即红**，基线**只许变小**（条目修好之后要从基线里删掉，否则棘轮不紧）。
  // 为什么不「一次全修」：那 53 条要逐个读 spec 才能判断「它到底读了什么」，
  // 属于**人工判断**，不是机械替换；把它们变成一道永远红的墙只会让人绕过判据。
  // 为什么不「只报告」：只报告 = 没有牙，同类问题会继续增加（R163 审计已实测 44 条）。
  let readsBaseline = { entries: [] };
  try {
    readsBaseline = JSON.parse(readFileSync(join(repoRoot, READS_BASELINE_REL), "utf-8"));
  } catch {
    failures.push(
      `读不到 ${READS_BASELINE_REL} —— 判据⑥ 的基线必须存在（空基线也要有文件，` +
        `否则「读不到」会静默变成「没有存量」）。`,
    );
  }
  const baselineKeys = new Set((readsBaseline.entries ?? []).map(String));
  const seenKeys = new Set();
  const readsViolations = [];
  const SRC_EXT = /\.(?:tsx?|jsx?|mjs|cjs|py|json|vue|css)$/i;
  const literalsOnReadLines = (text) => {
    const out = new Set();
    for (const line of String(text).split("\n")) {
      if (!line.includes("read(") && !line.includes("readFileSync(") && !line.includes("readFile(")) continue;
      const quoted = line.match(/['"`]([^'"`\n]+)['"`]/g) ?? [];
      for (const q of quoted) {
        const lit = q.slice(1, -1).trim();
        if (!lit || lit.includes("node:")) continue;
        if (!SRC_EXT.test(lit)) continue;
        out.add(lit);
      }
    }
    return out;
  };
  for (const e of entries) {
    if (isGlob(e.spec)) continue;
    const abs = join(repoRoot, e.spec);
    if (!existsSync(abs)) continue; // ② 已报「spec 不存在」
    const text = readFileSync(abs, "utf-8");
    const reads = Array.isArray(e.reads) ? e.reads.map(String) : [];
    // 正向：登记的每个 reads 都要在 spec 里被提到
    for (const rel of reads) {
      if (isGlob(rel)) continue; // glob 条目交给其它判据
      const tail = rel.split("/").slice(-2).join("/");
      if (!text.includes(rel) && !text.includes(tail) && !text.includes(rel.split("/").pop())) {
        readsViolations.push(
          `${e.id} reads 登记了「${rel}」，但 ${e.spec} 里**从未提到**它 —— ` +
            `登记的读取面与事实不一致（要么它读的是别的文件，要么这条 reads 是抄来的）。` +
            `修法：按 spec 里真实的 read(...) 调用改正 reads；若该 spec 根本不读源码文本，` +
            `整条登记都该复核。`,
        );
      }
    }
    // 反向：读调用行上的源码字面量必须被某个 reads 覆盖
    for (const lit of literalsOnReadLines(text)) {
      const covered = reads.some((rel) => rel === lit || rel.endsWith(lit) || lit.endsWith(rel));
      if (!covered) {
        readsViolations.push(
          `${e.id} 在 ${e.spec} 里读了「${lit}」，但它**不在** reads 里 —— ` +
            `漏登记会让「这个 spec 的读取面」被低估（外提/搬迁时没人知道要同步它）。` +
            `修法：把该文件补进 reads（若它是拼接读取的一部分，补**全部**文件）。`,
        );
      }
    }
  }

  for (const msg of readsViolations) {
    const id = (msg.match(/^(STC-\d+)/) ?? [])[1] ?? "";
    if (id && baselineKeys.has(id)) {
      seenKeys.add(id);
      continue; // 存量：已知债，不判红（但会被下面的「基线收紧」提示）
    }
    failures.push(msg + "（**新增**：不在判据⑥ 基线里 ⇒ 必须就地修，不要往基线里加）");
  }
  for (const id of baselineKeys) {
    if (!seenKeys.has(id)) {
      notes.push(
        `判据⑥ 基线里的 ${id} 已经不再违规 —— **请从 ${READS_BASELINE_REL} 删掉它**（棘轮只许变小）`,
      );
    }
  }

  // ── ④ 新增即红：未登记的「读实现源码」spec ──
  const exact = new Set(
    entries.filter((e) => !isGlob(e.spec)).map((e) => toPosix(e.spec)),
  );
  const globs = entries.filter((e) => isGlob(e.spec)).map((e) => globToRegExp(e.spec));
  // coverageBacklog：机器扫描发现但**尚未逐条甄别**的已知项。登记它们不是豁免，
  // 而是「把棘轮的起始线划在真实分布上」——新出现的未登记项仍然红，且 backlog
  // 自身也会按 reviewBy 到期（到期未甄别即红）。
  const backlog = Array.isArray(registry.coverageBacklog)
    ? registry.coverageBacklog
    : [];
  const backlogSpecs = new Set(backlog.map((b) => toPosix(b.spec)));
  for (const b of backlog) {
    if (!b?.owner || !b?.reviewBy) {
      failures.push(`coverageBacklog ${b?.spec ?? "?"} 缺 owner/reviewBy`);
      continue;
    }
    const bd = daysBetween(today, String(b.reviewBy));
    if (Number.isNaN(bd)) {
      failures.push(`coverageBacklog ${b.spec} 的 reviewBy 非法：${b.reviewBy}`);
    } else if (bd < 0) {
      failures.push(
        `coverageBacklog ${b.spec} 的 reviewBy=${b.reviewBy} 已到期 ${-bd} 天 —— ` +
          `必须逐条甄别并归入 entries（或判定非源文本契约后移出）`,
      );
    }
  }
  const discovered = discoverSourceTextReaders(repoRoot);
  const unregistered = discovered.filter(
    (f) => !exact.has(f) && !globs.some((re) => re.test(f)) && !backlogSpecs.has(f),
  );
  for (const f of unregistered) {
    failures.push(
      `${f} 读了实现源码文本但**未登记** —— 在 scripts/source-text-contracts.json 里加一条` +
        `（含 specLine + needle + 档位 + 处置）；这条断言会让重构静默变脆，必须显式签字`,
    );
  }

  return {
    failures,
    notes,
    entries,
    discovered,
    unregistered,
    stats: {
      total: entries.length,
      p0: entries.filter((e) => e.tier === "P0").length,
      p1: entries.filter((e) => e.tier === "P1").length,
      p2: entries.filter((e) => e.tier === "P2").length,
      discovered: discovered.length,
      backlog: backlog.length,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 第二登记表：**守卫侧**（scripts/check-*.mjs 读实现源码）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 二分档的**允许处置**（比 spec 侧窄：守卫的"修法"只有三种现实形态）。
 */
const GUARD_DISPOSITIONS = new Set([
  "fix-before-B4",
  "keep-and-accept",
  "keep-accept-and-whitelist",
]);

/**
 * 校验 `scripts/guard-source-text-contracts.json`。
 *
 * 判据（与 spec 侧同构，但**不重扫**守卫脚本 —— 见 GUARD_REGISTRY_PATH 头注）：
 *   ① 结构：entries 非空；每条 id/tier/spec/specLine/reads/asserts/disposition/owner/reviewBy 齐；
 *      tier ∈ {P0,P1,P2}；disposition ∈ 三选一；id 不重复；
 *      `keep-and-accept` / `keep-accept-and-whitelist` 必须写 dispositionNote（否则"接受"是空话）；
 *   ② 漂移：登记的 spec（守卫脚本）必须存在；
 *   ③ 过期：reviewBy 非法或已过期 ⇒ 红（到期没人重审 = 这张表已经没人看）；
 *   ④ 回收：backlog 里的脚本**若已出现在 entries 里** ⇒ 红（登记重复；
 *      否则同一条债会在两处各有一份状态，必然有一处先腐烂）；
 *   ⑤ backlog 自身：缺 owner/reviewBy 或过期 ⇒ 红。
 *
 * @returns {{failures: string[], notes: string[], stats: object}}
 */
export function checkGuardRegistry({
  repoRoot = REPO_ROOT,
  registry = JSON.parse(readFileSync(GUARD_REGISTRY_PATH, "utf-8")),
  today = todayISO(),
} = {}) {
  const failures = [];
  const notes = [];
  const entries = Array.isArray(registry?.entries) ? registry.entries : [];
  const backlog = Array.isArray(registry?.coverageBacklog) ? registry.coverageBacklog : [];

  if (entries.length === 0) {
    failures.push(`${GUARD_REGISTRY_PATH} 的 entries 为空 —— 空登记表等于这条判据被关灯`);
  }

  // ① 结构
  const seenIds = new Set();
  const entrySpecs = new Set();
  for (const [i, e] of entries.entries()) {
    const tag = e?.id ?? `entries[${i}]`;
    for (const k of ["id", "tier", "spec", "specLine", "reads", "asserts", "disposition", "owner", "reviewBy"]) {
      if (e?.[k] === undefined || e?.[k] === null || e?.[k] === "") {
        failures.push(`${tag} 缺必填字段 ${k}`);
      }
    }
    if (seenIds.has(e?.id)) failures.push(`${tag} id 重复`);
    seenIds.add(e?.id);
    if (e?.spec) entrySpecs.add(toPosix(e.spec));
    if (e?.tier !== undefined && !TIERS.has(e.tier)) {
      failures.push(`${tag} tier=${e.tier} 不在 {P0,P1,P2} 内`);
    }
    if (e?.disposition !== undefined && !GUARD_DISPOSITIONS.has(e.disposition)) {
      failures.push(
        `${tag} disposition=${e.disposition} 不在守卫侧允许集合内（${[...GUARD_DISPOSITIONS].join("/")}）`,
      );
    }
    if (
      (e?.disposition === "keep-and-accept" || e?.disposition === "keep-accept-and-whitelist") &&
      !String(e?.dispositionNote ?? "").trim()
    ) {
      failures.push(`${tag} disposition=${e.disposition} 必须写 dispositionNote（说明「为什么这个读法正当」）`);
    }
    if (!Array.isArray(e?.reads) || e.reads.length === 0) {
      failures.push(`${tag} reads 必须是非空数组`);
    }
  }
  // 表级 owner / reviewBy
  if (!registry?.owner) failures.push(`${GUARD_REGISTRY_PATH} 缺表级 owner`);
  const tableD = daysBetween(today, String(registry?.reviewBy));
  if (Number.isNaN(tableD)) {
    failures.push(`${GUARD_REGISTRY_PATH} 表级 reviewBy 不是合法 YYYY-MM-DD：${registry?.reviewBy}`);
  } else if (tableD < 0) {
    failures.push(`${GUARD_REGISTRY_PATH} 表级 reviewBy=${registry?.reviewBy} 已到期 ${-tableD} 天`);
  }

  // ② 漂移 + ③ 过期
  for (const e of entries) {
    if (typeof e?.spec === "string" && e.spec && !existsSync(join(repoRoot, e.spec))) {
      failures.push(`${e.id} 登记的守卫脚本不存在：${e.spec}（被改名/删除了？更新登记或移出）`);
    }
    const d = daysBetween(today, String(e?.reviewBy));
    if (Number.isNaN(d)) {
      failures.push(`${e.id} reviewBy 不是合法 YYYY-MM-DD：${e.reviewBy}`);
    } else if (d < 0) {
      failures.push(
        `${e.id} reviewBy=${e.reviewBy} 已到期 ${-d} 天 —— 要么处置掉，要么重新签字（更新 reviewBy）`,
      );
    } else if (d <= 30) {
      notes.push(`${e.id} 距复查 ${e.reviewBy} 还有 ${d} 天`);
    }
  }

  // ④ 回收：backlog 与 entries 不许重复登记同一条
  for (const b of backlog) {
    const spec = toPosix(b?.spec ?? "");
    if (spec && entrySpecs.has(spec)) {
      failures.push(
        `coverageBacklog 里的 ${spec} 已出现在 entries 中 —— 重复登记（同一条债两处状态，必然有一处先腐烂），删掉 backlog 那条`,
      );
    }
    if (!b?.owner || !b?.reviewBy) {
      failures.push(`coverageBacklog ${b?.spec ?? "?"} 缺 owner/reviewBy`);
      continue;
    }
    const bd = daysBetween(today, String(b.reviewBy));
    if (Number.isNaN(bd)) {
      failures.push(`coverageBacklog ${b.spec} 的 reviewBy 非法：${b.reviewBy}`);
    } else if (bd < 0) {
      failures.push(
        `coverageBacklog ${b.spec} 的 reviewBy=${b.reviewBy} 已到期 ${-bd} 天 —— 必须逐条深审并归入 entries`,
      );
    }
  }

  return {
    failures,
    notes,
    entries,
    stats: {
      total: entries.length,
      p0: entries.filter((e) => e.tier === "P0").length,
      p1: entries.filter((e) => e.tier === "P1").length,
      p2: entries.filter((e) => e.tier === "P2").length,
      backlog: backlog.length,
      owner: registry?.owner,
      reviewBy: registry?.reviewBy,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 输出
// ───────────────────────────────────────────────────────────────────────────

/**
 * **生成器**：从机器扫描产出 entries 的**骨架**（人工只做分档与处置决策）。
 *
 * ## 为什么 entries 的生成来源必须是机器而不是人
 *
 * 首轮实测：人工清点 12 处、机器扫描 30 处 ⇒ **人工漏了 80%**。
 * 若 entries 是人工挑的子集，那么「没登记」与「不存在」在表里**长得一样**
 * ⇒ 下一个人会以为没登记的地方没有约束（这正是「零清单包从判据里消失」的
 * 同一个错误模式）。⇒ 表与判据面必须**恒等**：表 = 扫描全集。
 *
 * ## 生成的字段 vs 人工填的字段
 *
 * 生成器负责（**机器事实**，不该由人抄）：
 *   · `spec`（哪个 spec）/ `specLine`（读源码的那一行）/ `needle`（该行文本）
 *   · `reads`（读的是哪些实现文件，能静态推出的部分）
 *   · `triageStatus: "needs-decision"` ← **未分档 ⇒ 守卫红**
 *
 * 人工负责（**决策**，机器推不出）：
 *   · `tier`（P0/P1/P2）/ `disposition`（五种处置之一）/ `dispositionNote`
 *   · `asserts`（断言对象是什么——需读代码才知道）
 *
 * ## 误报怎么办：显式豁免，不是"不登记"
 *
 * 扫描启发式可能把「读数据（json/log/产出）」误判成「读实现源码」。这类误报
 * **必须显式标记** `triageStatus: "not-a-source-text-contract"` + `reason`，
 * 然后**留在表里**——不许靠"不登记它"来隐藏（那正是本生成器要消灭的模式）。
 *
 * ## 用法
 *
 *   node scripts/check-source-text-contracts.mjs --generate            # 打印 JSON 骨架
 *   node scripts/check-source-text-contracts.mjs --generate --write    # 写回登记表
 *
 * `--write` 的语义是**合并**（不是覆盖）：已有人工填好的字段（tier/disposition/
 * asserts/reads 的完整版）**保留**，只补齐缺失的机器字段与新增的 needs-decision 条目。
 */
export function generateEntries({
  repoRoot = REPO_ROOT,
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")),
} = {}) {
  const existing = new Map(
    (registry.entries ?? []).map((e) => [toPosix(e.spec), e]),
  );
  const discovered = discoverSourceTextReaders(repoRoot);
  const generated = [];

  for (const spec of discovered) {
    const abs = join(repoRoot, spec);
    const lines = readFileSync(abs, "utf-8").split("\n");
    // 定位「读实现源码」的那一行（第一处命中）
    let specLine = 1;
    let needle = "";
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes("readFileSync") && !line.includes("readFile(")) continue;
      if (!looksLikeImplementationRead(lines, i)) continue;
      specLine = i + 1;
      needle = line.trim().slice(0, 120);
      break;
    }
    const prev = existing.get(spec);
    if (prev) {
      // 人工已填的决策字段一律保留；只补机器字段（若缺）
      generated.push({
        ...prev,
        spec,
        specLine: prev.specLine ?? specLine,
        needle: prev.needle ?? needle,
        triageStatus: prev.triageStatus ?? "triaged",
      });
      continue;
    }
    generated.push({
      id: `STC-${String(generated.length + 1).padStart(3, "0")}`,
      tier: null,
      spec,
      specLine,
      needle,
      reads: [],
      asserts: null,
      disposition: null,
      owner: "arch-core",
      reviewBy: registry.reviewBy,
      triageStatus: "needs-decision",
    });
  }
  return generated;
}

/**
 * 把生成的骨架合并回登记表（保留人工字段）。
 *
 * ## 语义是**并集**，不是覆盖（这一条踩过坑）
 *
 * 初版写成「以 generated 为准」⇒ 首跑把 **4 条人工已验证、但扫描器漏报**的
 * 条目静默丢掉了（`protocol-version-consistency` / `execution-list-projection` /
 * `application.service` / `response-stream-error-listener`——它们把路径拼在
 * **变量**里（`readFileSync(path.join(repoRoot, relative))`），窗口启发式看不见
 * 源码后缀字面量 ⇒ 漏报）。
 *
 * 丢掉它们正是本守卫要消灭的那个模式：**「从判据里消失」**。所以合并必须是：
 *
 *   `entries = 扫描发现的 ∪ 人工已登记的`
 *
 * 并且给「人工有、扫描没有」的条目打 `scannerDiscovered: false` —— 这不是豁免，
 * 而是**记录扫描器的假阴性**（将来扫描器改好了，这些标记会自然消失，可据此
 * 反过来验证扫描器是否变强）。反向（扫描有、人工没分档）仍由
 * `triageStatus: "needs-decision"` 兜住。
 */
export function mergeGenerated(registry, generated) {
  const prev = new Map(
    (registry.entries ?? []).map((e) => [toPosix(e.spec), e]),
  );
  const merged = [];
  const seen = new Set();

  // ① 扫描发现的部分：人工字段优先（人填的决策不被生成器覆盖）
  for (const g of generated) {
    seen.add(toPosix(g.spec));
    const old = prev.get(toPosix(g.spec));
    if (!old) {
      merged.push({ ...g, scannerDiscovered: true });
      continue;
    }
    merged.push({
      ...g,
      ...old,
      tier: old.tier ?? g.tier,
      disposition: old.disposition ?? g.disposition,
      asserts: old.asserts ?? g.asserts,
      reads: old.reads?.length ? old.reads : g.reads,
      dispositionNote: old.dispositionNote,
      triageStatus: old.triageStatus ?? g.triageStatus,
      scannerDiscovered: true,
    });
  }

  // ② 人工已登记、但本次扫描没发现的：**保留**，并标记扫描器假阴性
  for (const [spec, old] of prev) {
    if (seen.has(spec)) continue;
    if (spec.includes("*")) continue; // glob 汇总条目由调用方单独处理
    merged.push({ ...old, scannerDiscovered: false });
  }

  merged.sort((a, b) => String(a.spec).localeCompare(String(b.spec)));
  return { ...registry, entries: merged };
}

function printReport(registry, result) {
  const { stats, notes } = result;
  console.log("\n源码文本契约登记表（scripts/source-text-contracts.json）");
  console.log(`  owner=${registry.owner}  reviewBy=${registry.reviewBy}`);
  console.log(
    `  共 ${stats.total} 条：P0=${stats.p0} / P1=${stats.p1} / P2=${stats.p2}` +
      `  ｜ 扫描发现 ${stats.discovered} 个读实现源码的 spec（其中 ${stats.backlog} 条待甄别）`,
  );
  for (const tier of ["P0", "P1", "P2"]) {
    const group = result.entries.filter((e) => e.tier === tier);
    if (group.length === 0) continue;
    console.log(`\n── ${tier}（${group.length}）──`);
    for (const e of group) {
      console.log(`  ${e.id}  ${e.spec}:${e.specLine}`);
      console.log(`        reads   : ${(e.reads ?? []).join(", ")}`);
      console.log(`        断言     : ${String(e.asserts ?? "").slice(0, 96)}`);
      console.log(`        处置     : ${e.disposition}  reviewBy=${e.reviewBy}`);
    }
  }
  if (notes.length > 0) {
    console.log("\n近期到期提醒：");
    for (const n of notes) console.log(`  · ${n}`);
  }
  console.log("");
}

function selftest() {
  const results = [];
  const ok = (name, fn) => {
    try {
      fn();
      results.push([true, name]);
    } catch (err) {
      results.push([false, `${name} —— ${err.message}`]);
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  const base = (over = {}) => ({
    id: "T-1",
    tier: "P0",
    spec: "apps/admin-api/src/modules/executor/__tests__/protocol-version-consistency.spec.ts",
    specLine: 59,
    needle: 'readFileSync(path.join(repoRoot, relative), "utf-8")',
    reads: ["apps/admin-api/src/modules/executor/executor.service.ts"],
    asserts: "x",
    disposition: "keep-and-accept",
    dispositionNote: "理由",
    owner: "arch-core",
    reviewBy: "2999-01-01",
    ...over,
  });
  const runCheck = (entries, extra = {}) =>
    check({
      registry: { owner: "arch-core", reviewBy: "2999-01-01", entries },
      today: "2026-11-04",
      ...extra,
    });
  const realEntries = JSON.parse(
    readFileSync(REGISTRY_PATH, "utf-8"),
  ).entries;

  ok("① 真实登记表通过（含漂移/覆盖/backlog 判据）", () => {
    const r = check({ today: "2026-11-04" });
    assert(
      r.failures.length === 0,
      `期望 0 失败，实得 ${r.failures.length}：${r.failures.slice(0, 3).join(" ｜ ")}`,
    );
  });

  ok("② 空 entries ⇒ 红", () => {
    assert(runCheck([]).failures.some((f) => f.includes("空登记表")), "应报空登记表");
  });

  ok("③ 缺必填字段 ⇒ 红", () => {
    const r = runCheck([{ ...base(), asserts: "" }]);
    assert(r.failures.some((f) => f.includes("缺必填字段 asserts")), "应报缺字段");
  });

  ok("④ 非法 tier ⇒ 红", () => {
    assert(
      runCheck([base({ tier: "P9" })]).failures.some((f) => f.includes("tier=P9")),
      "应报非法 tier",
    );
  });

  ok("⑤ 非法 disposition ⇒ 红", () => {
    assert(
      runCheck([base({ disposition: "whatever" })]).failures.some((f) =>
        f.includes("disposition=whatever"),
      ),
      "应报非法 disposition",
    );
  });

  ok("⑥ P0 + defer 且无说明 ⇒ 红（defer 不是无限期豁免）", () => {
    assert(
      runCheck([base({ disposition: "defer", dispositionNote: "" })]).failures.some(
        (f) => f.includes("P0+defer 必须说明"),
      ),
      "应报 P0+defer 缺说明",
    );
  });

  ok("⑦ keep-and-accept 缺理由 ⇒ 红", () => {
    assert(
      runCheck([base({ dispositionNote: "" })]).failures.some((f) =>
        f.includes("必须写 dispositionNote"),
      ),
      "应报缺理由",
    );
  });

  ok("⑧ spec 文件不存在 ⇒ 红", () => {
    assert(
      runCheck([base({ spec: "apps/nope/none.spec.ts" })]).failures.some((f) =>
        f.includes("登记的 spec 不存在"),
      ),
      "应报 spec 不存在",
    );
  });

  ok("⑨ needle 漂走 ⇒ 红", () => {
    assert(
      runCheck([base({ needle: "THIS_NEEDLE_DOES_NOT_EXIST" })]).failures.some(
        (f) => f.includes("needle 在"),
      ),
      "应报 needle 漂移",
    );
  });

  ok("⑩ reviewBy 已过期 ⇒ 红", () => {
    assert(
      runCheck([base({ reviewBy: "2020-01-01" })]).failures.some((f) =>
        f.includes("已到期"),
      ),
      "应报过期",
    );
  });

  ok("⑪ reviewBy 非法日期 ⇒ 红", () => {
    assert(
      runCheck([base({ reviewBy: "not-a-date" })]).failures.some((f) =>
        f.includes("不是合法 YYYY-MM-DD"),
      ),
      "应报非法日期",
    );
  });

  ok("⑫ id 重复 ⇒ 红", () => {
    assert(
      runCheck([base(), base()]).failures.some((f) => f.includes("id 重复")),
      "应报 id 重复",
    );
  });

  ok("⑬ reads 为空数组 ⇒ 红", () => {
    assert(
      runCheck([base({ reads: [] })]).failures.some((f) =>
        f.includes("reads 必须是非空数组"),
      ),
      "应报 reads 为空",
    );
  });

  ok("⑭ 未登记的读源码 spec ⇒ 红（棘轮）", () => {
    // 用真实登记表但把 entries 换成只留一条无关条目 ⇒ 其余应全部报未登记
    const r = runCheck([base()], {});
    assert(
      r.failures.some((f) => f.includes("未登记")),
      "应报未登记的读源码 spec",
    );
  });

  ok("⑮ glob 条目能覆盖迁移 spec（不被误报未登记）", () => {
    const r = check({ today: "2026-11-04" });
    const mig = r.entries.find((e) => e.tier === "P2");
    assert(mig !== undefined, "登记表应有 P2 迁移类条目");
    assert(
      !r.unregistered.some((f) => f.includes("/migrations/")),
      `迁移 spec 不应被报未登记：${r.unregistered.filter((f) => f.includes("migrations")).slice(0, 2)}`,
    );
  });

  ok("⑯ 启发式：读 json 不算读实现源码", () => {
    const lines = ['const x = readFileSync(path.join(__dirname, "openapi.json"), "utf-8");'];
    assert(looksLikeImplementationRead(lines, 0) === false, "读 json 不应算实现源码");
  });

  ok("⑰ 启发式：__dirname + .ts 字面量算读实现源码", () => {
    const lines = ['const src = readFileSync(path.join(__dirname, "auth.ts"), "utf-8");'];
    assert(looksLikeImplementationRead(lines, 0) === true, "读 auth.ts 应算实现源码");
  });

  // ── A9-①：多行**正向**写法（2026-11-04 补的盲区）──────────────────
  //
  // 旧实现只往前看 LOOKBACK 行 ⇒ `readFileSync(` 换行后才出现 `.ts` 的写法**整个漏掉**。
  // 这组用例钉三件事：① 正向能命中；② 不误报 json；③ 括号已闭合时不启用正向回溯
  // （否则会把「下一句无关代码里的 .ts」算进来 ⇒ 误报）。

  ok("⑲ 【A9-①·正向】多行写法：readFileSync( 换行后才是 .ts ⇒ 必须命中", () => {
    const lines = [
      "const facadeSrc = readFileSync(",
      '  join(__dirname, "..", "task.service.ts"),',
      '  "utf-8",',
      ");",
    ];
    assert(
      looksLikeImplementationRead(lines, 0) === true,
      "多行正向写法应算读实现源码（旧实现正是在这里漏报）",
    );
  });

  ok("⑳ 【A9-①·反证】多行写法但目标是 json ⇒ 不命中（正向回溯不是「往后看到 .ts 就算」）", () => {
    const lines = [
      "const data = readFileSync(",
      '  join(__dirname, "..", "fixtures", "openapi.ts.json"),',
      '  "utf-8",',
      ");",
    ];
    assert(
      looksLikeImplementationRead(lines, 0) === false,
      "多行但读 json 不应算读实现源码",
    );
  });

  ok("㉑ 【A9-①·反证】括号已在本行闭合 ⇒ 不启用正向回溯（防误报下一句）", () => {
    const lines = [
      'const a = readFileSync(join(__dirname, "data.json"), "utf-8");',
      'const b = join(__dirname, "impl.ts"); // 下一句的 .ts 不该被算进来',
    ];
    assert(
      looksLikeImplementationRead(lines, 0) === false,
      "括号已闭合时不该往后看（否则下一句的 .ts 会造成误报）",
    );
  });

  ok("㉒ 【A9-①·正向】跨 8 行的超长多行写法也必须命中（LOOKAHEAD 边界内）", () => {
    const lines = [
      "const svcSource = fs.readFileSync(",
      "  path.join(",
      "    findRepoRoot(__dirname),",
      '    "apps",',
      '    "admin-api",',
      '    "src",',
      '    "modules",',
      '    "executor",',
      '    "executor.service.ts",', // 第 9 行（idx+8）—— 正好在 LOOKAHEAD 边界上
      "  ),",
      '  "utf-8",',
      ");",
    ];
    assert(
      looksLikeImplementationRead(lines, 0) === true,
      "超长多行写法（8 行内出现 .ts 效果）应命中",
    );
  });

  ok("㉓a 【A9-①·端到端有牙】fixture 树里塞一条多行正向写法 ⇒ 守卫必须红（未登记）", () => {
    const repo = makeFixtureRepo(
      {
        "apps/x/__tests__/multi-line.spec.ts": [
          'import { readFileSync } from "node:fs";',
          'import { join } from "node:path";',
          "it('x', () => {",
          "  const src = readFileSync(",
          '    join(__dirname, "..", "impl.service.ts"),',
          '    "utf-8",',
          "  );",
          "  expect(src).toBeTruthy();",
          "});",
          "",
        ].join("\n"),
      },
      { prefix: "stc-lookahead-" },
    );
    try {
      // ① 扫描器必须发现它（旧实现漏报 ⇒ 这一步就会失败）
      const found = discoverSourceTextReaders(repo.dir);
      assert(
        found.some((f) => f.includes("multi-line.spec.ts")),
        `多行正向写法必须被扫描器发现（旧实现整类漏报），实得 ${JSON.stringify(found)}`,
      );
      // ② 登记表里没有它 ⇒ 守卫必须红
      const r = check({
        repoRoot: repo.dir,
        registry: { owner: "t", reviewBy: "2999-01-01", entries: [] },
        today: "2026-11-04",
      });
      assert(
        r.failures.some((f) => f.includes("未登记") && f.includes("multi-line.spec.ts")),
        `未登记的多行正向 spec 必须判红，实得 ${JSON.stringify(r.failures.slice(0, 2))}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("⑱ coverageBacklog 到期 ⇒ 红（backlog 不是永久豁免）", () => {
    const reg = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    const withExpired = {
      ...reg,
      coverageBacklog: [
        { spec: "x.spec.ts", owner: "arch-core", reviewBy: "2020-01-01" },
      ],
    };
    const r = check({ registry: withExpired, today: "2026-11-04" });
    assert(
      r.failures.some((f) => f.includes("coverageBacklog") && f.includes("已到期")),
      "应报 backlog 到期",
    );
  });

  ok("⑲ coverageBacklog 缺 owner/reviewBy ⇒ 红", () => {
    const reg = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    const r = check({
      registry: { ...reg, coverageBacklog: [{ spec: "x.spec.ts" }] },
      today: "2026-11-04",
    });
    assert(
      r.failures.some((f) => f.includes("缺 owner/reviewBy")),
      "应报 backlog 缺字段",
    );
  });

  // ── 第二登记表（守卫侧）的用例 ⑳–㉖ + 双向隔离 ㉗㉘ ──────────────────────────────────
  //
  // 隔离是**双向**验证的（arch-core 2026-11-04 建议）：只坏一侧 ⇒ 另一侧必须仍然绿。
  // 单向只能证明「我的红不污染你」，双向才证明「两侧真的独立」。
  const gbase = (over = {}) => ({
    id: "G-1",
    tier: "P2",
    spec: "scripts/check-conditional-writes.mjs",
    specLine: 572,
    needle: "readText",
    reads: ["apps/admin-api/src/**/*.ts"],
    asserts: "x",
    disposition: "keep-and-accept",
    dispositionNote: "判据对象即文本形态",
    owner: "guard-smith",
    reviewBy: "2999-01-01",
    ...over,
  });
  const runGuardCheck = (entries, extra = {}) =>
    checkGuardRegistry({
      registry: { owner: "guard-smith", reviewBy: "2999-01-01", entries, coverageBacklog: [] },
      today: "2026-11-04",
      ...extra,
    });

  ok("⑳ 真实守卫侧登记表通过（结构/漂移/过期/回收全部满足）", () => {
    const r = checkGuardRegistry({ today: "2026-11-04" });
    assert(
      r.failures.length === 0,
      `期望 0 失败，实得 ${r.failures.length}：${r.failures.slice(0, 3).join(" ｜ ")}`,
    );
    assert(r.stats.total > 0, "entries 不应为空");
  });

  ok("㉑ 守卫侧空 entries ⇒ 红", () => {
    assert(
      runGuardCheck([]).failures.some((f) => f.includes("entries 为空")),
      "应报空登记表",
    );
  });

  ok("㉒ 守卫侧 disposition 用 spec 侧词表（fix-before-B5）⇒ 红（词表刻意不共用）", () => {
    assert(
      runGuardCheck([gbase({ disposition: "fix-before-B5" })]).failures.some((f) =>
        f.includes("不在守卫侧允许集合内"),
      ),
      "应报词表不共用",
    );
  });

  ok("㉓ 守卫侧 keep-and-accept 缺 dispositionNote ⇒ 红（「接受」必须给理由）", () => {
    assert(
      runGuardCheck([gbase({ dispositionNote: "" })]).failures.some((f) =>
        f.includes("必须写 dispositionNote"),
      ),
      "应报缺理由",
    );
  });

  ok("㉔ 守卫侧登记的脚本不存在 ⇒ 红（漂移）", () => {
    assert(
      runGuardCheck([gbase({ spec: "scripts/check-gone-forever.mjs" })]).failures.some((f) =>
        f.includes("守卫脚本不存在"),
      ),
      "应报漂移",
    );
  });

  ok("㉕ 守卫侧 reviewBy 已过期 ⇒ 红", () => {
    assert(
      runGuardCheck([gbase({ reviewBy: "2000-01-01" })]).failures.some((f) =>
        f.includes("已到期"),
      ),
      "应报过期",
    );
  });

  ok("㉖ 同一条债既在 entries 又在 backlog ⇒ 红（重复登记必然有一处先腐烂）", () => {
    const r = checkGuardRegistry({
      registry: {
        owner: "guard-smith",
        reviewBy: "2999-01-01",
        entries: [gbase()],
        coverageBacklog: [
          { id: "B-1", spec: "scripts/check-conditional-writes.mjs", owner: "guard-smith", reviewBy: "2999-01-01" },
        ],
      },
      today: "2026-11-04",
    });
    assert(r.failures.some((f) => f.includes("重复登记")), "应报重复登记");
  });

  // ── 双向隔离：只坏一侧 ⇒ 另一侧仍绿 ────────────────────────────────
  ok("㉗ 【隔离·正向】只坏 spec 侧 ⇒ 守卫侧仍绿", () => {
    const specSide = runCheck([{ ...base(), asserts: "" }]);
    const guardSide = checkGuardRegistry({ today: "2026-11-04" });
    assert(specSide.failures.length > 0, "spec 侧应红");
    assert(guardSide.failures.length === 0, `守卫侧不该被牵连，实得 ${guardSide.failures.length} 项`);
  });

  ok("㉘ 【隔离·反向】只坏守卫侧 ⇒ spec 侧仍绿", () => {
    const specSide = check({ today: "2026-11-04" });
    const guardSide = runGuardCheck([gbase({ disposition: "fix-before-B5" })]);
    assert(guardSide.failures.length > 0, "守卫侧应红");
    assert(specSide.failures.length === 0, `spec 侧不该被牵连，实得 ${specSide.failures.length} 项`);
  });

  ok("㉙ mergeGenerated 是**并集**：扫描未发现的已登记条目不被丢弃", () => {
    // 反证：初版写成「以 generated 为准」⇒ 首跑静默丢掉 4 条人工已验证的条目
    // （路径拼在变量里 ⇒ 扫描器假阴性）。这条钉住并集语义。
    const manualOnly = {
      id: "M-1",
      tier: "P0",
      spec: "apps/admin-api/src/modules/executor/__tests__/protocol-version-consistency.spec.ts",
      specLine: 59,
      needle: 'readFileSync(path.join(repoRoot, relative), "utf-8")',
      reads: ["apps/admin-api/src/modules/executor/executor.service.ts"],
      asserts: "x",
      disposition: "keep-and-accept",
      dispositionNote: "y",
      owner: "arch-core",
      reviewBy: "2999-01-01",
    };
    const merged = mergeGenerated({ entries: [manualOnly] }, []);
    assert(merged.entries.length === 1, `期望保留 1 条，实得 ${merged.entries.length}`);
    assert(
      merged.entries[0].scannerDiscovered === false,
      "扫描未发现的条目应标 scannerDiscovered:false（记录假阴性，不是豁免）",
    );
  });

  ok("㉚ mergeGenerated：生成项与人工项重合时**人工字段优先**", () => {
    const manual = {
      id: "M-1",
      tier: "P0",
      spec: "apps/x.spec.ts",
      specLine: 1,
      needle: "n",
      reads: ["a.ts"],
      asserts: "人类写的断言",
      disposition: "fix-before-B4",
      dispositionNote: "人类理由",
      owner: "arch-core",
      reviewBy: "2999-01-01",
    };
    const generated = [
      { id: "G-1", tier: null, spec: "apps/x.spec.ts", specLine: 9, needle: "n2",
        reads: [], asserts: null, disposition: null, owner: "arch-core",
        reviewBy: "2999-01-01", triageStatus: "needs-decision" },
    ];
    const merged = mergeGenerated({ entries: [manual] }, generated);
    assert(merged.entries.length === 1, "重合项不应重复");
    assert(merged.entries[0].tier === "P0", "人工 tier 应优先");
    assert(merged.entries[0].disposition === "fix-before-B4", "人工 disposition 应优先");
    assert(merged.entries[0].asserts === "人类写的断言", "人工 asserts 应优先");
    assert(merged.entries[0].scannerDiscovered === true, "被扫描发现应标 true");
  });

  // ── ㉛–㊱ 黑盒 CLI 夹具（R148）────────────────────────────────────────────
  //
  // 上面 ①–㉚ 全部是**进程内**调用（`check({registry})` / `checkGuardRegistry({registry})`），
  // 它们测的是**判据函数**。这一段测的是**守卫**：spawn 真脚本、只给 `--root=<夹具>`。
  //
  // 分开的理由不是洁癖：`applyRoot()` 是**唯一**把两张登记表切到 `<root>` 的地方，
  // 而 ①–㉚ 一条都碰不到它。把 `applyRoot` 里那两行删掉，30 条用例**全部照绿**，
  // 而夹具会**静默读真仓库** —— 这是本仓反复踩过的那种假绿（「以为在跑夹具」）。
  //
  // 夹具建在 `os.tmpdir()` 的 `mkdtemp` 下（`makeFixtureRepo`），用完即删 ——
  // **绝不往仓库写任何文件**。
  const SELF = fileURLToPath(import.meta.url);

  /** 一条「读实现源码」的最小 spec（`__dirname` + `.ts` 字面量 ⇒ 启发式必命中）。 */
  const specReadingImpl = (targetTs) =>
    [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'it("fixture", () => {',
      `  const src = readFileSync(join(__dirname, "..", "${targetTs}"), "utf-8");`,
      "  expect(src).toBeTruthy();",
      "});",
      "",
    ].join("\n");

  /** spec 侧登记表：登记 `apps/x/__tests__/reads-impl.spec.ts`（needle 与第 4 行逐字相同）。 */
  const specRegistry = (over = {}) => ({
    owner: "fixture",
    reviewBy: "2999-01-01",
    entries: [
      {
        id: "T-1",
        tier: "P1",
        spec: "apps/x/__tests__/reads-impl.spec.ts",
        specLine: 4,
        needle: 'readFileSync(join(__dirname, "..", "impl.ts"), "utf-8")',
        reads: ["apps/x/impl.ts"],
        asserts: "fixture",
        disposition: "keep-and-accept",
        dispositionNote: "fixture",
        owner: "fixture",
        reviewBy: "2999-01-01",
        ...(over.entry ?? {}),
      },
    ],
    coverageBacklog: [],
    ...(over.table ?? {}),
  });

  /** 守卫侧登记表：一条指向夹具里的守卫脚本（②「漂移」判据要求 spec 真实存在）。 */
  const guardRegistry = (over = {}) => ({
    owner: "fixture",
    reviewBy: "2999-01-01",
    entries: [
      {
        id: "G-1",
        tier: "P1",
        spec: "scripts/some-guard.mjs",
        specLine: 1,
        reads: ["apps/x/impl.ts"],
        asserts: "fixture",
        disposition: "keep-and-accept",
        dispositionNote: "fixture",
        owner: "fixture",
        reviewBy: "2999-01-01",
        ...(over.entry ?? {}),
      },
    ],
    coverageBacklog: [],
  });

  /** 一套「合规」夹具：**自带两张登记表** + 一个已登记的读源码 spec。 */
  const stcRepo = (over = {}) => {
    const files = {
      "apps/x/impl.ts": "export const A = 1;\n",
      "apps/x/__tests__/reads-impl.spec.ts": specReadingImpl("impl.ts"),
      "scripts/some-guard.mjs": "// fixture guard\n",
      "scripts/source-text-contracts.json": specRegistry(over.spec),
      "scripts/guard-source-text-contracts.json": guardRegistry(over.guard),
      // R164：判据⑥ 的存量基线也要落在夹具里 ——
      // 夹具**必须自带它**，否则「读不到基线」会把所有 CLI 夹具用例一起判红，
      // 而那与「基线存在但其内容有问题」是两件事（后者才是想测的）。
      "scripts/source-text-reads-baseline.json": JSON.stringify(
        over.readsBaseline ?? { entries: [] },
        null,
        2,
      ),
      ...(over.extraFiles ?? {}),
    };
    return makeFixtureRepo(files, { prefix: "stc-cli-" });
  };

  ok("㉛ CLI `--root=<合规夹具>` ⇒ 0（两张登记表都从**夹具根**读）", () => {
    const repo = stcRepo();
    try {
      expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
        code: 0,
        contains: [
          "源码文本契约（spec 侧）：1 条已登记",
          "扫描发现 1 个读实现源码的 spec，全部已登记 ✓",
          "源码文本契约（守卫侧）：1 条已登记",
        ],
        absent: ["源码文本契约守卫失败"],
        label: "CLI --root=<合规夹具>",
      });
    } finally {
      repo.cleanup();
    }
  });

  ok("㉜ CLI `--root=<夹具里多一个未登记的读源码 spec>` ⇒ 1，点名那个文件（棘轮）", () => {
    const repo = stcRepo({
      extraFiles: {
        "apps/x/__tests__/unregistered.spec.ts": specReadingImpl("impl.ts"),
      },
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: [
          "源码文本契约守卫失败（1 项）",
          "apps/x/__tests__/unregistered.spec.ts 读了实现源码文本但**未登记**",
          "必须显式签字",
        ],
        absent: ["全部已登记 ✓"],
        label: "CLI --root=<未登记 spec>",
      });
    } finally {
      repo.cleanup();
    }
  });

  ok("㉝ CLI `--root=<needle 被改掉的夹具>` ⇒ 1，点名条目 id 与 ±20 行（漂移）", () => {
    // 把 spec 改成读另一个文件名 ⇒ 登记表里的 needle 不再出现（判据② 的漂移面）。
    const repo = stcRepo({
      extraFiles: {
        "apps/x/__tests__/reads-impl.spec.ts": specReadingImpl("other-file.ts"),
      },
    });
    try {
      expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["T-1 needle 在", "±20 行内找不到", "spec 已漂走"],
        label: "CLI --root=<needle 漂走>",
      });
    } finally {
      repo.cleanup();
    }
  });

  ok("㉞ CLI `--root=<夹具里没有两张登记表>` ⇒ 1 结构红 + **打印实际查找路径**", () => {
    // 这条是「以为在跑夹具、实际跑真仓库」的机械反证：结构红里必须出现**夹具的路径**。
    // 若 `applyRoot()` 忘了切 `REGISTRY_PATH`，报错里出现的会是真仓库路径 ⇒ 用例红。
    const repo = makeFixtureRepo(
      { "apps/x/impl.ts": "export const A = 1;\n" },
      { prefix: "stc-no-registry-" },
    );
    try {
      expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: [
          "结构红：读不到登记表",
          join(repo.dir, "scripts", "source-text-contracts.json"),
          "--root 指错了树？",
        ],
        label: "CLI --root=<无登记表>",
      });
    } finally {
      repo.cleanup();
    }
  });

  ok("㉟ CLI `--root=<不存在的目录>` ⇒ 2（用法错误，不静默回落到真仓库）", () => {
    expectExit(
      runGuard(SELF, { args: [`--root=${join(tmpdir(), "stc-no-such-" + process.pid)}`] }),
      { code: 2, contains: ["用法错误", "指向的目录不存在"], label: "CLI --root=<不存在>" },
    );
  });

  ok("㊱ CLI `--selftest --root=<夹具>` ⇒ 2（互斥；不静默忽略用户明确给的根）", () => {
    const repo = stcRepo();
    try {
      expectExit(runGuard(SELF, { args: ["--selftest", `--root=${repo.dir}`] }), {
        code: 2,
        contains: ["用法错误", "互斥", "对照组就是**真仓库**"],
        label: "CLI --selftest + --root",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = results.filter(([p]) => !p);
  for (const [pass, name] of results) console.log(`${pass ? "✓" : "✗"} ${name}`);
  console.log(`\n自检：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.error(`\n自检失败 ${failed.length} 条`);
    process.exit(1);
  }
  // 让 linter 看到真实登记表被读过（避免 "declared but never used" 风格告警）
  if (realEntries.length === 0) process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────

// 只在「被直接执行」时跑主流程（被 import 时只导出纯函数，供自检/其他脚本复用）
const IS_MAIN =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);

/** 用法错误退出码（与「判据红 = 1」分开，口径同 `check-mcp-error-hints.mjs`）。 */
const EXIT_USAGE = 2;

/**
 * 解析仓库根并把两张登记表的路径切到该根下（**全脚本唯一**的根入口）。
 *
 * `--root` 缺值即抛（入口报 exit 2）：把末尾裸写的 `--root` 当成 `.` 会让根落到
 * `process.cwd()` —— 那句「以为在跑夹具」会直接掉进真仓库。
 */
function applyRoot(argv_) {
  let root = REPO_ROOT;
  let explicit = false;
  for (let i = 0; i < argv_.length; i += 1) {
    const a = argv_[i];
    if (a === "--root" || a.startsWith("--root=")) {
      const v = a === "--root" ? argv_[++i] : a.slice("--root=".length);
      if (!v || v.startsWith("--")) {
        throw new Error("`--root` 需要一个目录参数（`--root <dir>` 或 `--root=<dir>`）");
      }
      root = resolve(v);
      explicit = true;
    }
  }
  if (!explicit) return REPO_ROOT;
  if (argv_.includes("--selftest")) {
    throw new Error(
      "`--selftest` 与 `--root` 互斥：自检的对照组就是**真仓库**（读真登记表、真 spec）",
    );
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`\`--root\` 指向的目录不存在：${root}`);
  }
  REGISTRY_PATH = registryPath(root);
  GUARD_REGISTRY_PATH = guardRegistryPath(root);
  return root;
}

/** 根入口的**统一**调用点：用法错误一律 exit 2（自检分支也要经过它 —— 否则
 * `--selftest --root=<x>` 会在自检里静默忽略 `--root`，而头注写着「互斥」）。 */
function rootOrExit(argv_) {
  try {
    return applyRoot(argv_);
  } catch (err) {
    console.error(`✘ 用法错误：${err.message}`);
    process.exit(EXIT_USAGE);
  }
}

if (!IS_MAIN) {
  // imported as a module — 不执行任何副作用
} else if (argv.includes("--selftest")) {
  rootOrExit(argv); // 只为触发「互斥」判据；自检本身钉在真仓库上
  selftest();
} else {
  const repoRoot = rootOrExit(argv);
  let registry;
  try {
    registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch (err) {
    // 结构红（不是判据）：读不到登记表 ⇒ 判据瞎了。打印**实际查找的路径**，
    // 别让人以为守卫自己坏了（`--root` 指错树是最常见的原因）。
    console.error(
      `\n✘ 结构红：读不到登记表 ${REGISTRY_PATH}（${String(err.message).split("\n")[0]}）` +
        `—— --root 指错了树？`,
    );
    process.exit(1);
  }
  const result = check({ repoRoot, registry });
  // 第二登记表（守卫侧）。**独立 try**：一侧读不到不该让另一侧静默跳过 ——
  // 「读不到 ≠ 没问题」，两侧各自报各自的失败，合并进同一个退出码。
  let guardResult = null;
  let guardReadError = null;
  try {
    guardResult = checkGuardRegistry({ repoRoot });
  } catch (error) {
    guardReadError =
      `读不到/解析不了 ${GUARD_REGISTRY_PATH}（${String(error.message).split("\n")[0]}）—— ` +
      `守卫侧登记表是「守卫读源码」这件事的唯一记录，缺失即是结构问题，不是「没有守卫读源码」`;
  }

  if (argv.includes("--report")) printReport(registry, result);

  if (result.notes.length > 0 && !argv.includes("--report")) {
    for (const n of result.notes) console.log(`notice: ${n}`);
  }
  if (guardResult && guardResult.notes.length > 0 && !argv.includes("--report")) {
    for (const n of guardResult.notes) console.log(`notice(guard): ${n}`);
  }

  const needsDecision = result.entries.filter(
    (e) => (e.triageStatus ?? "triaged") === "needs-decision",
  );
  if (needsDecision.length > 0) {
    console.error(
      `\n源码文本契约：${needsDecision.length} 条**未分档**（机器扫出的真实项，须填 tier + disposition）：`,
    );
    for (const e of needsDecision) console.error(`  · ${e.spec}`);
  }
  const allFailures = [...result.failures, ...(guardReadError ? [guardReadError] : []), ...(guardResult?.failures ?? [])];
  if (allFailures.length > 0) {
    console.error(`\n源码文本契约守卫失败（${allFailures.length} 项）：`);
    for (const f of allFailures) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log(
    `源码文本契约（spec 侧）：${result.stats.total} 条已登记（P0=${result.stats.p0} / P1=${result.stats.p1} / P2=${result.stats.p2}），` +
      `扫描发现 ${result.stats.discovered} 个读实现源码的 spec，全部已登记 ✓`,
  );
  console.log(
    `源码文本契约（守卫侧）：${guardResult.stats.total} 条已登记（P0=${guardResult.stats.p0} / P1=${guardResult.stats.p1} / P2=${guardResult.stats.p2}），` +
      `${guardResult.stats.backlog} 条待深审（owner=${guardResult.stats.owner}，reviewBy=${guardResult.stats.reviewBy}）✓`,
  );
}
