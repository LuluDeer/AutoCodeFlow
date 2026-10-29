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
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **只测函数，不测闸门（最贵的一条）**：旧 `--selftest` 把 `auditDoc()` 当纯函数喂
 *     内联字符串，然后断言 `problems.length >= 1`。把 CLI 末尾的 `process.exit(1)` 删掉、
 *     或让 `main()` 永远 return 0，`--selftest` 照样全绿——**报告在说话，闸不关门**。
 *     现在 `--selftest` 在临时 fixture 树里跑**真子进程**，逐条断言退出码 + 关键报错文本。
 *   · **只数条数**：`problems.length >= minProblems` 无法区分「判据 A 抓到了」与
 *     「判据 B 永远报一条缺口径」。实测旧写法下，只要让 B 恒报红，`noImport` /
 *     `noCaveat` / `wrongClaim` 三个反例**全部通过**。现在每条用例断言**具体是哪条判据**、
 *     点名的文件与行号。
 *   · **事实源缺失 = 普通问题**：文档不在时旧实现 push 一条 `${rel}: 文件不存在` 混进
 *     「问题清单」，与真实漂移同一条输出流（处置动作却相反：一个是补文件 / 改路径，
 *     一个是改文档）。现在缺失 → **结构红**（`结构错误` + `事实源缺失：<路径>`），
 *     且绝不把 ENOENT 栈打给 CI 看。
 *   · **扫描面塌方 = 永真绿**：判据 A 遍历 `extractFences()` 的结果。若文档改用 `~~~`
 *     围栏、缩进围栏，或围栏未闭合（三反引号数为奇数）——前者 `blocks` 变空、后者
 *     把全文塞进一个块，两种情况判据 A 都**一条也扫不到**，于是报绿。
 *     现在：单篇解析出 0 个围栏 = 结构红；单篇 0 个「带 ctx.* 的围栏」= 结构红
 *     （下界 1，实测 README 4 个 / sdk-guide 3 个）；围栏不配对 = 结构红。
 *   · **`--root` 缺失 + import 即执行**：旧实现根目录钉死 `process.cwd()`，`--selftest`
 *     永远只能测内存字符串，**守卫本身还会不会红从未被验证**。现在全部路径相对
 *     `root`（默认脚本上级目录），且只有被直接执行时才跑（`isMain`）。
 *
 * 用法：
 *   node scripts/check-sdk-docs-truthfulness.mjs                # 守卫
 *   node scripts/check-sdk-docs-truthfulness.mjs --selftest     # 验证判据本身（有齿）
 *   node scripts/check-sdk-docs-truthfulness.mjs --root <dir>   # 把该目录当仓库根（selftest 专用）
 *
 * 退出码：0 = 文档与实现口径一致；1 = 存在漂移，**或判据本身不可信**（结构错）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = resolve(HERE, "..");

/** 目标文档：README.md 是事实源（README.en/zh 由 readme-sync 从它拆出）。 */
export const TARGETS = ["README.md", "docs/sdk-guide.md"];

/**
 * 每篇文档里「带 `ctx.*` 的代码围栏」的下界。
 *
 * 取 1（实测 README 4 个、docs/sdk-guide.md 3 个）：判据 A 只在**含 ctx.*** 的围栏上
 * 生效，一旦围栏抽取口径失配（`~~~`、缩进围栏、未闭合），A 就退化成永真断言。
 * 下界钉在 1 是「至少还能扫到一个」的最小可信面，不会因为删示例而误红。
 */
export const MIN_CTX_FENCES_PER_DOC = 1;

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

/**
 * 从 Markdown 抽取代码围栏。
 *
 * @param {string} md
 * @returns {{blocks: {lang: string, startLine: number, body: string}[], unclosed: boolean}}
 *   `unclosed` = 三反引号数量为奇数（最后一个围栏没闭合）。此时 `blocks` 的**最后一块
 *   是被截断的**，判据 A 的分块不可信 —— 由调用方升级为结构红，而不是悄悄收尾。
 */
export function extractFences(md) {
  const lines = String(md).split("\n");
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
  const unclosed = cur !== null;
  if (unclosed) {
    blocks.push({ lang: cur.lang, startLine: cur.startLine, body: cur.lines.join("\n") });
  }
  return { blocks, unclosed };
}

