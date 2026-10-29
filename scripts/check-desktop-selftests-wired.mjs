#!/usr/bin/env node
/**
 * executor-desktop 的 **selftest 必须被 `test:main` 执行** 守卫。
 *
 * 由来：`src/main` 下有 48 个 `*.selftest.ts`，而 `test:main` 只列了 46 个 ——
 * 漏掉的 `agent/browser.selftest.ts`（P7b 浏览器工具的**动作枚举 + 域名白名单**闸）与
 * `agent/package-candidate.selftest.ts`（P7d 的 ZIP 写入器 + **穿越载荷在写入层被拒**）
 * 都是**安全相关**的闸，却从来没在 CI 里跑过。
 *
 * 更刺眼的是：这两个文件的头注里都写着 `Run via: npm run test:main` —— **文档说它跑，实际不跑**。
 * 这与 `R82` 修的「守卫没接 CI」是同一类失败：**你以为有防线，其实没有**。
 *
 * 判据（双向）：
 *   ① 每个 `src/main/**` 的 `*.selftest.ts` 都必须在 `test:main` 里出现；
 *   ② `test:main` 里列的每一项都必须有对应源文件（删了 selftest 却忘删清单 = 命令直接报 ENOENT）。
 *
 * 判据③（R102-A1 实证）：`build:main` 必须接 `scripts/bundle-preload.cjs`。
 *   沙箱（sandbox: true）里的 preload 只支持受限 require，**相对 require 直接
 *   加载失败**。tsc 是逐文件 emit，preload 一旦 import 同目录模块（bridge-args）
 *   就会编译出 `require("./bridge-args")` → preload 整体不执行 →
 *   window.electronAPI 为 undefined → 渲染层落进错误边界（CI desktop-e2e-smoke
 *   10 条全红）。这道闸盯的是构建接线本身，不依赖先跑一遍 e2e 才发现。
 *
 * 判据④（CIR-02 实证，2026-10-29）：`test:main` 必须至少有一个**随 push 跑**的
 *   CI job 在执行。原先只有 desktop-linux-bundle / desktop-macos-bundle 调它，
 *   而两者都是 `pull_request || workflow_dispatch` 门控——本仓常规路径是直接
 *   push develop，于是 48 个 selftest 在主干上零覆盖，本守卫却只检查「有没有
 *   出现在 test:main 清单里」而发绿。判据④补上「接线是否在主干生效」。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **前缀误配**（判据④）：旧实现用 `/^\s*(?:-\s*)?run:\s*npm run test:main\b/`
 *     找 CI 里的执行点，`\b` 在 `main:` 之间成立——于是只跑 `npm run test:main:subset`
 *     （另一个更小的套件）的 job 也被判成「跑了 test:main」，主干照样假绿。
 *     现在要求 `main` 之后是非脚本名字符（空白 / 行尾 / `&&`）。
 *   · **只认 pull_request 的门控识别**：旧实现只把 `if:` 里出现 `pull_request` 的 job
 *     排除。于是 `if: github.event_name == 'schedule'`（或 `workflow_dispatch`）这种
 *     **只在侧路跑**的 job 被算成「随 push 运行」——判据④的整条结论就此失了依据。
 *     现在按「这个 job 会不会在 push 上跑」逐个判定。
 *   · **`continue` 跳块**：旧实现 `if (start < 0) continue` —— CI 结构一变（job 缩进
 *     改宽、`run:` 写在 `jobs:` 之外），那条执行点就**静默退出统计**，结果可能
 *     「没有任何 push job」或恰好还有别的 job 撑着 → 前者碰巧报红、后者碰巧报绿。
 *     现在无法归属到 job 的执行点一律**结构红**。
 *   · **扫描面下界只有「0 个文件」**：`src/main` 改名、`.selftest.ts` 后缀变化、`test:main`
 *     改成通配/换 runner（解析不到任何一项）时，「0 个 = 0 个未跑」是永真断言。
 *     现在两处（在盘 selftest 数 / 解析出的清单项数）各有下界，且都为**结构红**。
 *   · **崩溃 ≠ 红灯**：`src/main` 不存在时旧实现 `readdirSync` 抛 ENOENT 崩栈，
 *     与判据不一致混在同一个退出通道。现在结构错误单独成形、单独文案。
 *   · `--root` + 导出 `check()`：模块级 `process.cwd()` 收成参数，`import` 时不实扫、不 `process.exit`。
 *   · `--selftest`：跑真脚本的子进程，13 条用例逐条断言退出码 + 关键文本（含上述全部反证）。
 *
 * 用法：`node scripts/check-desktop-selftests-wired.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本（需要仓库根布局：apps/executor-desktop + .github）。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const SRC_REL = "apps/executor-desktop/src/main";
export const PKG_REL = "apps/executor-desktop/package.json";
export const BUNDLER_REL = "apps/executor-desktop/scripts/bundle-preload.cjs";
export const CI_REL = ".github/workflows/ci.yml";

/** 扫描面下界（2026-10-29 实测：src/main 下 48 个 *.selftest.ts、test:main 列 48 项）。只增不减。 */
export const MIN_SELFTESTS = 20;
export const MIN_LISTED = 20;

