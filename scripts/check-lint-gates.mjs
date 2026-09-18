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
// 退出码：0 = 全部命中；1 = 存在未进门禁的 lint 入口，或解析规模不达下界。
//
// 用法：
//   node scripts/check-lint-gates.mjs              # 门禁判据（CI 用）
//   node scripts/check-lint-gates.mjs --selftest   # 验证判据本身（不读仓库）
//   node scripts/check-lint-gates.mjs --strict     # 额外列出「无 lint 入口」的项目
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

/** 读 package.json 的 scripts（不存在/坏 JSON 返回 null）。 */
function readScripts(repoRoot, project, readFile) {
  const pkgPath = join(repoRoot, project, "package.json");
  try {
    const pkg = JSON.parse(readFile(pkgPath, "utf8"));
    return pkg.scripts ?? {};
  } catch {
    return null;
  }
}

/** 拼接 .github/workflows 下全部 workflow 文本。 */
function readWorkflows(repoRoot, readFile, readdir) {
  const dir = join(repoRoot, ".github", "workflows");
  let files;
  try {
    files = readdir(dir);
  } catch {
    return "";
  }
  return files
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => {
      try {
        return readFile(join(dir, f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
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
 * 只要求「该目录被 lint 覆盖」，不限定必须由 `npm run lint` 触发——CI 里
 * 直接调 `npx eslint` 是等价门禁。
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
      // ② 矩阵形态：目录由 matrix 展开，需确认**本 job** 的 matrix 里有它。
      if (dir.includes("matrix.")) {
        if (jobMatrixHasProject) hits++;
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
/** 主判据：返回 { ok, problems, gated, ungated, noLintEntry, lintStepTotal }。 */
export function checkLintGates({
  repoRoot,
  readFile = readFileSync,
  readdir = readdirSync,
  workflowsText,
  projects = TS_PROJECTS,
  minLintSteps = MIN_LINT_STEPS,
} = {}) {
  const problems = [];
  const gated = [];
  const ungated = [];
  const noLintEntry = [];

  const workflows =
    workflowsText !== undefined
      ? workflowsText
      : readWorkflows(repoRoot, readFile, readdir);
  const rootScripts = readScripts(repoRoot, ".", readFile) ?? {};
  const lintAll = rootScripts["lint:all"] ?? "";

  // 判据自守卫①：workflow 文本本身要非空。
  if (workflows.trim().length === 0) {
    problems.push(
      ".github/workflows 下读不到任何 workflow 文本 —— 判据已失效（路径漂移？）",
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
    const scripts = readScripts(repoRoot, project, readFile);
    if (scripts === null) continue; // 目录不存在（项目被删/改名）

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

  // 判据自守卫③：解析规模下界（见头部注释）。
  if (lintStepTotal < minLintSteps) {
    problems.push(
      `只在 workflows 里解析出 ${lintStepTotal} 个 lint step，低于规模下界 ${minLintSteps} —— ` +
        `解析正则很可能已失效（YAML 风格变化？）。判据失效比漏网更危险，按失败处理。`,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    gated,
    ungated,
    noLintEntry,
    lintStepTotal,
  };
}

// ── selftest：验证判据本身（不读真实仓库）──────────────────────────────────
function selftest() {
  const failures = [];
  const ok = (cond, name) => {
    if (!cond) failures.push(name);
  };

  // 用内存 fixture 伪造一个仓库。readFile/readdir 全部注入，不碰真实文件系统。
  const root = resolve("/fake-repo");
  const ROOT_PKG = join(root, "package.json");
  const API_PKG = join(root, "apps/admin-api", "package.json");
  const NODE_PKG = join(root, "apps/executor-node", "package.json");
  const CLI_PKG = join(root, "packages/acf-cli", "package.json");

  const mkFiles = (lintAll) => ({
    [ROOT_PKG]: JSON.stringify({
      scripts: {
        "lint:api": "cd apps/admin-api && npx eslint src",
        "lint:node": "cd apps/executor-node && npx eslint src --ext .ts",
        "lint:all": lintAll,
      },
    }),
    [API_PKG]: JSON.stringify({ scripts: { lint: "eslint src" } }),
    [NODE_PKG]: JSON.stringify({ scripts: { lint: "eslint src --ext .ts" } }),
    // 有 package.json 但**没有** lint script —— 模拟 acf-cli/mcp-server 现状。
    [CLI_PKG]: JSON.stringify({ scripts: { test: "vitest run" } }),
  });

  const mkReadFile = (files) => (p) => {
    if (files[p] === undefined) throw new Error(`ENOENT ${p}`);
    return files[p];
  };

  const FULL_LINT_ALL = "npm run lint:api && npm run lint:node";
  const PROJECTS = ["apps/admin-api", "apps/executor-node"];

  // 目录级覆盖的 workflow（两个项目各自 working-directory + lint）。
  const dirWorkflows = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: npm run lint",
    "        working-directory: apps/admin-api",
    "      - run: npm run lint",
    "        working-directory: apps/executor-node",
  ].join("\n");

  // 根级覆盖的 workflow（一条 lint:all 覆盖全部）。
  const rootWorkflows = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: npm run lint:all",
  ].join("\n");

  // ① 基线（目录级）：全部覆盖 → 干净
  const good = checkLintGates({
    repoRoot: root,
    readFile: mkReadFile(mkFiles(FULL_LINT_ALL)),
    workflowsText: dirWorkflows,
    projects: PROJECTS,
    minLintSteps: 2,
  });
  ok(good.ok, `基线（目录级）：应干净（实际 ${JSON.stringify(good.problems)}）`);
  ok(good.gated.length === 2, `基线（目录级）：两项都应记为已门禁（实际 ${good.gated.length}）`);

  // ② 基线（根级）：一条 lint:all 也构成覆盖
  const rootCovered = checkLintGates({
    repoRoot: root,
    readFile: mkReadFile(mkFiles(FULL_LINT_ALL)),
    workflowsText: rootWorkflows,
    projects: PROJECTS,
    minLintSteps: 1,
  });
  ok(
    rootCovered.ok,
    `基线（根级 lint:all）：应干净（实际 ${JSON.stringify(rootCovered.problems)}）`,
  );
  ok(
    rootCovered.gated.length === 2,
    `基线（根级）：两项都应记为已门禁（实际 ${rootCovered.gated.length}）`,
  );

  // ③ 有牙：只剩 admin-api 的 lint step → 必须精确报出 executor-node 漏网。
  //    刻意**不用字符串 replace 删除**：`- run: npm run lint` 这一行在
  //    admin-api 与 executor-node 两处逐字相同，replace 会命中第一个匹配，
  //    于是「删掉」的其实是 admin-api，executor-node 依然绿——反证就没动到
  //    被测对象。这里直接重建一份只含 admin-api 的文本，并显式断言它与原
  //    文本不同（否则下面的失败断言可能只是恒真）。
  const onlyApiWorkflows = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: npm run lint",
    "        working-directory: apps/admin-api",
  ].join("\n");
  ok(
    onlyApiWorkflows !== dirWorkflows,
    "反证前置：重建的文本必须与原文本不同（否则反证无效）",
  );
  ok(
    dirScopedLintSteps(onlyApiWorkflows, "apps/executor-node") === 0,
    "反证前置：重建文本里 executor-node 的 lint step 必须真的为 0",
  );

  const bad = checkLintGates({
    repoRoot: root,
    readFile: mkReadFile(mkFiles(FULL_LINT_ALL)),
    workflowsText: onlyApiWorkflows,
    projects: PROJECTS,
    minLintSteps: 1,
  });
  ok(!bad.ok, "删掉一个 lint step 后必须判失败（否则是永真断言）");
  ok(
    bad.problems.some((p) => p.includes("apps/executor-node")),
    `报的必须是 executor-node（实际 ${JSON.stringify(bad.problems)}）`,
  );

  // ④ 有牙：lint:all 漏串一个项目 → 必须报出（且根级覆盖不算数）
  const noAll = checkLintGates({
    repoRoot: root,
    readFile: mkReadFile(mkFiles("npm run lint:api")),
    workflowsText: rootWorkflows,
    projects: PROJECTS,
    minLintSteps: 1,
  });
  ok(
    noAll.problems.some((p) => p.includes("lint:all")),
    `lint:all 漏串 executor-node 时必须报出（实际 ${JSON.stringify(noAll.problems)}）`,
  );

  // ⑤ 有牙：CI 完全没有 lint 通路 → 两项都必须报出
  const noneWorkflows = "jobs:\n  a:\n    steps:\n      - run: echo hi\n";
  const none = checkLintGates({
    repoRoot: root,
    readFile: mkReadFile(mkFiles(FULL_LINT_ALL)),
    workflowsText: noneWorkflows,
    projects: PROJECTS,
    minLintSteps: 1,
  });
  ok(none.ungated.length === 2, `无通路时两项都应未门禁（实际 ${none.ungated.length}）`);

  // ⑥ 自守卫有牙：workflow 解析不到任何 lint step → 规模下界必须拦下
  const empty = checkLintGates({
    repoRoot: root,
    readFile: mkReadFile(mkFiles(FULL_LINT_ALL)),
    workflowsText: "",
    projects: PROJECTS,
    minLintSteps: 1,
  });
  ok(!empty.ok, "空 workflow 必须失败（不能永真通过）");
  ok(
    empty.problems.some((p) => p.includes("规模下界")),
    `空 workflow 报的应是规模下界（实际 ${JSON.stringify(empty.problems)}）`,
  );

  // ⑦ 无 lint 入口的项目：不计入 ungated（避免永久红被无视），但被单列
  const withNoEntry = checkLintGates({
    repoRoot: root,
    readFile: mkReadFile(mkFiles(FULL_LINT_ALL)),
    workflowsText: dirWorkflows,
    projects: [...PROJECTS, "packages/acf-cli"],
    minLintSteps: 2,
  });
  ok(
    withNoEntry.noLintEntry.includes("packages/acf-cli"),
    "无 lint 入口的项目应单列在 noLintEntry，而不是算作漏网",
  );
  ok(
    !withNoEntry.problems.some((p) => p.includes("packages/acf-cli")),
    "无 lint 入口的项目不应阻塞判据（它由 --strict 单独暴露）",
  );

  // ⑧ 有牙（真实踩过的假绿）：**注释里出现 lint 不算执行**。
  //    本脚本第一版没剥注释，于是 ci.yml 里那段解释「lint 只在本地跑」的
  //    注释（含 lint:all 字样）被归进上一个 npm ci step，把已删掉 lint 的
  //    executor-node 判成了「已覆盖」。这里把该形态钉死。
  const commentOnlyWorkflows = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: npm ci",
    "        working-directory: apps/executor-node",
    "        # 注意：本 job 的 lint 曾只在本地跑（npm run lint:all 的说明）",
    "      - run: npm run lint",
    "        working-directory: apps/admin-api",
  ].join("\n");
  ok(
    dirScopedLintSteps(commentOnlyWorkflows, "apps/executor-node") === 0,
    "注释里出现 lint 不得算作执行（否则删掉 lint step 也能假绿）",
  );
  const commentOnly = checkLintGates({
    repoRoot: root,
    readFile: mkReadFile(mkFiles(FULL_LINT_ALL)),
    workflowsText: commentOnlyWorkflows,
    projects: PROJECTS,
    minLintSteps: 1,
  });
  ok(
    commentOnly.problems.some((p) => p.includes("apps/executor-node")),
    `注释假绿必须被判失败（实际 ${JSON.stringify(commentOnly.problems)}）`,
  );

  // ⑨ 有牙：矩阵覆盖必须看**同一个 job** 的 matrix，不能拿别的 job 顶替。
  //    真实 ci.yml 里 docker-multiarch-build 的矩阵含 apps/executor-node，
  //    若用「全局第一个 matrix 段」就会把 windows 矩阵 job 的 lint 误判成
  //    覆盖了 executor-node。
  const matrixWorkflows = [
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
    "          - packages/acf-cli",
    "    steps:",
    "      - run: npm test",
    "        working-directory: ${{ matrix.project }}",
    "      - run: npm run lint",
    "        working-directory: ${{ matrix.project }}",
  ].join("\n");
  ok(
    dirScopedLintSteps(matrixWorkflows, "apps/executor-node") === 0,
    "别的 job 的 matrix 含该项目，不得算作覆盖（会张冠李戴）",
  );
  ok(
    dirScopedLintSteps(matrixWorkflows, "packages/acf-cli") === 1,
    "同 job 的 matrix 含该项目 + lint step，应算作覆盖",
  );

  if (failures.length) {
    console.error("check-lint-gates selftest FAILED:");
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log("check-lint-gates selftest: OK");
}

// ── main ────────────────────────────────────────────────────────────────────
// 仅在被直接执行时跑 main：本模块导出的 dirScopedLintSteps / checkLintGates
// 需要能被 import 做单元级验证（否则 import 就会触发 process.exit）。
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (process.argv.includes("--selftest")) {
  selftest();
} else if (invokedDirectly) {
  const repoRoot = findRepoRoot(process.cwd());
  const { ok, problems, gated, noLintEntry, lintStepTotal } = checkLintGates({
    repoRoot,
  });

  if (ok) {
    console.log(
      `lint-gates guard OK：${gated.length} 个子项目的 lint 已进门禁` +
        `（workflows 里解析到 ${lintStepTotal} 个 lint step）。`,
    );
  } else {
    console.error(`lint-gates guard FAILED（已门禁 ${gated.length} 个）：`);
    for (const p of problems) console.error("  ✗ " + p);
    process.exit(1);
  }

  if (process.argv.includes("--strict") && noLintEntry.length > 0) {
    console.log(
      `\n[--strict] 以下 TS 子项目还没有 lint 入口（E-41 同类缺口，需先补 eslint 配置与依赖）：\n  - ` +
        noLintEntry.join("\n  - "),
    );
  }
}
