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
 * **覆盖**：`--selftest` 现在有 **59** 条用例（R148 前是 35；R168 判据⑨ 补 6 条），其中 **6** 条是**黑盒 CLI 夹具**
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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix as pathPosix, relative, resolve } from "node:path";
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
/**
 * R165：判据⑧（`reads` 事实一致性·守卫侧）的**独立**存量基线（棘轮：只许变小）。
 *
 * 为什么要**单独**一个文件，而不是复用 spec 侧那份：两张登记表的 id 空间不同
 * （`STC-*` vs `GSTC-*`），owner 与复审节奏也不同；共用一份会让「守卫侧欠账」和
 * 「spec 侧欠账」在一个文件里互相踩（本仓并发编辑踩过基线一次）。格式刻意**同构**。
 */
const GUARD_READS_BASELINE_REL = "scripts/guard-source-text-reads-baseline.json";
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

/**
 * 极简 glob → 正则。**R166 扩了两种元字符**（`**` 与 `{a,b}`），原因见下。
 *
 *   · `*`   ：匹配**单段**内任意字符（不跨 `/`）—— 与 R164 的旧实现逐字等价；
 *   · `**`  ：匹配**任意多段**（递归读取面的唯一正确写法；`a/<**>/b` 也匹配 `a/b`，
 *             因为「双星 + 斜杠」被译成「零段或多段 + 斜杠」）；
 *   · `{a,b}`：择一（扩展名清单 `*.{ts,tsx,py}`）。`{}`**外**的逗号仍是字面量，
 *             这条不变量由 `,` 只在 `depth>0` 时译成 `|` 保证。
 *
 * ## 为什么必须扩（而不是继续只支持 `*`）
 *
 * R166 之前 `reads` 里的「递归读取面」只能写成 `apps/admin-api/src/**`（裸 `**`），
 * 旧实现把它当成 `[^/]*[^/]*`（=单段）⇒ 这条 glob **永远匹配不到任何文件**，而
 * 正向核又对 glob 整体跳过 ⇒ 它在两张表里都**不可见**。这不是理论问题：R166 实测
 * 既有登记里 **5 条** `reads` glob 是「假 glob」（`**` 不当递归用、或干脆写成
 * 「packages 下的双星 + 点号 + 花括号省略号」与「apps/admin-api/src 下的裸双星 + 一句人话」）。
 * 见 `analyzeReadsConsistency()` 里对 glob 的两条新增判据。
 */
function globToRegExp(pattern) {
  const src = toPosix(String(pattern));
  let out = "";
  let depth = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "*") {
      if (src[i + 1] === "*") {
        i += 1;
        // 双星 + 斜杠 吞掉紧随的斜杠：a/<**>/b 既要匹配 a/b，也要匹配 a/x/b
        if (src[i + 1] === "/") {
          i += 1;
          out += "(?:[^/]+/)*";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "{") {
      depth += 1;
      out += "(?:";
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      out += ")";
      continue;
    }
    if (ch === "," && depth > 0) {
      out += "|";
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * glob 条目的**字符白名单**：只许路径与 glob 元字符。
 *
 * 出现中文 / 空格 / `（）` / `…` 等「人话字符」⇒ 这不是一条能被机器核的 glob，
 * 而是「把一句说明塞进了 glob 的位置」。R166 之前这类条目**恰好**被
 * `isGlob()` 当 glob 整条跳过（正向核豁免 glob）⇒ 写人话比写路径更安全，
 * 于是表里长出了「packages 下的双星 + 花括号省略号」这种**一个文件都匹配不到**的条目。
 * 现在的口径：glob 要么是机器可解析的路径模式，要么红；说明写进 `asserts`。
 */
const GLOB_CHARSET_RE = /^[A-Za-z0-9._@\-/{}*,\[\]]+$/;

/** 单条 `reads` 覆盖一处字面量：两侧都先**规范化**再比（见 `normalizeReadPath`）。 */
function coversRead(normalizedRead, literal) {
  const lit = normalizeReadPath(literal);
  if (!normalizedRead || !lit) return false;
  return normalizedRead === lit || normalizedRead.endsWith(lit) || lit.endsWith(normalizedRead);
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

/**
 * 「源码扩展名」白名单：只有这些后缀的字符串字面量才当作**源码路径**。
 *
 * 判据⑥（spec 侧）与判据⑧（守卫侧）**共用**这一个常量 —— 两侧口径必须逐字相同，
 * 否则「spec 读了 X 算违规、守卫读了 X 不算」这种分叉没人能解释。
 */
const SOURCE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs|py|json|vue|css)$/i;

/**
 * **仅仅是一个扩展名**的字面量（`.ts` / `.d.ts` / `.json`）：它长得像路径，但不是路径。
 *
 * 实证（R166）：`apps/admin-api/.../app-deployment.optimistic-lock.spec.ts` 的
 * `walk()` 里有一行
 *   `else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(stripComments(read(full)));`
 * 它同时含 `read(` 与两个「带源码扩展名的字面量」⇒ 旧抽取把它读成「这个 spec 读了
 * 两个叫 `.ts` / `.d.ts` 的文件」。**一条只有扩展名的字面量不可能是「读取面」**：
 * 它的语义是「按后缀过滤」，不是「打开这个文件」。⇒ 直接不算字面量（不进任何集合）。
 *
 * 注意这里用的是**完整匹配**：`main.py`、`a.ts` 都不是 bare ext，不受影响。
 */
const BARE_EXT_RE = /^\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/;

/**
 * **第三方依赖**目录（裁决 B，R166）：`node_modules` / `.venv` / `site-packages`。
 *
 * ## 裁决
 *
 * `reads` 的语义是「这个 spec / 守卫读了**哪些实现源码**」——「实现源码」= **本仓的**
 * 实现。`apps/admin-api/node_modules/typeorm/...` 是**第三方库的实现**：
 *   · 它不是本仓的实现，改本仓的代码不会让它漂移；
 *   · 它会随**依赖升级**漂移 ⇒ 把它登记进 `reads` 等于把「依赖版本」写进本仓的债表，
 *     表会在每次 `npm install` 后变成谎话（而且没人会为了一个 spec 去核对它）；
 *   · 「依赖升级破坏了这条 spec」这件事有它自己的判据（`check-dependency-review.mjs`
 *     的复审期限 + CI 的版本闸），不需要 `reads` 再登记一遍。
 *
 * ⇒ 抽取口径**排除**这些路径（不算「读取面」），**且** `reads` 里出现它们即红
 * （见 `analyzeReadsConsistency`）—— 两侧都往「第三方不进这张表」一个方向倒。
 * 事实本身不会被丢掉：登记项的 `asserts` 里**明写**「读了 node_modules/typeorm 源码」
 * （STC-063 就是这么写的），读者仍然知道这条 spec 的证据强度依赖第三方内部实现。
 */
const THIRD_PARTY_DIR_RE = /(^|\/)(node_modules|\.venv)(\/|$)|(^|\/)site-packages(\/|$)/;
/** 行级种子：这一行**派生自**第三方依赖目录（宽松匹配，`"node_modules"` 那种带引号的也认）。 */
const THIRD_PARTY_SEED_RE = /\bnode_modules\b|\.venv|site-packages/;
/** 行级种子：这一行**派生自**临时目录（`mkdtemp` / `mkdtempSync` / `tmpdir()`）。 */
const TEMP_DIR_SEED_RE = /\b(?:mkdtemp|mkdtempSync|tmpdir)\s*\(/;

/**
 * 规范化「读取面」路径，**两侧共用**（判据⑥ / ⑧ 的比较基准）。
 *
 * ## 为什么必须规范化（R166 · GSTC-015 残留 1 条）
 *
 * `scripts/agent-sop-check.mjs` 里真的有一处
 *   `readFileSync(join(apiDir, "src/modules/sop/../sop/sop.service.ts"), "utf8")`
 * `a/../b` 与 `b` 是**同一个文件**。旧实现逐字符比较 ⇒ 覆盖不上 ⇒ 登记表里必须再写
 * 一串带 `..` 的「同一个文件的第二种写法」，否则永远红。那不是「保守」，那是口径错：
 * 判据拒绝承认一个显然为真的等式，只会逼人往表里塞别名。
 *
 * ⇒ 取 `path.posix.normalize()`（词法归一：折叠 `.` / `..` / 重复斜杠），
 * **两侧都过这同一个函数**——只规范化一侧才是真正的口径漂移。
 *
 * 刻意**不**做的事：不解析符号链接（那需要 I/O 且会随机器变化）、不做大小写折叠
 * （POSIX 上大小写敏感；Windows 的大小写不敏感是另一件事，不该在路径比较里混进来）。
 */
function normalizeReadPath(p) {
  const posix = toPosix(String(p ?? "")).trim();
  if (!posix) return "";
  const n = pathPosix.normalize(posix);
  return n === "." ? "" : n.replace(/^\.\//, "");
}

const IDENT_TOKEN_RE = /[A-Za-z_$][\w$]*/g;

/** 一行里「被赋值/被绑定」的标识符（含解构、对象键 —— 覆盖 `destDir: path.join(tmpRoot,…)`）。 */
function assignedNamesOnLine(line) {
  const out = new Set();
  for (const m of line.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of line.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const n of m[1].matchAll(IDENT_TOKEN_RE)) out.add(n[0]);
  }
  for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!=)/g)) out.add(m[1]);
  for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) out.add(m[1]);
  return out;
}

