#!/usr/bin/env node
/**
 * 「无上限的增长」守卫 —— 治「**代码只增不减，没有任何东西会说停**」这一**类**。
 *
 * ## 这不是拆分指令
 *
 * 本守卫**不**说「这个文件该拆成几块」。它说的是：**一个文件/一个函数继续长大时，
 * 必须有人签字**。阈值刻意定得比现状宽松得多（900 行 error 对应的四个已知文件都
 * 在 3000–10000 行量级），所以它平时**不会**对任何正常开发产生摩擦；它只在两种时刻响：
 *   ① 有人把某个文件推到离群值（第一次出现时没人注意到，等注意到时已经拆不动了）；
 *   ② 有人把已经在基线里的文件**继续变大**（棘轮只能往一个方向转）。
 *
 * ## 判据（JS/TS；每个被扫文件）
 *
 *   · **非注释行** > `MAX_LINES_ERROR`(900) ⇒ error；> `MAX_LINES_WARN`(600) ⇒ warn。
 *     **注释不算**：一个 900 行的文件里若有 400 行注释，它不是 900 行的代码问题。
 *     （注释剥离见 `scanSource` 的状态机；`//` 出现在字符串里不会被误判。）
 *   · **单个函数体** > `MAX_FUNCTION_LINES`(300) ⇒ error。
 *   · **`@Injectable` 类的构造器位置参数** > `MAX_CTOR_PARAMS_WARN`(5) ⇒ warn；
 *     > `MAX_CTOR_PARAMS_ERROR`(8) ⇒ error。（位置参数是这个代码库里 DI 的公认痛点：
 *     参数越多，「加一个依赖」越容易错位；改成 options 对象是可选的，不强制。）
 *   · **export 数** > `MAX_EXPORTS`(25) ⇒ warn（一个模块对外暴露 25 个东西，
 *     它已经不是「一个模块」了）。
 *   · **分支密度**（判定点 / 非注释行 × 100）> `MAX_BRANCH_DENSITY`(20) ⇒ warn。
 *     判定点 = `if` / `else if` / `for` / `while` / `case` / `catch` / `&&` / `||` /
 *     `??` / 三元 `?`；**注释与字符串字面量里的这些符号不算**（`"a && b"` 不是判定点）。
 *
 * ## 例外路径（显式排除，不静默）
 *
 * 路径含 `generated`、`.d.ts` 结尾、`dist/`、`locales/`、`node_modules`、`.venv`、
 * `build/`、`coverage/`、`__pycache__`、`.git`。
 * 生成物与本地化的行数不是人写的，判它没有意义；但**必须显式列出来**，
 * 不能靠「正好没扫到」。
 *
 * ## `ALLOW:` 行内豁免（照抄 check-image-pinned.mjs 的先例）
 *
 * 在触发违规的**那一行**、或该文件**头部注释块**里写 `ALLOW: <理由>`（理由 ≥
 * `MIN_ALLOW_REASON`(12) 字符）。`ALLOW:` 后面没理由 ⇒ **仍然红**，并且错误文案点名
 * 「豁免缺理由」——光秃秃的 `ALLOW:` 只是判据的关灯键，不是豁免。
 * 豁免**逐条列出**（报告里单列一节，可见，不静默）。
 *
 * **作用域**：文件级度量（非注释行 / export 数 / 分支密度）只认**头部注释块**里的
 * `ALLOW:`；行级度量（函数体 / 构造器参数）认**自己那一行**的 `ALLOW:`，其次头部。
 * 文件**中段**随手写的 `ALLOW:` 不能给文件级判据开免检（否则豁免作用域失控）。
 *
 * ## 基线 `scripts/source-size-baseline.json`：**只减不增（棘轮）**
 *
 * 条目形状：`{ "<仓库相对路径>": { "maxLines": <int>, "why": "<一句>" } }`，
 * 可选扩展字段 `ceiling: { nonCommentLines, functionLines, ctorParams, exports, branchDensity }`
 * （逐项签字；为什么需要见 `check()` 里的注释）。
 *
 *   · 文件在基线里 ⇒ 非注释行 ≤ 基线的 `maxLines` 时只 warn（不再 error）；
 *     超过 `maxLines` ⇒ error（棘轮：只能变小，不能变大）。
 *   · 基线里的文件**已降回** `MAX_LINES_WARN`(600) 以内 ⇒ **红**，要求把这条从基线删掉
 *     （文案点名「该从基线删除」）。这是「逼棘轮收紧」的那一条：不删，基线就成了永久豁免。
 *   · 基线里的路径**已不存在** ⇒ 红。
 *   · 基线条目数 < `MIN_BASELINE_ENTRIES`(1) ⇒ 结构红（空基线 = 棘轮没了）；
 *     > `MAX_BASELINE_ENTRIES` ⇒ 结构红（基线不许变成关灯键）。
 *
 * 首跑已知红项（**直接落基线，不改源码迁就守卫**）—— 任务书给的 4 个路径
 * `apps/executor-node/src/services/*.ts` 在本仓**并不存在**（那是旧布局）；实测同名文件
 * 在 `apps/admin-api/src/modules/` 下，全文件总行数与任务书一致（8518 / 10406 / 8798 /
 * 3032），但**非注释行数**更小，基线按**实测非注释行数**登记。首跑还有大量别的文件
 * 超阈值（实测 97 条），一并如实登记 —— 见基线 `$comment`。
 *
 * ## 反永真
 *
 *   · 扫到的文件数 < `MIN_FILES`(500) ⇒ 结构红；
 *   · 一个函数都没解析出来 ⇒ 结构红（解析器失效不能算「全干净」）；
 *   · 一个 `@Injectable` 都没找到 ⇒ 结构红（同上：这个仓有成百个）。
 *
 * ## 未纳入（诚实边界）
 *
 *   · 只扫 `.ts/.tsx/.js/.mjs/.cjs`。Python 侧（`apps/executor-python` 有 5000+ 行的
 *     `routers/*.py`）的行数上限**未纳入本守卫**，由既有 lint 闸负责 —— 本轮**未验证**
 *     既有 lint 是否真有行数上限。这是已知缺口，不是「已验证没问题」。
 *
 * ## 用法
 *
 *   node scripts/check-size-caps.mjs [--report] [--selftest] [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

/** 基线文件。 */
export const BASELINE_REL = "scripts/source-size-baseline.json";

/** 非注释行数阈值。 */
export const MAX_LINES_ERROR = 900;
export const MAX_LINES_WARN = 600;
/** 单个函数体行数上限。 */
export const MAX_FUNCTION_LINES = 300;
/** `@Injectable` 构造器位置参数。 */
export const MAX_CTOR_PARAMS_WARN = 5;
export const MAX_CTOR_PARAMS_ERROR = 8;
/** 单文件 export 数。 */
export const MAX_EXPORTS = 25;
/** 分支密度（每 100 非注释行的判定点数）。 */
export const MAX_BRANCH_DENSITY = 20;
/** `ALLOW:` 理由的最小长度。 */
export const MIN_ALLOW_REASON = 12;
/**
 * 基线条目数上限（防「基线 = 关灯键」）。
 *
 * 钉在**首跑实测条数（97，2026-11-04）**：等于「这套基线今天能签字的最大规模」。
 * 语义是**不许新增**——想给一个新的大文件签字，必须先把另一条删掉（换位）。
 * 这条刻意做得很硬：基线唯一的合法演化方向是变小。
 */
export const MAX_BASELINE_ENTRIES = 97;
/**
 * 基线条目数下限（空基线 = 棘轮没了）。
 *
 * 下限 1：本仓已知有超大文件（首跑实测 97 条），基线为空 ⇒ 那些文件立刻红，
 * 且「把第一条加进去」的起点必须是存在的。空基线不是「还没开始」，是「忘了登记」。
 */
