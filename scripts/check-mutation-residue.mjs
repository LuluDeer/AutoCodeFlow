#!/usr/bin/env node
/**
 * R288（2026-11-20）：**变异体残留检测**守卫 —— 「把被测代码改坏做反证，做完忘了还原」的机械兜底。
 *
 * ## 为什么需要它（本轮两次实测，不是推测）
 *
 * 多个 agent 并行做变异测试（改坏被测代码，看测试红不红）。本轮**两次**把变异体留在工作树：
 *   ① `apps/admin-web/src/api/inbox.ts:266` 被改成 `const total = null as number | null;`
 *      ⇒ 同一切片 33 例里 **2 例间歇红**，而切片报告只写「有 1 个未提交文件」；
 *   ② `apps/admin-api/src/modules/sop/sop-assignment-lag.service.ts:379` 被改成
 *      `return { value: (value === 0 ? null : value) as T, degraded: value === 0 };`
 *      ⇒ **反转了「0 是合法值」这个核心语义**（正是做「防御过头」双向反证时留下的）。
 *
 * 两次都靠**人工收口时偶然发现**。这类残留有三个特征，使它特别难被看见：
 *   · 它**不是编译错误** —— 变异体是合法代码，`as` 断言本来就是为骗过类型检查而存在；
 *   · 它**不一定让测试红** —— 「防御分支没有非法输入」「测试路径没走到被测层」时，改坏被测层测试照样全绿；
 *   · 它**看起来像正常改动** —— `git status` 只说「有未提交文件」，不说改动了哪一条语义。
 *
 * 本仓已有正确先例：`check-agent-event-causation.mjs:652` 的
 * 「**绝不在共享文件上做变异**」（把真实树复制到 `/tmp` 再改）。本守卫是那条纪律的兜底网。
 *
 * ## 判据（分层；立场是「**要求人确认**」，不是「断言这一定是变异体」）
 *
 * 误报的代价是「人看一眼」，漏报的代价是「一批测试间歇红、收口时才偶然发现」。
 * 所以只咬**变异体特有**的形态，宁可少报：
 *
 *   ① **高危标记（红）**：只扫**未提交改动里新增的行**（`git diff` 的 `+` 行 + 未跟踪新文件的全部行），
 *      且只扫 `apps/` `packages/` 下的**生产代码**：
 *      · `if-constant`：`if (false)` / `if (true)` —— 恒假/恒真分支，最常见的「改坏一行」；
 *      · `null-as`：`= null as <T>` —— 把值硬置 null 再用 `as` 断言类型（本轮 ① 的原形）；
 *      · `zero-to-null`：`(x === 0 ? null : x)` —— 把**合法值**当失败返回（本轮 ② 的原形）；
 *      · `mutation-word`：注释/字符串里的 `MUTATED` / `REVERSE-PROOF` / `变异`
 *        —— 做反证的人给自己留的记号没清掉。
 *   ② **配对提示（黄，不判红）**：未提交的生产代码改动**旁边没有任何测试改动** ⇒ 提示
 *      「请确认这不是变异体」。这是被替掉的那条签名式判据的降级形态（见下）。
 *   ③ **测试白名单**：`__tests__/`、`*.spec.*`、`*.test.*`、`tests/` 下的同形态代码**不判红**
 *      —— 测试里 `if (false)` 偶尔合法（临时短路一段用例），判红会把人逼去删白名单。
 *      测试文件的改动不进判据 ①，但仍计入判据 ② 的「有没有测试改动」。
 *
 * ## 被显式放弃的判据（写进代码，防下一轮有人再试一遍）
 *
 * 「未提交改动只动 1–3 行，且改动后该文件相关测试**间歇失败**」这条签名很准，但：
 *   · 「间歇失败」**得跑测试才知道**，而本守卫的设计前提是**零依赖、秒级、每轮可跑**；
 *   · 「间歇」本身不可判定（要同一条命令跑两次结果不同），重跑成本 = 全量测试；
 *   · 它会制造新的假绿通道：「守卫红了 ⇒ 去跑测试 ⇒ 测试恰好绿 ⇒ 以为没问题」。
 * ⇒ 只保留代价可忽略的替代：**生产代码改动与测试改动必须同批出现**（判据 ②）。
 *
 * ## 为什么**不**接进 `guards-repo-matrix` / `test:guards:repo`
 *
 * 它扫的是**工作树未提交改动**（`git diff`）。矩阵跑的是**已提交状态**（干净检出），
 * 接进去只会永远打印「无未提交改动」——一条恒绿的死判据比没有更糟（会让人以为有保护）。
 * 正确接法是**每轮收口前手工跑一次**（`npm run check:mutation-residue`），
 * 见 `docs/AGENT_HANDOFF.md` 的「变异测试纪律」一节。
 *
 * ## 退出码
 *
 *   0 = 扫描面内无未提交改动 / 只有黄灯提示（**黄灯不红**，它要求人确认）
 *   1 = 判据 ① 命中（红）
 *   2 = 判据不可判定（不是 git 仓库 / git 不可用 / 扫描面塌陷）—— **绝不把「读不到」当「干净」**
 *
 * ## 已知盲区（如实）
 *
 *   · 只扫 `apps/` `packages/`：`scripts/` `docs/` 与配置文件的改动不进面。`scripts/` 里大量守卫
 *     夹具**本来就含** `if (false)` 这类字面量，扫进去会把守卫自己判红；
 *   · 只看**新增行**：若变异体是「删掉一行守卫条件」形成，形态与本判据无关（由测试红兜底）；
 *   · 不判「改动语义是否等价」—— 那是人的事，本守卫只负责把可疑改动**摆到人眼前**；
 *   · 豁免标记 `mutation-residue-ok: <理由>` 必须与可疑行**同一行**（跨行窗口会制造漏报面）。
 *
 * ## 用法
 *
 *   npm run check:mutation-residue                       # 主跑（扫真实仓库工作树）
 *   node scripts/check-mutation-residue.mjs --selftest   # 判据自检（真子进程 + 夹具 git 仓库）
 *   node scripts/check-mutation-residue.mjs --root <dir> # 换仓库根（自检/排查用）
 *   node scripts/check-mutation-residue.mjs --json       # 机器可读
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
/** 仓库根：`<repo>/scripts/check-mutation-residue.mjs` 往上一级。 */
export const REPO_ROOT = resolve(dirname(HERE), "..");
/** 自检里要被反复调用的是本文件自己（真子进程，黑盒）。 */
export const SELF = HERE;