/** 一行里是否**提到**某个标识符（词边界；`a.destDir` 这种成员访问也算提到）。 */
function lineMentionsAnyName(line, names) {
  for (const name of names) {
    const re = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`);
    if (re.test(line)) return true;
  }
  return false;
}

/**
 * 从 `seedRe` 命中的行出发，推出「**派生自**该行的变量名」，**只做一跳**。
 *
 * 一跳是刻意的：两跳以上会顺着**形参名**漏出去。实测反例（R166）：
 * zip/typeorm 两个用例里 `const src = read(join(TYPEORM, …))` 让 `src` 成为派生名，
 * 两跳传播时 `const stripComments = (src: string) => …` 会把 `stripComments` 也染上，
 * 于是同一文件里**任何** `stripComments(read(...))` 行都被判成「第三方/临时」，把真
 * 实现读取一起吞掉。一跳足够覆盖实际形态：
 *   · `tmpRoot = mkdtempSync(...)` → `const zipPath = join(tmpRoot, name)` /
 *     `return { destDir: join(tmpRoot, "out") }`（读完就 `join(destDir, "main.py")`）；
 *   · `const TYPEORM = join(ADMIN_API, "node_modules", "typeorm")`（读在同一行）。
 */
function derivedNames(text, seedRe) {
  const lines = String(text).split("\n");
  const names = new Set();
  for (const line of lines) {
    if (!seedRe.test(line)) continue;
    for (const n of assignedNamesOnLine(line)) names.add(n);
  }
  if (names.size === 0) return names;
  for (const line of lines) {
    if (!lineMentionsAnyName(line, names)) continue;
    for (const n of assignedNamesOnLine(line)) names.add(n);
  }
  return names;
}

/**
 * 「读调用行」的**三分类**结果（判据⑥ / ⑧ 共用）。
 *
 *   · `literals`     —— 计入判据的源码路径字面量（**必须**被某条 `reads` 覆盖）；
 *   · `tempProducts` —— 落在 `mkdtemp` / `tmpdir()` 派生路径上的名字（**临时产物**）。
 *                       典型：`zip-safety.spec.ts` 的 23 处 `readFileSync` 全在解压产物目录里，
 *                       其中 6 处带源码扩展名（`main.py` / `index.js` / `主程序.py` …）——
 *                       它们是 **zip 条目名**，不是仓库里的文件。
 *   · `thirdParty`   —— 落在 `node_modules` / `.venv` 派生路径上的名字（裁决 B）。
 *
 * ## 为什么排除「临时产物」而不是排除「文件不存在」（STC-122 的口径，R166）
 *
 * 曾经考虑过「字面量在仓库里不存在 ⇒ 不是源码路径」。**实测否掉了**：全仓 88 处抽取
 * 字面量里 **87 处**在仓库根上不存在（它们相对 spec 所在目录，如 `impl.ts`、
 * `pages/TaskListPage.tsx`）⇒ 拿「存在性」当排除条件会把反向核**几乎全部**关掉。
 * 更糟的是它与正向核**同向失明**：「登记了一个不存在的文件」只要该字符串在 spec 文本里
 * 出现过就能过正向核（`main.py` 正是如此）—— 于是「不存在的登记」会同时绕过两核。
 *
 * 所以判据咬的是**证据**而不是**存在性**：这个字面量出现在一条「派生自 mkdtemp/tmpdir
 * 的路径」上 ⇒ 它描述的是一个**临时产物**，语义上根本不是「仓库里的实现源码」。
 * 同一份证据反向用在 `reads` 上：把临时产物名登记进 `reads` ⇒ **红**（不是静默忽略），
 * 于是 STC-122 那种「reads = [main.py, util.py]」的假登记不可能靠这条口径过关。
 *
 * @param {string} text 文件全文
 * @returns {{literals: Set<string>, tempProducts: Set<string>, thirdParty: Set<string>}}
 */
export function analyzeReadLines(text) {
  const src = String(text);
  const tempNames = derivedNames(src, TEMP_DIR_SEED_RE);
  const depNames = derivedNames(src, THIRD_PARTY_SEED_RE);
  const literals = new Set();
  const tempProducts = new Set();
  const thirdParty = new Set();
  for (const line of src.split("\n")) {
    if (
      !line.includes("read(") &&
      !line.includes("readFileSync(") &&
      !line.includes("readFile(")
    ) {
      continue;
    }
    const isTemp = tempNames.size > 0 && lineMentionsAnyName(line, tempNames);
    const isDep = depNames.size > 0 && lineMentionsAnyName(line, depNames);
    for (const q of line.match(/['"`]([^'"`\n]+)['"`]/g) ?? []) {
      const lit = q.slice(1, -1).trim();
      if (!lit || lit.includes("node:")) continue;
      if (!SOURCE_EXT_RE.test(lit)) continue;
      if (BARE_EXT_RE.test(lit)) continue; // `.ts` / `.d.ts`：后缀不是路径
      if (isDep || THIRD_PARTY_DIR_RE.test(lit)) {
        thirdParty.add(lit);
        continue;
      }
      if (isTemp) {
        tempProducts.add(lit);
        continue;
      }
      literals.add(lit);
    }
  }
  return { literals, tempProducts, thirdParty };
}

/**
 * 抽「读调用行」上的**源码路径字面量**（判据⑥ / 判据⑧ **共用同一份实现**）。
 *
 * ## 为什么必须是函数、且必须两侧共用（R165）
 *
 * R164 只给 spec 侧写了这条抽取逻辑（当时内联在 `check()` 里）。R165 要把同一判据
 * 扩到守卫侧，**复制一份**是最容易的做法，也是最坏的：两份正则/白名单会各自演化
 * （一侧补了 `.cjs`、另一侧没补），于是同一条事实在两张表里得到不同结论 —— 那种
 * 「看起来两边都校验了」的状态比只校验一边更危险。所以抽出来，两侧**同一份**。
 *
 * ## 口径（保守，刻意的）
 *
 * 只认**含 `read(` / `readFileSync(` / `readFile(` 的行**，只从该行抽**引号内**的
 * 字符串字面量，且必须带源码扩展名（`SOURCE_EXT_RE`）；`node:` 开头的（内置模块）
 * 排除，空串排除。**不解析变量**（`const f = 'a.ts'; read(f)` 抓不到）—— 宁可漏报
 * 一部分，也不要制造一堆「猜路径」的假红。
 *
 * R166 起另有三条**显式排除**（都在 `analyzeReadLines()` 里，本函数只是取它的
 * `literals` 一项）：bare extension（`.ts`）、`mkdtemp`/`tmpdir` 派生（临时产物）、
 * `node_modules`/`.venv` 派生（第三方依赖）。三条都**不是**「文件不存在」那种
 * 存在性判定 —— 理由见 `analyzeReadLines()` 头注。
 *
 * @param {string} text 文件全文（不要求是源码，任何文本都行）
 * @returns {Set<string>} 去重后的字面量（保持首次出现顺序）
 */
export function sourceLiteralsOnReadLines(text) {
  return analyzeReadLines(text).literals;
}

// ───────────────────────────────────────────────────────────────────────────
// R168：判据⑨ —— 「backlog 条目的**读取面快照**」
// ───────────────────────────────────────────────────────────────────────────
//
// ## 这段代码解决什么问题（判据⑧ 的一个真盲区）
//
// 判据⑧（守卫侧 `reads` 事实一致性）**只遍历 `entries`**。守卫侧登记表里还有
// **29 条 `coverageBacklog`** —— 「机器扫描发现、但**尚未逐条甄别**」的已知项。
// 它们**不在判据⑧ 的面内** ⇒ 这 29 条守卫脚本若发生「读取面漂移」
// （搬文件 / 改读法 / 把常量挪到别处），**没有任何东西会红**。
//
// ## 为什么**不能**给 backlog 条目补 `reads` 并直接跑判据⑧
//
// (b) 方向（补 `reads`）被否决，理由是**语义**而不是工作量：
//   · backlog 的语义是「**已知但未甄别**」—— 判据④（新增即红）**已经**把它当作
//     「已登记」处理（`backlogSpecs` 集合）。给一条**尚未甄别**的债补上 `reads`，
//     等于宣称「这条的读取面已被核过」—— 那是**降低门槛**，不是提高。
//   · 判据⑧ 的正向核要求「`reads` 登记的每项必须在守卫脚本里**被提到**」。
//     对一条**未甄别**的守卫脚本，机器**不知道**它读了什么 ⇒ 要么瞎填（假登记），
//     要么留空（触发「`reads` 必须是非空数组」⇒ 立刻红 ⇒ 29 条全部欠账 ⇒ 守卫被关灯）。
//
// ## 采纳的方向：(a) 的变体 —— **反向核 + 快照**
//
// backlog 条目**天然没有 `reads`**（本轮实测：29 条的字段并集 = `id / spec / status /
// why / owner / reviewBy`，**一条都没有 `reads`**）⇒ **正向核无从核起**（没有「登记的
// 事实」可比）。所以判据⑨ 走**反方向**：
//
//   · **观测面**（`observedReadSurface()`）：从守卫脚本源码里**机器抽出**它提到的
//     仓库路径字面量（注释里的不算；正则字面量不算；`node_modules` 第三方不算）——
//     这是**事实**，不是登记。
//   · **快照面**（backlog 条目上的新字段 `readSurface`）：把这 29 条**当前**的观测面
//     **冻结**下来，作为「已甄别到哪一步」的客观刻度。
//   · **判据⑨**：漂移即红 —— 观测面与快照面**不一致** ⇒ 红（点名多了什么 / 少了什么）。
//
// ## 为什么这**没有**降低 backlog 的门槛
//
//   · 快照**只**冻结「这个脚本提到了哪些路径」，**不**冻结「这些路径是否正当」、
//     **不**给分档、**不**给处置方式 —— 那些仍需**逐条甄别**（仍是 backlog 的一部分）。
//   · 快照**不**豁免任何东西：漂移（含**新增**读取）**立即红**，不许往任何地方加条目消红。
//   · 快照是**可选**字段：现有 29 条**没写** ⇒ **零影响**（旧行为）；写了就按形状核
//     （不是合法形状 ⇒ 红，不许静默忽略）。
//
// ## 与判据⑧ 的关系（**不是**替代，是补盲区）
//
// 判据⑧ 核的是「**登记的 `reads` == 事实**」（正向 + 反向），对象是**已甄别**的 18 条。
// 判据⑨ 核的是「**观测面 == 快照**」，对象是**未甄别**的 29 条。两者都答同一个问题
// （「这个守卫脚本的读取面是什么」），但**判据⑨ 只答「有没有变」**，不答「对不对」——
// 「对不对」正是 backlog 存在的理由（等人来甄别）。
//
// ## 字段形状（**可选**，向后兼容）
//
//   `readSurface`: string[] —— 该守卫脚本**当前**观测到的仓库路径字面量（已排序、去重）。
//   · 不写 ⇒ 旧行为（**零影响**）：该条**不进入**判据⑨ 的面内。
//   · 写了 ⇒ 必须是非空数组；每项必须是**仓库相对路径形态**（不含空白 / 不含中文）。
//   · 判据⑨ 只在「**观测面 ≠ 快照面**」时红（增删都红）。
//
// ## 抽取口径为什么必须**独立**于 `sourceLiteralsOnReadLines()`
//
// `sourceLiteralsOnReadLines()` 是**判据⑥/⑧ 的共用实现**，口径刻意**保守**：
// 只看「含 `read(` / `readFileSync(` 的**那一行**上的字面量。对**已甄别**的条目，
// 这个口径刚好（登记就是「那一行读的那个文件」）。但对 backlog 的 29 条，
// 实测**该口径几乎抽不到东西**（29 条里只有 1 条抽出 1 个字面量）—— 因为守卫脚本
// 普遍写成「常量表里列路径 → 循环里 `readFileSync(join(root, rel))`」，
// 路径字面量在**常量表那一行**，读调用在**另一行**。
// ⇒ 判据⑨ 需要一个**更宽但仍可核**的观测面：**全文件字面量**（去注释 / 去正则）。
// 代价是它**更宽**（会看到没被读到的路径）⇒ 所以快照是「**冻结观测**」而不是
// 「登记事实」：宽口径带来的噪声被**冻结**下来，不会每次都红。

/**
 * 词法扫描：从源码里抽出**字符串字面量**（跳过注释与正则字面量）。
 *
 * ## 为什么不用 `stripCommentsKeepStrings()`
 *
 * 共享件 `scripts/lib/agent-coverage.mjs` 的 `stripCommentsKeepStrings()` **实测**
 * 在本仓的真实文件上**会漏剥注释**：`scripts/check-metric-docs.mjs` 的第 1289 行
 * 起是一段 `/** … *\/` 块注释，里面写着一行 `` * `scripts/lib/guard-selftest.mjs`： ``
 * —— 该函数把它**整段保留**了（实测：剥完第 1295 行仍是注释原文）。
 *
 * 根因是它把「块注释结束符」当成普通字符扫，而本仓注释里出现了会**提前闭合**的写法
 * （本段注释自己就是例子：正文里若直接写出结束符，本段也会被提前闭合 ⇒
 * 那正是判据⑨ **不能**依赖共享件的实证）。
 * ⇒ 判据⑨ 不能依赖它：**注释里的路径不是事实**（把注释当事实 = 把「文档里提到过」
 * 记成「读过」⇒ 快照一开始就是假的）。
 *
 * @param {string} src 源码全文
 * @returns {{line: number, value: string}[]} 字符串字面量（行号 1 起）
 */