export const MIN_BASELINE_ENTRIES = 1;
/** 扫描面下界（2026-11-04 实测：apps/ + packages/ 下 JS/TS 源码约 1400 个）。 */
export const MIN_FILES = 500;

/**
 * 度量的阈值表。`warn` / `error` 两级；基线（见 `BASELINE_REL`）按**度量名**逐项给上限。
 *
 * 为什么要逐项：只按「非注释行」落基线的话，`main.ts` 的 `bootstrap()` 有 417 行、
 * `executor.service.ts` 的构造器有 21 个位置参数 —— 这两个文件行数也许没超，
 * 但函数体/构造器超了。行数基线管不到它们，守卫就会**永远红**，然后被整体关掉。
 */
export const THRESHOLDS = {
  nonCommentLines: { warn: MAX_LINES_WARN, error: MAX_LINES_ERROR, label: "非注释行" },
  functionLines: { warn: MAX_FUNCTION_LINES, error: MAX_FUNCTION_LINES, label: "最长函数体行数" },
  ctorParams: { warn: MAX_CTOR_PARAMS_WARN, error: MAX_CTOR_PARAMS_ERROR, label: "构造器位置参数" },
  // export 数与分支密度**只 warn**：它们的「阈值」本身是启发式，拿来判红会把
  // 「工具模块导出 26 个函数」这种完全正常的代码拦下来。行数/函数体/构造器才是硬指标。
  exports: { warn: MAX_EXPORTS, error: Number.POSITIVE_INFINITY, label: "export 数" },
  branchDensity: { warn: MAX_BRANCH_DENSITY, error: Number.POSITIVE_INFINITY, label: "分支密度" },
};

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "dist",
  "build",
  "coverage",
  "generated",
  "locales",
  "__pycache__",
  ".git",
  ".next",
  ".turbo",
]);
/**
 * 扫描根。**只有 apps/ 与 packages/**：那里是产品源码。
 * `scripts/` 是本仓的守卫与工具脚本，判据（`@Injectable` 构造器 / export 数）对它们没有意义，
 * 而它们的分支密度天然很高（守卫就是一堆判定）—— 扩进来只会制造噪声，噪声源一定会被加进豁免。
 * 这个取舍写在这里，避免下一轮有人「顺手把 scripts 加进来」又不知道为什么红。
 */
const SCAN_ROOTS = ["apps", "packages"];

/** 判「今天」用的 UTC 日序号（与 review_by 的 YYYY-MM-DD 同形，可直接比较）。 */
function todayDay() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
}

const toPosix = (p) => p.split(sep).join("/");

/** 例外路径（显式，不静默）：命中即跳过。 */
export function isExemptPath(rel) {
  if (rel.endsWith(".d.ts")) return true;
  if (rel.split("/").some((seg) => SKIP_DIRS.has(seg))) return true;
  return rel.includes("generated");
}

/**
 * 扫描一段 JS/TS 源码：非注释行数 + 逐行代码/注释标记。
 *
 * 状态机处理 `//`、`/* *\/`、单双引号字符串、模板字符串（含 `${}` 嵌套按字符跳过即可，
 * 目的是不把字符串里的 `//` 当注释）。
 *
 * @returns {{lines: string[], hasCode: boolean[], nonCommentLines: number}}
 */
export function scanSource(text) {
  const src = String(text ?? "");
  const lines = src.split(/\r?\n/);
  const hasCode = new Array(lines.length).fill(false);
  let state = "normal"; // normal | line | block | sq | dq | tpl
  let lineIndex = 0;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "\n") {
      // 行注释在换行处结束
      if (state === "line") state = "normal";
      lineIndex += 1;
      continue;
    }

    if (state === "normal") {
      if (ch === "/" && next === "/") {
        state = "line";
        i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        i += 1;
        continue;
      }
      if (ch === "'") {
        state = "sq";
        if (ch.trim() !== "") hasCode[lineIndex] = true;
        continue;
      }
      if (ch === '"') {
        state = "dq";
        if (ch.trim() !== "") hasCode[lineIndex] = true;
        continue;
      }
      if (ch === "`") {
        state = "tpl";
        if (ch.trim() !== "") hasCode[lineIndex] = true;
        continue;
      }
      if (ch.trim() !== "") hasCode[lineIndex] = true;
      continue;
    }

    if (state === "line") continue;
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "normal";
        i += 1;
      }
      continue;
    }
    // 字符串状态
    if (ch === "\\") {
      i += 1; // 跳过转义字符
      continue;
    }
    if (state === "sq" && ch === "'") {
      state = "normal";
      continue;
    }
    if (state === "dq" && ch === '"') {
      state = "normal";
      continue;
    }
    if (state === "tpl" && ch === "`") {
      state = "normal";
    }
  }

  const nonCommentLines = hasCode.filter(Boolean).length;
  return { lines, hasCode, nonCommentLines };
}

/** 从 `openIndex`（指向 `{`）开始做括号匹配，返回配对的 `}` 索引；失败返回 -1。 */
function matchBrace(text, openIndex) {
  let depth = 0;
  let state = "normal";
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (state === "normal") {
      if (ch === "/" && text[i + 1] === "/") {
        const nl = text.indexOf("\n", i);
        if (nl < 0) return -1;
        i = nl;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) return -1;
        i = end + 1;
        continue;
      }
      if (ch === "'") { state = "sq"; continue; }
      if (ch === '"') { state = "dq"; continue; }
      if (ch === "`") { state = "tpl"; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
      continue;
    }
    if (ch === "\\") { i += 1; continue; }
    if (state === "sq" && ch === "'") state = "normal";
    else if (state === "dq" && ch === '"') state = "normal";
    else if (state === "tpl" && ch === "`") state = "normal";
  }
  return -1;
}

const CONTROL_RE = /^\s*(?:if|for|while|switch|catch|return|do|else|try|finally|with)\b/;

/**
 * 找函数体：函数声明 / 箭头函数赋值 / 类方法。
 *
 * 返回 `[{ startLine, endLine, lines, label }]`（行号 0-based）。
 * 这是**启发式**解析：宁可漏判（少报）也不误判——误判会让守卫变成噪声源，
 * 而噪声源一定会被加进豁免名单。
 */