/** 判据 B：文档是否写明「Glue 不安装 requirements / 需显式引入」。 */
export function hasGlueCaveat(md) {
  return String(md)
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
  String(md)
    .split("\n")
    .forEach((l, i) => {
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
  for (const block of extractFences(md).blocks) {
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

/**
 * 全量判据。
 *
 * @param {string} [root] 仓库根
 * @returns {{problems: string[], structure: string[], stats: {docs: number, fences: number, ctxFences: number}}}
 *   `problems` = 真实文档漂移；`structure` = **判据本身不可信**（事实源缺失、围栏口径塌方）。
 */
export function check(root = DEFAULT_ROOT) {
  const problems = [];
  const structure = [];
  const stats = { docs: 0, fences: 0, ctxFences: 0 };

  for (const rel of TARGETS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      structure.push(
        `事实源缺失：${rel} —— 判据 A/B/C 都无从执行（路径改名/拆解脚本没跑都会这样，不是「文档真实」）。`,
      );
      continue;
    }
    const md = readFileSync(abs, "utf8");
    const { blocks, unclosed } = extractFences(md);
    stats.docs += 1;
    stats.fences += blocks.length;
    const ctxBlocks = blocks.filter((b) => /\bctx\s*\./.test(b.body));
    stats.ctxFences += ctxBlocks.length;

    if (unclosed) {
      structure.push(
        `${rel} 的代码围栏未闭合（三反引号数为奇数）—— 最后一块被吞进整篇剩余内容，` +
          `判据 A 的分块不可信。`,
      );
    }
    if (blocks.length === 0) {
      structure.push(
        `从 ${rel} 解析出 0 个代码围栏 —— 围栏口径与文档格式已失配（\`~~~\` 或缩进围栏），` +
          `判据 A 的扫描面是空的（不是「示例都合规」）。`,
      );
      continue;
    }
    if (ctxBlocks.length < MIN_CTX_FENCES_PER_DOC) {
      structure.push(
        `从 ${rel} 只解析出 ${ctxBlocks.length} 个带 ctx.* 的代码围栏（下界 ${MIN_CTX_FENCES_PER_DOC}）` +
          ` —— 判据 A 在该文档上退化成永真断言。`,
      );
      continue;
    }
    problems.push(...auditDoc(md, rel));
  }

  return { problems, structure, stats };
}

/**
 * 跑一次守卫（供 CLI 与 selftest 共用）。
 *
 * @param {{root?: string}} [options]
 * @returns {number} 退出码
 */
export function run({ root = DEFAULT_ROOT } = {}) {
  const { problems, structure, stats } = check(root);

  if (structure.length > 0) {
    console.error("");
    console.error("✖ SDK 文档真实性守卫结构错误（判据本身不可信，先修事实源）：");
    for (const s of structure) console.error("  · " + s);
    console.error("");
    return 1;
  }

  if (problems.length > 0) {
    console.error("");
    console.error(`✖ SDK 文档真实性守卫发现 ${problems.length} 个问题（${stats.docs} 篇）：`);
    for (const p of problems) console.error("  · " + p);
    console.error("");
    console.error("  修法：示例里显式引入 SDK（node @autocodeflow/sdk / python autoflow_sdk），");
    console.error("        并写明 Glue 脚本不安装 requirements；不要描述不存在的全局 ctx。");
    return 1;
  }

  console.log(
    `✔ SDK 文档真实性守卫通过（${stats.docs} 篇：${TARGETS.join(", ")}；` +
      `${stats.fences} 个代码围栏，其中 ${stats.ctxFences} 个含 ctx.*）`,
  );
  return 0;
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/** 合规文档：显式引入 + 口径齐全（node & python 各一）。 */
const GOOD_DOC =
  "# fixture doc\n\n" +
  "Glue 脚本走系统运行时、不安装 requirements；需要 SDK 时显式引入。\n\n" +
  "```js\nconst { TaskContext } = require('@autocodeflow/sdk');\nconst ctx = TaskContext.fromEnv();\nctx.logger.info('hi');\n```\n\n" +
  "```python\nfrom autoflow_sdk import TaskContext\nctx = TaskContext.from_env()\nctx.report_success()\n```\n";

/** 合法：纯 Glue 脚本，不碰 ctx，不应被判红（否则守卫会把合法写法判红）。 */
const GLUE_ONLY_DOC =
  "Glue 脚本走系统运行时、不安装 requirements。\n\n" +
  "```js\nconsole.log('hello from glue');\nreturn { ok: true };\n```\n";

/** 非法：用了 ctx.* 却没有引入。 */
const NO_IMPORT_DOC =
  "Glue 脚本不安装 requirements。\n\n" +
  "```js\nconst res = await ctx.http.get('/api/tasks');\nctx.logger.info('fetched');\n```\n";

/** 非法：python 围栏用了 ctx.* 却引了 node SDK（引入判据按语言各判）。 */
const WRONG_LANG_DOC =
  "Glue 脚本不安装 requirements。\n\n" +
  "```python\nctx = TaskContext.from_env()\nctx.report_success()\n```\n\n" +
  "```js\nconst { TaskContext } = require('@autocodeflow/sdk');\nconst ctx = TaskContext.fromEnv();\n```\n";

/** 非法：完全没有 Glue 口径。 */
const NO_CAVEAT_DOC =
  "```js\nconst { TaskContext } = require('@autocodeflow/sdk');\nconst ctx = TaskContext.fromEnv();\nctx.logger.info('hi');\n```\n";

/** 非法：错误地宣称 ctx 无需引入。 */
const WRONG_CLAIM_DOC =
  "Glue 脚本不安装 requirements。\n\nctx 无需引入，框架会自动注入全局 ctx。\n\n" +
  "```js\nconst { TaskContext } = require('@autocodeflow/sdk');\nconst ctx = TaskContext.fromEnv();\nctx.logger.info('hi');\n```\n";

/** fixture 树：两篇目标文档默认都合规，`omit` 用于造「事实源缺失」。 */
function tree({ readme = GOOD_DOC, guide = GOOD_DOC, omit = [] } = {}) {
  const files = { "package.json": { name: "fixture", private: true } };
  if (readme !== null) files["README.md"] = readme;
  if (guide !== null) files["docs/sdk-guide.md"] = guide;
  for (const key of omit) delete files[key];
  return files;
}

/** 自检：真子进程，逐条断言退出码 + 关键文本 + <1s。 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "sdk-docs-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("① 合规树（两篇都显式引入 + 有 Glue 口径）→ 绿", tree(), {
    code: 0,
    contains: ["SDK 文档真实性守卫通过", "2 篇", "含 ctx.*"],
    absent: ["结构错误", "✖"],
  });

  subprocess(
    "② 纯 Glue 脚本围栏（不碰 ctx）不算缺引入 → 绿（不误伤合法写法）",
    tree({ readme: GOOD_DOC + "\n```js\nconsole.log('glue only');\nreturn { ok: true };\n```\n" }),
    {
      code: 0,
      contains: ["SDK 文档真实性守卫通过"],
      absent: ["未显式引入", "结构错误"],
    },
  );

  subprocess("③ 用了 ctx.* 却没引入 → 红（点名文件:行 + 缺的是哪个 SDK）", tree({ readme: NO_IMPORT_DOC }), {
    code: 1,
    contains: [
      "README.md:3 js 代码块用了 ctx.* 却未显式引入 SDK（@autocodeflow/sdk）",
      "发现 1 个问题",
    ],
    absent: ["SDK 文档真实性守卫通过", "结构错误"],
  });

  subprocess("④ 【反证·按语言各判】python 围栏只引了 node SDK → 红（autoflow_sdk）", tree({ readme: WRONG_LANG_DOC }), {
    code: 1,
    contains: ["README.md:3 python 代码块用了 ctx.* 却未显式引入 SDK（autoflow_sdk）"],
    absent: ["SDK 文档真实性守卫通过"],
  });

  subprocess("⑤ 缺 Glue 口径 → 红（判据 B 单独成立，不是「有错就绿」）", tree({ readme: NO_CAVEAT_DOC }), {
    code: 1,
    contains: ["README.md: 缺少口径说明", "不安装 requirements"],
    absent: ["SDK 文档真实性守卫通过"],
  });

  subprocess("⑥ 【反证·只数条数】错误口径 → 红并点名行号与原文（不能被 B 的报错冒充）", tree({ readme: WRONG_CLAIM_DOC }), {
    code: 1,
    contains: ["README.md:3 出现「ctx 无需引入/全局可用」的错误口径：ctx 无需引入"],
    absent: ["SDK 文档真实性守卫通过"],
  });

  subprocess("⑦ 事实源缺失（docs/sdk-guide.md 不在）→ 结构红并点名路径", tree({ omit: ["docs/sdk-guide.md"] }), {
    code: 1,
    contains: ["结构错误", "事实源缺失：docs/sdk-guide.md"],
    absent: ["SDK 文档真实性守卫通过", "ENOENT", "Error:"],
  });

  subprocess(
    "⑧ 【反证·围栏口径塌方】用 `~~~` 围栏（解析出 0 个围栏）→ 结构红，不是「示例都合规」",
    tree({ readme: GOOD_DOC.replace(/```/g, "~~~") }),
    {
      code: 1,
      contains: ["解析出 0 个代码围栏", "判据 A 的扫描面是空的"],
      absent: ["SDK 文档真实性守卫通过"],
    },
  );

  subprocess(
    "⑨ 【反证·下界】文档有围栏但一个 ctx 示例都没有 → 结构红（判据 A 退化成永真）",
    tree({ readme: GLUE_ONLY_DOC }),
    {
      code: 1,
      contains: ["只解析出 0 个带 ctx.* 的代码围栏", "下界 1"],
      absent: ["SDK 文档真实性守卫通过"],
    },
  );

  subprocess("⑩ 围栏未闭合（三反引号数为奇数）→ 结构红（分块不可信）", tree({ readme: GOOD_DOC + "\n```js\nconst x = ctx.y;\n" }), {
    code: 1,
    contains: ["代码围栏未闭合", "判据 A 的分块不可信"],
    absent: ["SDK 文档真实性守卫通过"],
  });

  const failed = reportCases(cases, { title: "check-sdk-docs-truthfulness selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
  } else {
    const rootArg = argValue(argv, "--root");
    process.exit(run({ root: rootArg ? resolve(rootArg) : DEFAULT_ROOT }));
  }
}