export function lexStringLiterals(src) {
  const s = String(src);
  const n = s.length;
  const out = [];
  let i = 0;
  let line = 1;
  /** 上一个有效字符（用来区分「除号」与「正则字面量起点」）。 */
  let prev = "";
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i += 1;
      continue;
    }
    // 行注释
    if (c === "/" && c2 === "/") {
      while (i < n && s[i] !== "\n") i += 1;
      continue;
    }
    // 块注释
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) {
        if (s[i] === "\n") line += 1;
        i += 1;
      }
      i = Math.min(n, i + 2);
      continue;
    }
    // 字符串字面量
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      const startLine = line;
      let j = i + 1;
      let buf = "";
      let closed = false;
      while (j < n) {
        if (s[j] === "\\") {
          buf += s[j] + (s[j + 1] ?? "");
          if (s[j + 1] === "\n") line += 1;
          j += 2;
          continue;
        }
        if (s[j] === q) {
          closed = true;
          j += 1;
          break;
        }
        if (s[j] === "\n") {
          if (q !== "`") break; // 未闭合的普通引号 ⇒ 不是字面量
          line += 1;
        }
        buf += s[j];
        j += 1;
      }
      if (closed) out.push({ line: startLine, value: buf });
      i = j;
      prev = "x";
      continue;
    }
    // 正则字面量（不是字符串 ⇒ 不算路径）
    if (c === "/" && !/[A-Za-z0-9_$)\]]/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = s[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "\n") break;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(s[j])) j += 1;
        i = j;
        prev = "x";
        continue;
      }
    }
    prev = c;
    i += 1;
  }
  return out;
}

/**
 * 「仓库路径」字面量**形态**检查（判据⑨ 用）。
 *
 * 只许路径字符与 glob 元字符（**复用** `GLOB_CHARSET_RE`，与判据⑥/⑧ 的 glob 牙
 * 同一口径 ⇒ 两侧不会对「什么算路径」产生分叉）。
 * 另排除 **bare extension**（`.ts` / `.d.ts`）—— 那是「按后缀过滤」，不是路径
 * （与 `analyzeReadLines()` 的第三条排除**同款理由**）。
 */
const BACKLOG_SURFACE_ROOTS = ["apps/", "packages/", "scripts/"];

/**
 * 一个字面量**算不算**「仓库路径」。
 *
 * @param {string} lit 字面量原文
 * @returns {boolean}
 */
export function isRepoPathLiteral(lit) {
  const s = String(lit ?? "").trim().replace(/\/+$/, "");
  if (!s) return false;
  if (!GLOB_CHARSET_RE.test(s)) return false;
  if (BARE_EXT_RE.test(s)) return false;
  if (!BACKLOG_SURFACE_ROOTS.some((r) => s.startsWith(r))) return false;
  if (THIRD_PARTY_DIR_RE.test(s)) return false;
  return true;
}

/**
 * 观测一个守卫脚本的**读取面**（判据⑨ 的事实面）。
 *
 * ## 口径（**宽口径 + 冻结**，不是「登记 = 事实」）
 *
 *   · **全文件**的仓库路径字面量（不限于「读调用那一行」）——
 *     实测：29 条 backlog 守卫里 **28 条**把路径写在**常量表**里、读调用在**别的行**，
 *     用「读调用那一行」的口径只能抽出 **1** 条 ⇒ 那个口径对本任务**不可用**。
 *   · 注释与正则字面量**不算**（见 `lexStringLiterals()` 的头注）。
 *   · 第三方依赖（`node_modules` / `.venv`）不算（与判据⑥/⑧ 的裁决 B 同款）。
 *   · **不**做「文件是否存在」的判定 —— 那是**存在性**口径，本仓已实测否掉它
 *     （R166：`analyzeReadLines()` 头注：「87 处字面量在仓库根上不存在」）。
 *
 * ## 为什么**宽口径**是可接受的
 *
 * 因为判据⑨ 比的是「**观测面 == 快照面**」，而快照面是**同一口径**抽出来的。
 * 宽口径的噪声（没被读到的路径也被算进来）在**冻结那一刻**就固定了 ⇒
 * 之后只有**真实漂移**才会让两者不等 ⇒ 不会每次都红。
 *
 * @param {string} text 守卫脚本全文
 * @returns {string[]} 观测到的仓库路径（已排序、去重）
 */
export function observedReadSurface(text) {
  const out = new Set();
  for (const { value } of lexStringLiterals(text)) {
    if (!isRepoPathLiteral(value)) continue;
    out.add(value.trim().replace(/\/+$/, ""));
  }
  return [...out].sort();
}

/**
 * 仓库内**全部文件**（posix 相对路径，跳过 `SKIP_DIRS`）—— glob 展开用。
 * 按 root 缓存：一张表里几十条 glob，重复 walk 会慢到没人愿意跑。
 */
const repoFileCache = new Map();
function listRepoFiles(repoRoot) {
  const key = resolve(repoRoot);
  const cached = repoFileCache.get(key);
  if (cached) return cached;
  const out = [];
  (function walkAll(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walkAll(p);
      else if (e.isFile()) out.push(toPosix(relative(repoRoot, p)));
    }
  })(repoRoot);
  repoFileCache.set(key, out);
  return out;
}

/**
 * glob 的**解析基准**（可能多个）：仓库根、登记项所在文件的目录、所属包根。
 *
 * 为什么不是只有仓库根：两张表里的 `reads` 历史上既写过仓库相对路径
 * （`apps/admin-api/src/...`），也写过**相对 spec 目录**的（STC-001 `modules/task/task.service.ts`）
 * 和**相对包根**的（STC-085 `src/utils/*.ts` ← `apps/admin-web/`）。这是既有事实，
 * 本轮只给 glob 加「必须能展开」的牙，不顺带重写别人几十条登记的写法。
 * 基准顺序固定（仓库根 → 文件目录 → 包根），任一基准能展开即算「这条 glob 是活的」。
 */
function globBases(specRel) {
  const bases = [""];
  const specDir = toPosix(dirname(String(specRel ?? "")));
  if (specDir && specDir !== ".") bases.push(specDir);
  const m = /^(apps|packages)\/([^/]+)\//.exec(toPosix(String(specRel ?? "")));
  if (m) bases.push(`${m[1]}/${m[2]}`);
  return [...new Set(bases)];
}

/**
 * 一条 glob 在任一基准下**能匹配到的文件数**（取最大；0 ⇒ 这条 glob 是死的）。
 *
 * 「死 glob」是 R166 实测到的真问题：「packages 下的双星 + 花括号省略号」（省略号写进了模式里）
 * 与 `apps/admin-api/src/**（递归遍历全部实现文件）`（一句人话塞进了模式里）
 * 在旧实现下**永远匹配 0 个文件**，而正向核又对 glob 整体跳过 ⇒ 它们在两张表里
 * **完全不可见**。现在：glob 展开不到任何文件 ⇒ **红**（登记必须写真实读取面）。
 */
function globMatchCount(repoRoot, specRel, pattern) {
  const files = listRepoFiles(repoRoot);
  const re = globToRegExp(pattern);
  const body = re.source.slice(1, -1);
  let best = 0;
  for (const base of globBases(specRel)) {
    const probe = base ? new RegExp(`^${escapeRe(base)}/(?:${body})$`) : re;
    const n = files.reduce((acc, f) => acc + (probe.test(f) ? 1 : 0), 0);
    if (n > best) best = n;
  }
  return best;
}

