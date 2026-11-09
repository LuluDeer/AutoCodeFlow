#!/usr/bin/env node
/**
 * `WINDOWS_GUI_SCRIPT`（Windows 桌面 GUI 的固定 PowerShell 程序）的**静态解析守卫**。
 *
 * ## 这条守卫防的是哪一类事故
 *
 * `apps/executor-desktop/src/main/agent/gui-windows.ts` 用 `String.raw` 内联了约 230 行
 * PowerShell：`Reply` 回话协议、`ConvertTo-Json`、`Add-Type` 注入 C#（user32 P/Invoke）、
 * 以及 focus/click/type/press/screenshot 五个动作。**这段脚本从来没有被任何东西校验过**：
 *
 *   · `gui-windows.selftest.ts` 把 `invoke` 整体 mock 掉（`invoke: async (request) => …`），
 *     130 行自检没有一行触到脚本文本 —— 它验的是 TS 侧边界，不是 PowerShell 语法；
 *   · CI 里没有 Windows PowerShell / pwsh 解析器（selftest 跑在 Linux，`process.platform`
 *     分支直接跳过真机段）；
 *   · 于是少一个 `}`、here-string 的 `'@` 缩进了一格、`$` 撞上保留名、模板里混进一个
 *     `${` —— **只有真机 Windows 打到那一步才炸**，而且现场表现是
 *     `invalid_powershell_response`（脚本根本没跑起来，stdout 为空），日志里完全看不出
 *     是「脚本语法错」还是「Windows API 抽风」。
 *
 * 对照判据（`luanyujia-workbench-main` 复核 §「最该照做」）：**拼出来的代码也要被单独
 * 解析校验**。那里的 `check-injected.mjs` 就是干这件事的。
 *
 * ## 为什么不需要 PowerShell
 *
 * 这里不做完整 PS 解析，只做**结构层**判定 —— 而结构层恰好覆盖了「手改脚本时最容易
 * 犯且只在真机才暴露」的那几类错（括号、引号、here-string、残留插值）。刻意保持
 * 零依赖、纯静态：CI 的 Linux runner 上也必须能跑。
 *
 * ## 判据（六条 + 一条钩子，每条都能人工复核）
 *
 *   ① **提取脚本**：从 `gui-windows.ts` 里**解析**出 `WINDOWS_GUI_SCRIPT = String.raw`…``
 *      的模板体。**绝不复制一份脚本文本**——副本会与源漂移，闸就废了（本仓的「单一事实源」）。
 *      提取按反引号配对扫描，并识别 `\` 转义（`String.raw` 里反引号仍靠 `\` 转义）。
 *   ② **结构平衡**：`{}` / `()` / `[]` 三类括号逐字符配对（**先剥掉字符串字面量、here-string
 *      内容与 `#` 注释**，否则 C# 里的 `"user32.dll"`、`'{'`、注释里的括号会误报）。
 *      同时查「先闭后开」（负深度）：那同样是语法错，只数总数会漏掉。
 *   ③ **引号与 here-string 闭合**：单引号（`''` 为转义）、双引号（`` ` `` 与 `""` 为转义）
 *      必须成对；here-string（`@"` … `"@`、`@'` … `'@`）必须闭合，**起始符后必须立刻换行、
 *      终止符必须在行首**（PS 5.1 的硬约束，缩进一格就是解析错）。
 *   ④ **无意外插值**：脚本体里**不得**出现 `${`。该脚本的设计是「不接收任何插值」，
 *      模型给的值只走 stdin 的 JSON —— 出现 `${` 说明有人在模板里塞了 JS 表达式
 *      （那会在**构建期**把值焊进脚本，直接破坏「数据只走 stdin」这条不变量）。
 *   ⑤ **必需结构存在**：`function Reply`、`try`、`catch`、`ConvertTo-Json`、
 *      `$ErrorActionPreference = 'Stop'`，以及**退出码契约**：失败路径必须落在 `catch` 里的
 *      `Reply`（→ 进程仍退出 0、JSON 回话），**禁止 `exit <非零>`**（那会让 node 侧只看到
 *      `powershell_failed: <stderr>`，丢掉错误码）。
 *   ⑥ **结构红（绝不当绿）**：取不到 `WINDOWS_GUI_SCRIPT`（改名/正则失配/文件不在）、
 *      模板未闭合、脚本塌到下界（< `MIN_SCRIPT_LINES` 非空行）⇒ 打印「判据瞎了」并 **exit 2**。
 *      「0 条 = 没问题」在这里是不允许的结论。
 *   ⑦ **钩子守卫**：`gui-windows.selftest.ts` 里必须有一段被 `[script-assert]` 标记包住的
 *      **脚本文本断言**（≥ `MIN_SELFTEST_SCRIPT_ASSERTS` 条 `assert.*`，且该文件确实读了
 *      `gui-windows.ts`）。这半条同样重要：`invoke` 全 mock 的测试若不看脚本，
 *      「全绿」等于「什么都没验」。
 *
 * ## 退出码
 *
 *   0 全绿 · 1 有判据不通过（找到具体问题）· 2 **结构红 / 判据瞎了**（解析面失效，
 *   连「有没有问题」都无从判断）。CI 里 1 和 2 都是红，但文案把两类分开写。
 *
 * 用法：`node scripts/check-windows-gui-script.mjs [--selftest] [--root <dir>]`
 *   --selftest：用 `scripts/lib/guard-selftest.mjs` 跑**真脚本子进程**，13 条用例逐条断言
 *               退出码 + 关键文本，含**正例控制组**（真仓库 / 未改坏的 fixture）与
 *               「剥离规则不能误报」的正例。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 `process.cwd()`）。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R163：覆盖计数出口。**必须在任何 require/依赖之前**打印 —— 本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看（`scripts/lib/agent-coverage.mjs` 头注同款纪律）。
printCoverageBanner(import.meta.url, "runGuard");

import {
  REPO_ROOT,
  expectExit,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./lib/guard-selftest.mjs";

/** 事实源（唯一一份脚本文本）。 */
export const SRC_REL = "apps/executor-desktop/src/main/agent/gui-windows.ts";
/** 第二半：selftest 必须真的断言脚本文本。 */
export const SELFTEST_REL = "apps/executor-desktop/src/main/agent/gui-windows.selftest.ts";
/** 脚本常量名（改名 = 提取面失效 ⇒ 结构红）。 */
export const SCRIPT_CONST = "WINDOWS_GUI_SCRIPT";

