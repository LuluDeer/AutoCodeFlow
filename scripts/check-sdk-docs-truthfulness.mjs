#!/usr/bin/env node
/**
 * SDK 文档真实性守卫（docs/ROADMAP.md P0-2）。
 *
 * 由来：README 的 SDK 示例曾写成「任务脚本里直接就有 `ctx`」的样子，而真实语义是
 * **必须显式引入 SDK**（`require('@autocodeflow/sdk')` / `from autoflow_sdk import ...`），
 * 且 **Glue 脚本走系统运行时、不安装 `requirements`**（需要 SDK 时得用应用包/依赖渠道）。
 * 这两条恰恰决定「第一次照着文档抄能不能跑通」——文档漂了，用户会先撞一次墙再回来怀疑产品。
 *
 * 判据（只判确定能判的，不做语义理解）：
 *   A. 目标文档里每个 js/ts/python 代码围栏，只要出现 `ctx.`，同一围栏内必须出现对应的
 *      显式引入（node → `@autocodeflow/sdk`；python → `autoflow_sdk`）。
 *   B. 目标文档必须有一行同时出现 `glue` 与「忽略 / 不安装 / do not install / ignored」，
 *      即把「Glue 不安装 requirements」的口径写出来。
 *   C. 不得出现「ctx 无需/不用引入」这类与 A 相反的错误口径。
 *
 * 反例测试：`--selftest` 用内联夹具验证「无引入 / 无口径 / 错误口径会被抓」，
 * 同时验证「纯 Glue 脚本（不碰 ctx）不会被误伤」——避免守卫把合法写法判红。
 *
 * 用法：node scripts/check-sdk-docs-truthfulness.mjs [--selftest]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

/** 目标文档：README.md 是事实源（README.en/zh 由 readme-sync 从它拆出）。 */
export const TARGETS = ["README.md", "docs/sdk-guide.md"];

/** 围栏语言 → SDK 引入判据。 */
const LANG_KIND = {
  js: "node",
  javascript: "node",
  ts: "node",
  typescript: "node",
  jsx: "node",
  tsx: "node",
  python: "python",
  py: "python",
};

const SDK_IMPORT = {
  node: /@autocodeflow\/sdk/,
  python: /autoflow_sdk/,
};

/** 从 Markdown 抽取代码围栏（返回 {lang,startLine,body}）。 */
export function extractFences(md) {
  const lines = md.split("\n");
  const blocks = [];
  let cur = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (/^\s*```/.test(line)) {
      if (cur === null) {
        cur = {
          lang: line.replace(/^\s*```/, "").trim().toLowerCase(),
          startLine: idx + 1,
          lines: [],
        };
      } else {
        blocks.push({ lang: cur.lang, startLine: cur.startLine, body: cur.lines.join("\n") });
        cur = null;
      }
      continue;
    }
    if (cur !== null) cur.lines.push(line);
  }
  if (cur !== null) {
    blocks.push({ lang: cur.lang, startLine: cur.startLine, body: cur.lines.join("\n") });
  }
  return blocks;
}

/** 判据 B：文档是否写明「Glue 不安装 requirements / 需显式引入」。 */
export function hasGlueCaveat(md) {
  return md
    .split("\n")
    .some(
      (l) =>
        /glue/i.test(l) &&
        /(忽略|不安装|不生效|不参与|do not install|are ignored|ignored)/i.test(l),
    );
}