/** 正则元字符转义（给 `globToRegExp` 的基准前缀用）。 */
function escapeRe(s) {
  return String(s).replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * 按 `a.b.*.c` 取 JSON 里的叶子（`*` = 数组/对象逐项展开）—— `readsVia.key` 的解析器。
 *
 * 刻意做得很小：只支持**点分 + `*` 通配**。够表达 `entries.*.targets.*.file`
 * （GSTC-001 的手抄副本登记表），也不需要引入 JSONPath 依赖。
 */
function jsonLeaves(node, segs) {
  if (segs.length === 0) return [node];
  const [head, ...rest] = segs;
  if (head === "*") {
    const items = Array.isArray(node)
      ? node
      : node && typeof node === "object"
        ? Object.values(node)
        : null;
    if (!items) return [];
    return items.flatMap((v) => jsonLeaves(v, rest));
  }
  if (node && typeof node === "object" && Object.hasOwn(node, head)) {
    return jsonLeaves(node[head], rest);
  }
  return [];
}

/**
 * `readsVia` 的**形状校验**（R166 新增字段，向后兼容）。
 *
 * ## 这条字段是什么（裁决 C · GSTC-001）
 *
 * 有些守卫的读取面是**数据驱动**的：`scripts/check-handwritten-copies.mjs` 的源码里
 * 只提到 `scripts/handwritten-copies.json`（一个登记表路径），真正被读的那些实现文件
 * （`config.ts` / `config.py` / `protocol-compat.util.ts` / …）**只出现在那份 JSON 里**。
 * 于是判据⑧ 的正向核（`reads` 每项都要在守卫脚本里**被提到**）必然判「从未提到」——
 * 而这不是假登记，那 7 个文件**确实被读了**。
 *
 * 三个选项：
 *   ① 允许 `reads` 条目写成「描述」（人话）⇒ 正向核要能识别「描述」并跳过 ⇒
 *      **判据学会了自己看不懂的东西**。红变绿了，但表里那句话仍然是不可核的。
 *   ② 如实留在基线里 ⇒ 表继续说「这件事我核不了」。
 *   ③ **新增 `readsVia` 字段**：把「经数据文件间接读取」这件事**显式登记**，
 *      并让判据**去那份数据文件里核**（真的把 JSON 解析出来、真的检查那些目标文件
 *      是不是就登记的那些）⇒ 正向核**没有**被削弱，反而多了一核。
 *
 * ⇒ 选 ③。理由：**正向核的目的是「登记 = 事实」，不是「登记看起来像事实」**。
 * 判据学会跳过看不懂的条目 = 把「核不了」变成「不用核」。而 `readsVia` 让判据
 * **多了一件能做的事**：它能顺着 `file` + `key` 去数据文件里取到真实目标，
 * 再要求「取到的目标集合 == 登记的 `reads` 集合」—— 数据文件漂了（新增一条 target
 * 没登记）也会红。
 *
 * ## 形状
 *
 *   `readsVia: [{ file: "scripts/handwritten-copies.json", key: "entries.*.targets.*.file" }]`
 *
 *   · `file`  —— 仓库相对路径；必须存在（不存在 ⇒ 红：登记表腐烂）。
 *   · `key`   —— 点分路径，`*` 表示「数组/对象逐项展开」；取到的叶子必须是**字符串**。
 *   · `expect` —— **可选**；数组，取到的目标集合必须与它**相等**（顺序无关）。
 *                 不写 `expect` 时只要求「能取到至少一个目标」。
 *
 * ## 向后兼容
 *
 * 字段**可选**：现有 123 + 18 条登记**一条都没有**这个字段 ⇒ 不写就是旧行为，
 * 零影响。写了就按上面的形状核 —— 写错形状（`file`/`key` 缺失、`key` 取不到东西）
 * 一律**红**，不许静默忽略。
 */
function validateReadsVia(entry, repoRoot, sideLabel) {
  const problems = [];
  const targets = new Set();
  const files = new Set();
  const raw = entry?.readsVia;
  if (raw === undefined || raw === null) return { problems, targets, files }; // 没写 = 旧行为（向后兼容）
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(
      `${entry.id} readsVia 必须是**非空数组**（没写就等于没登记这层间接；写了必须是数组）`,
    );
    return { problems, targets, files };
  }
  for (const [i, via] of raw.entries()) {
    const at = `${entry.id} readsVia[${i}]`;
    if (!via || typeof via !== "object") {
      problems.push(`${at} 必须是对象 { file, key, expect? }`);
      continue;
    }
    if (typeof via.file !== "string" || !via.file.trim()) {
      problems.push(`${at} 缺 file（数据文件路径）`);
      continue;
    }
    if (typeof via.key !== "string" || !via.key.trim()) {
      problems.push(`${at} 缺 key（数据文件里的点分路径，如 entries.*.targets.*.file）`);
      continue;
    }
    const abs = join(repoRoot, via.file);
    files.add(normalizeReadPath(via.file));
    if (!existsSync(abs)) {
      problems.push(
        `${at} 的数据文件不存在：${via.file} —— 登记表腐烂（数据文件被搬走了/改名了）`,
      );
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(readFileSync(abs, "utf-8"));
    } catch (err) {
      problems.push(
        `${at} 的数据文件解析不了：${via.file}（${String(err.message).split("\n")[0]}）`,
      );
      continue;
    }
    const leaves = jsonLeaves(doc, via.key.split(".").filter(Boolean)).filter(
      (v) => typeof v === "string" && v.trim(),
    );
    if (leaves.length === 0) {
      problems.push(
        `${at} 的 key「${via.key}」在 ${via.file} 里取不到任何字符串目标 —— ` +
          `key 写错了，或数据文件里没有这层间接`,
      );
      continue;
    }
    for (const leaf of leaves) targets.add(normalizeReadPath(leaf));
    if (Array.isArray(via.expect)) {
      const got = new Set(leaves.map((v) => normalizeReadPath(v)));
      const want = new Set(via.expect.map((v) => normalizeReadPath(String(v))));
      const missing = [...want].filter((w) => !got.has(w));
      const extra = [...got].filter((g) => !want.has(g));
      if (missing.length || extra.length) {
        problems.push(
          `${at} 的实际目标与 expect 不一致 —— ` +
            (missing.length ? `缺：${missing.join("、")}；` : "") +
            (extra.length ? `多：${extra.join("、")}；` : "") +
            `数据文件漂了（新增/删除 target）必须同步登记`,
        );
      }
    }
  }
  void sideLabel;
  return { problems, targets, files };
}

/**
 * 判据⑥ / ⑧ **共用**的 `reads` 一致性分析（R166）。
 *
 * 两侧的 `reads` 语义不同（spec 侧 = 「这个 spec 读了哪些实现源码」；守卫侧 =
 * 「这个守卫脚本读了哪些实现源码」），但**判据本身逐条同构** —— 所以实现也共用，
 * 只把「违规文案」按侧拼（R165 的纪律：复制一份 ⇒ 两侧口径各自漂移）。
 *
 * ## 五类检查
 *
 *   ① **正向**（登记 = 事实）：每条 `reads` 必须在源码里**被提到**。
 *      匹配方式：整串 / 末两段 / 末段（三种都是**子串**匹配，R164 起未变）。
 *   ② **反向**（事实 ⊆ 登记）：每处「读调用行」上的源码路径字面量必须被某条 `reads` 覆盖。
 *      覆盖 = 相等 / 条目以字面量结尾 / 字面量以条目结尾；**两侧都先规范化**（R166）。
 *   ③ **临时产物**（R166 · STC-122）：落在 `mkdtemp`/`tmpdir()` 派生路径上的字面量
 *      **不是**读取面（那是 zip 条目名 / 解压产物名）。反向：把它们登记进 `reads` ⇒ **红**。
 *   ④ **第三方依赖**（R166 · STC-063）：`node_modules`/`.venv` 派生路径上的字面量
 *      **不是**本仓实现源码 ⇒ 不进反向核；反向：登记进 `reads` ⇒ **红**。
 *   ⑤ **glob**（R166）：glob 必须**是机器可解析的模式**（字符白名单）且**能展开到
 *      至少一个文件**（否则是「死 glob」= 表里那条登记其实什么都没说）。
 *
 * @param {object} opts
 * @param {object} opts.entry      登记项
 * @param {string} opts.text       源码全文（spec 正文 / 守卫脚本正文）
 * @param {string} opts.repoRoot   仓库根
 * @param {"spec"|"guard"} opts.side 侧（只影响文案）
 * @returns {{id: string, msg: string}[]} 违规列表
 */