/** 剥掉 YAML 注释（整行 + 行内 ` #…`）：注释掉的 `if:` / `run:` 都不能算接线。 */
export function stripYamlComments(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

/**
 * 这个 job 会不会在 push 上跑？
 *
 * `if:` 缺失 → 会（workflow 的 `on:` 决定触发面，job 不再额外门控）；
 * 提到 `push` → 会；写成「不含某事件」的否定式（`!= 'schedule'`）→ 会；
 * 只提到 pull_request / workflow_dispatch / schedule → **不会**（判据④的整条结论会因此失真）。
 * 其它无法静态判断的条件按「可能会」处理（方向是「不误判为没跑」，宁可少报）。
 */
export function gateAllowsPush(ifLine) {
  if (ifLine == null) return true;
  const t = String(ifLine);
  if (/\bpush\b/.test(t)) return true;
  if (/!=\s*['"]?(pull_request|schedule|workflow_dispatch)/.test(t)) return true;
  if (/pull_request|workflow_dispatch|schedule/.test(t)) return false;
  return true;
}

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".selftest.ts")) out.push(p.replace(/\.ts$/, ""));
  }
  return out;
}

/**
 * 判据本体。返回 `{ structure, problems, counts }`：
 *   · structure = 结构性（事实源读不到 / 清单解析不到 / 扫描面塌了）——「判据本身不可信」；
 *   · problems  = 接线漂移（未跑 / 无源文件 / build:main 未接打包 / 无 push job）。
 */