/**
 * 脚本非空行下界。2026-11-02 实测：234 行、其中非空 210 行。
 * 取 50 是为了「塌陷」而不是「微调」：正常改脚本只会在这个数附近浮动，
 * 掉到 50 以下说明提取错了对象（抓到了别的模板）或脚本被掏空。
 */
export const MIN_SCRIPT_LINES = 50;
/** selftest 里脚本文本断言的下界（少于 2 条就是又回到了「什么都没验」）。 */
export const MIN_SELFTEST_SCRIPT_ASSERTS = 2;
/** selftest 断言段的边界标记（`check-windows-gui-script.mjs` 判据⑦ 靠它定位）。 */
export const SELFTEST_MARKER_BEGIN = "[script-assert:begin]";
export const SELFTEST_MARKER_END = "[script-assert:end]";

/** `${` 序列（写成常量是为了避免本文件自己的模板字符串里出现转义地狱）。 */
const INTERP = "$" + "{";

/** 提取面失效（= 判据瞎了），与「找到具体问题」区分开。 */
export class StructureError extends Error {}

const DECL_RE =
  /(?:^|\n)[ \t]*(?:export[ \t]+)?const[ \t]+WINDOWS_GUI_SCRIPT[ \t]*=[ \t]*String[ \t]*\.[ \t]*raw[ \t]*`/;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/**
 * 判据①：从 TS 源码里**解析**出 `String.raw` 模板体（不复制文本）。
 *
 * @param {string} source
 * @returns {{body: string, bodyLines: string[], nonEmptyLines: number,
 *            startLine: number, endLine: number, interpolations: number[]}}
 */
export function extractRawScript(source) {
  const text = String(source ?? "");
  const match = DECL_RE.exec(text);
  if (!match) {
    throw new StructureError(
      `找不到 \`const ${SCRIPT_CONST} = String.raw\`…\` 的声明（常量改名 / 改成普通模板 / 文件被搬走都算）`,
    );
  }
  const openTick = match.index + match[0].length - 1;
  const interpolations = [];
  let closeTick = -1;
  let i = openTick + 1;
  while (i < text.length) {
    const ch = text[i];
    // String.raw 只是「不解释转义」，反引号仍靠 `\` 转义（所以不能简单找下一个反引号）。
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      closeTick = i;
      break;
    }
    if (ch === "$" && text[i + 1] === "{") interpolations.push(i);
    i += 1;
  }
  if (closeTick < 0) {
    throw new StructureError(`${SCRIPT_CONST} 的 String.raw 模板没有闭合反引号`);
  }
  const body = text.slice(openTick + 1, closeTick);
  const bodyLines = body.split("\n");
  const startLine = lineOf(text, openTick + 1);
  return {
    body,
    bodyLines,
    nonEmptyLines: bodyLines.filter((line) => line.trim() !== "").length,
    startLine,
    endLine: lineOf(text, closeTick),
    interpolations,
  };
}