export function findFunctions(text) {
  const found = [];
  const push = (nameText, openBraceIndex) => {
    if (openBraceIndex < 0) return;
    const close = matchBrace(text, openBraceIndex);
    if (close < 0) return;
    const startLine = text.slice(0, openBraceIndex).split("\n").length - 1;
    const bodyEnd = text.slice(0, close).split("\n").length - 1;
    const label = formatFunctionLabel(text, startLine, nameText);
    found.push({ startLine, endLine: bodyEnd, lines: bodyEnd - startLine + 1, label });
  };

  // ① function 声明（含 async / export default）
  const declRe = /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([\w$]*)[ \t]*(?:<[^>]*>)?[ \t]*\(/g;
  let m;
  while ((m = declRe.exec(text)) !== null) {
    const openParen = text.indexOf("(", m.index + m[0].length - 1);
    const openBrace = findBodyBrace(text, openParen);
    push(m[1] || "anonymous", openBrace);
  }

  // ② 箭头函数 / 函数表达式赋值：const x = (...) => {
  const arrowRe = /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([\w$]+)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]*)?(?:function[ \t]*)?(?:<[^>]*>)?[ \t]*\(/g;
  while ((m = arrowRe.exec(text)) !== null) {
    const openParen = text.indexOf("(", m.index + m[0].length - 1);
    const openBrace = findBodyBrace(text, openParen);
    push(m[1], openBrace);
  }

  // ③ 类方法：缩进 ≥2 且不以控制关键字开头的 `name(...) {`
  const methodRe = /(?:^|\n)([ \t]{2,})(?:(?:public|private|protected|static|async|readonly|override)[ \t]+)*([\w$]+)[ \t]*(?:<[^>]*>)?[ \t]*\(/g;
  while ((m = methodRe.exec(text)) !== null) {
    const lineStart = m.index + (m[0].startsWith("\n") ? 1 : 0);
    const lineText = text.slice(lineStart, text.indexOf("\n", lineStart) < 0 ? text.length : text.indexOf("\n", lineStart));
    if (CONTROL_RE.test(lineText)) continue;
    const openParen = text.indexOf("(", m.index + m[0].length - 1);
    const openBrace = findBodyBrace(text, openParen);
    push(m[2], openBrace);
  }

  return found;
}

/** 函数名附近取一个可读标签（`name` 或 `name@L12`）。 */
function formatFunctionLabel(text, startLine, nameText) {
  return `${nameText || "?"}@L${startLine + 1}`;
}

/**
 * 从参数列表的 `(` 往后找到函数体的 `{`（跳过多行参数、返回类型注解、`=>`）。
 * 找不到返回 -1。
 */
function findBodyBrace(text, openParen) {
  if (openParen < 0) return -1;
  let depth = 0;
  let state = "normal";
  for (let i = openParen; i < text.length; i += 1) {
    const ch = text[i];
    if (state === "normal") {
      if (ch === "/" && text[i + 1] === "/") {
        const nl = text.indexOf("\n", i);
        if (nl < 0) return -1;
        i = nl;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) return -1;
        i = end + 1;
        continue;
      }
      if (ch === "'") { state = "sq"; continue; }
      if (ch === '"') { state = "dq"; continue; }
      if (ch === "`") { state = "tpl"; continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          // 参数列表结束：往后找第一个 `{`（可能是返回类型之后的函数体）
          for (let j = i + 1; j < text.length; j += 1) {
            const c = text[j];
            if (c === "{") return j;
            if (c === ";" || c === "\n" && /^\s*(?:export|const|let|class|function)/.test(text.slice(j + 1, j + 40))) {
              // `;` ⇒ 只有声明没有实现；换行后出现新声明 ⇒ 同上
              if (c === ";") return -1;
            }
            if (c === "=" && text[j + 1] === ">") continue;
          }
          return -1;
        }
      }
      continue;
    }
    if (ch === "\\") { i += 1; continue; }
    if (state === "sq" && ch === "'") state = "normal";
    else if (state === "dq" && ch === '"') state = "normal";
    else if (state === "tpl" && ch === "`") state = "normal";
  }
  return -1;
}

/**
 * `@Injectable` 类的构造器位置参数个数。
 *
 * 返回 `[{ line, params, name }]`。用「`constructor(` 前 800 字符内有 `@Injectable`」
 * 判定归属 —— 精度足够（一个类里不会有第二个 constructor），漏判方向安全。
 */
export function findInjectableConstructors(text) {
  const out = [];
  const re = /(?:^|\n)([ \t]*)constructor[ \t]*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 800), m.index);
    if (!/@Injectable\s*\(/.test(before)) continue;
    const openParen = text.indexOf("(", m.index + m[0].length - 1);
    const closeParen = findCloseParen(text, openParen);
    if (closeParen < 0) continue;
    const paramsText = text.slice(openParen + 1, closeParen);
    const params = splitTopLevel(paramsText).filter((p) => p.trim() !== "");
    const line = text.slice(0, m.index).split("\n").length - 1;
    const classMatch = /(?:export\s+)?class\s+([\w$]+)/.exec(before);
    out.push({ line, params: params.length, name: classMatch?.[1] ?? "?" });
  }
  return out;
}

function findCloseParen(text, openParen) {
  if (openParen < 0) return -1;
  let depth = 0;
  let state = "normal";
  for (let i = openParen; i < text.length; i += 1) {
    const ch = text[i];
    if (state === "normal") {
      if (ch === "'") { state = "sq"; continue; }
      if (ch === '"') { state = "dq"; continue; }
      if (ch === "`") { state = "tpl"; continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
      continue;
    }
    if (ch === "\\") { i += 1; continue; }
    if (state === "sq" && ch === "'") state = "normal";
    else if (state === "dq" && ch === '"') state = "normal";
    else if (state === "tpl" && ch === "`") state = "normal";
  }
  return -1;
}

/** 按顶层逗号切分（忽略 () [] {} <> 与字符串内部的逗号）。 */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let state = "normal";
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (state === "normal") {
      if (ch === "'") { state = "sq"; current += ch; continue; }
      if (ch === '"') { state = "dq"; current += ch; continue; }
      if (ch === "`") { state = "tpl"; current += ch; continue; }
      if ("([{<".includes(ch)) depth += 1;
      else if (")]}>".includes(ch)) depth -= 1;
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
      current += ch;
      continue;
    }
    current += ch;
    if (ch === "\\") { current += text[i + 1] ?? ""; i += 1; continue; }
    if (state === "sq" && ch === "'") state = "normal";
    else if (state === "dq" && ch === '"') state = "normal";
    else if (state === "tpl" && ch === "`") state = "normal";
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** 判定点计数（分支密度分子）。 */
/**
 * 判定点计数（分支密度分子）。
 *
 * **只数控制流语句**（`if` / `else if` / `for` / `while` / `case` / `catch`），
 * 把 `&&` / `||` / `??` / 三元 `?` 排除在外 —— 实测（2026-11-04）本仓若把它们算进来，
 * 有 378 个文件密度 > 20，其中大量是「一堆守卫式判定」的合法写法。判据一旦噪声化，
 * 下场就是被整体加进豁免名单；所以这里取**最保守**的分子。
 */
const BRANCH_RE = /\b(?:if|else\s+if|for|while|case|catch)\b/g;

/**
 * 判定点计数（分支密度分子）—— **任务书口径**。
 *
 * 分子 = `if` / `else if` / `for` / `while` / `case` / `catch` / `&&` / `||` /
 * `??` / 三元 `?` 的出现次数。
 *
 * 口径说明（写清楚免得下一轮误读）：
 *   · `else if` 由 `if` 一并覆盖（它本来就是**一个**判定点，不重复计数）；
 *   · `?.`（可选链）算一个判定点 —— 它是一次条件取值；
 *   · **注释与字符串字面量里的这些符号不算**：`"a && b"`、`"https://x/y?z=1"`
 *     都不是判定点（见 `scrubForDensity`）；
 *   · TypeScript 的可选属性标记 `foo?: string` 里的 `?` 按字面计入 ——
 *     这会让 TS 文件的密度读数偏高，但**分支密度只 warn 不 error**，
 *     不会把任何文件判红，属于「读数偏高」的诚实代价。
 */
const BRANCH_PATTERNS = [
  /\bif\b/g,
  /\bfor\b/g,
  /\bwhile\b/g,
  /\bcase\b/g,
  /\bcatch\b/g,
  /&&/g,
  /\|\|/g,
  /\?\?/g,
  /\?(?!\?)/g,
];

/**
 * 剥掉注释 + 置空字符串字面量的内容（保留换行与列宽 ⇒ 行号不变）。
 *
 * 为什么单独做一遍：分支密度统计的是**代码里的判定点**，而
 * `const url = "https://x/y?z=1"; // if you want` 这种行里，
 * 注释与字符串里的 `?` / `if` 都不是判定点。
 */
export function scrubForDensity(text) {
  const out = String(text ?? "").split("");
  let state = "normal"; // normal | line | block | ' | " | `
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (state === "normal") {
      if (ch === "/" && out[i + 1] === "/") {
        state = "line";
        i += 1;
        continue;
      }
      if (ch === "/" && out[i + 1] === "*") {
        state = "block";
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        state = ch;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") state = "normal";
      else out[i] = " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && out[i + 1] === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        state = "normal";
        i += 2;
        continue;
      }
      if (ch !== "\n") out[i] = " ";
      i += 1;
      continue;
    }
    // 字符串态：内容置空（转义序列整体跳过），引号本身保留。
    if (ch === "\\") {
      if (ch !== "\n") out[i] = " ";
      if (i + 1 < out.length && out[i + 1] !== "\n") out[i + 1] = " ";
      i += 2;
      continue;
    }
    if (ch === state) {
      state = "normal";
      i += 1;
      continue;
    }
    if (ch !== "\n") out[i] = " ";
    i += 1;
  }
  return out.join("");
}