export function check({ root = process.cwd() } = {}) {
  const structure = [];
  const problems = [];
  const counts = { files: 0, listed: 0, pushJobs: [] };

  // ── 事实源：package.json ────────────────────────────────────────────────
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(root, PKG_REL), "utf8"));
  } catch (error) {
    structure.push(
      `读不到/解析不了 ${PKG_REL}（${error.code ?? error.message}）—— test:main 与 build:main 都无从核对。`,
    );
    return { structure, problems, counts };
  }
  const testMain = pkg.scripts?.["test:main"];
  const buildMain = pkg.scripts?.["build:main"];
  if (typeof testMain !== "string") {
    structure.push(`${PKG_REL} 里没有 \`test:main\` 脚本 —— 判据①的清单来源消失了（不是「全都跑过了」）。`);
  }
  if (typeof buildMain !== "string") {
    structure.push(`${PKG_REL} 里没有 \`build:main\` 脚本 —— 判据③的接线来源消失了。`);
  }
  if (structure.length > 0) return { structure, problems, counts };

  // ── ① 在盘 selftest ────────────────────────────────────────────────────
  const srcDir = join(root, SRC_REL);
  const shortFiles = [];
  if (!existsSync(srcDir)) {
    structure.push(`读不到目录 ${SRC_REL} —— 路径变了，扫描面为 0（不是「selftest 都没了」）。`);
  } else {
    const abs = walk(srcDir, []);
    // 相对 SRC 的短名（去掉 .ts），用于与 dist-selftest/… 对齐
    for (const f of abs) shortFiles.push(f.slice(f.indexOf(SRC_REL) + SRC_REL.length + 1));
    counts.files = shortFiles.length;
    if (shortFiles.length === 0) {
      structure.push(`一个 selftest 都没扫到：${SRC_REL} —— 路径或后缀变了。`);
    } else if (shortFiles.length < MIN_SELFTESTS) {
      structure.push(
        `只扫到 ${shortFiles.length} 个 *.selftest.ts（下界 ${MIN_SELFTESTS}）—— 子树改名或大面积排除，判据不可信。`,
      );
    }
  }
  if (structure.length > 0) return { structure, problems, counts };

  // ── ② test:main 清单 ───────────────────────────────────────────────────
  const listed = [...testMain.matchAll(/dist-selftest\/([^\s&]+)\.js/g)].map((m) => m[1]);
  counts.listed = listed.length;
  if (listed.length === 0) {
    structure.push(
      "`test:main` 里解析不到任何 `dist-selftest/*.js` 项 —— 清单格式变了（通配 / 换 runner），判据①②已经瞎了。",
    );
  } else if (listed.length < MIN_LISTED) {
    structure.push(
      `\`test:main\` 只解析到 ${listed.length} 项（下界 ${MIN_LISTED}）—— 清单结构变了，判据不可信。`,
    );
  }
  if (structure.length > 0) return { structure, problems, counts };

  const listedSet = new Set(listed);
  const shortSet = new Set(shortFiles);
  const notRun = shortFiles.filter((f) => !listedSet.has(f)).sort();
  const noSource = listed.filter((l) => !shortSet.has(l)).sort();
  if (notRun.length > 0) {
    problems.push({ kind: "not-run", items: notRun });
  }
  if (noSource.length > 0) {
    problems.push({ kind: "no-source", items: noSource });
  }

  // ── ③ build:main 必须接 preload 自包含打包 ─────────────────────────────
  if (!buildMain.includes("bundle-preload.cjs")) {
    problems.push({ kind: "build-main", items: [BUNDLER_REL] });
  } else if (!existsSync(join(root, BUNDLER_REL))) {
    problems.push({ kind: "bundler-missing", items: [BUNDLER_REL] });
  }

  // ── ④ 至少一个随 push 运行的 job 执行 npm run test:main ────────────────
  const ciAbs = join(root, CI_REL);
  if (!existsSync(ciAbs)) {
    structure.push(`找不到 ${CI_REL} —— 无法验证 selftest 是否随 push 运行。`);
    return { structure, problems, counts };
  }
  const ciLines = stripYamlComments(readFileSync(ciAbs, "utf8")).split("\n");
  const jobStarts = [];
  for (let i = 0; i < ciLines.length; i += 1) {
    if (/^ {2}[a-zA-Z0-9_-]+:\s*$/.test(ciLines[i])) jobStarts.push(i);
  }
  // 只认 YAML 的 run 指令；注释/步骤名里提到 test:main 不算接线（注释已剥）。
  // `main` 之后必须是非脚本名字符：`npm run test:main:subset` 不是 test:main（前缀误配）。
  const runRe = /^\s*(?:-\s*)?run:\s*npm run test:main(?![\w:-])/;
  const pushJobs = [];
  for (let i = 0; i < ciLines.length; i += 1) {
    if (!runRe.test(ciLines[i])) continue;
    const start = [...jobStarts].reverse().find((j) => j < i);
    if (start === undefined) {
      structure.push(
        `${CI_REL} 第 ${i + 1} 行的 \`npm run test:main\` 无法归属到任何 job（job 缩进/结构变了）—— 无法判断它是否随 push 运行（旧实现这里静默跳过）。`,
      );
      continue;
    }
    const end = jobStarts.find((j) => j > start) ?? ciLines.length;
    const block = ciLines.slice(start, end);
    const ifLine = block.map((l) => /^ {4}if:\s*(.+)$/.exec(l)).find(Boolean)?.[1] ?? null;
    if (!gateAllowsPush(ifLine)) continue;
    const jobName = ciLines[start].trim().replace(/:$/, "");
    if (!pushJobs.includes(jobName)) pushJobs.push(jobName);
  }
  counts.pushJobs = pushJobs;
  if (pushJobs.length === 0) {
    problems.push({ kind: "no-push-job", items: [] });
  }

  return { structure, problems, counts };
}

