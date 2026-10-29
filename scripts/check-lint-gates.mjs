#!/usr/bin/env node
// E-41 残差（本轮实测发现）：**「有 lint 入口」不等于「lint 在门禁里跑」**。
//
// 问题：E-41 给 executor-node 补了 `.eslintrc.js` 与根 `lint:node`，交接文档
// 记为已收口；但全仓 grep `run lint` 会发现——admin-api 在 admin-api-test、
// admin-web 在 admin-web-build / windows-admin-web 都有 `npm run lint`，
// **executor-node 的 lint 没有任何 CI job 调用它**。于是它的静态检查只在
// 「有人记得在本地跑 lint:all」时才存在。
//
// 这不是理论风险，HEAD 上已经真实发生：
//   · `apps/executor-node/src/process-rlimits.spec.ts` 有一个 no-unused-vars
//     错误 → `npm run lint:node` 直接红，而 CI 全绿；
//   · `apps/admin-api` 两个 spec 有 14 处 prettier 错误 → `lint:api` 也红，
//     同样漏网（CI 跑的是各 job 自己的 lint，从不跑根级 `lint:all`）。
//
// 本脚本把两件事变成机器判据：
//   ① 根 `lint:all` 必须串联**每一个**定义了 lint script 的 TS 子项目；
//   ② 每个这样的子项目都必须在 `.github/workflows/` 里被真覆盖，覆盖形态二选一：
//      (a) 目录级：某个 step 在 `working-directory: <project>`（或矩阵展开到
//          该目录）下执行 lint；
//      (b) 根级：某个 step 直接跑 `npm run lint:all`——根 script 会把全部
//          子项目串起来，一次覆盖所有被 ① 收录的项目。
// 新增子项目却忘了接门禁 → 这里红，而不是等下一次有人在本地跑 lint:all。
//
// 设计要点（踩过的坑写在这）：
//  · **扫整个 workflows 目录**而不是只读 ci.yml：lint 可能被放进 release.yml
//    或任何新 workflow，只盯一个文件会写出「换了文件就假绿」的守卫。
//  · **判据有规模下界**：如果解析正则因 YAML 风格变化而匹配不到任何东西，
//    「0 个匹配 → 0 个缺失」是永真断言。故断言「至少解析出 N 个 lint step」，
//    低于下界直接失败（宁可红也不能假装绿）——与 check-consumer-routes.mjs
//    同款自守卫。
//  · 只要求「已定义 lint script」的项目进门禁：acf-cli / mcp-server /
//    node-sdk / desktop 目前**没有** eslint 配置（E-41 同类缺口，需先补
//    配置与依赖），把它们算进来会让本判据永久红，从而被无视。它们由
//    `--strict` 模式单独暴露，供后续专项逐个收口。
//
// 退出码：0 = 全部命中；1 = 存在未进门禁的 lint 入口，或判据本身不可信（结构错）。
//
// ## T4（第 4 轮守卫自检审计）修掉的假绿
//
//   · **只测函数，不测闸门（最贵的一条）**：旧 `--selftest` 用注入的 readFile 造内存
//     仓库、断言 `checkLintGates(...).ok`，**从不跑 CLI**。把 main 里的 `process.exit(1)`
//     删掉、或让 main 永远打印 OK，13 条断言照样全绿——报告在说话，闸不关门。现在
//     每条用例在 `mkdtemp` 里造**真目录树**并以 `--root` 跑真子进程，断言退出码 +
//     关键报错文本。
//   · **事实源缺失 = 普通问题**：旧实现里「读不到 workflows」「项目 package.json 坏了」
//     与「某项目没进门禁」混在同一条 `problems` 流里（处置动作相反）。更糟的是
//     `readScripts()` 把**坏 JSON 和不存在的目录都返回 null**，于是「package.json 解析
//     失败」被当成「项目被删了」→ 该项目**静默退出扫描面**（假绿）。现在两者都升级为
//     `structure`（结构红），并分别点名。
//   · **扫描面下界只当普通问题**：`lintStepTotal < MIN_LINT_STEPS`（解析正则失效）与
//     「某项目漏网」打印在同一段里，读者分不清「要补一个 CI step」还是「要修正则」。
//     现在它进 `structure`。
//   · **`continue` 跳块**：`dirScopedLintSteps()` 里 `working-directory` 含 `matrix.`
//     但 matrix 里没有该项目时是 `continue`——于是**同一 step 里的 `cd <project> && … lint`
//     被整个跳过**。这是「判据少看一眼」的形态：写成矩阵 + cd 混合的 step 会静默漏检。
//     现在改成「matrix 不命中就落到 cd 判据」，不再提前 continue。
//   · **`import` 即执行**：旧实现 `if (argv.includes('--selftest')) selftest(); else if
//     (invokedDirectly) …` —— `--selftest` 分支**没有被 main 判定包住**，任何
//     `import` 本模块且命令行含 `--selftest` 的探针都会直接跑自检并 exit。
//     现在先判 `isMain`，再分派。
//   · **`--root` 缺失**：旧 CLI 只能从 `process.cwd()` 上溯找根，selftest 无法对「另一棵树」
//     验证闸门。现在 `--root <dir>` 可覆盖（selftest 专用），默认根由脚本位置推出。
//
// 用法：
//   node scripts/check-lint-gates.mjs                 # 门禁判据（CI 用）
//   node scripts/check-lint-gates.mjs --selftest      # 验证判据本身（真子进程，有齿）
//   node scripts/check-lint-gates.mjs --strict        # 额外列出「无 lint 入口」的项目
//   node scripts/check-lint-gates.mjs --root <dir>    # 把该目录当仓库根（selftest 专用）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = resolve(HERE, "..");