/** 判定点计数（分支密度分子，任务书口径）。 */
export function countDecisionPoints(text) {
  let n = 0;
  for (const pattern of BRANCH_PATTERNS) {
    const re = new RegExp(pattern.source, "g");
    while (re.exec(text) !== null) n += 1;
  }
  return n;
}

/**
 * 解析一段源码的全部度量。
 *
 * @param {string} text 源码
 * @param {string} rel 仓库相对路径（报错点名用）
 */
export function measure(text, rel) {
  const { lines, hasCode, nonCommentLines } = scanSource(text);
  const functions = findFunctions(text);
  const constructors = findInjectableConstructors(text);
  const exportCount = lines.filter(
    (line, i) => hasCode[i] && /^\s*export\b/.test(line),
  ).length;
  const branchCount = countDecisionPoints(scrubForDensity(text));
  const density = nonCommentLines === 0 ? 0 : (branchCount / nonCommentLines) * 100;
  const longest = functions.reduce(
    (acc, f) => (f.lines > (acc?.lines ?? 0) ? f : acc),
    null,
  );
  return {
    rel,
    nonCommentLines,
    totalLines: lines.length,
    functions: functions.length,
    longestFunction: longest,
    constructors,
    exportCount,
    branchCount,
    branchDensity: Math.round(density * 10) / 10,
  };
}

/** 抽 `ALLOW:` 标记；没有返回 null。 */
export function parseAllowMarker(text) {
  const m = /ALLOW:([^\n]*)/.exec(String(text ?? ""));
  if (!m) return null;
  const reason = m[1].replace(/^[\s:：\-—–=]+/, "").trim();
  return { raw: m[0], reason, ok: reason.length >= MIN_ALLOW_REASON };
}

/**
 * 按文件路径收集 `ALLOW:` 标记，**分作用域**：
 *   · `header` —— 文件**头部注释块**里的标记（第一段连续注释，最长 40 行）。
 *     它对该文件的**所有**判据生效（行级度量没有「触发行」可言）。
 *   · `lines`  —— 每一行上的标记（行号 → 标记），只对该行触发的判据生效。
 *
 * 为什么分作用域（任务书口径：「在**触发违规的那一行**（或该文件头部注释块）」）：
 * 文件中间随手写一个 `ALLOW:` 就给整个文件开免检 = 豁免作用域失控。
 * 行级判据（函数体 / 构造器）按自己的起始行找豁免；文件级判据（非注释行 /
 * export 数 / 分支密度）只认头部注释块。
 *
 * 光秃秃的 `ALLOW:`（没有理由）**不算豁免** —— 它会让命中处变成 error，
 * 文案点明「豁免缺理由」。
 */
export function allowReasons(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const header = { marker: null, line: 0 };
  const limit = Math.min(lines.length, 40);
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const isComment = trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
    if (!isComment) break; // 第一行代码 ⇒ 头部注释块结束
    const marker = parseAllowMarker(line);
    if (marker) {
      header.marker = marker;
      header.line = i + 1;
      break;
    }
  }

  const byLine = new Map();
  lines.forEach((line, index) => {
    const marker = parseAllowMarker(line);
    if (marker) byLine.set(index + 1, marker);
  });

  return { header, byLine };
}

/**
 * 读基线。
 *
 * @returns {{entries: Record<string, object>|null, error: string|null}}
 */
export function readBaseline(root) {
  const abs = join(root, BASELINE_REL);
  if (!existsSync(abs)) {
    return {
      entries: null,
      knownGaps: [],
      error: `读不到基线 ${BASELINE_REL} —— 基线是「哪些大文件已被签字」的唯一记录，缺失即是结构问题。`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    return {
      entries: null,
      knownGaps: [],
      error: `${BASELINE_REL} 不可解析（${String(error.message).split("\n")[0]}）—— 基线坏了，判据无法执行。`,
    };
  }
  const entries = parsed?.entries;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    return { entries: null, knownGaps: [], error: `${BASELINE_REL} 缺少 entries 对象 —— 形状非法。` };
  }
  const knownGaps = Array.isArray(parsed?.knownGaps) ? parsed.knownGaps : [];
  return { entries, knownGaps, error: null };
}

/**
 * 校验 `knownGaps`（**已知盲区登记表**）。
 *
 * 为什么要有它：本守卫的扫描面只到 JS/TS。Python 侧（apps/executor-python 最大的
 * routers/execute.py 有 5564 行）**没有任何体量判据** —— 这是真实缺口。
 * 缺口写在本仓的其它文档里 = 没人会再看见；写进这张**被守卫读的**表里，
 * 它才有 owner、有复核期限、过期会红。
 *
 * 判定口径与 `check-publishable-wiring` / `check-version-line` 一致：
 * 缺 owner / 缺 review_by / review_by 不是 YYYY-MM-DD / 过期 ⇒ 红。
 *
 * 注意：这是**显式登记**，不是「已修好」。缺口本身不判红（有缺口是事实，不是 bug）；
 * 判红的是「缺口没有主人」或「缺口过期没人管」。
 */
export function validateKnownGaps(knownGaps, { today }) {
  const problems = [];
  if (!Array.isArray(knownGaps)) return problems;
  for (const [index, gap] of knownGaps.entries()) {
    const at = `knownGaps[${index}]`;
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      problems.push(`${at} 不是对象 —— 登记腐烂了。`);
      continue;
    }
    if (typeof gap.id !== "string" || gap.id.trim() === "") {
      problems.push(`${at} 缺 id —— 缺口必须能点名。`);
    }
    if (typeof gap.owner !== "string" || gap.owner.trim() === "") {
      problems.push(`${at} 缺 owner —— 没有责任人的缺口等于没有缺口记录（它会被遗忘）。`);
    }
    if (typeof gap.review_by !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(gap.review_by)) {
      problems.push(`${at} 的 review_by 必须是 YYYY-MM-DD（收到 ${JSON.stringify(gap.review_by)}）。`);
      continue;
    }
    const day = Math.floor(Date.parse(`${gap.review_by}T00:00:00Z`) / 86_400_000);
    if (!Number.isFinite(day)) {
      problems.push(`${at} 的 review_by 不是合法日期：${gap.review_by}。`);
      continue;
    }
    if (day < today) {
      problems.push(
        `${at}（${gap.id ?? "?"}）的复核期限已过（review_by=${gap.review_by}）—— ` +
          `缺口还在，但已经没人打算管它了。要么补上判据，要么把 review_by 改到未来并在 why 里写清理由。`,
      );
    }
  }
  return problems;
}

function collectFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      if (!SOURCE_EXT.has(entry.name.slice(dot))) continue;
      const rel = toPosix(relative(root, abs));
      if (isExemptPath(rel)) continue;
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size > 2 * 1024 * 1024) continue;
      files.push({ rel, abs });
    }
  };
  for (const group of SCAN_ROOTS) walk(join(root, group));
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 判据本体。
 *
 * @returns {{errors: string[], violations: object[], warnings: object[], rows: object[], counts: object}}
 */