/** 判据 C：是否出现「ctx 无需/不用引入」的错误口径。 */
export function wrongGlobalCtxClaims(md) {
  const out = [];
  md.split("\n").forEach((l, i) => {
    const a = /(无需|不用|不需要)\s*(显式)?\s*(引入|import)[^\n]{0,16}ctx/i.test(l);
    const b = /ctx[^\n]{0,12}(无需|不用|不需要)\s*(显式)?\s*(引入|import)/i.test(l);
    const c = /(全局|内置|global)\s*`?ctx`?\s*(变量|对象|可直接用|自动注入)/i.test(l);
    if (a || b || c) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

/** 对一个文档跑全部判据，返回问题清单（空数组 = 通过）。 */
export function auditDoc(md, label) {
  const problems = [];
  for (const block of extractFences(md)) {
    const kind = LANG_KIND[block.lang];
    if (!kind) continue;
    if (!/\bctx\s*\./.test(block.body)) continue;
    if (!SDK_IMPORT[kind].test(block.body)) {
      problems.push(
        `${label}:${block.startLine} ${block.lang} 代码块用了 ctx.* 却未显式引入 SDK` +
          `（${kind === "node" ? "@autocodeflow/sdk" : "autoflow_sdk"}）`,
      );
    }
  }
  if (!hasGlueCaveat(md)) {
    problems.push(
      `${label}: 缺少口径说明——Glue 脚本不安装 requirements / 需要 SDK 时必须显式引入`,
    );
  }
  for (const claim of wrongGlobalCtxClaims(md)) {
    problems.push(`${label}:${claim.line} 出现「ctx 无需引入/全局可用」的错误口径：${claim.text}`);
  }
  return problems;
}

// ── 反例测试（判定必须有齿） ────────────────────────────────────────────
const FIXTURES = {
  /** 合法：显式引入 + 口径齐全（node & python 各一）。 */
  good:
    "# doc\n\nGlue 脚本走系统运行时、不安装 requirements；需要 SDK 时显式引入。\n\n" +
    "```js\nconst { TaskContext } = require('@autocodeflow/sdk');\nconst ctx = TaskContext.fromEnv();\nctx.logger.info('hi');\n```\n\n" +
    "```python\nfrom autoflow_sdk import TaskContext\nctx = TaskContext.from_env()\nctx.report_success()\n```\n",
  /** 合法：纯 Glue 脚本，不碰 ctx，不应被判红。 */
  glueOnly:
    "Glue 脚本走系统运行时、不安装 requirements。\n\n" +
    "```js\nconsole.log('hello from glue');\nreturn { ok: true };\n```\n",
  /** 非法：用了 ctx.* 却没有引入。 */
  noImport:
    "Glue 脚本不安装 requirements。\n\n" +
    "```js\nconst res = await ctx.http.get('/api/tasks');\nctx.logger.info('fetched');\n```\n",
  /** 非法：完全没有 Glue 口径。 */
  noCaveat:
    "```js\nconst { TaskContext } = require('@autocodeflow/sdk');\nconst ctx = TaskContext.fromEnv();\n```\n",
  /** 非法：错误地宣称 ctx 无需引入。 */
  wrongClaim:
    "Glue 脚本不安装 requirements。\n\nctx 无需引入，框架会自动注入全局 ctx。\n\n" +
    "```js\nconst { TaskContext } = require('@autocodeflow/sdk');\n```\n",
};

function runSelftest() {
  const checks = [
    ["good", 0],
    ["glueOnly", 0],
    ["noImport", 1],
    ["noCaveat", 1],
    ["wrongClaim", 1],
  ];
  let failures = 0;
  for (const [name, minProblems] of checks) {
    const problems = auditDoc(FIXTURES[name], `fixture:${name}`);
    const ok = minProblems === 0 ? problems.length === 0 : problems.length >= minProblems;
    if (ok) {
      console.log(`✅ 有齿：${name} → ${problems.length} 个问题（期望 ${minProblems === 0 ? "0" : "≥1"}）`);
    } else {
      failures++;
      console.error(`✗ 失齿：${name} → ${problems.length} 个问题（期望 ${minProblems === 0 ? "0" : "≥1"}）`);
      for (const p of problems) console.error("    " + p);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} 项反例测试失败\n`);
    process.exit(1);
  }
  console.log("\n反例测试全部通过\n");
}

function main() {
  const problems = [];
  for (const rel of TARGETS) {
    let md;
    try {
      md = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      problems.push(`${rel}: 文件不存在`);
      continue;
    }
    problems.push(...auditDoc(md, rel));
  }
  if (problems.length > 0) {
    console.error("");
    console.error(`✖ SDK 文档真实性守卫发现 ${problems.length} 个问题：`);
    for (const p of problems) console.error("  · " + p);
    console.error("");
    console.error("  修法：示例里显式引入 SDK（node @autocodeflow/sdk / python autoflow_sdk），");
    console.error("        并写明 Glue 脚本不安装 requirements；不要描述不存在的全局 ctx。");
    process.exit(1);
  }
  console.log(`✔ SDK 文档真实性守卫通过（${TARGETS.length} 篇：${TARGETS.join(", ")}）`);
}

// 只有被直接执行时才跑判定（被 import 时保持纯函数，便于夹具测试复用）。
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes("--selftest")) {
    runSelftest();
  } else {
    main();
  }
}