export function analyzeReadsConsistency({ entry, text, repoRoot, side }) {
  const violations = [];
  const id = String(entry?.id ?? "");
  const specRel = String(entry?.spec ?? "");
  const reads = Array.isArray(entry?.reads) ? entry.reads.map(String) : [];
  const isSpecSide = side !== "guard";
  const noun = isSpecSide ? "spec" : "守卫脚本";
  const src = String(text);

  const {
    problems: viaProblems,
    targets: viaTargets,
    files: viaFiles,
  } = validateReadsVia(entry, repoRoot, side);
  for (const p of viaProblems) {
    violations.push({ id, msg: `${p}` });
  }

  const analysis = analyzeReadLines(src);
  const normalizedReads = reads.map((r) => ({ raw: r, norm: normalizeReadPath(r) }));

  // ① 正向：登记的每个 reads 都要在源码里被提到
  for (const rel of reads) {
    if (isGlob(rel)) {
      // ⑤ glob：必须可解析 + 必须展开得到东西
      if (!GLOB_CHARSET_RE.test(rel)) {
        violations.push({
          id,
          msg:
            `${id} reads 里的「${rel}」**不是一个机器可解析的 glob** —— ` +
            `模式里只许路径字符与 glob 元字符（* ** {a,b}），说明文字请写进 asserts。` +
            `（否则这条登记在两张表里都不可见：正向核豁免 glob，而它又匹配不到任何文件。）`,
        });
        continue;
      }
      const n = globMatchCount(repoRoot, specRel, rel);
      if (n === 0) {
        violations.push({
          id,
          msg:
            `${id} reads 里的 glob「${rel}」**匹配不到任何文件**（相对仓库根 / ` +
            `${specRel} 所在目录 / 所属包根都试过了）—— 这是一条「死 glob」，` +
            `它什么都没登记。要么改成能展开的真实读取面，要么改用确切路径。`,
        });
      }
      continue;
    }
    // 经数据文件间接读取的（`readsVia`）：目标**不在源码里**出现，而是在数据文件里。
    // 正向核据此**改判**：这一条算「被提到」—— 而且判据**自己去数据文件里核过了**
    // （`validateReadsVia` 已经把真实目标取出来，并要求与 `expect` 相等）。
    if (viaTargets.size > 0) {
      const hit = [...viaTargets].some(
        (t) => coversRead(normalizeReadPath(rel), t) || coversRead(t, rel),
      );
      if (hit) continue;
    }
    const tail = rel.split("/").slice(-2).join("/");
    if (!src.includes(rel) && !src.includes(tail) && !src.includes(rel.split("/").pop())) {
      violations.push({
        id,
        msg:
          `${id} reads 登记了「${rel}」，但 ${specRel} 里**从未提到**它 —— ` +
          `登记的读取面与事实不一致（要么它读的是别的文件，要么这条 reads 是抄来的）。` +
          `修法：按${noun}里真实的 read(...) 调用改正 reads；若该${noun}根本不读源码文本，` +
          `整条登记都该复核。` +
          (viaTargets.size > 0
            ? `（若这条读取是**经数据文件间接**的，请用 readsVia 登记那层间接：` +
              `判据会自己去数据文件里取真实目标来核。）`
            : ""),
      });
    }
  }

  // ② 反向：读调用行上的源码字面量必须被某个 reads 覆盖
  //    （R166：`readsVia` 登记的那层间接**也算覆盖** —— 守卫脚本里出现的是数据文件路径，
  //    真实目标在数据文件里；数据文件本身则必须被 `reads` 或 `readsVia` 覆盖。）
  for (const lit of analysis.literals) {
    const covered =
      normalizedReads.some((r) => coversRead(r.norm, lit)) ||
      [...viaTargets].some((t) => coversRead(t, lit)) ||
      [...viaFiles].some((f) => coversRead(f, lit));
    if (!covered) {
      violations.push({
        id,
        msg:
          `${id} 在 ${specRel} 里读了「${lit}」，但它**不在** reads 里 —— ` +
          `漏登记会让「这个${noun}的读取面」被低估（外提/搬迁时没人知道要同步它）。` +
          `修法：把该文件补进 reads（若它是拼接读取的一部分，补**全部**文件）。`,
      });
    }
  }

  // ③ 临时产物：登记它 = 假登记（反向核豁免它，但正向核不许它进表）
  for (const lit of analysis.tempProducts) {
    const mentioned = normalizedReads.some((r) => coversRead(r.norm, lit));
    if (mentioned) {
      violations.push({
        id,
        msg:
          `${id} reads 登记了「${lit}」，但它是**临时解压产物名 / zip 条目名** ` +
          `（落在 mkdtemp/tmpdir 派生路径上），不是仓库里的实现源码 —— ` +
          `把它登记进 reads 会让这张表说谎。修法：从 reads 里删掉它；` +
          `若这条${noun}真的读到了本仓实现源码，把那些**真实路径**登记进去。`,
      });
    }
  }

  // ④ 第三方依赖：同上（裁决 B）
  for (const lit of analysis.thirdParty) {
    const mentioned = normalizedReads.some((r) => coversRead(r.norm, lit));
    if (mentioned) {
      violations.push({
        id,
        msg:
          `${id} reads 登记了「${lit}」，但它落在 **node_modules / .venv** 里 —— ` +
          `那是**第三方依赖的实现**，不是本仓的实现源码。` +
          `裁决（R166）：第三方依赖不进 reads（reads 的语义是「读了哪些**本仓**实现源码」；` +
          `登记依赖版本等于把「依赖升级」写进本仓的债表）。修法：从 reads 里删掉它。`,
      });
    }
  }

  return violations;
}

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
  // 抽取实现**不在本函数里**：见 `sourceLiteralsOnReadLines()`。R165 把同一判据扩到
  // 守卫侧（判据⑧）时两侧共用那一份 —— 复制一份会让两条判据的口径悄悄漂移。
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
  for (const e of entries) {
    if (isGlob(e.spec)) continue;
    const abs = join(repoRoot, e.spec);
    if (!existsSync(abs)) continue; // ② 已报「spec 不存在」
    const text = readFileSync(abs, "utf-8");
    // 判据本体**共用** `analyzeReadsConsistency()`（R166）—— 两侧逐条同构。
    readsViolations.push(
      ...analyzeReadsConsistency({ entry: e, text, repoRoot, side: "spec" }),
    );
  }

  for (const v of readsViolations) {
    const id = v.id || ((v.msg.match(/^(STC-\d+)/) ?? [])[1] ?? "");
    if (id && baselineKeys.has(id)) {
      seenKeys.add(id);
      continue; // 存量：已知债，不判红（但会被下面的「基线收紧」提示）
    }
    failures.push(v.msg + "（**新增**：不在判据⑥ 基线里 ⇒ 必须就地修，不要往基线里加）");
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
  // ── R167：`spec` 上的 glob 也必须有**两条牙**（与 `reads` 上的 glob 同款）────────
  //
  // ## 为什么（这是判据④的一处真盲区）
  //
  // R166 给 `reads` 里的 glob 加了「① 机器可解析 ② 必须展开得到 ≥1 个文件」两条牙，
  // 但 **`spec` 字段上的 glob 仍然没有** ⇒ 判据④（新增即红）用 `globToRegExp(e.spec)`
  // 去匹配，而**人话 glob 匹配不到任何文件** ⇒ 那条登记在判据④面前**完全不可见**：
  // 它既挡不住「新增的未登记 spec」，也**挡不住自己**（一条解析不出路径的登记 =
  // 一条什么都没说的登记）。
  //
  // 实测：全表 **123 条里只有 1 条** `spec` 是 glob，而它恰好是**人话**：
  //   `apps/admin-api/src/migrations/__tests__/*.spec.ts（约 12+ 处）`
  // ⇒ 「约 12+ 处」这段中文让模式**匹配不到任何文件**，于是这条登记**是装饰**。
  //
  // ## 修法（**不放宽判据④**，只把它变得可核）
  //
  // ① 模式必须**机器可解析**（`GLOB_CHARSET_RE`：只许路径字符与 glob 元字符）——
  //    中文/空格/「约 N 处」这类说明文字**一律红**，说明文字请写进 `asserts`；
  // ② 模式必须**展开得到 ≥1 个文件**（相对仓库根 / 登记项所在目录 / 所属包根都试）——
  //    匹配 0 个 ⇒ 是「**死 glob**」⇒ 红。
  // ⇒ 这**不是**给判据④加豁免，是**把一条不可核的登记变成可核的**（与 R166 对 `reads` 侧同款）。
  const specGlobProblems = [];
  const globs = [];
  for (const e of entries.filter((e) => isGlob(e.spec))) {
    const pat = toPosix(e.spec);
    if (!GLOB_CHARSET_RE.test(pat)) {
      specGlobProblems.push(
        `${e.id} 的 spec「${e.spec}」**不是一个机器可解析的 glob** —— ` +
          `模式里只许路径字符与 glob 元字符（* ** {a,b}），说明文字（如「约 N 处」）` +
          `请写进 asserts。\n` +
          `（否则这条登记在判据④面前**完全不可见**：它既挡不住「新增的未登记 spec」，` +
          `也挡不住自己 —— 人话 glob 匹配不到任何文件 = 一条什么都没说的登记。）`,
      );
      continue;
    }
    if (globMatchCount(repoRoot, e.spec, pat) === 0) {
      specGlobProblems.push(
        `${e.id} 的 spec glob「${pat}」**匹配不到任何文件**（相对仓库根 / 登记项所在目录 / ` +
          `所属包根都试过了）—— 这是一条「死 glob」，它什么都没登记。要么改成能展开的真实读取面，` +
          `要么改用确切路径。`,
      );
      continue;
    }
    globs.push(globToRegExp(pat));
  }
  failures.push(...specGlobProblems);
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
 *   ⑧ `reads` **事实一致性（守卫侧，R165）**：与 spec 侧判据⑥ 同构、共用
 *      `sourceLiteralsOnReadLines()` —— 正向「`reads` 登记的每项必须在守卫脚本里被提到」+
 *      反向「读调用行上的源码字面量必须被某个 `reads` 覆盖」；存量进
 *      `scripts/guard-source-text-reads-baseline.json`（新增即红 / 只许变小 /
 *      读不到基线即红）。编号取 **⑧** 而不是 ⑥：⑥ 已经是 spec 侧那条（R164），同一
 *      守卫里出现两个「判据⑥」会让报告与回执分不清在说哪一侧；①–⑤ 已归本表。
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

  // ── ⑧（R165）`reads` 的事实一致性（守卫侧）：与判据⑥ **同构** ──
  //
  // ## 为什么需要这条
  //
  // 守卫侧的 `reads` 与 spec 侧的 `reads` 是**同一个字段、同一个风险**：它是本表里
  // **唯一没有判据的必填字段**（① 只查「非空数组」）。字段的**语义**两边不同 ——
  // 这边是「**这个守卫脚本读了哪些实现源码文件**」（不是「哪些 spec」）—— 但判据
  // 本身**逐条一致**（R164 定型、本轮原样搬到这一侧）：
  //
  //   · **正向**：每个 `reads` 条目必须在守卫脚本源码里**被提到**；
  //   · **反向**：守卫脚本的「读调用行」上的**源码路径字面量**必须**被某个 `reads`
  //     覆盖**（覆盖 = 相等 / 条目以字面量结尾 / 字面量以条目结尾）。
  //   · 只认**源码扩展名**的字面量，抽取逻辑**复用** `sourceLiteralsOnReadLines()`
  //     —— 不复制一份：复制会让两条判据的白名单各自演化，最后「同一件事在两张表里
  //     结论不同」，比只校验一侧更危险。
  //
  // ⚠️ 保守面（与 ⑥ 逐条相同）：只做**字面量级**匹配，不解析变量、**不做路径规范化**。
  // 已知的两类**误报**来源（都**不许**「顺手改登记」来消红 —— 改登记会让这张表说谎，
  // 而说谎的登记比没有登记更坏）：
  //   · **数据驱动读取**：目标清单在 `scripts/handwritten-copies.json` 里，源码只提到
  //     「登记表」三个字 ⇒ 真实读到的目标「从未被提到」（GSTC-001 那两条）；
  //   · **reads 写成了一句人话**（不是路径）：GSTC-006 的「扫描根 apps/ 与 packages/
  //     （递归遍历 …）」，正则抽不出路径，正向核必然判「从未提到」。
  //
  // **棘轮**：存量进 `GUARD_READS_BASELINE_REL`（格式与 spec 侧基线同构）——
  // **新增即红**、基线**只许变小**（条目修好后必须删掉，下次运行打 note 催删）、
  // **空基线也要有文件**、**读不到基线 ⇒ 红**（「读不到」不许静默变成「没有存量」）。
  let guardReadsBaseline = { entries: [] };
  try {
    guardReadsBaseline = JSON.parse(
      readFileSync(join(repoRoot, GUARD_READS_BASELINE_REL), "utf-8"),
    );
  } catch {
    failures.push(
      `读不到 ${GUARD_READS_BASELINE_REL} —— 判据⑧ 的基线必须存在（空基线也要有文件，` +
        `否则「读不到」会静默变成「没有存量」，存量欠账会一夜之间全变成红或全变成绿）。`,
    );
  }
  const guardBaselineKeys = new Set(
    (Array.isArray(guardReadsBaseline?.entries) ? guardReadsBaseline.entries : []).map(String),
  );
  // 违规记 `{ id, msg }` 而不是「从消息里正则抠 id」：守卫侧 id 形态不止 `GSTC-*`
  // 一种（自检夹具里就有 `G-1`），靠 `^(GSTC-\d+)` 抓 id 会把「已在基线」判成新增。
  const guardReadsViolations = [];
  for (const e of entries) {
    if (typeof e?.spec !== "string" || !e.spec) continue;
    const abs = join(repoRoot, e.spec);
    if (!existsSync(abs)) continue; // ② 已报「登记的守卫脚本不存在」
    let text;
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      continue; // 读不到脚本正文 ⇒ ② 会以「不存在」之外的方式暴露，不在这里猜
    }
    const reads = Array.isArray(e.reads) ? e.reads.map(String) : [];
    const id = String(e?.id ?? "");
    // 判据本体**共用** `analyzeReadsConsistency()`（R166）—— 与 spec 侧逐条同构。
    guardReadsViolations.push(
      ...analyzeReadsConsistency({ entry: e, text, repoRoot, side: "guard" }),
    );
  }

  const seenGuardKeys = new Set();
  for (const v of guardReadsViolations) {
    if (v.id && guardBaselineKeys.has(v.id)) {
      seenGuardKeys.add(v.id);
      continue; // 存量：已知债，不判红（但会被下面的「基线收紧」提示）
    }
    failures.push(v.msg + "（**新增**：不在判据⑧ 基线里 ⇒ 必须就地修，不要往基线里加）");
  }
  for (const id of guardBaselineKeys) {
    if (!seenGuardKeys.has(id)) {
      notes.push(
        `判据⑧ 基线里的 ${id} 已经不再违规 —— **请从 ${GUARD_READS_BASELINE_REL} 删掉它**` +
          `（棘轮只许变小）`,
      );
    }
  }

  // ── ⑨（R168）backlog 条目的**读取面快照**：漂移即红 ────────────────────
  //
  // ## 为什么需要这条（判据⑧ 的一处真盲区）
  //
  // 判据⑧ 只遍历 `entries`（18 条）⇒ 守卫侧登记表里的 **29 条 `coverageBacklog`**
  // **不在面内** ⇒ 那 29 条守卫脚本若发生「读取面漂移」（搬文件 / 改读法），
  // **没有任何东西会红**。
  //
  // ## 为什么**不能**给 backlog 条目补 `reads` 跑判据⑧（见本文件判据⑨ 段的完整说明）
  //
  // backlog 的语义是「**已知但未甄别**」—— 判据④（新增即红）**已经**把它当作
  // 「已登记」处理。给一条**尚未甄别**的债补 `reads` = 宣称「读取面已被核过」
  // ⇒ **降低门槛**。且 backlog 条目**天然没有 `reads`**（实测：字段并集 =
  // `id / spec / status / why / owner / reviewBy`）⇒ **正向核无从核起**。
  //
  // ## 判据⑨ 的形状（**只比「有没有变」，不比「对不对」**）
  //
  //   · 观测面（`observedReadSurface()`）：从守卫脚本源码里机器抽出的仓库路径字面量
  //     （去注释 / 去正则 / 去第三方依赖）。
  //   · 快照面（backlog 条目上的**可选**字段 `readSurface`）：当前冻结的观测面。
  //   · **不一致 ⇒ 红**（点名「多了什么 / 少了什么」）。
  //
  // ## 向后兼容（**不写就是旧行为，零影响**）
  //
  // 字段**可选**：现有 29 条**没写** ⇒ 该条**不进入**判据⑨ 的面内 ⇒ 行为不变。
  // 写了就按形状核：不是非空字符串数组 ⇒ **红**（不许静默忽略）。
  const backlogSurfaceViolations = [];
  let backlogSurfaceChecked = 0;
  for (const b of backlog) {
    const raw = b?.readSurface;
    if (raw === undefined || raw === null) continue; // 没写 = 旧行为（零影响）
    const id = String(b?.id ?? b?.spec ?? "?");
    if (!Array.isArray(raw) || raw.length === 0) {
      backlogSurfaceViolations.push(
        `${id} 的 readSurface 必须是**非空字符串数组**（没写 = 不进入判据⑨ 的面内；` +
          `写了就必须是真的读取面）`,
      );
      continue;
    }
    const bad = raw.filter((r) => typeof r !== "string" || !isRepoPathLiteral(r));
    if (bad.length > 0) {
      backlogSurfaceViolations.push(
        `${id} 的 readSurface 里有**不是仓库路径形态**的条目：${bad
          .map((b2) => JSON.stringify(b2))
          .join("、")} —— 只许仓库相对路径（apps/ packages/ scripts/ 开头，路径字符与 glob 元字符）`,
      );
      continue;
    }
    const spec = String(b?.spec ?? "");
    const abs = join(repoRoot, spec);
    // ⚠️ **不能**在这里静默 continue：backlog 条目**没有**「登记脚本必须存在」这条判据
    // （判据② 的漂移核只遍历 `entries`，不遍历 backlog）⇒「守卫脚本被搬走 / 删掉」
    // 这种**最典型的读取面漂移**在旧实现下**什么都不红**。进了判据⑨ 的面（写了
    // `readSurface`）就必须能核 —— 核不了（脚本没了）本身就是漂移。
    if (!existsSync(abs)) {
      backlogSurfaceViolations.push(
        `${id} 的 readSurface 已登记，但**守卫脚本不存在**：${spec} —— ` +
          `「读取面快照」核不了就是漂移（脚本被搬走 / 改名 / 删除？）。` +
          `修法：把 spec 改到新位置 + 重新冻结 readSurface；脚本真的不该存在时，` +
          `把这条从 coverageBacklog 移出并写明理由。`,
      );
      continue;
    }
    let text;
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      backlogSurfaceViolations.push(
        `${id} 的守卫脚本**读不到**：${spec} —— 读取面快照核不了（不是「没有漂移」）`,
      );
      continue;
    }
    backlogSurfaceChecked += 1;
    const observed = observedReadSurface(text);
    const want = new Set(raw.map((r) => String(r).trim().replace(/\/+$/, "")));
    const got = new Set(observed);
    const added = [...got].filter((x) => !want.has(x));
    const removed = [...want].filter((x) => !got.has(x));
    if (added.length || removed.length) {
      backlogSurfaceViolations.push(
        `${id}（${spec}）的**读取面漂移了** —— 观测面与快照面不一致：` +
          (added.length ? `新增读取 ${added.join("、")}；` : "") +
          (removed.length ? `不再读取 ${removed.join("、")}；` : "") +
          `backlog 条目的 readSurface 必须**跟着脚本一起更新**（它记的是「这个守卫脚本` +
          `提到了哪些路径」这个事实）。⚠️ 更新快照**不等于**这条已甄别 —— ` +
          `它仍需逐条甄别（分档 + 处置）才能进 entries。`,
      );
    }
  }
  failures.push(...backlogSurfaceViolations);

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
      readsBaseline: guardBaselineKeys.size,
      readsViolations: guardReadsViolations.length,
      backlogSurfaceChecked,
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

  // ── ⑧（R165）守卫侧 `reads` 事实一致性 ────────────────────────────────
  //
  // 四条用例覆盖判据⑧ 的**四个分叉**（与 spec 侧判据⑥ 的用例逐条同构）：
  //   ① 正向：reads 指向它**没提到**的文件 ⇒ 红；
  //   ② 反向：读了但**没登记** ⇒ 红；
  //   ③ 在基线里 ⇒ **不判红**（存量容忍）；
  //   ④ 读不到守卫侧基线文件 ⇒ 红（不许静默当成「没有存量」）。
  //
  // 这四条用**夹具仓库**（`repoRoot` 指向临时树），不用真仓库的 18 条登记 ——
  // 真仓库的存量在基线里（③ 那种情形），拿真仓库测 ①② 会**恒绿**（测不到东西）。
  /** 夹具里一个「守卫脚本读了实现源码」的最小样本。 */
  const guardScript = (relPath) =>
    [
      'import { readFileSync } from "node:fs";',
      `const src = readFileSync("${relPath}", "utf-8");`,
      "export default src;",
      "",
    ].join("\n");

  /** 守卫侧夹具仓库：`repoRoot` = 临时树，登记表 + 基线都在树里。 */
  const guardRepo = (over = {}) => {
    const files = {
      "apps/x/impl.ts": "export const A = 1;\n",
      "scripts/some-guard.mjs": guardScript("apps/x/impl.ts"),
      "scripts/guard-source-text-contracts.json": JSON.stringify(
        {
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
        },
        null,
        2,
      ),
      "scripts/guard-source-text-reads-baseline.json": JSON.stringify(
        over.guardReadsBaseline ?? { entries: [] },
        null,
        2,
      ),
      ...(over.extraFiles ?? {}),
    };
    if (over.omitGuardBaseline) delete files["scripts/guard-source-text-reads-baseline.json"];
    return makeFixtureRepo(files, { prefix: "stc-guard-" });
  };

  /** 在夹具树上跑**守卫侧**判据（只跑守卫侧登记表，不牵动 spec 侧）。 */
  const guardSideOn = (repo) =>
    checkGuardRegistry({
      repoRoot: repo.dir,
      registry: JSON.parse(
        readFileSync(join(repo.dir, "scripts", "guard-source-text-contracts.json"), "utf-8"),
      ),
      today: "2999-01-01",
    });

  ok("⑧-① 守卫侧 reads 指向它**没提到**的文件 ⇒ 红（正向核）", () => {
    const repo = guardRepo({ entry: { reads: ["apps/x/never-mentioned.ts"] } });
    try {
      const r = guardSideOn(repo);
      assert(
        r.failures.some(
          (f) =>
            f.includes("G-1 reads 登记了") &&
            f.includes("apps/x/never-mentioned.ts") &&
            f.includes("从未提到"),
        ),
        `应报正向不一致，实得：${JSON.stringify(r.failures)}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("⑧-② 守卫侧读了但**没登记** ⇒ 红（反向核）", () => {
    // 脚本真的读了 apps/x/impl.ts，但登记里写的是别的文件 ⇒ 反向核命中。
    const repo = guardRepo({
      entry: { reads: ["apps/x/other.ts"] },
      extraFiles: { "apps/x/other.ts": "export const B = 1;\n" },
    });
    try {
      const r = guardSideOn(repo);
      assert(
        r.failures.some(
          (f) =>
            f.includes("G-1 在 scripts/some-guard.mjs 里读了") &&
            f.includes("apps/x/impl.ts") &&
            f.includes("不在** reads 里"),
        ),
        `应报反向不一致，实得：${JSON.stringify(r.failures)}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("⑧-③ 守卫侧违规**在基线里** ⇒ 不判红（存量容忍）", () => {
    // 与 ①② 同一个「不登记就不一致」的树，**只多**一份基线 ⇒ 必须绿。
    // 这条钉住「基线是容忍存量」而不是「基线是第二个豁免通道」：
    // 反证手段 = 把基线文件删掉（见 ⑧-④）⇒ 立刻红。
    const repo = guardRepo({
      entry: { reads: ["apps/x/other.ts"] },
      extraFiles: { "apps/x/other.ts": "export const B = 1;\n" },
      guardReadsBaseline: { entries: ["G-1"] },
    });
    try {
      const r = guardSideOn(repo);
      assert(
        !r.failures.some((f) => f.includes("判据⑧")),
        `在基线里不该判红，实得：${JSON.stringify(r.failures)}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("⑧-④ **读不到**守卫侧基线文件 ⇒ 红（不许静默当成「没有存量」）", () => {
    // 树里**没有**基线文件 ⇒ 判红。反证：⑧-③ 同一棵树只多了基线文件就绿 ——
    // 两条合起来证明「读不到基线」与「没有存量」被**区分**了。
    const repo = guardRepo({
      entry: { reads: ["apps/x/other.ts"] },
      extraFiles: { "apps/x/other.ts": "export const B = 1;\n" },
      omitGuardBaseline: true,
    });
    try {
      const r = guardSideOn(repo);
      assert(
        r.failures.some(
          (f) =>
            f.includes("读不到 scripts/guard-source-text-reads-baseline.json") &&
            f.includes("判据⑧"),
        ),
        `应报「读不到基线」⇒ 红，实得：${JSON.stringify(r.failures)}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  // ── R166：三条新口径 + 一条路径规范化 ──────────────────────────────
  //
  // 判据⑥/⑧ 在 R166 各补了四条判据，每条都必须有**红演示**（放宽了口径的地方，
  // 必须证明新口径**仍然有牙** —— 否则「放宽」就是「关灯」）：
  //   ① 临时产物（mkdtemp/tmpdir 派生）不是「源码路径」，但**登记它 ⇒ 红**；
  //   ② 第三方依赖（node_modules/.venv 派生）不是「源码路径」，但**登记它 ⇒ 红**；
  //   ③ `readsVia`（数据驱动读取）：能核、且数据文件漂了会红；
  //   ④ glob 必须机器可解析 + 必须展开得到 ≥1 个文件；
  //   ⑤ 路径规范化（`a/../b` == `b`）—— 两侧共用同一个函数。
  const analyze = (entry, text, repoRoot, side = "spec") =>
    analyzeReadsConsistency({ entry, text, repoRoot, side });

  ok("R166-① 临时产物（mkdtemp 派生）不进反向核，但**登记它 ⇒ 红**", () => {
    const text = [
      'import { mkdtempSync } from "node:fs";',
      'import { join } from "node:path";',
      'const tmpRoot = mkdtempSync(join(tmpdir(), "x-"));',
      'const destDir = join(tmpRoot, "out");',
      'const src = readFileSync(join(destDir, "main.py"), "utf8");',
      "",
    ].join("\n");
    const entry = { id: "T-1", spec: "apps/x.spec.ts", reads: ["apps/x/impl.ts"] };
    // ① 反向核**不**要求登记 `main.py`（它是 zip 条目名 / 解压产物名）
    const clean = analyze(entry, text, REPO_ROOT);
    assert(
      !clean.some((v) => v.msg.includes("main.py")),
      `临时产物不该被反向核要求登记，实得：${JSON.stringify(clean.map((v) => v.msg))}`,
    );
    // ② 但**登记**它 ⇒ 红（正向核不许假登记过关 —— 这条牙保住「正向核没被削弱」）
    const lying = analyze(
      { ...entry, reads: ["apps/x/impl.ts", "main.py"] },
      text,
      REPO_ROOT,
    );
    assert(
      lying.some((v) => v.msg.includes("main.py") && v.msg.includes("临时解压产物名")),
      `登记临时产物必须判红，实得：${JSON.stringify(lying.map((v) => v.msg))}`,
    );
  });

  ok("R166-② 第三方依赖（node_modules 派生）不进反向核，但**登记它 ⇒ 红**", () => {
    const text = [
      'import { join } from "node:path";',
      'const TYPEORM = join(ADMIN_API, "node_modules", "typeorm");',
      'const src = readFileSync(join(TYPEORM, "persistence", "SubjectExecutor.js"), "utf8");',
      "",
    ].join("\n");
    const entry = { id: "T-1", spec: "apps/x.spec.ts", reads: ["apps/x/impl.ts"] };
    const clean = analyze(entry, text, REPO_ROOT);
    assert(
      !clean.some((v) => v.msg.includes("SubjectExecutor.js")),
      `第三方依赖不该被反向核要求登记，实得：${JSON.stringify(clean.map((v) => v.msg))}`,
    );
    const lying = analyze(
      { ...entry, reads: ["apps/x/impl.ts", "SubjectExecutor.js"] },
      text,
      REPO_ROOT,
    );
    assert(
      lying.some((v) => v.msg.includes("node_modules") && v.msg.includes("第三方依赖")),
      `登记第三方依赖必须判红，实得：${JSON.stringify(lying.map((v) => v.msg))}`,
    );
  });

  ok("R166-③ `readsVia`：间接读取被认可，且**数据文件漂了 ⇒ 红**", () => {
    // 夹具：守卫脚本只提「登记表」，真实目标在数据文件里。
    const files = {
      "apps/x/impl.ts": "export const A = 1;\n",
      "scripts/data-registry.json": JSON.stringify({
        entries: [{ id: "e1", targets: [{ file: "apps/x/impl.ts" }] }],
      }),
      "scripts/some-guard.mjs": [
        'import { readFileSync } from "node:fs";',
        'const reg = JSON.parse(readFileSync("scripts/data-registry.json", "utf-8"));',
        "export default reg;",
        "",
      ].join("\n"),
    };
    const repo = makeFixtureRepo(files, { prefix: "stc-readsvia-" });
    try {
      const entry = {
        id: "G-1",
        spec: "scripts/some-guard.mjs",
        reads: ["apps/x/impl.ts"],
        readsVia: [
          { file: "scripts/data-registry.json", key: "entries.*.targets.*.file", expect: ["apps/x/impl.ts"] },
        ],
      };
      const text = readFileSync(join(repo.dir, "scripts", "some-guard.mjs"), "utf-8");
      const ok = analyze(entry, text, repo.dir, "guard");
      assert(
        ok.length === 0,
        `readsVia 应当核得过，实得：${JSON.stringify(ok.map((v) => v.msg))}`,
      );
      // 牙①：数据文件里多了一个 target，登记没同步 ⇒ 红
      writeFileSync(
        join(repo.dir, "scripts", "data-registry.json"),
        JSON.stringify({
          entries: [
            { id: "e1", targets: [{ file: "apps/x/impl.ts" }] },
            { id: "e2", targets: [{ file: "apps/x/other.ts" }] },
          ],
        }),
      );
      const drifted = analyze(entry, text, repo.dir, "guard");
      assert(
        drifted.some((v) => v.msg.includes("与 expect 不一致")),
        `数据文件漂了必须判红，实得：${JSON.stringify(drifted.map((v) => v.msg))}`,
      );
      // 牙②：key 写错（取不到目标）⇒ 红（不许静默忽略）
      const badKey = analyze(
        { ...entry, readsVia: [{ file: "scripts/data-registry.json", key: "entries.*.nope" }] },
        text,
        repo.dir,
        "guard",
      );
      assert(
        badKey.some((v) => v.msg.includes("取不到任何字符串目标")),
        `key 写错必须判红，实得：${JSON.stringify(badKey.map((v) => v.msg))}`,
      );
      // 牙③：数据文件不存在 ⇒ 红（登记表腐烂）
      const missing = analyze(
        { ...entry, readsVia: [{ file: "scripts/nope.json", key: "entries.*.targets.*.file" }] },
        text,
        repo.dir,
        "guard",
      );
      assert(
        missing.some((v) => v.msg.includes("数据文件不存在")),
        `数据文件不存在必须判红，实得：${JSON.stringify(missing.map((v) => v.msg))}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("R167 spec-glob：spec 上的 glob 机器不可解析 ⇒ 红；展开不到文件 ⇒ 红（死 glob）", () => {
    // R167：`spec` 上的 glob 此前**没有**牙 ⇒ 人话 glob（如 STC-005 原值）匹配不到任何文件 ⇒
    // 那条登记在判据④面前**完全不可见**（既挡不住新增的未登记 spec，也挡不住自己）。
    // 这两条用例把「spec 侧的 glob」与「reads 侧的 glob」拉到**同一口径**。
    const repo = makeFixtureRepo({
      "scripts/source-text-contracts.json": JSON.stringify({
        owner: "fixture",
        reviewBy: "2999-01-01",
        entries: [
          {
            id: "T-glob-human",
            tier: "P2",
            spec: "apps/x/__tests__/*.spec.ts（约 12+ 处）",
            specLine: 1,
            needle: "readFileSync",
            reads: ["apps/x/impl.ts"],
            asserts: "fixture",
            disposition: "keep-and-accept",
            dispositionNote: "fixture",
            owner: "fixture",
            reviewBy: "2999-01-01",
          },
        ],
        coverageBacklog: [],
      }, null, 2),
      "scripts/guard-source-text-contracts.json": JSON.stringify({
        owner: "fixture",
        reviewBy: "2999-01-01",
        entries: [],
        coverageBacklog: [],
      }, null, 2),
      "scripts/source-text-reads-baseline.json": JSON.stringify({ entries: [] }, null, 2),
      "scripts/guard-source-text-reads-baseline.json": JSON.stringify({ entries: [] }, null, 2),
      "apps/x/impl.ts": "export const A = 1;\n",
    }, { prefix: "stc-specglob-" });
    try {
      const r = check({
        repoRoot: repo.dir,
        registry: JSON.parse(
          readFileSync(join(repo.dir, "scripts/source-text-contracts.json"), "utf-8"),
        ),
        today: "2026-11-04",
      });
      const human = r.failures.some((f) => f.includes("不是一个机器可解析的 glob"));
      if (!human) {
        throw new Error("spec 里的**人话 glob**（含中文）必须红 —— 否则它在判据④面前不可见");
      }
    } finally {
      repo.cleanup();
    }
    // 死 glob：机器可解析但匹配 0 个文件
    const repo2 = makeFixtureRepo({
      "scripts/source-text-contracts.json": JSON.stringify({
        owner: "fixture",
        reviewBy: "2999-01-01",
        entries: [
          {
            id: "T-glob-dead",
            tier: "P2",
            spec: "apps/x/__tests__/*.spec.ts",
            specLine: 1,
            needle: "readFileSync",
            reads: ["apps/x/impl.ts"],
            asserts: "fixture",
            disposition: "keep-and-accept",
            dispositionNote: "fixture",
            owner: "fixture",
            reviewBy: "2999-01-01",
          },
        ],
        coverageBacklog: [],
      }, null, 2),
      "scripts/guard-source-text-contracts.json": JSON.stringify({
        owner: "fixture",
        reviewBy: "2999-01-01",
        entries: [],
        coverageBacklog: [],
      }, null, 2),
      "scripts/source-text-reads-baseline.json": JSON.stringify({ entries: [] }, null, 2),
      "scripts/guard-source-text-reads-baseline.json": JSON.stringify({ entries: [] }, null, 2),
      "apps/x/impl.ts": "export const A = 1;\n",
    }, { prefix: "stc-specglob2-" });
    try {
      const r = check({
        repoRoot: repo2.dir,
        registry: JSON.parse(
          readFileSync(join(repo2.dir, "scripts/source-text-contracts.json"), "utf-8"),
        ),
        today: "2026-11-04",
      });
      const dead = r.failures.some((f) => f.includes("死 glob"));
      if (!dead) {
        throw new Error("spec 里的**死 glob**（匹配 0 个文件）必须红");
      }
    } finally {
      repo2.cleanup();
    }
  });

  ok("R166-④ glob：机器不可解析 ⇒ 红；**展开不到文件** ⇒ 红（死 glob）", () => {
    const entry = (reads) => ({ id: "T-1", spec: "apps/x.spec.ts", reads });
    // ① 一句人话塞在 glob 位置 ⇒ 红（这不是 glob，是不可核的描述）
    const prose = analyze(
      entry(["apps/admin-api/src/**（递归遍历全部实现文件）"]),
      "",
      REPO_ROOT,
    );
    assert(
      prose.some((v) => v.msg.includes("不是一个机器可解析的 glob")),
      `人话 glob 必须判红，实得：${JSON.stringify(prose.map((v) => v.msg))}`,
    );
    // ② 死 glob（匹配 0 个文件）⇒ 红
    const dead = analyze(entry(["apps/definitely-not-here/**/*.ts"]), "", REPO_ROOT);
    assert(
      dead.some((v) => v.msg.includes("匹配不到任何文件")),
      `死 glob 必须判红，实得：${JSON.stringify(dead.map((v) => v.msg))}`,
    );
    // ③ 真 glob ⇒ 绿（口径没把正常的 glob 也打掉）
    const good = analyze(entry(["apps/admin-api/src/**/*.ts"]), "", REPO_ROOT);
    assert(
      !good.some((v) => v.msg.includes("glob")),
      `正常 glob 不该被判红，实得：${JSON.stringify(good.map((v) => v.msg))}`,
    );
  });

  ok("R166-⑤ 路径规范化：`a/../b` 与 `b` 是**同一个文件**（两侧共用同一函数）", () => {
    // 事实：`scripts/agent-sop-check.mjs` 真的有一处
    //   readFileSync(join(apiDir, "src/modules/sop/../sop/sop.service.ts"))
    // 而登记写的是 `apps/admin-api/src/modules/sop/sop.service.ts` ⇒ 旧实现覆盖不上（红）。
    const text = [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const src = readFileSync(join(apiDir, "src/modules/sop/../sop/sop.service.ts"), "utf8");',
      "",
    ].join("\n");
    const entry = {
      id: "T-1",
      spec: "apps/x.spec.ts",
      reads: ["apps/admin-api/src/modules/sop/sop.service.ts"],
    };
    const v = analyze(entry, text, REPO_ROOT);
    assert(
      !v.some((x) => x.msg.includes("sop.service.ts")),
      `规范化后应覆盖得上，实得：${JSON.stringify(v.map((x) => x.msg))}`,
    );
    // 牙：规范化**不能**变成「什么都能覆盖」—— 另一个文件仍然要红
    const other = analyze({ ...entry, reads: ["apps/admin-api/src/modules/sop/other.ts"] }, text, REPO_ROOT);
    assert(
      other.some((x) => x.msg.includes("不在") && x.msg.includes("reads 里")),
      `规范化不许放宽成「什么都能覆盖」，实得：${JSON.stringify(other.map((x) => x.msg))}`,
    );
  });

  ok("R166-⑥ 正向核**没有被削弱**：登记一个**不存在的文件** ⇒ 仍红", () => {
    // 这条是本轮所有放宽（临时产物 / 第三方 / readsVia / glob / 规范化）的**总反证**：
    // 任何一条放宽都不许把「登记了它根本不读的文件」变成绿灯。
    const text = [
      'import { readFileSync } from "node:fs";',
      'const src = readFileSync("apps/x/impl.ts", "utf-8");',
      "",
    ].join("\n");
    const entry = {
      id: "T-1",
      spec: "apps/x.spec.ts",
      reads: ["apps/x/impl.ts", "apps/x/does-not-exist.ts"],
    };
    const v = analyze(entry, text, REPO_ROOT);
    assert(
      v.some((x) => x.msg.includes("does-not-exist.ts") && x.msg.includes("从未提到")),
      `登记不存在的文件必须仍判红，实得：${JSON.stringify(v.map((x) => x.msg))}`,
    );
  });

  ok("R166-⑦ bare extension（`.ts`）不算「源码路径」（后缀过滤不是路径）", () => {
    const text = [
      'const src = readFileSync(p, "utf8");',
      'if (e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(read(full));',
      "",
    ].join("\n");
    const a = analyzeReadLines(text);
    assert(
      !a.literals.has(".ts") && !a.literals.has(".d.ts"),
      `bare extension 不该算字面量，实得：${JSON.stringify([...a.literals])}`,
    );
  });

  // ── R168：判据⑨（backlog 条目的**读取面快照**）──────────────────────────
  //
  // 三条用例，覆盖判据⑨ 的**三个方向**：
  //   ① **正向（有牙）**：backlog 里的守卫脚本读了**未登记**的文件 ⇒ 红（漂移被抓住）。
  //   ② **反向（门槛没被降低）**：backlog 条目**仍未甄别** ⇒ 它**仍在 backlog 里**、
  //      **没有**被当成已甄别（没有 `tier`/`disposition` ⇒ 不会被误当 entries）。
  //   ③ **向后兼容（不写就是旧行为）**：没写 `readSurface` ⇒ 该条**不进入**判据⑨ 的面内。
  //
  // 判据⑨ 的**观察面**在夹具树里自造一个「守卫脚本」，避免依赖真仓库的 29 条。
  const backlogRepo = (over = {}) => {
    const files = {
      "apps/x/impl.ts": "export const A = 1;\n",
      "apps/x/other.ts": "export const B = 1;\n",
      // 守卫脚本：读 apps/x/impl.ts
      "scripts/some-guard.mjs": [
        'import { readFileSync } from "node:fs";',
        'const src = readFileSync("apps/x/impl.ts", "utf-8");',
        "export default src;",
        "",
      ].join("\n"),
      // 另一条**已甄别**的登记（让 entries 非空 —— 判据①「entries 为空 ⇒ 红」）
      "scripts/other-guard.mjs": [
        'import { readFileSync } from "node:fs";',
        'const src = readFileSync("apps/x/impl.ts", "utf-8");',
        "export default src;",
        "",
      ].join("\n"),
      "scripts/guard-source-text-contracts.json": JSON.stringify(
        {
          owner: "fixture",
          reviewBy: "2999-01-01",
          entries: [
            {
              id: "G-1",
              tier: "P1",
              spec: "scripts/other-guard.mjs",
              specLine: 2,
              needle: 'readFileSync("apps/x/impl.ts", "utf-8")',
              reads: ["apps/x/impl.ts"],
              asserts: "fixture",
              disposition: "keep-and-accept",
              dispositionNote: "fixture",
              owner: "fixture",
              reviewBy: "2999-01-01",
            },
          ],
          coverageBacklog: [
            {
              id: "B-1",
              spec: "scripts/some-guard.mjs",
              status: "待深审",
              why: "fixture",
              owner: "fixture",
              reviewBy: "2999-01-01",
              ...(over.backlog ?? {}),
            },
          ],
        },
        null,
        2,
      ),
      "scripts/guard-source-text-reads-baseline.json": JSON.stringify(
        { entries: [] },
        null,
        2,
      ),
      ...(over.extraFiles ?? {}),
    };
    return makeFixtureRepo(files, { prefix: "stc-backlog-" });
  };

  const backlogSideOn = (repo) =>
    checkGuardRegistry({
      repoRoot: repo.dir,
      registry: JSON.parse(
        readFileSync(join(repo.dir, "scripts", "guard-source-text-contracts.json"), "utf-8"),
      ),
      today: "2999-01-01",
    });

  ok("R168-① 判据⑨：backlog 里的守卫脚本读了**未登记**的文件 ⇒ 红（漂移被抓住）", () => {
    // 快照只记了 apps/x/impl.ts；脚本后来又多读了一个 apps/x/other.ts ⇒ 漂移 ⇒ 红。
    const repo = backlogRepo({
      backlog: { readSurface: ["apps/x/impl.ts"] },
      extraFiles: {
        "scripts/some-guard.mjs": [
          'import { readFileSync } from "node:fs";',
          'const a = readFileSync("apps/x/impl.ts", "utf-8");',
          'const b = readFileSync("apps/x/other.ts", "utf-8");',
          "export default a + b;",
          "",
        ].join("\n"),
      },
    });
    try {
      const r = backlogSideOn(repo);
      assert(
        r.failures.some(
          (f) =>
            f.includes("B-1") &&
            f.includes("读取面漂移") &&
            f.includes("apps/x/other.ts"),
        ),
        `backlog 守卫脚本多读一个文件必须判红，实得：${JSON.stringify(r.failures)}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("R168-② 判据⑨ 的门槛**没有**被降低：backlog 条目仍未甄别 ⇒ 仍在 backlog、没被当成已甄别", () => {
    // 反向用例：判据⑨ **只**冻结「读取面」，**不**给分档、**不**给处置方式 ——
    // backlog 条目在读Surface 正确时仍**没有** tier / disposition（= 未甄别），
    // 且它**仍在 coverageBacklog 里**（判据⑨ 不许把它移进 entries）。
    const repo = backlogRepo({
      backlog: { readSurface: ["apps/x/impl.ts"] },
    });
    try {
      const r = backlogSideOn(repo);
      assert(
        r.failures.length === 0,
        `快照与观测面一致时不该红，实得：${JSON.stringify(r.failures)}`,
      );
      const reg = JSON.parse(
        readFileSync(join(repo.dir, "scripts", "guard-source-text-contracts.json"), "utf-8"),
      );
      const b = reg.coverageBacklog[0];
      assert(
        b.status === "待深审",
        `backlog 条目必须仍是「待深审」（判据⑨ 不许把未甄别当成已甄别），实得 ${b.status}`,
      );
      assert(
        b.tier === undefined && b.disposition === undefined,
        "backlog 条目不许被补上 tier/disposition（那会伪装成已甄别）",
      );
      assert(
        reg.coverageBacklog.length === 1,
        "backlog 条目必须**留在** coverageBacklog 里（判据⑨ 只冻结读取面，不做甄别）",
      );
      assert(
        !reg.entries.some((e) => e.spec === "scripts/some-guard.mjs"),
        "backlog 条目不许被挪进 entries（判据⑨ 只冻结读取面，不做甄别）",
      );
      assert(
        r.stats.backlog === 1 && r.stats.backlogSurfaceChecked === 1,
        `backlog 统计须仍然把它算作 backlog（未甄别），实得 ${JSON.stringify(r.stats)}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("R168-③ 判据⑨ **向后兼容**：backlog 条目没写 readSurface ⇒ 不进入面内（零影响）", () => {
    // 没写 = 旧行为（该条不进判据⑨ 的面内）⇒ 即使脚本读了别的文件也不红。
    const repo = backlogRepo({
      extraFiles: {
        "scripts/some-guard.mjs": [
          'import { readFileSync } from "node:fs";',
          'const a = readFileSync("apps/x/impl.ts", "utf-8");',
          'const b = readFileSync("apps/x/other.ts", "utf-8");',
          "export default a + b;",
          "",
        ].join("\n"),
      },
    });
    try {
      const r = backlogSideOn(repo);
      assert(
        !r.failures.some((f) => f.includes("读取面漂移")),
        `没写 readSurface 的条目不该进判据⑨ 的面内，实得：${JSON.stringify(r.failures)}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("R168-④ 判据⑨：readSurface 形状不合法 ⇒ 红（不许静默忽略）", () => {
    const repo = backlogRepo({ backlog: { readSurface: [] } });
    try {
      const r = backlogSideOn(repo);
      assert(
        r.failures.some((f) => f.includes("readSurface 必须是**非空字符串数组**")),
        `readSurface 形状不合法必须判红，实得：${JSON.stringify(r.failures)}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("R168-④b 判据⑨：登记了 readSurface 但**守卫脚本被搬走** ⇒ 红（核不了 = 漂移，不是「没问题」）", () => {
    // 这条钉住一处**真盲区**：backlog 条目**没有**「脚本必须存在」的判据
    // （判据② 的漂移核只遍历 entries）⇒ 旧实现下「脚本被搬走」什么都不红。
    const repo = backlogRepo({
      backlog: { readSurface: ["apps/x/impl.ts"], spec: "scripts/moved-away.mjs" },
    });
    try {
      const r = backlogSideOn(repo);
      assert(
        r.failures.some(
          (f) => f.includes("守卫脚本不存在") && f.includes("scripts/moved-away.mjs"),
        ),
        `登记了 readSurface 但脚本不存在必须判红，实得：${JSON.stringify(r.failures)}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  ok("R168-⑤ 观测面：注释里的路径**不算**事实；正则字面量不算", () => {
    // 「注释里提到过」≠「读过」—— 若把注释当事实，快照一开始就是假的。
    const text = [
      'import { readFileSync } from "node:fs";',
      "// 曾经读过 apps/x/commented-out.ts（已删除）",
      "/* 块注释里也提过 apps/x/block-comment.ts */",
      'const re = /apps\\/x\\/regex-not-a-path\\.ts/;',
      'const src = readFileSync("apps/x/impl.ts", "utf-8");',
      "export default src;",
      "",
    ].join("\n");
    const obs = observedReadSurface(text);
    assert(
      obs.includes("apps/x/impl.ts"),
      `真实读到的路径必须在观测面里，实得：${JSON.stringify(obs)}`,
    );
    assert(
      !obs.some((o) => o.includes("commented-out") || o.includes("block-comment") || o.includes("regex-not-a-path")),
      `注释/正则里的路径不算事实，实得：${JSON.stringify(obs)}`,
    );
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
      // R165：夹具里的守卫脚本必须**真的读到**它登记的那个文件（判据⑧ 的正向核）。
      // 夹具若只是「登记了但脚本不提」⇒ 合规夹具自己就带着一条新增违规，
      // 于是「CLI --root=<合规夹具> ⇒ 0」这条用例测不到任何东西。
      "scripts/some-guard.mjs": [
        'import { readFileSync } from "node:fs";',
        'const src = readFileSync("apps/x/impl.ts", "utf-8");',
        "export default src;",
        "",
      ].join("\n"),
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
      // R165：判据⑧ 的守卫侧基线同样**必须**落在夹具里（理由同上）。
      "scripts/guard-source-text-reads-baseline.json": JSON.stringify(
        over.guardReadsBaseline ?? { entries: [] },
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