/** 扫描面：产品代码所在的两个组。`scripts/` 刻意排除（理由见头注「已知盲区」）。 */
export const SCAN_ROOTS = ["apps", "packages"];

const CODE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
/** 生成物 / 依赖目录：内容由机器产生，标记命中没有信息量。 */
const IGNORE_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "generated",
]);

/**
 * 测试文件判定（白名单，判据 ③）。
 *
 * 覆盖本仓实际存在的四种形态：`__tests__/x.ts`、`x.spec.ts`、`x.test.tsx`、`tests/x.ts`；
 * 另把 `__mocks__/` / `__fixtures__/` 一并归入（它们是测试夹具，不是产品行为）。
 */
const TEST_PATH_RE =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?)\/|\.(?:spec|test|stories)\.[cm]?[jt]sx?$/;

/**
 * 判据 ① 的四个高危标记。
 *
 * `id` 会原样出现在报错文本里 —— 自检断言与人工确认都靠它，改名即等于改契约。
 * `why` 写在人看到的那一行里：**要求确认**必须有「确认什么」。
 */
export const MARKERS = [
  {
    id: "if-constant",
    re: /\bif\s*\(\s*(?:false|true)\s*\)/,
    why: "恒假/恒真分支 if (false) / if (true)：把一段行为一次性关掉或打开",
  },
  {
    id: "null-as",
    re: /(?:=|return)\s*null\s+as\s+[A-Za-z_$(]/,
    why: "把值硬置 null 再用 `as` 断言类型（`= null as T`）：值没了，类型检查还认为它在",
  },
  {
    id: "zero-to-null",
    re: /\b([A-Za-z_$][\w$.]*)\s*={2,3}\s*0\s*\?\s*null\s*:\s*\1\b/,
    why: "把合法值当失败：(x === 0 ? null : x) —— 「0 是合法值」的语义被反转",
  },
  {
    id: "derived-to-constant",
    // 形如 `truncated: total.value === null ? false : returned < total.value` 被改成
    // `truncated: false` —— **把一个派生布尔直接钉成常量**。这是 R288 第三次真实残留
    // 的原形（`returned < total.value` → `returned <= total.value` 也属同族，
    // 见下面的 comparison-flip）。
    re: /\b(?:truncated|degraded|total|returned)\s*:\s*(?:false|true|null)\s*[,}]/,
    why: "把派生字段钉成常量（`truncated: false` / `degraded: true` …）：契约字段失去信息量，且正常路径照样绿",
  },
  {
    id: "comparison-flip",
    // `<` ↔ `<=` 这类「差一个等号」的翻转：截断/边界语义全变但类型全对。
    // 只在**未提交改动的 `+` 行**里咬，且要求同行出现截断/边界类标识符，压低误报。
    re: /\b(?:truncated|isTruncated|hasMore)\b[^\n]*[<>]=?[^\n]*\b(?:total|len|length)\b/,
    why: "边界比较可能被翻转（`<` ↔ `<=`）：截断/分页语义全变而类型全对",
  },
  {
    id: "mutation-word",
    re: /\b(?:MUTATED|REVERSE-?PROOF)\b|变异/,
    why: "注释/字符串里残留变异标记 MUTATED / REVERSE-PROOF / 变异：反证做的记号没清",
  },
];