export function check({ root = process.cwd() } = {}) {
  const errors = [];
  const violations = [];
  const warnings = [];
  const exempt = [];
  const rows = [];
  const counts = { files: 0, functions: 0, injectables: 0, baseline: 0, knownGaps: 0, allowed: 0, root };

  const baseline = readBaseline(root);
  if (baseline.error) {
    errors.push(baseline.error);
    return { errors, violations, warnings, exempt, rows, counts };
  }
  const base = baseline.entries;
  counts.baseline = Object.keys(base).length;
  counts.knownGaps = baseline.knownGaps.length;
  for (const p of validateKnownGaps(baseline.knownGaps, { today: todayDay() })) {
    errors.push(`${BASELINE_REL} 的 knownGaps 登记有问题：${p}`);
  }
  if (counts.baseline > MAX_BASELINE_ENTRIES) {
    errors.push(
      `基线条目 ${counts.baseline} 条，超过上限 ${MAX_BASELINE_ENTRIES} —— 基线正在变成「把所有大文件都签字」的关灯键。`,
    );
  }
  if (counts.baseline < MIN_BASELINE_ENTRIES) {
    errors.push(
      `基线条目 ${counts.baseline} 条 < 下界 ${MIN_BASELINE_ENTRIES} —— 空基线 = 棘轮没了` +
        `（本仓已知有超大文件，必须登记在基线里）。`,
    );
  }

  const files = collectFiles(root);
  counts.files = files.length;
  if (files.length < MIN_FILES) {
    errors.push(
      `只扫到 ${files.length} 个 JS/TS 源文件（下界 ${MIN_FILES}）—— 扫描面塌了，此刻「零违规」是假象。`,
    );
    return { errors, violations, warnings, exempt, rows, counts };
  }

  const seenBaseline = new Set();

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file.abs, "utf8");
    } catch (error) {
      errors.push(`读不到 ${file.rel}（${error.code ?? error.message}）—— 读不到 ≠ 没问题，按结构红处理。`);
      continue;
    }
    const m = measure(text, file.rel);
    counts.functions += m.functions;
    counts.injectables += m.constructors.length;
    rows.push(m);

    const allows = allowReasons(text);
    const headerAllow = allows.header.marker;
    /**
     * 取某个判据的豁免：
     *   · `line` 给定 ⇒ 该行上的标记优先，其次文件头部注释块；
     *   · `line` 为 null（文件级度量）⇒ 只认文件头部注释块。
     */
    const allowFor = (line) => {
      const onLine = line != null ? allows.byLine.get(line) : undefined;
      const marker = onLine ?? headerAllow ?? null;
      if (!marker) return null;
      return { marker, line: onLine ? line : allows.header.line };
    };

    const pushes = (severity, why, line = null) => {
      const item = { rel: file.rel, severity, why, metric: m };
      const hit = allowFor(line);
      if (hit) {
        if (hit.marker.ok) {
          counts.allowed += 1;
          // 豁免**逐条单列**（可见，不静默）：报告里单独一节列出来。
          exempt.push({
            rel: file.rel,
            line: hit.line,
            why: hit.marker.reason,
            covers: why,
            raw: hit.marker.raw,
          });
          warnings.push({
            ...item,
            why: `${why}（已 ALLOW 豁免：${hit.marker.reason}）`,
            allowLine: hit.line,
          });
          return;
        }
        violations.push({
          ...item,
          why: `${why}；ALLOW: 缺理由（至少要 ${MIN_ALLOW_REASON} 个字符的说明，否则它只是判据的关灯键）`,
          allowLine: hit.line,
        });
        return;
      }
      if (severity === "error") violations.push(item);
      else warnings.push(item);
    };

    const baseEntry = base[file.rel];
    if (baseEntry) seenBaseline.add(file.rel);

    // 每项度量当前值 + 阈值
    const metrics = {
      nonCommentLines: m.nonCommentLines,
      functionLines: m.longestFunction?.lines ?? 0,
      ctorParams: m.constructors.reduce((acc, c) => Math.max(acc, c.params), 0),
      exports: m.exportCount,
      branchDensity: m.branchDensity,
    };
    const exceed = [];
    for (const [key, spec] of Object.entries(THRESHOLDS)) {
      const value = metrics[key];
      if (value > spec.error) exceed.push({ key, value, severity: "error", limit: spec.error, label: spec.label });
      else if (value > spec.warn) exceed.push({ key, value, severity: "warn", limit: spec.warn, label: spec.label });
    }

    if (!baseEntry) {
      for (const e of exceed) {
        pushes(
          e.severity,
          e.key === "functionLines"
            ? `${m.longestFunction.label} 函数体 ${e.value} 行 > ${e.limit}`
            : e.key === "ctorParams"
              ? `@Injectable ${m.constructors.find((c) => c.params === e.value)?.name ?? "?"} 构造器 ${e.value} 个位置参数 > ${e.limit}`
              : `${e.label} ${e.value} > ${e.limit}`,
          // 行级判据带自己的触发行（豁免可写在那一行）；文件级判据没有触发行。
          e.key === "functionLines"
            ? m.longestFunction?.startLine + 1
            : e.key === "ctorParams"
              ? m.constructors.find((c) => c.params === e.value)?.line + 1
              : null,
        );
      }
      continue;
    }

    // ── 在基线里 ──────────────────────────────────────────────────
    /**
     * 基线条目的两种形状（**任务书口径 = `{ maxLines, why }`**）：
     *   ① `maxLines`（正整数）—— 规范形状：文件的**非注释行数**只要 ≤ `maxLines`
     *      就只 warn 不 error；超过 `maxLines` ⇒ error（棘轮：只能变小，不能变大）。
     *   ② `ceiling`（对象）—— **扩展形状**：逐项给已签字的上限
     *      （`nonCommentLines` / `functionLines` / `ctorParams` / `exports` /
     *      `branchDensity`）。为什么需要它：只按「非注释行」落基线的话，
     *      `main.ts` 的 `bootstrap()` 有 417 行、`executor.service.ts` 的构造器有
     *      21 个位置参数 —— 这两个文件行数也许没超，但函数体/构造器超了。
     *      行数基线管不到它们，守卫就会**永远红**，然后被整体关掉。
     *
     * 两种形状都接受；`maxLines` 是**必填的规范字段**（`ceiling` 只是补充）。
     */
    const maxLines = Number(baseEntry.maxLines);
    const ceiling = baseEntry.ceiling;
    const hasCeiling = ceiling !== undefined && ceiling !== null;
    if (!Number.isFinite(maxLines) || maxLines <= 0) {
      errors.push(
        `${BASELINE_REL} 里 ${file.rel} 缺 maxLines（或不是正整数）—— 基线条目必须写明` +
          `「这个文件的非注释行数上限是多少」，否则它只是「这个文件免检」。`,
      );
      continue;
    }
    if (hasCeiling && (typeof ceiling !== "object" || Array.isArray(ceiling))) {
      errors.push(`${BASELINE_REL} 里 ${file.rel} 的 ceiling 不是对象 —— 形状非法。`);
      continue;
    }
    if (typeof baseEntry.why !== "string" || baseEntry.why.trim().length < 12) {
      errors.push(`${BASELINE_REL} 里 ${file.rel} 的 why 太短 —— 基线条目必须写清「为什么现在不拆」。`);
    }

    // 棘轮：`maxLines` 是非注释行数的上限，超出 ⇒ error（不许继续长）。
    if (m.nonCommentLines > maxLines) {
      violations.push({
        rel: file.rel,
        severity: "error",
        why:
          `非注释行 现为 ${m.nonCommentLines}，超过基线上限 ${maxLines}（基线只减不增：` +
          `已在基线里的文件不许再变大；真要变大，先说服复核人把 maxLines 调高并在 why 里写清原因）`,
        metric: m,
      });
    }

    /**
     * 棘轮收紧（**基线腐烂**）：文件已经降回阈值以内 ⇒ 要求把这条从基线删掉。
     *
     * 口径：
     *   · 规范形状（只有 `maxLines`）⇒ 非注释行 ≤ `MAX_LINES_WARN`(600) 即腐烂；
     *   · 扩展形状（带 `ceiling`）⇒ **所有**度量都回到阈值内才算腐烂
     *     （行数降下来了但函数体还是 417 行 ⇒ 它仍需要基线，不是腐烂）。
     */
    const decayed = hasCeiling ? exceed.length === 0 : m.nonCommentLines <= MAX_LINES_WARN;
    if (decayed) {
      violations.push({
        rel: file.rel,
        severity: "error",
        why:
          `非注释行已降回 ${m.nonCommentLines}（阈值 ${MAX_LINES_WARN} 以内）` +
          `（最长函数 ${metrics.functionLines} 行、构造器 ${metrics.ctorParams} 参数、` +
          `export ${metrics.exports}、密度 ${metrics.branchDensity}）` +
          `—— **该从基线删除**：它已经不需要签字了。基线只减不增：留着这条，棘轮永远不会收紧`,
        metric: m,
      });
      continue;
    }

    for (const e of exceed) {
      if (!hasCeiling) {
        // 规范形状（只有 maxLines）：非注释行由 maxLines 棘轮管。
        //   · > maxLines ⇒ 上面已经判 error；
        //   · ≤ maxLines ⇒ **只 warn**（任务书口径：「只要 ≤ 基线 maxLines 就只 warn 不 error」）。
        if (e.key === "nonCommentLines") {
          warnings.push({
            rel: file.rel,
            severity: "warn",
            why: `非注释行 ${e.value}（基线内，上限 ${maxLines}，阈值 ${e.limit}）`,
            metric: m,
          });
          continue;
        }
        // 其余度量没有签字上限：**不能降级成 warn**（那等于「没登记 = 不判」），
        // 原 severity 保留。
        const item = {
          rel: file.rel,
          severity: e.severity,
          why: `${e.label} ${e.value} > ${e.limit}（基线条目未给 ${e.key} 的上限，按阈值判）`,
          metric: m,
        };
        if (e.severity === "error") violations.push(item);
        else warnings.push(item);
        continue;
      }
      const cap = Number(ceiling[e.key]);
      if (!Number.isFinite(cap) || cap <= 0) {
        const item = {
          rel: file.rel,
          severity: e.severity,
          why: `${e.label} ${e.value} > ${e.limit}（基线条目未给 ${e.key} 的上限，按阈值判）`,
          metric: m,
        };
        if (e.severity === "error") violations.push(item);
        else warnings.push(item);
        continue;
      }
      if (e.value > cap) {
        violations.push({
          rel: file.rel,
          severity: "error",
          why:
            `${e.label} 现为 ${e.value}，超过基线上限 ${cap}（基线只减不增：已在基线里的文件不许再变大；` +
            `真要变大，先说服复核人把 ceiling.${e.key} 调高并在 why 里写清原因）`,
          metric: m,
        });
        continue;
      }
      warnings.push({
        rel: file.rel,
        severity: e.severity,
        why: `${e.label} ${e.value}（基线内，上限 ${cap}，阈值 ${e.limit}）`,
        metric: m,
      });
    }
  }

  // 反永真：解析器活着吗
  if (counts.functions === 0) {
    errors.push(`一个函数都没解析出来（扫了 ${counts.files} 个文件）—— 解析器失效了，「零违规」是假象。`);
  }
  if (counts.injectables === 0) {
    errors.push(
      `一个 @Injectable 构造器都没找到（扫了 ${counts.files} 个文件）—— 本仓有成百个，解析器失效了。`,
    );
  }

  // 基线腐烂：路径不存在
  for (const rel of Object.keys(base)) {
    if (!seenBaseline.has(rel)) {
      violations.push({
        rel,
        severity: "error",
        why: `基线里的路径已不存在（或已被排除规则跳过）—— 删掉这条`,
      });
    }
  }

  return { errors, violations, warnings, exempt, rows, counts };
}