// ── 候选子项目 ──────────────────────────────────────────────────────────────
// 只列「TS 且有 package.json」的目录。Python 子项目走 ruff/black，不在本判据。
const TS_PROJECTS = [
  "apps/admin-api",
  "apps/admin-web",
  "apps/executor-node",
  "apps/executor-desktop",
  "packages/acf-cli",
  "packages/mcp-server",
  "packages/autocodeflow-node-sdk",
];

// 解析规模下界：见头部「判据有规模下界」。当前三个有 lint 入口的子项目在
// workflows 里各有至少一处 lint step（admin-api 1、admin-web 2、executor-node
// 经根级 lint:all 1）。取 3 是保守值——正则若整体失效，匹配数会掉到 0/1。
const MIN_LINT_STEPS = 3;

/** 找仓库根：同时存在根 package.json 与 .github/workflows。 */
export function findRepoRoot(from, exists = existsSync) {
  let dir = resolve(from);
  for (let i = 0; i < 12; i++) {
    if (
      exists(join(dir, "package.json")) &&
      exists(join(dir, ".github", "workflows"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repo root not found above ${from}`);
}

/**
 * 读一个 package.json 的 scripts。
 *
 * @returns {{scripts: Record<string,string>} | {missing: true} | {error: string}}
 *   三种结果必须分开：旧实现把「目录不存在」与「JSON 坏了」都返回 null，于是
 *   一个坏掉的 package.json 会让该项目**静默退出扫描面**（= 假绿）。
 */
function readScripts(repoRoot, project, readFile) {
  const pkgPath = join(repoRoot, project, "package.json");
  let raw;
  try {
    raw = readFile(pkgPath, "utf8");
  } catch {
    return { missing: true };
  }
  try {
    const pkg = JSON.parse(raw);
    return { scripts: pkg.scripts ?? {} };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

/**
 * 读 `.github/workflows` 下全部 workflow 文本。
 *
 * @returns {{text: string, files: number} | {error: string}}
 *   读目录失败不再冒充「空文本」（旧实现返回 ""，下游只报一条普通 problem）。
 */
function readWorkflows(repoRoot, readFile, readdir) {
  const dir = join(repoRoot, ".github", "workflows");
  let files;
  try {
    files = readdir(dir);
  } catch (error) {
    return { error: `${dir} 读不出来（${error?.code ?? error?.message ?? "unknown"}）` };
  }
  const picked = files.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const parts = [];
  for (const f of picked) {
    try {
      parts.push(readFile(join(dir, f), "utf8"));
    } catch (error) {
      return { error: `${join(dir, f)} 读不出来（${error?.code ?? "unknown"}）` };
    }
  }
  return { text: parts.join("\n"), files: picked.length };
}

/**
 * 去掉 YAML **整行注释**。
 *
 * 这一步不是洁癖，是判据正确性的前提：本脚本第一版没去注释，于是我自己写在
 * ci.yml 里的那段解释「lint 只在本地跑」的注释（含 `lint:all` 字样）被
 * stepBlocks 归进了**上一个 step**，让那个 `npm ci` step 看起来在跑 lint——
 * 把被删掉 lint 的项目判成了「已覆盖」。**注释里的词不算执行**，故先剥注释
 * 再做结构分析。
 *
 * 只剥整行注释（首个非空白字符是 `#`）：行内 `#` 在 shell 脚本里可能是
 * 参数的一部分（如 `${VAR#prefix}`），保守起见不碰。
 */
export function stripCommentLines(workflows) {
  return workflows
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * 把 workflow 文本切成 step 块：每个 `- ` 列表项起一个新块，直到下一个为止。
 *
 * 为什么不用「`working-directory` 之后 N 字符内出现 lint」这种窗口正则：
 * 真实 ci.yml 里 **`run:` 写在 `working-directory:` 之前**（
 * `- run: npm run lint` 换行 `working-directory: apps/admin-api`），窗口正则
 * 必须双向匹配才能命中，而双向 + 大窗口又会把相邻的**另一个** step 的 lint
 * 误算进来（admin-web 的两处 lint 就会互相顶替）。按 step 块判定是结构化的，
 * 与 YAML 顺序无关，也不会跨 step 串味。
 */
export function stepBlocks(workflows) {
  const blocks = [];
  let current = null;
  for (const line of stripCommentLines(workflows).split("\n")) {
    if (/^\s*- /.test(line)) {
      if (current !== null) blocks.push(current);
      current = line;
    } else if (current !== null) {
      current += "\n" + line;
    }
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

/**
 * 取出一个 job 里 `matrix:` 段的文本（含其下所有更深缩进的行）。
 *
 * 注意缩进不固定：`strategy:` 本身可能省掉，`matrix:` 也可能出现在
 * `include:` 形式下——所以按「`matrix:` 行的缩进 + 其后所有更深缩进行」取，
 * 而不是写死 4 空格（第一版写死 4 空格，于是真实 ci.yml 里 6 空格的
 * `matrix:` 取不到，矩阵判定静默失效）。
 */
export function matrixSectionOf(job) {
  const lines = job.split("\n");
  const start = lines.findIndex((l) => /^\s*matrix:\s*$/.test(l));
  if (start === -1) return "";
  const indent = lines[start].match(/^\s*/)[0].length;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * 把 workflow 文本切成 job 块：`^  <name>:` 起新 job（两个空格缩进 = job 级）。
 *
 * 用于矩阵判定——`working-directory: ${{ matrix.project }}` 是否覆盖某个项目，
 * 取决于**同一个 job** 的 matrix 列表里有没有它。用「全局第一个 matrix 段」
 * 代替会张冠李戴：docker-multiarch-build 的矩阵里也有 `apps/executor-node`
 * 字样，足以把 windows 矩阵 job 的 lint 步骤误判成覆盖了 executor-node。
 */
export function jobBlocks(workflows) {
  const jobs = [];
  let current = null;
  for (const line of stripCommentLines(workflows).split("\n")) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) {
      if (current !== null) jobs.push(current);
      current = line;
    } else if (current !== null) {
      current += "\n" + line;
    }
  }
  if (current !== null) jobs.push(current);
  return jobs;
}

/**
 * 目录级覆盖：在 workflow 的 **step 块**里找「切到该目录 + 跑 lint」。
 *
 * 覆盖三种真实写法：
 *   ① `working-directory: <dir>` + 同 step 内 `run: ... lint`（顺序无关）
 *   ② 矩阵 job：`working-directory: ${{ matrix.<var> }}`，且**同一 job** 的
 *      matrix 列表里含 `<dir>`，同 step 内 `run: ... lint`
 *   ③ 同 step 内 `cd <dir> && ... lint`
 *
 * 只要求「该目录被 lint 覆盖」，不限定必须由 `npm run lint` 触发——`cd <dir> &&
 * npm run lint:js` 也算（形态 ③）。⚠️ 已知边界：step 里必须出现**独立词** `lint`
 * （`\blint\b`），因此只写 `npx eslint` 的 step **不算**覆盖（`eslint` 里的 `lint`
 * 不是独立词）。这是**失败方向**的边界（漏认 → 报未覆盖 → 逼你补一个 `npm run lint`
 * 入口），不是假绿；真要支持 `npx eslint`，改 `runsLint` 的正则并在评审里说明。
 */
export function dirScopedLintSteps(workflows, project) {
  const esc = project.replace(/[/\\]/g, "[/\\\\]");
  const cdPattern = new RegExp(`cd\\s+${esc}\\s*&&[^\\n]*lint`);
  const jobs = jobBlocks(workflows);
  let hits = 0;

  for (const job of jobs) {
    // 该 job 的 matrix 列表里是否出现本项目（用于形态 ②）。
    const matrixSection = matrixSectionOf(job);
    const jobMatrixHasProject = new RegExp(
      `(^|[\\s\\[,'"/])${esc}([\\s\\],'"/]|$)`,
      "m",
    ).test(matrixSection);

    for (const block of stepBlocks(job)) {
      // 该 step 是否真的在跑 lint（`run: |` 多行脚本里出现 lint 同样算）。
      const runsLint = /\brun:/.test(block) && /\blint\b/.test(block);
      if (!runsLint) continue;

      // `working-directory: ${{ matrix.project }}` 里含空格，`\S+` 会在
      // 第一个空格处截断成 `${{`，于是矩阵判定静默失效（实测踩到）。
      // 故取整行剩余部分并 trim。
      const dirMatch = block.match(/working-directory:[ \t]*(.+)/);
      const dir = (dirMatch?.[1] ?? "").trim();

      if (dir === project) {
        hits++;
        continue;
      }
      // ⚠️ 这里**不能** `continue`：旧实现是「dir 含 matrix. 但不属于本 job 的 matrix
      //     ⇒ 直接 continue」，于是同一 step 里的 `cd <project> && … lint` 被整个跳过
      //     （判据少看一眼＝静默漏检）。matrix 不命中就往下落到 ③ 的 cd 判据。
      if (dir.includes("matrix.") && jobMatrixHasProject) {
        hits++;
        continue;
      }
      // ③ `cd <dir> && ... lint`
      if (cdPattern.test(block)) hits++;
    }
  }
  return hits;
}

/**
 * 根级覆盖：workflow 里是否有 step 直接跑根 `lint:all`。
 *
 * 这是「一次覆盖全部子项目」的形态——根 script 本身就串联了所有 lint:<x>。
 * 必须与 `lint:all` 的实际内容配合：只有 lint:all 真的收录了该项目，才算覆盖
 * （由调用方按 reachable 判定）。
 *
 * 同样按 step 块判定而不是单行正则：CI 里真实的写法是 YAML 块标量
 * （`run: |` 换行后逐个命令），`npm run lint:all` 不在 `run:` 同一行上——
 * 单行正则会漏掉这个形态，从而把「已覆盖」误报成「未覆盖」。
 */
export function rootLevelLintAllSteps(workflows) {
  return stepBlocks(workflows).filter(
    (block) => /\brun:/.test(block) && /\bnpm\s+run\s+lint:all\b/.test(block),
  ).length;
}
/** 主判据：返回 { ok, problems, structure, gated, ungated, noLintEntry, lintStepTotal }。 */
export function checkLintGates({
  repoRoot,
  readFile = readFileSync,
  readdir = readdirSync,
  workflowsText,
  projects = TS_PROJECTS,
  minLintSteps = MIN_LINT_STEPS,
} = {}) {
  const problems = [];
  const structure = [];
  const gated = [];
  const ungated = [];
  const noLintEntry = [];

  let workflows = workflowsText;
  let workflowFiles = null;
  let workflowsReadFailed = false;
  if (workflows === undefined) {
    const wf = readWorkflows(repoRoot, readFile, readdir);
    if (wf.error) {
      structure.push(
        `事实源缺失：.github/workflows —— ${wf.error}。判据一处 workflow 都没读到` +
          `（不是「lint 都进门禁了」）。`,
      );
      workflows = "";
      workflowsReadFailed = true;
    } else {
      workflows = wf.text;
      workflowFiles = wf.files;
    }
  }

  const rootPkg = readScripts(repoRoot, ".", readFile);
  if (rootPkg.error) {
    structure.push(`事实源缺失：package.json 解析失败 —— ${rootPkg.error}（lint:all 无从判定）`);
  } else if (rootPkg.missing) {
    structure.push("事实源缺失：package.json —— 根 manifest 不在，lint:all 无从判定");
  }
  const rootScripts = rootPkg.scripts ?? {};
  const lintAll = rootScripts["lint:all"] ?? "";

  // 判据自守卫①：workflow 文本本身要非空（目录读失败时上面已经报过，别重复）。
  if (!workflowsReadFailed && workflows.trim().length === 0) {
    structure.push(
      `.github/workflows 下读不到任何 workflow 文本 —— 判据已失效（路径漂移？），` +
        `「0 个项目漏网」不是「全部命中」。`,
    );
  }

  // 判据自守卫②：根 lint:all 必须存在。
  if (!lintAll) {
    problems.push("根 package.json 缺少 lint:all —— 本地/CI 没有统一 lint 入口");
  }

  // 根级 lint:all 被 CI 调用了几次（0 表示 CI 没有这条通路）。
  const rootLevelSteps = rootLevelLintAllSteps(workflows);

  let lintStepTotal = 0;
  for (const project of projects) {
    const pkg = readScripts(repoRoot, project, readFile);
    if (pkg.missing) continue; // 目录不存在（项目被删/改名）
    if (pkg.error) {
      // 旧实现这里也走 `continue`：坏掉的 package.json 让项目**静默退出扫描面**。
      structure.push(
        `事实源缺失：${project}/package.json 解析失败 —— ${pkg.error}（该项目因此不在判据内）`,
      );
      continue;
    }
    const scripts = pkg.scripts;

    if (!scripts.lint) {
      noLintEntry.push(project);
      continue;
    }

    // ① 根 lint:all 是否串联到它。lint:all 里引用的每个 `lint:<name>` 都要
    //    能在某个子项目里落到实处——既防「漏串」，也防「引用了不存在的 script」。
    const referenced = [...lintAll.matchAll(/lint:([a-z0-9-]+)/g)].map(
      (m) => m[1],
    );
    const scriptNames = Object.keys(scripts);
    const reachable = referenced.some(
      (name) =>
        scriptNames.includes(name) ||
        scriptNames.includes(`lint:${name}`) ||
        // 根 script 名与子项目名不同形（admin-api → lint:api）时，靠根
        // scripts 里那条 lint:<name> 的 `cd <project>` 反查。
        (rootScripts[`lint:${name}`] ?? "").includes(project),
    );

    if (!reachable) {
      problems.push(
        `${project}: 有 lint script 但根 lint:all 没串联到它（lint:all = "${lintAll}"）`,
      );
    }

    // ② CI 是否真覆盖：目录级或（根级 lint:all 调用 + ① 可达）。
    const dirSteps = dirScopedLintSteps(workflows, project);
    const rootCovered = reachable && rootLevelSteps > 0;
    const steps = dirSteps + (rootCovered ? rootLevelSteps : 0);
    lintStepTotal += steps;

    if (steps === 0) {
      ungated.push(project);
      problems.push(
        `${project}: 有 lint script（"${scripts.lint}"）但没有任何 CI job 覆盖它的 lint ` +
          `—— 静态检查只在「有人记得本地跑 lint:all」时存在`,
      );
    } else {
      gated.push(project);
    }
  }

  // 判据自守卫③：解析规模下界（见头部注释）。这是「判据失效」而非「项目漏网」，
  // 故进 structure：两类问题的处置动作相反（修正则 vs 补 CI step）。
  if (lintStepTotal < minLintSteps) {
    structure.push(
      `只在 workflows 里解析出 ${lintStepTotal} 个 lint step，低于规模下界 ${minLintSteps} —— ` +
        `解析正则很可能已失效（YAML 风格变化？）。判据失效比漏网更危险，按失败处理。`,
    );
  }

  return {
    ok: problems.length === 0 && structure.length === 0,
    problems,
    structure,
    gated,
    ungated,
    noLintEntry,
    lintStepTotal,
    workflowFiles,
  };
}

// ── selftest：真子进程 + 退出码 + 报错文本（T4）──────────────────────────────
const SELF = fileURLToPath(import.meta.url);

const P_API = "apps/admin-api";
const P_NODE = "apps/executor-node";
const P_WEB = "apps/admin-web";
const ALL3 = [P_API, P_NODE, P_WEB];

/** 一份最小 workflow（单 job `lint`，steps 由用例给）。 */
const wf = (steps) =>
  ["name: fixture", "on: push", "jobs:", "  lint:", "    runs-on: ubuntu-latest", "    steps:", ...steps].join("\n") +
  "\n";

/** 目录级 lint step（真实写法：`run:` 在前、`working-directory:` 在后）。 */
const dirStep = (project) => ["      - run: npm run lint", `        working-directory: ${project}`];

/** 根级 lint:all step。 */
const ROOT_STEP = ["      - run: npm run lint:all"];

const pkgScripts = (lint) => ({ name: "fixture-app", scripts: { lint } });

/**
 * 造 fixture 树（默认是「全部命中」的基线树）。
 *
 * @param {{
 *   lintAll?: string,
 *   projects?: Record<string, {lint?: string} | string>,
 *   steps?: string[],
 *   rootWf?: string,
 *   rawFiles?: Record<string, string>,
 *   omitWorkflows?: boolean,
 * }} spec
 */
function tree({
  lintAll = "npm run lint:api && npm run lint:node && npm run lint:web",
  projects = { [P_API]: { lint: "eslint src" }, [P_NODE]: { lint: "eslint src --ext .ts" }, [P_WEB]: { lint: "eslint src" } },
  steps,
  rootWf,
  rawFiles = {},
  omitWorkflows = false,
} = {}) {
  const files = {
    "package.json": {
      name: "fixture",
      private: true,
      scripts: {
        "lint:api": `cd ${P_API} && npx eslint src`,
        "lint:node": `cd ${P_NODE} && npx eslint src --ext .ts`,
        "lint:web": `cd ${P_WEB} && npx eslint src`,
        "lint:all": lintAll,
      },
    },
  };
  for (const [dir, val] of Object.entries(projects)) {
    files[`${dir}/package.json`] =
      typeof val === "string" ? pkgScripts(val) : { name: "fixture-app", scripts: val };
  }
  if (!omitWorkflows) {
    files[".github/workflows/ci.yml"] = rootWf ?? wf(steps ?? [...ALL3.flatMap(dirStep), ...ROOT_STEP]);
  }
  return { ...files, ...rawFiles };
}

/** 自检：真子进程，逐条断言退出码 + 关键文本 + <1s。 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "lint-gates-selftest-" });
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

  // ① 绿：目录级 3 步 + 根级 lint:all 各算一次覆盖（不是「有 lint 入口」就算）
  subprocess("① 三项都被目录级 + 根级覆盖 → 绿（解析到 6 个 lint step）", tree(), {
    code: 0,
    contains: ["lint-gates guard OK", "3 个子项目的 lint 已进门禁", "解析到 6 个 lint step"],
    absent: ["✗", "结构错误"],
  });

  // ② 红：lint:all 漏串 + 没有目录级 step → 两条判据各自成立，且点名项目
  subprocess(
    "② executor-node 既没被目录级覆盖、也没被 lint:all 串联 → 红（点名项目 + 给出 lint:all 原文）",
    tree({
      lintAll: "npm run lint:api && npm run lint:web",
      steps: [dirStep(P_API), dirStep(P_WEB), ...ROOT_STEP],
    }),
    {
      code: 1,
      contains: [
        'apps/executor-node: 有 lint script（"eslint src --ext .ts"）但没有任何 CI job 覆盖它的 lint',
        "根 lint:all 没串联到它",
        'lint:all = "npm run lint:api && npm run lint:web"',
        "已门禁 2 个",
      ],
      absent: ["lint-gates guard OK", "结构错误"],
    },
  );

  // ③ 【反证·判据分离】CI 目录级覆盖了，但根 lint:all 漏串 → 仍红（reachable 单独成立）
  subprocess(
    "③ 目录级覆盖了但 lint:all 漏串 → 红（只报「没串联」，不报「没 CI 覆盖」）",
    tree({
      lintAll: "npm run lint:api && npm run lint:web",
      steps: [...ALL3.flatMap(dirStep), ...ROOT_STEP],
    }),
    {
      code: 1,
      contains: ["根 lint:all 没串联到它", "lint:all ="],
      absent: ["没有任何 CI job 覆盖", "lint-gates guard OK"],
    },
  );

  // ④ 【反证·注释算数】注释里的 lint 不算执行。注意：本用例刻意不给根级 lint:all step，
  //    否则「根级覆盖」会把漏网盖住（那就是另一种假绿）。
  subprocess(
    "④ 注释里出现 lint 不算执行（ci.yml 里解释性注释曾让 npm ci step 被当成跑了 lint）",
    tree({
      steps: [
        ...dirStep(P_API),
        // admin-api 的第二条 lint（真实 ci.yml 里 admin-web 就是两步 lint）
        ["      - run: npm run lint:js", `        working-directory: ${P_API}`],
        dirStep(P_WEB),
        [
          "      - run: npm ci",
          `        working-directory: ${P_NODE}`,
          "        # 注意：本 job 的 lint 曾只在本地跑（npm run lint:all 的说明）",
        ],
      ].flat(),
    }),
    {
      code: 1,
      contains: ["apps/executor-node: 有 lint script", "没有任何 CI job 覆盖它的 lint"],
      absent: ["lint-gates guard OK", "结构错误"],
    },
  );

  // ⑤ 【反证·前缀/后缀误配】`apps/executor-node-legacy` / `apps/executor-node2` 不得算作
  //    `apps/executor-node` 的覆盖（`startsWith` 式判据会让它们顶替过去）。
  subprocess(
    "⑤ 目录前缀/后缀相近（-legacy、…node2）不得顶替 executor-node → 红",
    tree({
      steps: [
        ...dirStep(P_API),
        ["      - run: npm run lint:js", `        working-directory: ${P_API}`],
        dirStep(P_WEB),
        `      - run: npm run lint`,
        "        working-directory: apps/executor-node-legacy",
        `      - run: npm run lint`,
        "        working-directory: apps/executor-node2",
      ].flat(),
    }),
    {
      code: 1,
      contains: ["apps/executor-node: 有 lint script", "没有任何 CI job 覆盖"],
      absent: ["lint-gates guard OK"],
    },
  );

  // ⑥ 【反证·张冠李戴】别的 job 的 matrix 里有该项目，不得算作本 job 的 lint 覆盖
  subprocess(
    "⑥ 别的 job 的 matrix 含该项目 → 不算覆盖（用「全局第一个 matrix」会张冠李戴）",
    tree({
      rootWf: [
        "name: fixture",
        "on: push",
        "jobs:",
        "  docker:",
        "    strategy:",
        "      matrix:",
        "        project:",
        "          - apps/executor-node",
        "    steps:",
        "      - run: docker build .",
        "  windows:",
        "    strategy:",
        "      matrix:",
        "        project:",
        "          - apps/admin-api",
        "          - apps/admin-web",
        "    steps:",
        "      - run: npm run lint",
        "        working-directory: ${{ matrix.project }}",
        "      - run: npm run lint:js",
        "        working-directory: ${{ matrix.project }}",
        "",
      ].join("\n"),
    }),
    {
      code: 1,
      contains: ["apps/executor-node: 有 lint script", "没有任何 CI job 覆盖"],
      absent: ["lint-gates guard OK"],
    },
  );

  // ⑦ 同 job 的 matrix 含该项目 + lint step → 算覆盖（正例控制组，防 ⑥ 变成永假）
  subprocess(
    "⑦ 同 job 的 matrix 含三项 + lint step → 绿（正例：矩阵形态本身可用）",
    tree({
      rootWf: [
        "name: fixture",
        "on: push",
        "jobs:",
        "  windows:",
        "    strategy:",
        "      matrix:",
        "        project:",
        "          - apps/admin-api",
        "          - apps/executor-node",
        "          - apps/admin-web",
        "    steps:",
        "      - run: npm run lint",
        "        working-directory: ${{ matrix.project }}",
        "      - run: npm run lint:js",
        "        working-directory: ${{ matrix.project }}",
        "      - run: npm run lint:types",
        "        working-directory: ${{ matrix.project }}",
        "",
      ].join("\n"),
    }),
    {
      code: 0,
      contains: ["lint-gates guard OK", "3 个子项目的 lint 已进门禁"],
      absent: ["结构错误"],
    },
  );

  // ⑧ `cd <project> && npm run lint` 也算覆盖（形态 ③，不依赖 working-directory）
  subprocess(
    "⑧ `cd <project> && npm run lint` 也算覆盖 → 绿（形态 ③ 不被 ①② 遮住）",
    tree({
      steps: [
        `      - run: cd ${P_API} && npm run lint`,
        `      - run: cd ${P_NODE} && npm run lint`,
        `      - run: cd ${P_WEB} && npm run lint`,
      ],
    }),
    {
      code: 0,
      contains: ["lint-gates guard OK", "解析到 3 个 lint step"],
      absent: ["结构错误"],
    },
  );

  // ⑨ 【反证·continue 跳块】step 同时写了 `working-directory: ${{ matrix.project }}`
  //    与 `cd apps/executor-node && … lint`：matrix 不命中该项目时，旧实现 `continue`
  //    把 cd 判据整个跳过 ⇒ executor-node 静默变成「未覆盖」。
  subprocess(
    "⑨ matrix 不命中但同 step 里有 `cd <project>` → 仍算覆盖（不得 continue 跳块）",
    tree({
      rootWf: [
        "name: fixture",
        "on: push",
        "jobs:",
        "  windows:",
        "    strategy:",
        "      matrix:",
        "        project:",
        "          - apps/admin-api",
        "          - apps/admin-web",
        "    steps:",
        "      - run: npm run lint",
        "        working-directory: ${{ matrix.project }}",
        "      - run: cd apps/executor-node && npm run lint",
        "        working-directory: ${{ matrix.project }}",
        "",
      ].join("\n"),
    }),
    {
      code: 0,
      contains: ["lint-gates guard OK", "3 个子项目的 lint 已进门禁"],
      absent: ["没有任何 CI job 覆盖", "结构错误"],
    },
  );

  // ⑩ 事实源缺失（没有 .github/workflows）→ 结构红，不报「全部命中」
  subprocess("⑩ 事实源缺失（没有 .github/workflows）→ 结构红", tree({ omitWorkflows: true }), {
    code: 1,
    contains: ["结构错误", "事实源缺失：.github/workflows", "判据一处 workflow 都没读到"],
    absent: ["lint-gates guard OK", "    at ", "Error:"],
  });

  // ⑪ 【反证·静默 catch】项目 package.json 坏 JSON：旧实现返回 null → 该项目**静默
  //     退出扫描面**（看起来「全部命中」）。现在必须结构红并点名。
  subprocess(
    "⑪ 项目 package.json 坏 JSON → 结构红（旧实现把它当成「项目被删了」静默跳过）",
    tree({ rawFiles: { [`${P_WEB}/package.json`]: "{ this is not json" } }),
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${P_WEB}/package.json 解析失败`],
      absent: ["lint-gates guard OK"],
    },
  );

  // ⑫ 根 lint:all 缺失 → **可处置的问题**（不是结构错）：处置动作是补 script
  subprocess(
    "⑫ 根 package.json 缺 lint:all → 红但归为问题（不是结构错）",
    tree({ lintAll: "" }),
    {
      code: 1,
      contains: ["根 package.json 缺少 lint:all", "lint-gates guard FAILED"],
      absent: ["结构错误", "lint-gates guard OK"],
    },
  );

  // ⑬ 【反证·扫描面下界】workflow 里一处 lint step 都没有 → 结构红（正则失效）
  subprocess(
    "⑬ workflow 里解析不到 lint step → 结构红（规模下界，不是「全部命中」）",
    tree({ steps: ["      - run: echo hi"] }),
    {
      code: 1,
      contains: ["结构错误", "低于规模下界 3", "判据失效比漏网更危险"],
      absent: ["lint-gates guard OK"],
    },
  );

  const failed = reportCases(cases, { title: "check-lint-gates selftest" });
  if (failed > 0) process.exit(1);
}

// ── 跑一次守卫（CLI 与 selftest 共用）──────────────────────────────────────
/**
 * @param {{repoRoot?: string, strict?: boolean}} [options]
 * @returns {number} 退出码
 */
export function run({ repoRoot = DEFAULT_ROOT, strict = false } = {}) {
  const { ok, problems, structure, gated, noLintEntry, lintStepTotal } = checkLintGates({ repoRoot });

  if (structure.length > 0) {
    console.error("");
    console.error("✖ lint-gates 守卫结构错误（判据本身不可信，先修事实源/扫描面）：");
    for (const s of structure) console.error("  · " + s);
    console.error("");
    return 1;
  }

  if (!ok) {
    console.error(`lint-gates guard FAILED（已门禁 ${gated.length} 个）：`);
    for (const p of problems) console.error("  ✗ " + p);
    return 1;
  }

  console.log(
    `lint-gates guard OK：${gated.length} 个子项目的 lint 已进门禁` +
      `（workflows 里解析到 ${lintStepTotal} 个 lint step）。`,
  );

  if (strict && noLintEntry.length > 0) {
    console.log(
      `\n[--strict] 以下 TS 子项目还没有 lint 入口（E-41 同类缺口，需先补 eslint 配置与依赖）：\n  - ` +
        noLintEntry.join("\n  - "),
    );
  }
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────
// 仅在被**直接执行**时跑：本模块导出 dirScopedLintSteps / checkLintGates 供 import
// 单独调用。旧实现把 `--selftest` 分支放在 main 判定**之外**，于是任何带
// `--selftest` 的探针只要 import 本模块就会跑自检并 process.exit。
const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
  } else {
    const rootArg = argValue(argv, "--root");
    let repoRoot;
    try {
      repoRoot = rootArg ? resolve(rootArg) : findRepoRoot(DEFAULT_ROOT);
    } catch (error) {
      console.error(`✖ lint-gates 守卫无法确定仓库根：${error?.message ?? error}`);
      process.exit(1);
    }
    process.exit(run({ repoRoot, strict: argv.includes("--strict") }));
  }
}