/** 豁免标记：同一行写 `mutation-residue-ok: <≥8 字理由>` 才认；**光秃标记仍然红**。 */
const EXEMPT_RE = /mutation-residue-ok\s*:\s*(.*)$/;
const MIN_EXEMPT_REASON = 8;

/** 报错里最多列这么多条（防止一次误改刷屏，人看不完）。 */
const MAX_REPORTED = 40;

const git = (cwd, args) =>
  spawnSync("git", ["-C", cwd, "-c", "core.quotepath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      // 与用户级 git 配置隔离：自检夹具仓库不该被 gpg 签名 / 全局 hooks / 别名污染。
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });

const isInScanFace = (rel) =>
  SCAN_ROOTS.some((r) => rel === r || rel.startsWith(`${r}/`)) &&
  CODE_EXT_RE.test(rel) &&
  !rel.split("/").some((seg) => IGNORE_SEGMENTS.has(seg));

export const isTestPath = (rel) => TEST_PATH_RE.test(rel);

/**
 * 读工作树状态（相对仓库根，`-z` 逐条，避免空格路径被切断）。
 *
 * 返回 `{ ok: false, reason }` 表示**判据不可判定**（调用方据此 exit 2）：
 * 「读不到工作树」与「工作树干净」是两件事，混为一谈就是本仓最熟悉的假绿。
 */
export function readWorkingTreeChanges(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.error || top.status !== 0) {
    return { ok: false, reason: `不是 git 工作树（或 git 不可用）：${String(top.stderr ?? "").trim()}` };
  }
  const gitRoot = top.stdout.trim();
  if (gitRoot === "") return { ok: false, reason: "`git rev-parse --show-toplevel` 返回空路径" };

  const status = git(gitRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.status !== 0) {
    return { ok: false, reason: `git status 失败：${String(status.stderr ?? "").trim()}` };
  }

  const records = status.stdout.split("\0");
  const entries = [];
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec || rec.length < 4) continue;
    const code = rec.slice(0, 2);
    const path = rec.slice(3);
    // 重命名/复制记录后面紧跟一条「原路径」，跳过它（否则会把旧路径当成又一改动）。
    if (/[RC]/.test(code)) i += 1;
    entries.push({ code, path });
  }
  return { ok: true, gitRoot, entries };
}