// ── CLI ────────────────────────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

function printReport({ rows, counts }) {
  const top = [...rows].sort((a, b) => b.nonCommentLines - a.nonCommentLines).slice(0, 25);
  console.log(
    `文件 ${counts.files} 个、函数 ${counts.functions} 个、@Injectable 构造器 ${counts.injectables} 个、` +
      `基线条目 ${counts.baseline} 个、ALLOW 豁免 ${counts.allowed} 处、已知盲区 ${counts.knownGaps} 条`,
  );
  console.log(
    `阈值：非注释行 warn>${MAX_LINES_WARN} error>${MAX_LINES_ERROR}；函数体>${MAX_FUNCTION_LINES}；` +
      `构造器参数>${MAX_CTOR_PARAMS_WARN}(error>${MAX_CTOR_PARAMS_ERROR})；export>${MAX_EXPORTS}；分支密度>${MAX_BRANCH_DENSITY}`,
  );
  console.log("非注释行最多的 25 个文件：");
  for (const row of top) {
    const fn = row.longestFunction ? `${row.longestFunction.label}:${row.longestFunction.lines}` : "-";
    const ctor = row.constructors.length
      ? ` ctor=${row.constructors.map((c) => `${c.name}:${c.params}`).join(",")}`
      : "";
    console.log(
      `  · ${String(row.nonCommentLines).padStart(6)} 行  ${row.rel}` +
        `  fn=${row.functions} 最长=${fn} export=${row.exportCount} 密度=${row.branchDensity}${ctor}`,
    );
  }
}

function runCli(root, { report }) {
  const { errors, violations, warnings, exempt, rows, counts } = check({ root });

  if (report) printReport({ rows, counts });

  // 豁免**逐条列出**（可见，不静默）：命中一条就必须在输出里看得见。
  for (const x of exempt) {
    console.log(`  · ${x.rel}${x.line ? `:${x.line}` : ""} —— ALLOW 豁免：${x.why}（覆盖：${x.covers}）`);
  }

  if (errors.length > 0) {
    console.error("");
    console.error("✖ 体量上限自检结构错误（判据本身不可信）：");
    for (const e of errors) console.error("  · " + e);
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error("");
    console.error(`✖ ${violations.length} 处超出体量上限（error 级；这是「无上限增长」的闸，不是拆分指令）：`);
    for (const v of violations) console.error(`  · ${v.rel}: ${v.why}`);
    console.error("");
    console.error(
      "  修法：① 先确认这是真违规（不是生成物/本地化文件被漏排除）；② 大文件请登记进 " +
        `${BASELINE_REL}（entries[<路径>] = { maxLines: <实测非注释行数>, why: "<一句>" }` +
        `；可选 ceiling: { nonCommentLines, functionLines, ctorParams, exports, branchDensity } 逐项签字），并在 why 里写真话；\n` +
        "  ③ 单点豁免用行内注释 `ALLOW: <≥12 字理由>`（光秃秃的 ALLOW: 仍然红）。",
    );
    process.exit(1);
  }

  const warnShown = warnings.slice(0, 40);
  for (const w of warnShown) console.log(`  ⚠ ${w.rel}: ${w.why}`);
  if (warnings.length > warnShown.length) {
    console.log(`  … 另有 ${warnings.length - warnShown.length} 条 warn 未打印（用 --report 看全表）`);
  }
  console.log(
    `✔ 体量上限自检通过：${counts.files} 个 JS/TS 文件、${counts.functions} 个函数、` +
      `${counts.injectables} 个 @Injectable 构造器都在阈值内（基线条目 ${counts.baseline} 个，` +
      `ALLOW 豁免 ${counts.allowed} 处，warn ${warnings.length} 条）。`,
  );
}