/**
 * 判据②③④ 的扫描器：把字符串 / here-string / 注释**抹成空白**（保留换行，行号不变），
 * 只留结构性字符。返回 findings（每条带脚本内行号）。
 *
 * 为什么必须抹：C# 里 `DllImport("user32.dll")`、`'@` 内容里的 `{ }`、注释里的括号
 * 都会让「直接数括号」误报 —— 误报的闸最后一定被人关掉。
 */
export function analyzeScript(body) {
  const chars = String(body ?? "").split("");
  const findings = [];
  const blank = (from, to) => {
    for (let k = from; k < to && k < chars.length; k += 1) if (chars[k] !== "\n") chars[k] = " ";
  };

  const quotes = { single: 0, double: 0 };
  const hereStrings = [];
  let interpolations = 0;

  let i = 0;
  while (i < body.length) {
    const ch = body[i];

    // `#` 行注释（脚本里 `#` 只出现在行首或语句后，不在字符串内 —— 字符串已先被跳过）。
    if (ch === "#") {
      let end = body.indexOf("\n", i);
      if (end < 0) end = body.length;
      blank(i, end);
      i = end;
      continue;
    }

    // here-string：`@" … "@` / `@' … '@`
    if (ch === "@" && (body[i + 1] === '"' || body[i + 1] === "'")) {
      const quote = body[i + 1];
      const term = `${quote}@`;
      const openerLine = lineOf(body, i);
      let cursor = i + 2;
      if (body[cursor] === "\r") cursor += 1;
      if (body[cursor] !== "\n") {
        findings.push({
          code: "herestring-opener",
          line: openerLine,
          message: `here-string 起始符 \`@${quote}\` 后面必须立刻换行（PS 5.1 硬约束），实际是 ${
            JSON.stringify(body.slice(i + 2, i + 6))
          }`,
        });
        // 无法可靠定位终止符：按普通字符继续，避免掩盖后续判据。
        i += 2;
        continue;
      }
      let termAt = -1;
      let indentedAt = -1;
      let scan = cursor + 1;
      let lineStart = scan;
      while (lineStart <= body.length) {
        const nl = body.indexOf("\n", lineStart);
        const lineEnd = nl < 0 ? body.length : nl;
        const line = body.slice(lineStart, lineEnd);
        if (line.startsWith(term)) {
          termAt = lineStart;
          break;
        }
        if (line.trimStart().startsWith(term)) {
          indentedAt = lineStart;
          break;
        }
        if (nl < 0) break;
        lineStart = nl + 1;
      }
      if (termAt < 0 && indentedAt < 0) {
        findings.push({
          code: "herestring-unclosed",
          line: openerLine,
          message: `here-string（\`@${quote} … ${term}\`）未闭合：从第 ${openerLine} 行起再没有以 ${term} 开头的行`,
        });
        i = body.length;
        continue;
      }
      if (indentedAt >= 0) {
        findings.push({
          code: "herestring-terminator-indent",
          line: lineOf(body, indentedAt),
          message: `here-string 终止符 ${term} 必须**在行首**（行内不能有缩进），实际「${body
            .slice(indentedAt, indentedAt + 12)
            .trimEnd()}…」`,
        });
        termAt = indentedAt;
      }
      hereStrings.push({ openerLine, terminatorLine: lineOf(body, termAt) });
      blank(i, termAt);
      blank(termAt, termAt + term.length);
      i = termAt + term.length;
      continue;
    }

    // 单引号字符串：`''` 是转义。
    if (ch === "'") {
      const startLine = lineOf(body, i);
      let j = i + 1;
      let closed = false;
      while (j < body.length) {
        if (body[j] === "'") {
          if (body[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) {
        findings.push({
          code: "quote-unclosed",
          line: startLine,
          message: `单引号字符串未闭合（从第 ${startLine} 行开始）`,
        });
        i = body.length;
        continue;
      }
      quotes.single += 1;
      blank(i, j);
      i = j;
      continue;
    }

    // 双引号字符串：反引号与 `""` 都是转义。
    if (ch === '"') {
      const startLine = lineOf(body, i);
      let j = i + 1;
      let closed = false;
      while (j < body.length) {
        if (body[j] === "`") {
          j += 2;
          continue;
        }
        if (body[j] === '"') {
          if (body[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) {
        findings.push({
          code: "quote-unclosed",
          line: startLine,
          message: `双引号字符串未闭合（从第 ${startLine} 行开始）`,
        });
        i = body.length;
        continue;
      }
      quotes.double += 1;
      blank(i, j);
      i = j;
      continue;
    }

    // 反引号转义（`` ` `` 后一个字符是字面量，不参与括号配对）。
    if (ch === "`") {
      i += 2;
      continue;
    }

    if (ch === "$" && body[i + 1] === "{") interpolations += 1;
    i += 1;
  }

  const stripped = chars.join("");

  // 判据②：括号逐字符配对（含「先闭后开」）。
  const pairs = { "}": "{", ")": "(", "]": "[" };
  const labels = { "{": "{}", "(": "()", "[": "[]" };
  const counts = { "{}": { open: 0, close: 0 }, "()": { open: 0, close: 0 }, "[]": { open: 0, close: 0 } };
  const stack = [];
  let maxDepth = 0;
  for (let k = 0; k < stripped.length; k += 1) {
    const c = stripped[k];
    if (c === "{" || c === "(" || c === "[") {
      counts[labels[c]].open += 1;
      stack.push({ c, line: lineOf(stripped, k) });
      if (stack.length > maxDepth) maxDepth = stack.length;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      counts[labels[pairs[c]]].close += 1;
      const top = stack.pop();
      if (!top) {
        findings.push({
          code: "bracket-unmatched-close",
          line: lineOf(stripped, k),
          message: `多余的闭合括号 \`${c}\`（前面没有与之配对的 \`${pairs[c]}\`）`,
        });
        continue;
      }
      if (top.c !== pairs[c]) {
        findings.push({
          code: "bracket-mismatch",
          line: lineOf(stripped, k),
          message: `括号交叉：第 ${top.line} 行的 \`${top.c}\` 被第 ${
            lineOf(stripped, k)
          } 行的 \`${c}\` 关闭（应为 \`${pairs[top.c]}\`）`,
        });
      }
    }
  }
  for (const open of stack) {
    findings.push({
      code: "bracket-unclosed",
      line: open.line,
      message: `未闭合的 \`${open.c}\`（第 ${open.line} 行打开，脚本结束时仍未关闭）`,
    });
  }

  return {
    findings,
    counts,
    maxDepth,
    quotes,
    hereStrings,
    interpolationHits: (String(body).match(/\$\{/g) ?? []).length,
  };
}

/** 判据⑤：必需结构 + 退出码契约。 */
export function checkRequiredStructure(body) {
  const text = String(body ?? "");
  const items = [
    {
      id: "function Reply",
      re: /(?:^|\n)[ \t]*function[ \t]+Reply\b/,
      why: "回话协议：所有结果（含失败）都经 Reply 以 JSON 写 stdout",
    },
    { id: "try", re: /\btry[ \t]*\{/, why: "整体包在 try 里，避免未捕获异常直接喷 stderr" },
    { id: "catch", re: /\bcatch[ \t]*\{/, why: "异常必须被转成 Reply $false JSON" },
    { id: "ConvertTo-Json", re: /\bConvertTo-Json\b/, why: "stdout 必须是单行 JSON（node 侧 JSON.parse）" },
    {
      id: "$ErrorActionPreference = 'Stop'",
      re: /(?:^|\n)[ \t]*\$ErrorActionPreference[ \t]*=[ \t]*['"]Stop['"]/,
      why: "非终止错误也要抛，否则失败会漏过 catch 变成「空 stdout」",
    },
  ];
  const missing = items.filter((item) => !item.re.test(text));

  // 退出码契约：失败路径必须落到 catch 里的 Reply（进程仍 exit 0），且不得 exit 非零。
  const catchIndex = text.search(/\bcatch[ \t]*\{/);
  const replyInCatch =
    catchIndex >= 0 && /\bReply\b/.test(text.slice(catchIndex)) && /ConvertTo-Json|Reply/.test(text);
  const badExit = [];
  const exitRe = /(?:^|\n)[ \t]*exit\b([^\n]*)/g;
  let exitMatch = exitRe.exec(text);
  while (exitMatch) {
    const arg = exitMatch[1].trim();
    if (arg !== "0") {
      badExit.push({ line: lineOf(text, exitMatch.index + 1), text: exitMatch[0].trim() });
    }
    exitMatch = exitRe.exec(text);
  }

  return { items, missing, replyInCatch, badExit };
}

/** 判据⑦：selftest 里那段被标记的脚本文本断言。 */
export function checkSelftestHook(selftestSource) {
  const text = String(selftestSource ?? "");
  const beginAt = text.indexOf(SELFTEST_MARKER_BEGIN);
  const endAt = text.indexOf(SELFTEST_MARKER_END);
  const problems = [];
  let assertions = 0;
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    problems.push(
      `缺少 \`${SELFTEST_MARKER_BEGIN}\` / \`${SELFTEST_MARKER_END}\` 标记段（钩子被删 = 自检又变回「什么都没验」）`,
    );
  } else {
    const section = text.slice(beginAt, endAt);
    assertions = (section.match(/\bassert\.[A-Za-z]+\(/g) ?? []).length;
    if (assertions < MIN_SELFTEST_SCRIPT_ASSERTS) {
      problems.push(
        `标记段里只有 ${assertions} 条 \`assert.*\`（下界 ${MIN_SELFTEST_SCRIPT_ASSERTS}）`,
      );
    }
    if (!/gui-windows\.ts/.test(section)) {
      problems.push("标记段没有读源码 `gui-windows.ts`（断言的可能不是真脚本）");
    }
  }
  return { problems, assertions };
}

/**
 * 主判据。
 *
 * @param {{root?: string}} [options]
 * @returns {{root: string, srcPath: string, ok: boolean, blind: string[],
 *            criteria: {id: string, title: string, ok: boolean, detail: string}[],
 *            metrics: Record<string, unknown>, findings: object[]}}
 */
export function check(options = {}) {
  const root = resolve(String(options.root ?? process.cwd()));
  const srcPath = resolve(root, SRC_REL);
  const blind = [];
  const criteria = [];
  const metrics = {};

  if (!existsSync(srcPath)) {
    blind.push(`事实源缺失：${SRC_REL} 不存在（root=${root}）—— 判据瞎了，不是「脚本没问题」`);
    return { root, srcPath, ok: false, blind, criteria, metrics, findings: [] };
  }
  const source = readFileSync(srcPath, "utf8");

  let extracted;
  try {
    extracted = extractRawScript(source);
  } catch (error) {
    if (!(error instanceof StructureError)) throw error;
    blind.push(`${error.message} —— 判据瞎了`);
    return { root, srcPath, ok: false, blind, criteria, metrics, findings: [] };
  }

  const { body, nonEmptyLines, startLine, endLine } = extracted;
  const bodyLines = extracted.bodyLines;
  const firstContent = bodyLines.findIndex((line) => line.trim() !== "");
  const lastContent = bodyLines.length - 1 - [...bodyLines].reverse().findIndex((line) => line.trim() !== "");
  const contentSpan = `L${startLine + firstContent}-L${startLine + lastContent}`;
  metrics.startLine = startLine;
  metrics.endLine = endLine;
  metrics.contentSpan = contentSpan;
  metrics.lines = extracted.bodyLines.length;
  metrics.nonEmptyLines = nonEmptyLines;

  if (nonEmptyLines < MIN_SCRIPT_LINES) {
    blind.push(
      `脚本塌到 ${nonEmptyLines} 个非空行（下界 ${MIN_SCRIPT_LINES}）—— 提取面抓错了对象或脚本被掏空，判据瞎了`,
    );
    return { root, srcPath, ok: false, blind, criteria, metrics, findings: [] };
  }

  const analysis = analyzeScript(body);
  metrics.counts = analysis.counts;
  metrics.maxDepth = analysis.maxDepth;
  metrics.quotes = analysis.quotes;
  metrics.hereStrings = analysis.hereStrings.length;
  metrics.interpolationHits = analysis.interpolationHits;

  const at = (line) => `脚本第 ${line} 行（${SRC_REL}:${startLine + line - 1}）`;

  // ① 提取
  criteria.push({
    id: "①",
    title: "提取脚本（String.raw 模板体，未复制文本）",
    ok: true,
    detail: `解析自 ${SRC_REL}:${contentSpan}，${bodyLines.length} 行 / 非空 ${nonEmptyLines} 行（模板边界 L${startLine}-L${endLine}；未复制任何脚本文本）`,
  });

  // ② 结构平衡
  const bracketFindings = analysis.findings.filter((f) => f.code.startsWith("bracket"));
  const bracketDetail = ["{}", "()", "[]"]
    .map((k) => `${k} 开/闭 ${analysis.counts[k].open}/${analysis.counts[k].close}`)
    .join(" · ");
  criteria.push({
    id: "②",
    title: "结构平衡（先剥字符串/here-string/注释再配对）",
    ok: bracketFindings.length === 0,
    detail:
      bracketFindings.length === 0
        ? `${bracketDetail}（最大嵌套 ${analysis.maxDepth}）`
        : bracketFindings.map((f) => `${at(f.line)}：${f.message}`).join("；"),
  });

  // ③ 引号与 here-string
  const quoteFindings = analysis.findings.filter(
    (f) => f.code.startsWith("quote") || f.code.startsWith("herestring"),
  );
  criteria.push({
    id: "③",
    title: "引号与 here-string 闭合（终止符必须在行首）",
    ok: quoteFindings.length === 0,
    detail:
      quoteFindings.length === 0
        ? `单引号 ${analysis.quotes.single} 对 · 双引号 ${analysis.quotes.double} 对 · here-string ${analysis.hereStrings.length} 段（${
            analysis.hereStrings
              .map((h) => `脚本第 ${h.openerLine}→${h.terminatorLine} 行，即 ${SRC_REL}:${
                startLine + h.openerLine - 1
              }→${startLine + h.terminatorLine - 1}`)
              .join("、") || "无"
          }）`
        : quoteFindings.map((f) => `${at(f.line)}：${f.message}`).join("；"),
  });

  // ④ 无意外插值
  criteria.push({
    id: "④",
    title: "无意外插值（不得出现 ${）",
    ok: analysis.interpolationHits === 0,
    detail:
      analysis.interpolationHits === 0
        ? "0 处 `${`（该脚本设计上不接收任何插值，模型输入只走 stdin JSON）"
        : "出现 " + analysis.interpolationHits + " 处 " + INTERP + "：模板里被塞了 JS 表达式（值会在构建期焊进脚本，破坏「数据只走 stdin」）",
  });

  // ⑤ 必需结构 + 退出码契约
  const required = checkRequiredStructure(body);
  const requiredOk = required.missing.length === 0 && required.replyInCatch && required.badExit.length === 0;
  const requiredProblems = [];
  if (required.missing.length) {
    requiredProblems.push(
      `缺失：${required.missing.map((item) => `\`${item.id}\`（${item.why}）`).join("；")}`,
    );
  }
  if (!required.replyInCatch) {
    requiredProblems.push("`catch` 里没有 `Reply`：失败路径会变成空 stdout（node 侧读成 invalid_powershell_response）");
  }
  for (const bad of required.badExit) {
    requiredProblems.push(
      `${at(bad.line)}：\`${bad.text}\` —— 退出码契约只允许 \`exit 0\`；失败必须经 Reply 回 JSON，让进程 exit 0`,
    );
  }
  criteria.push({
    id: "⑤",
    title: "必需结构 + 退出码契约",
    ok: requiredOk,
    detail: requiredOk
      ? required.items.map((item) => item.id).join(" · ") +
        " · catch→Reply（进程 exit 0）· 无 exit <非零>"
      : requiredProblems.join("；"),
  });

  // ⑦ 钩子守卫（第二半）
  const selftestPath = resolve(root, SELFTEST_REL);
  let hook;
  if (!existsSync(selftestPath)) {
    hook = { problems: [`selftest 文件缺失：${SELFTEST_REL}`], assertions: 0 };
  } else {
    hook = checkSelftestHook(readFileSync(selftestPath, "utf8"));
  }
  metrics.selftestAssertions = hook.assertions;
  criteria.push({
    id: "⑦",
    title: "钩子：selftest 真的断言脚本文本",
    ok: hook.problems.length === 0,
    detail:
      hook.problems.length === 0
        ? `${SELFTEST_REL} 的 \`${SELFTEST_MARKER_BEGIN}\` 段里有 ${hook.assertions} 条断言`
        : hook.problems.join("；"),
  });

  // ⑥ 结构红：只在「提取面失效 / 下界塌陷」时触发（那时上面早就 return 了），
  // 正常路径下它是**显式的绿灯**——让人看清「这一条本次是跑过的，不是没跑」。
  criteria.splice(5, 0, {
    id: "⑥",
    title: "结构红（绝不当绿）未触发",
    ok: true,
    detail: `模板在 · 下界 ${MIN_SCRIPT_LINES} 满足（实测非空 ${nonEmptyLines} 行）· 提取面活着`,
  });

  const ok = blind.length === 0 && criteria.every((item) => item.ok);
  return { root, srcPath, ok, blind, criteria, metrics, findings: analysis.findings };
}

/** 人读的报告（判据逐条 + 复核要点，供 CI 日志与人工 review）。 */
export function printReport(result) {
  const { root, srcPath, blind, criteria, metrics } = result;
  console.log("check-windows-gui-script：Windows GUI 的固定 PowerShell 脚本静态校验（零依赖，不需要 PowerShell）");
  console.log(`  事实源：${srcPath.replace(root + "/", "")}（root=${root}）`);
  if (typeof metrics.lines === "number") {
    const shape = ["{}", "()", "[]"]
      .filter((k) => metrics.counts && metrics.counts[k])
      .map((k) => `${k} ${metrics.counts[k].open}/${metrics.counts[k].close}`)
      .join(" ");
    console.log(
      `  脚本：${metrics.lines} 行 / 非空 ${metrics.nonEmptyLines} 行` +
        (shape
          ? ` · here-string ${metrics.hereStrings} 段 · 最大嵌套 ${metrics.maxDepth} · ${INTERP} ${metrics.interpolationHits} 处 · 括号 ${shape}`
          : "（未进入结构分析：判据面已失效）"),
    );
  }
  if (blind.length > 0) {
    for (const item of blind) console.error(`✖ 结构红（判据瞎了）：${item}`);
    console.error("✖ 结论：判据失效，无法判断脚本是否可用 —— 不许当绿。");
    return 2;
  }
  let failed = 0;
  for (const item of criteria) {
    const mark = item.ok ? "✔" : "✖";
    if (!item.ok) failed += 1;
    console.log(`${mark} 判据${item.id} ${item.title}`);
    console.log(`    └ ${item.detail}`);
  }
  console.log("");
  if (failed === 0) {
    console.log(`✔ 全部通过：${criteria.length} 条判据（①–⑥ 静态判据 + ⑦ selftest 钩子）`);
    return 0;
  }
  console.error(`✖ ${failed}/${criteria.length} 条判据不通过（每一条都必须有本事失败，别把判据改宽）`);
  return 1;
}

/* ────────────────────────────── selftest ────────────────────────────── */

/** fixture 用的一份**合法**脚本（≥ 下界行数；结构与真脚本同形，但内容是最小化的）。 */
function fixtureScriptBody(filler = 60) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "",
    "function Reply([bool]$ok, [string]$error = '', [string]$detail = '') {",
    "  $result = @{ ok = $ok }",
    "  if ($error) { $result.error = $error }",
    "  if ($detail) { $result.detail = $detail }",
    "  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 3))",
    "}",
    "",
    "try {",
    "  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "  Add-Type -TypeDefinition @'",
    "public static class FixtureNative {",
    "  public static int Value() { return 1; }",
    "}",
    "'@ -ErrorAction Stop",
  ];
  for (let k = 0; k < filler; k += 1) lines.push(`  $filler${String(k).padStart(2, "0")} = ${k}`);
  lines.push("  Reply $true '' 'fixture'", "} catch {", "  Reply $false ([string]$_.Exception.Message)", "}");
  return lines.join("\n");
}

const FIXTURE_SELFTEST = [
  "// fixture 版 selftest：只保留「标记段 + 两条断言」的最小形态",
  `// ${SELFTEST_MARKER_BEGIN}`,
  "const source = fs.readFileSync(path.join(__dirname, 'gui-windows.ts'), 'utf8');",
  "assert.equal(typeof source, 'string');",
  "assert.ok(source.includes('WINDOWS_GUI_SCRIPT'));",
  `// ${SELFTEST_MARKER_END}`,
  "",
].join("\n");

function fixtureSource(mutate) {
  const body = fixtureScriptBody();
  const source = [
    "export const WINDOWS_GUI_KEYS = ['ENTER'] as const;",
    "",
    "const WINDOWS_GUI_SCRIPT = String.raw`",
    body,
    "`;",
    "",
    "export const ENCODED_SCRIPT = Buffer.from(WINDOWS_GUI_SCRIPT, 'utf16le').toString('base64');",
    "",
  ].join("\n");
  return mutate ? mutate(source) : source;
}

function fixtureFiles(mutate) {
  return {
    [SRC_REL]: fixtureSource(mutate),
    [SELFTEST_REL]: FIXTURE_SELFTEST,
  };
}

function runSelftest() {
  const self = fileURLToPath(import.meta.url);
  const cases = [];
  const withFixture = (name, mutate, expectations) =>
    cases.push({
      name,
      fn: () => {
        const fixture = makeFixtureRepo(fixtureFiles(mutate));
        try {
          const result = runGuard(self, { args: ["--root", fixture.dir], cwd: fixture.dir });
          expectExit(result, { ...expectations, label: name });
        } finally {
          fixture.cleanup();
        }
      },
    });

  cases.push({
    name: "①【正例控制组】真仓库（默认 cwd）→ 绿，六条判据 + 钩子全打勾",
    fn: () => {
      const result = runGuard(self);
      expectExit(result, {
        code: 0,
        contains: [
          "✔ 判据①",
          "✔ 判据②",
          "✔ 判据③",
          "✔ 判据④",
          "✔ 判据⑤",
          "✔ 判据⑦",
          "全部通过",
        ],
        label: "真仓库",
      });
    },
  });

  withFixture(
    "②【正例控制组·未改坏的 fixture】→ 绿（证明下面的负例是被改坏才红的）",
    null,
    { code: 0, contains: ["✔ 判据②", "全部通过"], absent: ["判据瞎了"] },
  );

  cases.push({
    name: "③【结构红】事实源缺失 → exit 2 + 「判据瞎了」",
    fn: () => {
      const fixture = makeFixtureRepo({ [SELFTEST_REL]: FIXTURE_SELFTEST });
      try {
        expectExit(runGuard(self, { args: ["--root", fixture.dir], cwd: fixture.dir }), {
          code: 2,
          contains: ["判据瞎了", "事实源缺失"],
        });
      } finally {
        fixture.cleanup();
      }
    },
  });

  cases.push({
    name: "④【结构红】WINDOWS_GUI_SCRIPT 改名 → exit 2（提取面失效）",
    fn: () => {
      const fixture = makeFixtureRepo(
        fixtureFiles((src) => src.replace("const WINDOWS_GUI_SCRIPT =", "const WINDOWS_GUI_PROGRAM =")),
      );
      try {
        expectExit(runGuard(self, { args: ["--root", fixture.dir], cwd: fixture.dir }), {
          code: 2,
          contains: ["判据瞎了", "String.raw"],
        });
      } finally {
        fixture.cleanup();
      }
    },
  });

  withFixture(
    "⑤【反证】少一个 `}` → 判据②红（括号未闭合）",
    (src) => src.replace("if ($detail) { $result.detail = $detail }", "if ($detail) { $result.detail = $detail "),
    { code: 1, contains: ["✖ 判据②", "未闭合的 `{`"] },
  );

  withFixture(
    "⑥【反证】here-string 终止符被删 → 判据③红",
    (src) => src.replace("\n'@ -ErrorAction Stop\n", "\n\n"),
    { code: 1, contains: ["✖ 判据③", "here-string"] },
  );

  withFixture(
    "⑦【反证】here-string 终止符缩进一格 → 判据③红（PS 5.1 必须在行首）",
    (src) => src.replace("\n'@ -ErrorAction Stop\n", "\n  '@ -ErrorAction Stop\n"),
    { code: 1, contains: ["✖ 判据③", "必须在行首"] },
  );

  withFixture(
    "⑧【反证】单引号字符串未闭合 → 判据③红",
    (src) => src.replace("Reply $true '' 'fixture'", "Reply $true '' 'fixture"),
    { code: 1, contains: ["✖ 判据③", "单引号字符串未闭合"] },
  );

  withFixture(
    "⑨【反证】模板里混进 ${ → 判据④红（插值残留）",
    (src) => src.replace("  $filler03 = 3", "  $filler03 = ${jsValue}"),
    { code: 1, contains: ["✖ 判据④", "插值"] },
  );

  withFixture(
    "⑩【反证】`function Reply` 被改名 → 判据⑤红",
    (src) => src.replace("function Reply([bool]$ok", "function Answer([bool]$ok"),
    { code: 1, contains: ["✖ 判据⑤", "function Reply"] },
  );

  withFixture(
    "⑪【反证】加一行 `exit 1` → 判据⑤红（退出码契约）",
    (src) => src.replace("\n  Reply $true '' 'fixture'", "\n  exit 1\n  Reply $true '' 'fixture'"),
    { code: 1, contains: ["✖ 判据⑤", "exit 1"] },
  );

  withFixture(
    "⑫【正例】注释/字符串里的 `{`、`#` 不算括号 → 不该误报（剥离规则有效）",
    (src) =>
      [
        src.replace(
          "  $filler00 = 0",
          ["  # 注释里的 ( { [ 都不算结构", "  $s = '{(['", '  $t = ")]}"', "  $u = @{ a = '}' }", "  $filler00 = 0"].join(
            "\n",
          ),
        ),
      ].join(""),
    { code: 0, contains: ["✔ 判据②", "全部通过"] },
  );

  cases.push({
    name: "⑬【结构红】脚本塌到 8 行 → exit 2（下界失守，不许静默通过）",
    fn: () => {
      const fixture = makeFixtureRepo(
        fixtureFiles((src) => {
          const stub = [
            "$ErrorActionPreference = 'Stop'",
            "function Reply() { }",
            "try { } catch { Reply }",
            "ConvertTo-Json",
          ].join("\n");
          return src.replace(/const WINDOWS_GUI_SCRIPT = String\.raw`[\s\S]*?`;/, `const WINDOWS_GUI_SCRIPT = String.raw\`\n${stub}\n\`;`);
        }),
      );
      try {
        expectExit(runGuard(self, { args: ["--root", fixture.dir], cwd: fixture.dir }), {
          code: 2,
          contains: ["判据瞎了", "下界"],
        });
      } finally {
        fixture.cleanup();
      }
    },
  });

  cases.push({
    name: "⑭【反证】selftest 删掉 [script-assert] 段 → 判据⑦红（自检变回「什么都没验」）",
    fn: () => {
      const files = fixtureFiles();
      files[SELFTEST_REL] = "assert.ok(true);\n";
      const fixture = makeFixtureRepo(files);
      try {
        expectExit(runGuard(self, { args: ["--root", fixture.dir], cwd: fixture.dir }), {
          code: 1,
          contains: ["✖ 判据⑦", SELFTEST_MARKER_BEGIN],
        });
      } finally {
        fixture.cleanup();
      }
    },
  });

  const failed = reportCases(cases, { title: "check-windows-gui-script selftest" });
  process.exitCode = failed > 0 ? 1 : 0;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--selftest")) {
    runSelftest();
    return;
  }
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  if (rootIndex >= 0 && (root === undefined || root.startsWith("--"))) {
    console.error("--root 需要一个目录参数");
    process.exitCode = 2;
    return;
  }
  const unknown = args.filter((arg, index) => {
    if (arg === "--root") return false;
    if (rootIndex >= 0 && index === rootIndex + 1) return false;
    return arg.startsWith("--");
  });
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(" ")}（支持 --selftest / --root <dir>）`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = printReport(check({ root }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv);
}