/** 统一 diff 里取出**新增行**（带新文件行号）。 */
export function parseAddedLines(diffText, map) {
  let cur = null;
  let newLine = 0;
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (cur !== null && !map.has(cur)) map.set(cur, []);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (cur === null || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      map.get(cur).push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return map;
}

/**
 * 收集扫描面内每个候选文件的新增行。
 *
 * 已跟踪文件走 `git diff HEAD -U0`（**工作树 vs HEAD**，同时覆盖已暂存与未暂存——
 * 只比 index 会漏掉已 `git add` 的变异体）；未跟踪新文件整体视为新增。
 */
export function collectAddedLines(gitRoot, tracked, untracked) {
  const map = new Map();
  if (tracked.length > 0) {
    let diff = git(gitRoot, ["diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "--", ...tracked]);
    if (diff.status !== 0) {
      // 没有 HEAD（空仓库）时 HEAD 不存在：退回「工作树 vs index」+「index vs HEAD」两段。
      const work = git(gitRoot, ["diff", "-U0", "--no-color", "--", ...tracked]);
      const staged = git(gitRoot, ["diff", "--cached", "-U0", "--no-color", "--", ...tracked]);
      diff = { status: 0, stdout: `${work.stdout ?? ""}\n${staged.stdout ?? ""}` };
    }
    parseAddedLines(diff.stdout, map);
  }
  for (const rel of untracked) {
    let text = "";
    try {
      text = readFileSync(join(gitRoot, rel), "utf8");
    } catch {
      text = "";
    }
    map.set(
      rel,
      text.split("\n").map((line, idx) => ({ line: idx + 1, text: line })),
    );
  }
  return map;
}

/** 单行判定：先看豁免标记，再逐个标记。返回 `{ status, hits, exemptReason }`。 */
export function judgeLine(text, { allowMarkers }) {
  const exempt = EXEMPT_RE.exec(text);
  if (exempt) {
    const reason = (exempt[1] ?? "").trim();
    if ([...reason].length >= MIN_EXEMPT_REASON) {
      return { status: "exempt", hits: [], exemptReason: reason };
    }
    return {
      status: "red",
      hits: [
        {
          id: "exempt-without-reason",
          why: `豁免标记 \`mutation-residue-ok:\` 必须跟 ≥${MIN_EXEMPT_REASON} 字理由（收到 ${JSON.stringify(reason)}）`,
        },
      ],
      exemptReason: null,
    };
  }
  if (!allowMarkers) return { status: "clean", hits: [], exemptReason: null };
  const hits = [];
  for (const marker of MARKERS) {
    if (marker.re.test(text)) hits.push({ id: marker.id, why: marker.why });
  }
  return { status: hits.length > 0 ? "red" : "clean", hits, exemptReason: null };
}

/**
 * 主判据：返回
 *   `{ ok, red: [{path,line,id,why,snippet}], yellow: {prod, tests, small}, entries, structural }`
 * - `structural` 非空 ⇒ 判据不可判定（exit 2）；
 * - `red` 非空 ⇒ exit 1；
 * - `yellow` 非空 ⇒ exit 0 + 提示（**要求人确认**）。
 */
export function judge(root = REPO_ROOT) {
  const state = readWorkingTreeChanges(root);
  if (!state.ok) {
    return { ok: false, structural: [state.reason], red: [], yellow: null, entries: 0, scoped: 0 };
  }
  const { gitRoot, entries } = state;

  const facePresent = SCAN_ROOTS.filter((r) => {
    try {
      readFileSync(join(gitRoot, r, ".keep"), "utf8");
      return true;
    } catch {
      return git(gitRoot, ["ls-files", "--", r]).stdout.trim() !== "";
    }
  });
  if (facePresent.length === 0) {
    return {
      ok: false,
      structural: [`扫描面塌陷：${gitRoot} 下 ${SCAN_ROOTS.join(" / ")} 都没有可扫描的文件`],
      red: [],
      yellow: null,
      entries,
      scoped: 0,
    };
  }

  const scoped = entries.filter((e) => isInScanFace(e.path));
  const tracked = scoped.filter((e) => e.code !== "??").map((e) => e.path);
  const untracked = scoped.filter((e) => e.code === "??").map((e) => e.path);
  const added = collectAddedLines(gitRoot, tracked, untracked);

  const red = [];
  const prod = [];
  const tests = [];
  let exemptCount = 0;

  for (const entry of scoped) {
    const isTest = isTestPath(entry.path);
    const lines = added.get(entry.path) ?? [];
    const addedCount = lines.length;
    (isTest ? tests : prod).push({ path: entry.path, addedCount, code: entry.code });

    if (isTest) continue; // 判据 ③：测试文件白名单（同形态代码不判红）
    for (const row of lines) {
      const verdict = judgeLine(row.text, { allowMarkers: true });
      if (verdict.status === "exempt") {
        exemptCount += 1;
        continue;
      }
      for (const hit of verdict.hits) {
        red.push({
          path: entry.path,
          line: row.line,
          id: hit.id,
          why: hit.why,
          snippet: row.text.trim().slice(0, 200),
        });
      }
    }
  }

  const yellow =
    prod.length > 0 && tests.length === 0
      ? {
          prod,
          small: prod.reduce((acc, p) => acc + p.addedCount, 0) <= 3,
        }
      : null;

  return {
    ok: red.length === 0,
    structural: [],
    red,
    yellow,
    entries: entries.length,
    scoped: scoped.length,
    prodFiles: prod.length,
    testFiles: tests.length,
    exemptCount,
  };
}

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
}

function printRed(red) {
  console.error("");
  console.error(
    `✘ 变异体残留：${red.length} 处**可疑**改动（要求人确认，不是断言「这一定是变异体」）：`,
  );
  for (const r of red.slice(0, MAX_REPORTED)) {
    console.error(`  · ${r.path}:${r.line}  [${r.id}]`);
    console.error(`      ${r.why}`);
    console.error(`      ${r.line} | ${r.snippet}`);
  }
  if (red.length > MAX_REPORTED) {
    console.error(`  … 另有 ${red.length - MAX_REPORTED} 处未打印（用 --json 看全量）`);
  }
  console.error("");
  console.error("  处置：① 是留下的变异体 ⇒ 还原该行（`git checkout -- <file>` 或手工改回）；");
  console.error("        ② 是正常改动 ⇒ 在同一行写 `mutation-residue-ok: <≥8 字理由>`，它会出现在 diff 里被 review 看见。");
  console.error("  纪律：做变异测试请在 `git stash` / `/tmp` 副本上做（先例见 check-agent-event-causation.mjs:652）。");
}

function printYellow(yellow) {
  console.log("");
  console.log("⚠ 变异体残留提示（黄灯，不判红）：只有生产代码改动、同批**没有任何测试改动**");
  console.log("  —— 请确认这不是变异体。");
  for (const p of yellow.prod.slice(0, MAX_REPORTED)) {
    console.log(`  · ${p.path}（+${p.addedCount} 行）`);
  }
  if (yellow.prod.length > MAX_REPORTED) {
    console.log(`  … 另有 ${yellow.prod.length - MAX_REPORTED} 个文件未打印（用 --json 看全量）`);
  }
  if (yellow.small) {
    console.log("  · 合计新增 ≤3 行：这正是「改一行看测试红不红」的典型形状。");
  }
  console.log("");
  console.log("  为什么这是信号：变异测试的产物有两种留痕形态 —— 改坏被测源码，或只改测试。");
  console.log("  被测源码单独出现改动时，从 diff 上看不出「这是新功能，还是把判据改松了」。");
  console.log("  处置：确认是正常功能改动 ⇒ 继续；是变异体 ⇒ 还原，并补上对应的测试改动。");
}

function main(argv) {
  const json = argv.includes("--json");
  const rootArg = argValue(argv, "--root");
  const result = judge(resolve(rootArg ?? REPO_ROOT));

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.structural.length > 0 ? 2 : result.red.length > 0 ? 1 : 0;
  }

  if (result.structural.length > 0) {
    console.error(`✘ 变异体残留扫描：判据不可判定 —— ${result.structural.join("；")}`);
    console.error("  绝不把「读不到工作树状态」当成「工作树干净」。");
    return 2;
  }

  if (result.red.length > 0) {
    printRed(result.red);
    return 1;
  }

  if (result.yellow) {
    printYellow(result.yellow);
    console.log(
      `✔ 未命中高危标记（扫描面内 ${result.scoped} 个未提交代码文件、工作树共 ${result.entries} 个未提交条目）。`,
    );
    return 0;
  }

  if (result.scoped === 0) {
    const extra = result.entries > 0
      ? `另有 ${result.entries} 个未提交条目不在扫描面（${SCAN_ROOTS.join(" / ")} 之外，如 docs/ scripts/ 与根配置）`
      : "工作树完全干净";
    console.log(
      `✔ 变异体残留扫描：扫描面（${SCAN_ROOTS.join(" + ")} 的代码）内无未提交改动 —— ${extra}。`,
    );
    return 0;
  }

  // prod 为空（只改了测试）：不触发黄灯（改测试不是「改坏被测代码」的形状），
  // 但同样不许说成「生产代码 + 测试配对」—— 措辞必须与事实一致，否则下次没人信这条输出。
  const shape =
    result.prodFiles === 0
      ? "只改了测试（无生产代码改动），未命中高危标记"
      : `${result.scoped} 个未提交代码文件全部配对（生产代码 + 测试同批改动），未命中高危标记`;
  console.log(
    `✔ 变异体残留扫描：${shape}` +
      `${result.exemptCount > 0 ? `（另有 ${result.exemptCount} 行带理由豁免）` : ""}。`,
  );
  return 0;
}

/* ─────────────────────────────── --selftest ─────────────────────────────── */

/** 真 git 夹具仓库：先提交基线，再在工作树里落「变异体」（**不提交**，这正是被测状态）。 */
function makeGitFixture(baseFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acf-mutation-residue-"));
  const write = (rel, text) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  };
  const files = {
    "apps/fixture/src/panel.service.ts": "export const load = () => 1;\n",
    "apps/fixture/src/__tests__/panel.spec.ts": "test('ok', () => expect(1).toBe(1));\n",
    ...baseFiles,
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);

  const init = git(dir, ["init", "-q"]);
  if (init.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`夹具仓库 git init 失败：${String(init.stderr ?? "").trim()}`);
  }
  git(dir, ["add", "-A"]);
  const commit = git(dir, [
    "-c",
    "user.name=guard-selftest",
    "-c",
    "user.email=guard@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "baseline",
  ]);
  if (commit.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`夹具仓库基线提交失败：${String(commit.stderr ?? "").trim()}`);
  }
  return {
    dir,
    write,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 同一棵树的**非** git 版本：用来证明「判不出就是 2，不是 0」。 */
function makePlainFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "acf-mutation-residue-plain-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  const withRepo = (mutate, assertions) => {
    const repo = makeGitFixture();
    try {
      mutate(repo);
      assertions(repo);
    } finally {
      repo.cleanup();
    }
  };

  push("① 干净工作树 ⇒ exit 0，且明确输出「无未提交改动」", () => {
    withRepo(
      () => {},
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 0,
          contains: ["无未提交改动"],
          absent: ["请确认这不是变异体", "变异体残留："],
          label: "干净树",
        });
      },
    );
  });

  push("② `if (false)` 在生产文件 ⇒ exit 1 点名 if-constant", () => {
    withRepo(
      (repo) =>
        repo.write(
          "apps/fixture/src/panel.service.ts",
          "export const load = () => 1;\nif (false) {\n  throw new Error('x');\n}\n",
        ),
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 1,
          contains: ["apps/fixture/src/panel.service.ts", "if-constant"],
          label: "生产文件恒假分支",
        });
      },
    );
  });

  push("③ 同样内容在 `__tests__` ⇒ exit 0（测试白名单）", () => {
    withRepo(
      (repo) =>
        repo.write(
          "apps/fixture/src/__tests__/panel.spec.ts",
          "test('ok', () => {\n  if (false) {\n    expect(1).toBe(2);\n  }\n  expect(1).toBe(1);\n});\n",
        ),
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 0,
          absent: ["if-constant", "变异体残留："],
          label: "测试白名单",
        });
      },
    );
  });

  push("④ `= null as number | null`（inbox.ts 的原形）⇒ exit 1 点名 null-as", () => {
    withRepo(
      (repo) =>
        repo.write(
          "apps/fixture/src/panel.service.ts",
          "export const load = () => 1;\nexport const total = null as number | null;\n",
        ),
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 1,
          contains: ["null-as", "as number | null"],
          label: "null as 断言",
        });
      },
    );
  });

  push(
    "⑪ `truncated: false`（派生字段钉成常量，R288 第三次残留的原形）⇒ exit 1 点名 derived-to-constant",
    () => {
      withRepo(
        (repo) => {
          repo.write(
            "apps/fixture/src/lag.service.ts",
            [
              "export function f(returned: number, total: number) {",
              "  return { truncated: false, returned, total };",
              "}",
              "",
            ].join("\n"),
          );
          repo.write("apps/fixture/src/__tests__/lag.spec.ts", "test('t', () => {});\n");
        },
        (repo) => {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            code: 1,
            contains: ["derived-to-constant"],
            label: "derived-to-constant",
          });
        },
      );
    },
  );

  push("⑤ `(value === 0 ? null : value)`（sop-assignment-lag 的原形）⇒ exit 1 点名 zero-to-null", () => {
    withRepo(
      (repo) =>
        repo.write(
          "apps/fixture/src/panel.service.ts",
          "export const load = () => 1;\nexport function pick(value: number) {\n  return (value === 0 ? null : value);\n}\n",
        ),
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 1,
          contains: ["zero-to-null"],
          label: "0 反转成 null",
        });
      },
    );
  });

  push("⑥ 只有 `src/` 改动、无测试改动 ⇒ exit 0 + 黄灯「请确认这不是变异体」", () => {
    withRepo(
      (repo) => repo.write("apps/fixture/src/panel.service.ts", "export const load = () => 2;\n"),
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 0,
          contains: ["请确认这不是变异体", "panel.service.ts", "黄灯"],
          absent: ["变异体残留："],
          label: "黄灯提示",
        });
      },
    );
  });

  push("⑦ 正例控制组：生产代码 + 测试同批改动且无高危标记 ⇒ exit 0 且**不许**出现黄灯", () => {
    withRepo(
      (repo) => {
        repo.write("apps/fixture/src/panel.service.ts", "export const load = () => 3;\n");
        repo.write(
          "apps/fixture/src/__tests__/panel.spec.ts",
          "test('ok', () => expect(3).toBe(3));\n",
        );
      },
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 0,
          contains: ["全部配对"],
          absent: ["请确认这不是变异体", "变异体残留："],
          label: "配对正例（黄灯不是永真）",
        });
      },
    );
  });

  push("⑧ 豁免标记：带 ≥8 字理由 ⇒ exit 0；光秃标记 ⇒ 仍然 exit 1", () => {
    withRepo(
      (repo) =>
        repo.write(
          "apps/fixture/src/panel.service.ts",
          "export const load = () => 1;\nconst total = null as number | null; // mutation-residue-ok: 未读数表示还没统计，与变异无关\n",
        ),
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 0,
          absent: ["[null-as]"],
          label: "带理由豁免",
        });
        repo.write(
          "apps/fixture/src/panel.service.ts",
          "export const load = () => 1;\nconst total = null as number | null; // mutation-residue-ok:\n",
        );
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 1,
          contains: ["exempt-without-reason"],
          label: "光秃豁免仍然红",
        });
      },
    );
  });

  push("⑨ 生产代码里的 `MUTATED` 注释 ⇒ exit 1 点名 mutation-word", () => {
    withRepo(
      (repo) =>
        repo.write(
          "apps/fixture/src/panel.service.ts",
          "export const load = () => 1;\n// MUTATED: 去掉 Number.isFinite 看测试红不红\nexport const meta = (v: number) => v;\n",
        ),
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 1,
          contains: ["mutation-word"],
          label: "变异标记残留",
        });
      },
    );
  });

  push("⑩ 不是 git 仓库 ⇒ exit 2（判不出 ≠ 干净）", () => {
    const plain = makePlainFixture({ "apps/fixture/src/panel.service.ts": "export const load = () => 1;\n" });
    try {
      expectExit(runGuard(SELF, { args: ["--root", plain.dir] }), {
        code: 2,
        contains: ["判据不可判定"],
        label: "非 git 树",
      });
    } finally {
      plain.cleanup();
    }
  });

  return reportCases(cases, { title: "check-mutation-residue selftest" }) === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