// ── 自检（T4：全部跑真脚本子进程）─────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

// fixture 事实源：24 个 selftest（3 个在子目录里）+ 逐项列进 test:main。
const CASES = [
  ...["agent", "host", "ipc"].flatMap((dir) =>
    Array.from({ length: 3 }, (_, i) => `${dir}/case-${i}.selftest`),
  ),
  ...Array.from({ length: 15 }, (_, i) => `core/mod-${i}.selftest`),
];
const BUNDLER = "// fixture：preload 自包含打包器\n";

const desktopPkg = ({ listed = CASES, buildMain = "tsc -p tsconfig.json && node scripts/bundle-preload.cjs" } = {}) => ({
  name: "fixture-desktop",
  private: true,
  scripts: {
    "build:main": buildMain,
    "test:main":
      "npm run build:agent-worker && tsc -p tsconfig.selftest.json && " +
      listed.map((f) => `node dist-selftest/${f}.js`).join(" && "),
  },
});

/** 一段最小 ci.yml：push job（desktop-selftests）+ PR 门控 job（desktop-linux-bundle）。 */
const ciYaml = ({ pushStep = "npm run test:main", pushIf = null, dropPushJob = false, extra = [] } = {}) =>
  [
    "name: fixture",
    "on:",
    "  push:",
    "    branches: [develop]",
    "jobs:",
    ...(dropPushJob
      ? []
      : [
          "  desktop-selftests:",
          ...(pushIf ? [`    if: ${pushIf}`] : []),
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v7",
          `      - run: ${pushStep}`,
        ]),
    "  desktop-linux-bundle:",
    "    if: github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm run test:main",
    ...extra,
    "",
  ].join("\n");

function desktopTree({ selftests = CASES, pkg, ci, drop = [] } = {}) {
  const files = {
    [PKG_REL]: pkg ?? desktopPkg(),
    [CI_REL]: ci ?? ciYaml(),
    [BUNDLER_REL]: BUNDLER,
  };
  for (const f of selftests) files[`${SRC_REL}/${f}.ts`] = "export const ok = true;\n";
  for (const d of drop) delete files[d];
  return files;
}