// ── 自检（真子进程：退出码 + 关键文本）────────────────────────────────────
/** 造一个「非注释行 = n」的满速填充文件（每行一个合法语句）。 */
function filler(n, name = "f") {
  return Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`).join("\n") + "\n";
}

/**
 * 造一个「非注释行 = n、但只有一个 export」的填充文件（避免触发 export warn）。
 */
function fillerBody(n) {
  return (
    "export function small(): number {\n" +
    Array.from({ length: n - 3 }, (_, i) => `  const v${i} = ${i};`).join("\n") +
    "\n  return 1;\n}\n"
  );
}

/** fixture 里被基线登记的那个文件：700 非注释行（> 警告线 600，≤ maxLines 700）。 */
const BASELINED_REL = "apps/fixture/src/baselined.ts";
const BASELINED_LINES = 700;

/**
 * 造一个「非注释行 = n」的填充文件：**很多个短函数**（每个 ≤ 20 行）。
 *
 * 为什么不用 `filler`（一行一个 `export const`）：那样 export 数会 = n（> 25 ⇒ warn），
 * 且没有函数体 —— 用它当「基线登记的大文件」会把「export 数」与「函数体」一起带进
 * 判据，污染「该绿」的用例。
 */
function fillerSpread(n) {
  const lines = [];
  let index = 0;
  while (lines.length < n) {
    const size = Math.min(20, n - lines.length);
    if (size >= 3) {
      // 一个 size 行的函数块：header(1) + (size-3) 个 const + return(1) + }(1) = size 行
      lines.push(`function g${index}(): number {`);
      for (let k = 0; k < size - 3; k += 1) lines.push(`  const v${k} = ${k};`);
      lines.push("  return 1;");
      lines.push("}");
    } else {
      for (let k = 0; k < size; k += 1) lines.push(`const w${index}_${k} = ${k};`);
    }
    index += 1;
  }
  return lines.join("\n") + "\n";
}

/**
 * 造 fixture 的基线文件。
 *
 * 基线必须**非空**（下界 MIN_BASELINE_ENTRIES = 1）：空基线 = 棘轮没了。
 * 同时登记的路径必须在 fixture 树里**真的存在**，否则触发「基线里的路径已不存在」。
 * 而被登记的文件又必须**不在阈值内**（否则触发「基线腐烂：该从基线删除」）。
 * ⇒ 唯一自洽的组合：一个 700 行（> 600 警告线、≤ maxLines）的文件。
 */
function fixtureBaseline(extraEntries = {}) {
  return {
    $comment: "fixture",
    entries: {
      [BASELINED_REL]: {
        maxLines: BASELINED_LINES,
        why: "fixture：已签字的大文件，棘轮上限 700 非注释行",
      },
      ...extraEntries,
    },
  };
}

/** fixture 树：足够多的「小文件」把扫描面撑过 MIN_FILES。 */
function baseTree(extra = {}, { smallCount = MIN_FILES + 20 } = {}) {
  const files = {
    "scripts/source-size-baseline.json": fixtureBaseline(),
  };
  for (let i = 0; i < smallCount; i += 1) {
    files[`apps/fixture/src/f${String(i).padStart(4, "0")}.ts`] =
      `export function f${i}(a: number): number {\n  return a + ${i};\n}\n`;
  }
  // 被基线登记的那个文件（700 非注释行 ⇒ 触发 warn，不触发 error）。
  files[BASELINED_REL] = fillerSpread(BASELINED_LINES);
  // 一个 @Injectable，保证「解析器活着」这条反永真在绿树上是绿的
  files["apps/fixture/src/dep.service.ts"] = [
    'import { Injectable } from "@nestjs/common";',
    "@Injectable()",
    "export class DepService {",
    "  constructor(private readonly a: string) {}",
    "  run(): string { return this.a; }",
    "}",
    "",
  ].join("\n");
  return { ...files, ...extra };
}

function runSelftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "size-caps-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 20_000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ① 正例
  subprocess("① 正例：只有小文件 → 绿", baseTree(), {
    code: 0,
    contains: ["体量上限自检通过"],
    absent: ["超出体量上限", "结构错误"],
  });

  // ② 反例：950 非注释行 → error（点名文件 + 实测行数 950）
  subprocess(
    "② 反例：950 非注释行 > 900 → 红并点名文件与行数",
    baseTree({ "apps/fixture/src/huge.ts": filler(950) }),
    {
      code: 1,
      contains: ["超出体量上限", "huge.ts", "非注释行 950", "> 900"],
      absent: ["体量上限自检通过"],
    },
  );

  // ③ 结构塌陷反永真：文件数不足
  subprocess(
    "③ 结构塌陷：文件数 < 下界 → 结构红（分母塌了不是「全干净」）",
    baseTree({}, { smallCount: 5 }),
    {
      code: 1,
      contains: ["结构错误", "扫描面塌了", `下界 ${MIN_FILES}`],
      absent: ["体量上限自检通过"],
    },
  );

  // ④ 基线腐烂：基线里的文件已降回阈值内 → 红
  subprocess(
    "④ 基线腐烂：基线里的文件已降回阈值内 → 红（逼棘轮收紧）",
    baseTree({
      "apps/fixture/src/shrunk.ts": fillerBody(120),
      "scripts/source-size-baseline.json": fixtureBaseline({
        "apps/fixture/src/shrunk.ts": {
          maxLines: 5000,
          why: "曾经很大（fixture）",
        },
      }),
    }),
    {
      code: 1,
      contains: ["shrunk.ts", "该从基线删除"],
      absent: ["体量上限自检通过"],
    },
  );

  // ⑤ 基线内文件继续变大 → error（棘轮只往一个方向转）
  subprocess(
    "⑤ 基线内文件超过 maxLines → 红（基线只减不增）",
    baseTree({
      "apps/fixture/src/grown.ts": filler(1000),
      "scripts/source-size-baseline.json": fixtureBaseline({
        "apps/fixture/src/grown.ts": {
          maxLines: 950,
          why: "签名时的上限 950（fixture）",
        },
      }),
    }),
    {
      code: 1,
      contains: ["grown.ts", "超过基线上限 950", "只减不增"],
      absent: ["体量上限自检通过"],
    },
  );

  // ⑥ ALLOW 合法豁免 → 绿（且报告里点名）
  subprocess(
    "⑥ ALLOW: <理由> 命中 → 绿（豁免可见）",
    baseTree({
      "apps/fixture/src/allowed.ts":
        "// ALLOW: 生成的协议映射表，人工维护会出错，见 scripts/generate-executor-protocol.mjs\n" +
        filler(950),
    }),
    {
      code: 0,
      contains: ["体量上限自检通过", "已 ALLOW 豁免"],
      absent: ["超出体量上限"],
    },
  );

  // ⑦ ALLOW 缺理由 → 仍然红
  subprocess(
    "⑦ `ALLOW:` 没写理由 → 仍然红（光秃秃的标记是关灯键，不是豁免）",
    baseTree({
      "apps/fixture/src/allow-bad.ts": "// ALLOW:\n" + filler(950),
    }),
    {
      code: 1,
      contains: ["allow-bad.ts", "ALLOW: 缺理由"],
      absent: ["体量上限自检通过"],
    },
  );

  // ⑧ 注释不算行数：900 行里 500 行是注释
  subprocess(
    "⑧ 注释不算行数：950 总行但其中 500 行是注释 → 绿",
    baseTree({
      "apps/fixture/src/commented.ts":
        Array.from({ length: 500 }, (_, i) => `// 说明第 ${i} 行`).join("\n") + "\n" + filler(450),
    }),
    {
      code: 0,
      contains: ["体量上限自检通过"],
      absent: ["超出体量上限"],
    },
  );

  // ⑨ 单个函数体 > 300 行 → error
  subprocess(
    "⑨ 单个函数体 > 300 行 → 红",
    baseTree({
      "apps/fixture/src/longfn.ts":
        "export function giant(): number {\n" +
        Array.from({ length: 320 }, (_, i) => `  const v${i} = ${i};`).join("\n") +
        "\n  return 1;\n}\n",
    }),
    {
      code: 1,
      contains: ["longfn.ts", "giant@L1 函数体", "> 300"],
      absent: ["体量上限自检通过"],
    },
  );

  // ⑩ @Injectable 构造器 9 个位置参数 → error（> 8）
  subprocess(
    "⑩ @Injectable 构造器 9 个位置参数 → 红",
    baseTree({
      "apps/fixture/src/fat.service.ts": [
        'import { Injectable } from "@nestjs/common";',
        "@Injectable()",
        "export class FatService {",
        "  constructor(",
        ...Array.from({ length: 9 }, (_, i) => `    private readonly d${i}: string,`),
        "  ) {}",
        "}",
        "",
      ].join("\n"),
    }),
    {
      code: 1,
      contains: ["fat.service.ts", "FatService", "9 个位置参数"],
      absent: ["体量上限自检通过"],
    },
  );

  // ⑪ 例外路径不参与扫描：dist/generated/locales/.d.ts 里的大文件应为空气
  subprocess(
    "⑪ 例外路径（dist/generated/locales/.d.ts）里的大文件不参与判据 → 绿",
    baseTree({
      "apps/fixture/src/dist/big.js": filler(1200),
      "apps/fixture/src/generated/big.ts": filler(1200),
      "apps/fixture/src/locales/zh.ts": filler(1200),
      "apps/fixture/src/types.d.ts": filler(1200),
    }),
    {
      code: 0,
      contains: ["体量上限自检通过"],
      absent: ["超出体量上限", "big.js", "types.d.ts"],
    },
  );

  // ⑫ 基线路径已不存在 → 红
  subprocess(
    "⑫ 基线里的路径已不存在 → 红（基线腐烂）",
    baseTree({
      "scripts/source-size-baseline.json": fixtureBaseline({
        "apps/fixture/src/gone.ts": { maxLines: 3000, why: "文件已删（fixture）" },
      }),
    }),
    {
      code: 1,
      contains: ["gone.ts", "基线里的路径已不存在"],
      absent: ["体量上限自检通过"],
    },
  );

  // ⑬ 基线条目超上限 → 结构红（基线不许变成关灯键）
  subprocess(
    "⑬ 基线条目超过上限 → 结构红（基线不许变成关灯键）",
    (() => {
      const entries = {};
      for (let i = 0; i <= MAX_BASELINE_ENTRIES; i += 1) {
        entries[`apps/fixture/src/b${i}.ts`] = {
          maxLines: 5000,
          why: "fixture 基线关灯键",
        };
      }
      return baseTree({
        "scripts/source-size-baseline.json": fixtureBaseline(entries),
      });
    })(),
    {
      code: 1,
      contains: ["结构错误", "超过上限"],
      absent: ["体量上限自检通过"],
    },
  );

  // ⑮ knownGaps（已知盲区登记）：过期 ⇒ 红（缺口没主人 / 没人管）
  subprocess(
    "⑮ knownGaps 登记过期 ⇒ 红（盲区必须有主人与复核期限）",
    baseTree({
      "scripts/source-size-baseline.json": {
        $comment: "fixture",
        ...fixtureBaseline(),
        knownGaps: [
          {
            id: "python-side-not-covered",
            scope: "apps/executor-python/**/*.py",
            why: "本守卫只扫 JS/TS（fixture）",
            owner: "unassigned",
            review_by: "2000-01-01",
          },
        ],
      },
    }),
    {
      code: 1,
      contains: ["knownGaps", "复核期限已过", "python-side-not-covered"],
      absent: ["体量上限自检通过"],
    },
  );

  // ⑯ knownGaps 缺 owner ⇒ 红（没主人的缺口会被遗忘）
  subprocess(
    "⑯ knownGaps 缺 owner ⇒ 红（没有责任人的缺口等于没有记录）",
    baseTree({
      "scripts/source-size-baseline.json": {
        $comment: "fixture",
        ...fixtureBaseline(),
        knownGaps: [
          {
            id: "python-side-not-covered",
            scope: "apps/executor-python/**/*.py",
            why: "本守卫只扫 JS/TS（fixture）",
            review_by: "2099-01-01",
          },
        ],
      },
    }),
    {
      code: 1,
      contains: ["knownGaps", "缺 owner"],
      absent: ["体量上限自检通过"],
    },
  );

  // ⑰ --report 不吞红灯
  {
    const name = "⑰ --report 打印全表但不吞红灯";
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(baseTree({ "apps/fixture/src/huge.ts": filler(950) }), {
          prefix: "size-caps-selftest-",
        });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir, "--report"] }), {
            code: 1,
            contains: ["非注释行最多的 25 个文件", "huge.ts", "超出体量上限"],
            withinMs: 20_000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  }

  // ⑱ 反永真：一个 @Injectable 都没找到 ⇒ 结构红（解析器失效不能算「全干净」）
  {
    const name = "⑱ 一个 @Injectable 都没找到 → 结构红（解析器失效 ≠ 全干净）";
    cases.push({
      name,
      fn: () => {
        const tree = baseTree();
        // 删掉 fixture 里唯一的 @Injectable 那个文件 ⇒ 「一个都没找到」。
        delete tree["apps/fixture/src/dep.service.ts"];
        const repo = makeFixtureRepo(tree, { prefix: "size-caps-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            code: 1,
            contains: ["结构错误", "@Injectable 构造器都没找到", "解析器失效"],
            absent: ["体量上限自检通过"],
            withinMs: 20_000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  }

  // ⑲ 反永真：一个函数都没解析出来 ⇒ 结构红
  {
    const name = "⑲ 一个函数都没解析出来 → 结构红（解析器失效 ≠ 全干净）";
    cases.push({
      name,
      fn: () => {
        const tree = baseTree();
        // 把所有 fixture 文件换成「没有函数」的内容（只有 const 与 export）。
        const noFn = "export const value = 1;\n";
        for (const key of Object.keys(tree)) {
          if (key.startsWith("apps/fixture/src/f") && key.endsWith(".ts")) tree[key] = noFn;
        }
        tree["apps/fixture/src/dep.service.ts"] = noFn;
        tree[BASELINED_REL] = noFn;
        const repo = makeFixtureRepo(tree, { prefix: "size-caps-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            code: 1,
            contains: ["结构错误", "一个函数都没解析出来", "解析器失效"],
            absent: ["体量上限自检通过"],
            withinMs: 20_000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  }

  // ⑳ ALLOW 的作用域：文件中段的 ALLOW 不能给「文件级」判据（非注释行）开免检
  {
    const name = "⑳ ALLOW 作用域：文件中的 ALLOW 不给文件级判据开免检";
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(
          baseTree({
            "apps/fixture/src/mid-allow.ts":
              filler(400) + "// ALLOW: 这条理由够长了，但它在文件中段\n" + filler(600),
          }),
          { prefix: "size-caps-selftest-" },
        );
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            code: 1,
            contains: ["mid-allow.ts", "非注释行 1000", "超出体量上限"],
            absent: ["体量上限自检通过"],
            withinMs: 20_000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  }

  const failed = reportCases(cases, { title: "check-size-caps selftest" });
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  if (process.argv.includes("--selftest")) {
    runSelftest();
  } else {
    runCli(resolve(argValue(process.argv, "--root") ?? process.cwd()), {
      report: process.argv.includes("--report"),
    });
  }
}