/**
 * 自检：13 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树）。
 *
 * 旧版**没有 selftest**（模块级直接执行），所以「前缀误配」「只有 schedule 门控的
 * job 被当成随 push 运行」「run 行归属不到 job 时静默跳过」三处假绿都没被钉住。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "desktop-selftests-selftest-" });
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

  subprocess("① 干净树：24 项全部在 test:main、build:main 已接打包、有 push job → 绿", desktopTree(), {
    code: 0,
    contains: [
      `desktop 脚本接线一致：${CASES.length} 个 selftest 全部在 test:main 中且都有源文件`,
      "build:main 已接 preload 自包含打包",
      "push 触发 job：desktop-selftests",
    ],
    absent: ["结构错误", "没有被 test:main 执行", "没有源文件"],
  });

  subprocess(
    "② selftest 没被 test:main 执行（漏列 agent/case-0）→ 红并点名",
    desktopTree({ pkg: desktopPkg({ listed: CASES.filter((c) => c !== "agent/case-0.selftest") }) }),
    {
      code: 1,
      contains: ["1 个 selftest **没有被 test:main 执行**", "src/main/agent/case-0.selftest.ts"],
      absent: ["脚本接线一致"],
    },
  );

  subprocess(
    "③ test:main 列了没有源文件的项（删了 selftest 忘删清单）→ 红",
    desktopTree({ pkg: desktopPkg({ listed: [...CASES, "ghost/missing.selftest"] }) }),
    {
      code: 1,
      contains: ["1 个**没有源文件**的 selftest", "dist-selftest/ghost/missing.selftest.js"],
      absent: ["脚本接线一致"],
    },
  );

  subprocess(
    "④ build:main 没接 bundle-preload.cjs → 红",
    desktopTree({ pkg: desktopPkg({ buildMain: "tsc -p tsconfig.json" }) }),
    {
      code: 1,
      contains: ["build:main 没有接 preload 自包含打包", "scripts/bundle-preload.cjs"],
      absent: ["脚本接线一致"],
    },
  );

  subprocess(
    "⑤ build:main 写着打包器但文件不存在 → 红",
    desktopTree({ drop: [BUNDLER_REL] }),
    {
      code: 1,
      contains: ["bundle-preload.cjs", "不存在"],
      absent: ["脚本接线一致"],
    },
  );

  subprocess(
    "⑥ 只有 PR/手动门控的 job 跑 test:main → 红（判据④）",
    desktopTree({ ci: ciYaml({ dropPushJob: true }) }),
    {
      code: 1,
      contains: ["没有任何**随 push 运行**的 CI job 执行 `npm run test:main`", "desktop-selftests"],
      absent: ["脚本接线一致"],
    },
  );

  // ⑦ 修掉的假绿（前缀误配）：CI 只跑 `npm run test:main:subset`，旧实现的 `\b` 会命中
  subprocess(
    "⑦ 【反证·前缀误配】CI 只跑 `npm run test:main:subset` → 不算跑了 test:main，红",
    desktopTree({ ci: ciYaml({ pushStep: "npm run test:main:subset" }) }),
    { code: 1, contains: ["没有任何**随 push 运行**的 CI job 执行"], absent: ["脚本接线一致"] },
  );

  // ⑧ 修掉的假绿（门控识别）：只在 schedule 上跑的 job 不算「随 push 运行」
  subprocess(
    "⑧ 【反证·门控】push job 的 if 只在 schedule 上成立 → 不算随 push，红",
    desktopTree({ ci: ciYaml({ pushIf: "github.event_name == 'schedule'" }) }),
    { code: 1, contains: ["没有任何**随 push 运行**的 CI job 执行"], absent: ["脚本接线一致"] },
  );

  subprocess(
    "⑨ [反证·门控] if 是「不等于 schedule」的否定式 → 仍算随 push，绿",
    desktopTree({ ci: ciYaml({ pushIf: "github.event_name != 'schedule'" }) }),
    { code: 0, contains: ["push 触发 job：desktop-selftests"], absent: ["结构错误"] },
  );

  // ⑩ 修掉的假绿（continue 跳块）：run 行归属不到任何 job → 结构红，不再静默跳过
  subprocess(
    "⑩ 【反证·continue 跳块】run 行在 jobs 之外（归属不到 job）→ 结构红",
    desktopTree({
      ci: [
        "name: fixture",
        "on: push",
        "      - run: npm run test:main",
        "jobs:",
        "  desktop-selftests:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm run test:renderer",
        "",
      ].join("\n"),
    }),
    { code: 1, contains: ["结构错误", "无法归属到任何 job"], absent: ["脚本接线一致"] },
  );

  subprocess(
    "⑪ 【反证·扫描面】只剩 3 个 selftest → 结构红",
    desktopTree({ selftests: CASES.slice(0, 3), pkg: desktopPkg({ listed: CASES.slice(0, 3) }) }),
    { code: 1, contains: ["结构错误", `只扫到 3 个 *.selftest.ts（下界 ${MIN_SELFTESTS}）`], absent: ["脚本接线一致"] },
  );

  subprocess(
    "⑫ 【反证·解析失败】test:main 改成通配（解析不到任何项）→ 结构红",
    desktopTree({
      pkg: {
        name: "fixture-desktop",
        private: true,
        scripts: {
          "build:main": "tsc -p tsconfig.json && node scripts/bundle-preload.cjs",
          "test:main": "node scripts/run-selftests.mjs --all",
        },
      },
    }),
    { code: 1, contains: ["结构错误", "解析不到任何 `dist-selftest/*.js` 项"], absent: ["脚本接线一致"] },
  );

  subprocess("⑬ 事实源缺失（package.json 被删）→ 结构红且不崩栈", desktopTree({ drop: [PKG_REL] }), {
    code: 1,
    contains: ["结构错误", `读不到/解析不了 ${PKG_REL}`],
    absent: ["脚本接线一致", "Error:", "\n    at "],
  });

  subprocess(
    "⑭ 事实源缺失（src/main 目录整个不在）→ 结构红且点名路径",
    desktopTree({ selftests: [], pkg: desktopPkg({ listed: CASES }) }),
    { code: 1, contains: ["结构错误", `读不到目录 ${SRC_REL}`], absent: ["脚本接线一致", "Error:", "\n    at "] },
  );

  const failed = reportCases(cases, { title: "check-desktop-selftests-wired selftest" });
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
    const { structure, problems, counts } = check({ root });

    if (structure.length > 0) {
      console.error("");
      console.error("✖ desktop 脚本接线守卫结构错误（判据本身不可信）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (problems.length > 0) {
      console.error("");
      for (const p of problems) {
        if (p.kind === "not-run") {
          console.error("✖ " + p.items.length + " 个 selftest **没有被 test:main 执行**：");
          for (const f of p.items) console.error("  · src/main/" + f + ".ts");
        } else if (p.kind === "no-source") {
          console.error("✖ test:main 列了 " + p.items.length + " 个**没有源文件**的 selftest：");
          for (const f of p.items) console.error("  · dist-selftest/" + f + ".js");
        } else if (p.kind === "build-main") {
          console.error("✖ build:main 没有接 preload 自包含打包（scripts/bundle-preload.cjs）。");
          console.error("  沙箱 preload 只能 require('electron') 这类受限模块，相对 require 会导致");
          console.error("  整个 preload 加载失败（window.electronAPI 消失 → 界面落进错误边界）。");
          console.error("  修法：build:main = \"tsc -p tsconfig.json && node scripts/bundle-preload.cjs\"。");
        } else if (p.kind === "bundler-missing") {
          console.error("✖ build:main 引用的 " + p.items[0] + " 不存在 —— 打包步骤会直接失败（不是「已接线」）。");
        } else if (p.kind === "no-push-job") {
          console.error("✖ 没有任何**随 push 运行**的 CI job 执行 `npm run test:main`。");
          console.error("  现状：test:main 只挂在 pull_request / workflow_dispatch / schedule 门控的 job 上，");
          console.error("  而本仓常规路径是直接 push develop——" + counts.files + " 个 selftest 在主干上零覆盖。");
          console.error("  修法：保留一个不加 `if`（或 if 含 push 语义）的 job 跑 npm run test:main");
          console.error("  （见 ci.yml 的 desktop-selftests）。");
        }
      }
      console.error("");
      console.error("  修法：改 apps/executor-desktop/package.json 的 test:main 清单（补上/删掉对应项）。");
      console.error("  删 selftest 时记得同步删清单，否则命令会在 CI 里 ENOENT。");
      process.exit(1);
    }

    console.log(
      "✔ desktop 脚本接线一致：" +
        counts.files +
        " 个 selftest 全部在 test:main 中且都有源文件；build:main 已接 preload 自包含打包；" +
        "push 触发 job：" + counts.pushJobs.join(", ") + "。",
    );
  }
}
