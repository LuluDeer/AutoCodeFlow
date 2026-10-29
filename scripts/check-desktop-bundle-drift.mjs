#!/usr/bin/env node
// F-19 / ADR-005 加固：desktop 内嵌 executor-node bundle 的**语义漂移**守卫。
//
// 背景（为什么需要第二道闸）：
// 现有的 .github/workflows/ci.yml 的 desktop-bundle-drift job 比对的是
// 「ncc 重打产物的 sha256 == 清单 executor-node-bundle.sha256」。该判据有两个
// 结构性问题，见 docs/design/python-task-upload-and-multiversion/BUNDLE-DRIFT-FINDING.md：
//
//   ① **构建路径依赖**：ncc 的 module id 由模块解析后的**真实绝对路径**派生，
//      同一份源码在不同目录下重打得到不同哈希。CI 固定在
//      `/home/runner/work/<repo>/<repo>`，本地开发者**永远算不出** CI 的值，
//      只能"推 CI → 读 actual → 回填"。这使该闸对本地开发**不可用**。
//   ② **构建器版本依赖**：ncc 换版（如 0.44 → 0.45）会整体改变产物字节，
//      即使源码一字未改，清单哈希也会失效——把"工具链升级"误报成"源码漂移"。
//      （2026-09 依赖审计二轮即命中：ncc 0.44→0.45，bundle 2600kB → 4035kB。）
//   ③ 失败信息不可诊断："本地算不出"与"真的漏打"给出同一句话。
//
// 本闸的判据**故意不看产物字节**，而是回答该闸真正要回答的问题：
//   「apps/executor-node/src 的内容，与清单记录的**那份源码**是否一致？」
// 做法：对 bundle 的**输入源文件**（排除 .spec/.test——它们不进产物）按
// 路径排序后，逐个喂 `路径\n内容` 求 sha256，得到一个与构建路径、OS、
// ncc 版本**全都无关**的语义摘要，与清单里的 `source-digest` 比对。
//
// 两个闸分工（都保留）：
//   · 本闸（语义）：抓"改了 executor-node/src 却没重打 bundle"——ADR-005 的本意，
//     且**本地可复现**，推送前就能自查。
//   · 原闸（字节）：抓"重打了但产物与源码不符"（更严，但只在 CI 可判）。
//
// ## T4（第 4 轮守卫自检审计）修掉的假绿
//
//   · **`--print` 是判据的静默后门（最贵的一条）**：旧实现 `--print` 对
//     「源码目录不在 / 一个输入文件都没有」照样打印 `source-digest: e3b0c442…`
//     （空输入串的 sha256）并 **exit 0**。回填命令正好就是 `--print`，
//     于是「在错误目录跑一次 → 把空摘要写进清单」能让语义闸**永久绿**，
//     且之后任何人改源码都会被判成「与清单不一致」——方向反了，没人看懂。
//     现在 `--print` 也先过结构关：事实源缺失/扫描面塌方 → 结构红 + exit 1。
//   · **事实源缺失只报一句普通错误**：清单不在、没有 bundle 输入、清单缺
//     `source-digest` 行，旧实现都塞进同一个 `errors` 数组（"漂移 1 项"），
//     于是「清单没写」和「源码真漂移」在 CI 日志里长得一样，处置动作却相反。
//     现在这两类是**分开的**：`structure` = 判据不可信（先修判据），
//     `errors` = 真漂移（去重打 bundle）。
//   · **扫描面没有下界**：`listBundleInputs` 的 walk 一旦因目录改名/权限问题
//     返回 1-2 个文件，摘要必然与清单不符——但如果有人照着提示"回填"，
//     清单就被钉死在这 1-2 个文件上。现在输入文件数低于下界 = 结构红。
//   · **`--root` 缺失**：整个检查隐式依赖 `process.cwd()`，selftest 只能在
//     真实仓库上跑（改坏一次源码就污染工作区）。现在所有路径相对 `root`，
//     selftest 用**真 sha256 清单 + 真源码树**的 fixture（不碰真清单）。
//   · **只数条数/函数级断言**：旧 selftest 只断言 `computeSourceDigest` 的
//     五个性质，删掉 CLI 的 `process.exit(1)`（第 285 行）它照样全绿——而
//     "闸不关门"恰是本闸最贵的失效形态。现在跑**真子进程**，逐条断言退出码 +
//     关键文本（10 条）。
//
// 退出码：0 = 无漂移（且判据可信）；1 = 源码漂移，或结构错（--print 同样）。
//
// 用法：
//   node scripts/check-desktop-bundle-drift.mjs                 # 检查真实代码库
//   node scripts/check-desktop-bundle-drift.mjs --selftest      # 验证判据本身
//   node scripts/check-desktop-bundle-drift.mjs --print         # 打印当前摘要（供回填）
//   node scripts/check-desktop-bundle-drift.mjs --root <dir>    # selftest 专用（默认 cwd）
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const SRC_DIR = "apps/executor-node/src";
export const MANIFEST = "apps/executor-desktop/executor-node-bundle.sha256";

// N-06①：agent-worker bundle 的第二段闸（同判据，输入面不同）。
// worker 的 bundle 输入 = src/agent-worker/**（esbuild 入口 + electron-stub
// 包，stub 内容内联进产物，改动必须重打）+ src/main/agent/**（AgentHost 及
// 其执行层——worker 的全部业务代码）。manifest 为 agent-worker-bundle.sha256。
export const AGENT_WORKER_SRC_DIRS = [
  "apps/executor-desktop/src/agent-worker",
  "apps/executor-desktop/src/main/agent",
];
export const AGENT_WORKER_MANIFEST = "apps/executor-desktop/agent-worker-bundle.sha256";

/**
 * 扫描面下界（2026-10-29 实测：executor-node 51 个输入、agent-worker 41 个）。
 * 输入文件塌到下界以下时摘要必然"不一致"，但照着提示回填会把清单钉死在
 * 一个瞎掉的分母上——所以这里判**结构红**，不是判漂移。
 */
export const MIN_BUNDLE_INPUTS = 10;

/** bundle 输入 = src 下所有 .ts（executor-node 面）/ .ts+.cjs（agent-worker 面，
 * stub 的 index.cjs 会内联进产物），排除测试文件（实测不进产物）。 */
export function isBundleInput(name) {
  const isTs = name.endsWith(".ts") &&
    !name.endsWith(".spec.ts") &&
    !name.endsWith(".test.ts") &&
    !name.endsWith(".d.ts");
  const isWorkerCjs = name.endsWith(".cjs") &&
    !name.endsWith(".selftest.cjs");
  return isTs || isWorkerCjs;
}

/**
 * 递归列出 bundle 输入文件（**相对 root 的 POSIX 路径**，已排序）。
 *
 * 返回相对路径而不是绝对路径，是摘要跨环境可复现的前提：
 * `computeSourceDigest` 把路径本身也喂进哈希，绝对路径会让同一份源码在不同
 * checkout 目录下算出不同摘要。
 *
 * @param {string|string[]} [srcDirs] 相对 root 的目录（默认 executor-node 面）
 * @param {string} [root] 仓库根
 * @returns {string[]}
 */
export function listBundleInputs(srcDirs = [SRC_DIR], root = process.cwd()) {
  const dirs = Array.isArray(srcDirs) ? srcDirs : [srcDirs];
  const out = [];
  for (const srcDir of dirs) {
    const relBase = String(srcDir).replace(/\\/g, "/").replace(/\/+$/, "");
    const absBase = join(root, relBase);
    if (!existsSync(absBase)) continue;
    const walk = (abs, rel) => {
      for (const name of readdirSync(abs)) {
        const absChild = join(abs, name);
        if (statSync(absChild).isDirectory()) {
          if (name === "node_modules" || name === "dist") continue;
          walk(absChild, `${rel}/${name}`);
        } else if (isBundleInput(name)) {
          out.push(`${rel}/${name}`);
        }
      }
    };
    walk(absBase, relBase);
  }
  return [...new Set(out)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 语义摘要：对排序后的 (路径, 内容) 求 sha256。
 * 关键点——**不包含**绝对路径、构建时间、OS、ncc 版本，故跨环境可复现；
 * 但包含每个文件的相对路径，故"文件改名/移动"同样会被判为漂移。
 * 行尾统一为 \n：Windows checkout（core.autocrlf）不应造成假漂移。
 */
export function computeSourceDigest(files, read = (f) => readFileSync(f, "utf8")) {
  const h = createHash("sha256");
  // 内部再排一次序：调用方传什么顺序都不影响结果（自检 ⑤ 钉住该契约）。
  for (const f of [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const content = read(f).replace(/\r\n/g, "\n");
    h.update(f);
    h.update("\n");
    h.update(content);
    h.update("\n");
  }
  return h.digest("hex");
}

/** 从清单文本里取**最后一条** `source-digest: <hex>`（# 注释行忽略，含行内 `#` 之前）。 */
export function parseManifestDigest(manifestText) {
  let found = null;
  for (const line of String(manifestText ?? "").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(/source-digest:\s*([0-9a-f]{64})/i);
    if (m) found = m[1].toLowerCase();
  }
  return found;
}

/** 从清单文本里取末行字节哈希（既有判据，保留供提示用）。 */
export function parseManifestBundleHash(manifestText) {
  for (const line of String(manifestText ?? "").split(/\r?\n/).reverse()) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(/^([0-9a-f]{64})\s/m);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * 段级判据。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] 仓库根（默认 cwd）
 * @param {string|string[]} [opts.srcDir] bundle 输入目录（相对 root）
 * @param {string} [opts.manifestPath] 清单路径（相对 root）
 * @param {string} [opts.artifactLabel] 报错里的产物名
 * @param {(rel: string) => string} [opts.read] 注入读取器（默认从 root 读）
 * @returns {{errors: string[], structure: string[], files: string[],
 *            actual: string|null, expected: string|null}}
 *   `structure` = 判据不可信（事实源缺失/扫描面塌方），`errors` = 真漂移。
 */
export function check({
  root = process.cwd(),
  srcDir = SRC_DIR,
  manifestPath = MANIFEST,
  artifactLabel = "executor-node",
  read,
} = {}) {
  const errors = [];
  const structure = [];
  const readRel = read ?? ((f) => readFileSync(join(root, f), "utf8"));
  const dirs = Array.isArray(srcDir) ? srcDir : [srcDir];
  const where = dirs.join(" + ");

  const files = listBundleInputs(srcDir, root);
  if (files.length === 0) {
    structure.push(
      `事实源缺失：${where} 里没有任何 bundle 输入文件 —— 判据瞎了（目录改名/在子目录跑都会这样，不是「无漂移」）。`,
    );
    return { errors, structure, files, actual: null, expected: null };
  }
  if (files.length < MIN_BUNDLE_INPUTS) {
    structure.push(
      `只扫到 ${files.length} 个 bundle 输入文件（下界 ${MIN_BUNDLE_INPUTS}）—— ` +
        `${where} 的扫描面塌方；此时摘要必然不一致，但「回填」会把清单钉死在瞎掉的分母上。`,
    );
    return { errors, structure, files, actual: null, expected: null };
  }
  if (!existsSync(join(root, manifestPath))) {
    structure.push(
      `事实源缺失：清单 ${manifestPath} 不在 —— 判据无从比对（不是「无漂移」）。`,
    );
    return { errors, structure, files, actual: null, expected: null };
  }

  const actual = computeSourceDigest(files, readRel);
  const expected = parseManifestDigest(readRel(manifestPath));
  if (!expected) {
    structure.push(
      `清单缺少 source-digest 行：${manifestPath} —— 判据无从比对；` +
        "按 'node scripts/check-desktop-bundle-drift.mjs --print' 取值后按格式补一行。",
    );
    return { errors, structure, files, actual, expected: null };
  }
  if (actual !== expected) {
    errors.push(
      `${artifactLabel} 源码语义摘要漂移：actual=${actual.slice(0, 12)}… expected=${expected.slice(0, 12)}…`,
    );
  }
  return { errors, structure, files, actual, expected };
}

/** N-06①：agent-worker 段的 check 便捷入口。 */
export function checkAgentWorker(opts = {}) {
  return check({
    srcDir: AGENT_WORKER_SRC_DIRS,
    manifestPath: AGENT_WORKER_MANIFEST,
    artifactLabel: "agent-worker",
    ...opts,
  });
}

/** 两段（executor-node / agent-worker）的统一定义，CLI 与 selftest 共用。 */
export const SEGMENTS = [
  {
    label: "executor-node",
    srcDir: SRC_DIR,
    manifestPath: MANIFEST,
    run: (opts) => check(opts),
  },
  {
    label: "agent-worker",
    srcDir: AGENT_WORKER_SRC_DIRS,
    manifestPath: AGENT_WORKER_MANIFEST,
    run: (opts) => checkAgentWorker(opts),
  },
];

// ── 自检（T4：真子进程 + 退出码 + 报错文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const FIXTURE_INPUTS = 12;
const ZERO_DIGEST = "0".repeat(64);
const BYTE_HASH = "a".repeat(64);

/** executor-node 面的 12 个输入（+1 个 spec，证明测试文件不进摘要）。 */
const execFiles = () =>
  Object.fromEntries([
    ...Array.from({ length: FIXTURE_INPUTS }, (_, i) => [
      `${SRC_DIR}/f${String(i).padStart(2, "0")}.ts`,
      `export const f${String(i).padStart(2, "0")} = ${i};\n`,
    ]),
    [`${SRC_DIR}/f00.spec.ts`, "it('x', () => {});\n"],
  ]);

/** agent-worker 面的 12 个输入（两个目录各 6 个，证明多目录合并）。 */
const workerFiles = () =>
  Object.fromEntries(
    AGENT_WORKER_SRC_DIRS.flatMap((dir, d) =>
      Array.from({ length: FIXTURE_INPUTS / 2 }, (_, i) => [
        `${dir}/w${d}${String(i).padStart(2, "0")}.ts`,
        `export const w${d}${i} = ${i};\n`,
      ]),
    ),
  );

const manifestText = (digest) =>
  ["# fixture 清单（真正的 sha256 摘要由 selftest 现算）", `${BYTE_HASH}  index.js`, `source-digest: ${digest}`, ""].join("\n");

/** 从「文件映射」里筛出某几个目录下的 bundle 输入（与 listBundleInputs 同集合、同顺序）。 */
function inputsUnder(files, dirs) {
  return Object.keys(files)
    .filter((p) => dirs.some((d) => p.startsWith(d + "/")) && isBundleInput(p.split("/").pop()))
    .sort();
}

/**
 * fixture 树：源码树 + 真 sha256 清单（双段）。
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.exec] executor-node 面源码
 * @param {Record<string,string>} [opts.worker] agent-worker 面源码
 * @param {string|null} [opts.execManifest] `"auto"` = 用现算摘要；null = 不写清单；字符串 = 原样
 * @param {string|null} [opts.workerManifest]
 */
function tree({
  exec = execFiles(),
  worker = workerFiles(),
  execManifest = "auto",
  workerManifest = "auto",
} = {}) {
  const files = { "package.json": { name: "fixture", private: true }, ...exec, ...worker };
  const digestOf = (dirs) => computeSourceDigest(inputsUnder(files, dirs), (rel) => files[rel]);
  const execDigest = digestOf([SRC_DIR]);
  const workerDigest = digestOf(AGENT_WORKER_SRC_DIRS);
  if (execManifest !== null) {
    files[MANIFEST] = execManifest === "auto" ? manifestText(execDigest) : execManifest;
  }
  if (workerManifest !== null) {
    files[AGENT_WORKER_MANIFEST] =
      workerManifest === "auto" ? manifestText(workerDigest) : workerManifest;
  }
  return files;
}

/**
 * 自检：10 条子进程用例。
 *
 * 每条都断言退出码 + 关键文本：本闸的历史事故形态在 **CLI 层**（`process.exit`
 * 是否执行、`--print` 是否也过结构关）与 **判据边界层**（事实源缺失被算成漂移、
 * 扫描面没有下界）。旧版只断言摘要函数的五个性质，删掉 exit(1) 也全绿。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, args, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "bundle-drift-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir, ...args] }), {
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

  subprocess(
    "① 清单与源码一致（双段）→ 绿",
    tree(),
    [],
    {
      code: 0,
      contains: [
        `✔ executor-node 源码摘要一致（${FIXTURE_INPUTS} 个输入文件`,
        `✔ agent-worker 源码摘要一致（${FIXTURE_INPUTS} 个输入文件`,
        "与打包器版本/构建路径无关",
      ],
      absent: ["结构错误", "漂移", "✖"],
    },
  );

  subprocess(
    "② 改了源码没重打/回填 → 红（点名 actual/expected 与处置命令）",
    (() => {
      const files = tree();
      files[`${SRC_DIR}/f03.ts`] = "export const f03 = 999;\n";
      return files;
    })(),
    [],
    {
      code: 1,
      contains: [
        "executor-node 源码语义摘要漂移",
        "actual=",
        "expected=",
        "npm run build:executor",
      ],
      absent: ["✔ executor-node 源码摘要一致"],
    },
  );

  subprocess(
    "③ 【反证·注释算数】清单里只有注释掉的 source-digest → 结构红（不是「无漂移」）",
    tree({
      execManifest: `# source-digest: ${ZERO_DIGEST}  ← 注释里的示例\n${BYTE_HASH}  index.js\n`,
    }),
    [],
    {
      code: 1,
      contains: ["结构错误", `清单缺少 source-digest 行：${MANIFEST}`],
      absent: ["✔ executor-node 源码摘要一致", "源码语义摘要漂移"],
    },
  );

  subprocess(
    "④ 【反证·测试文件不进摘要】改 .spec.ts 内容 → 仍绿（不触发假漂移）",
    (() => {
      const files = tree();
      files[`${SRC_DIR}/f00.spec.ts`] = "it('changed', () => { throw new Error(); });\n";
      return files;
    })(),
    [],
    { code: 0, contains: ["✔ executor-node 源码摘要一致"], absent: ["漂移", "结构错误"] },
  );

  subprocess(
    "⑤ 【反证·--print 吞结构错】源码目录整棵不在 + --print → 结构红 + exit 1（不许打印空摘要）",
    { "package.json": { name: "empty", private: true } },
    ["--print"],
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${SRC_DIR} 里没有任何 bundle 输入文件`],
      absent: ["source-digest:", "Error:", "ENOENT"],
    },
  );

  {
    const files = tree();
    const execDigest = computeSourceDigest(inputsUnder(files, [SRC_DIR]), (rel) => files[rel]);
    subprocess(
      "⑥ --print 在合规树上打印可回填的摘要（与清单值相等）",
      files,
      ["--print"],
      {
        code: 0,
        contains: [
          `source-digest: ${execDigest}`,
          "agent-worker source-digest:",
          `(${FIXTURE_INPUTS} bundle input files)`,
        ],
        absent: ["结构错误"],
      },
    );
  }

  subprocess(
    "⑦ 事实源缺失（清单不在）→ 结构红，不是「漂移 1 项」",
    tree({ execManifest: null }),
    [],
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：清单 ${MANIFEST} 不在`],
      absent: ["✔ executor-node 源码摘要一致", "Error:"],
    },
  );

  subprocess(
    "⑧ 【反证·扫描面】src 只剩 3 个输入 → 结构红（不是「漂移」）",
    tree({
      exec: Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [`${SRC_DIR}/only${i}.ts`, `export const o = ${i};\n`]),
      ),
      execManifest: `source-digest: ${ZERO_DIGEST}\n`,
    }),
    [],
    {
      code: 1,
      contains: ["结构错误", "只扫到 3 个 bundle 输入文件", `下界 ${MIN_BUNDLE_INPUTS}`],
      absent: ["源码语义摘要漂移"],
    },
  );

  subprocess(
    "⑨ agent-worker 段单独漂移 → 红只点 agent-worker（executor-node 仍绿）",
    tree({ workerManifest: `source-digest: ${ZERO_DIGEST}\n` }),
    [],
    {
      code: 1,
      contains: ["agent-worker 源码语义摘要漂移", "✔ executor-node 源码摘要一致"],
      absent: ["executor-node 源码语义摘要漂移"],
    },
  );

  subprocess(
    "⑩ 清单 source-digest 格式坏了（非 64 hex）→ 结构红",
    tree({ execManifest: `source-digest: deadbeef  index.js\n` }),
    [],
    {
      code: 1,
      contains: ["结构错误", `清单缺少 source-digest 行：${MANIFEST}`],
      absent: ["✔ executor-node 源码摘要一致"],
    },
  );

  const failed = reportCases(cases, { title: "check-desktop-bundle-drift selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
function printDigests(root) {
  const warnings = [];
  for (const seg of SEGMENTS) {
    const files = listBundleInputs(seg.srcDir, root);
    const where = [].concat(seg.srcDir).join(" + ");
    if (files.length === 0) {
      warnings.push(`事实源缺失：${where} 里没有任何 bundle 输入文件`);
      continue;
    }
    if (files.length < MIN_BUNDLE_INPUTS) {
      warnings.push(
        `只扫到 ${files.length} 个 bundle 输入文件（下界 ${MIN_BUNDLE_INPUTS}）：${where} —— 扫描面塌方`,
      );
      continue;
    }
    const prefix = seg.label === "executor-node" ? "" : `${seg.label} `;
    console.log(`${prefix}source-digest: ${computeSourceDigest(files, (f) => readFileSync(join(root, f), "utf8"))}`);
    console.log(`(${files.length} bundle input files)`);
  }
  if (warnings.length > 0) {
    console.error("");
    console.error("✖ bundle 摘要生成失败（结构错误，判据不可信）：");
    for (const w of warnings) console.error("  · " + w);
    console.error("  处置：确认在仓库根执行、源码目录存在；**不要**把空/塌方摘要回填进清单。");
    console.error("");
    process.exit(1);
  }
}

const invoked = process.argv[1]?.replace(/\\/g, "/").split("/").pop();

if (invoked === "check-desktop-bundle-drift.mjs") {
  const argv = process.argv.slice(2);
  const root = resolve(argValue(argv, "--root") ?? process.cwd());

  if (argv.includes("--selftest")) {
    selftest();
  } else if (argv.includes("--print")) {
    printDigests(root);
  } else {
    let failed = false;
    let structureFailed = false;
    for (const seg of SEGMENTS) {
      const { errors, structure, files, actual } = seg.run({ root });
      if (structure.length > 0) {
        structureFailed = true;
        console.error(`✖ ${seg.label} 结构错误（判据本身不可信，先修扫描面）：`);
        for (const e of structure) console.error(`  · ${e}`);
        continue;
      }
      if (errors.length > 0) {
        failed = true;
        console.error(`${seg.label} 语义漂移（${errors.length} 项）：`);
        for (const e of errors) console.error(`  - ${e}`);
        continue;
      }
      console.log(
        `✔ ${seg.label} 源码摘要一致（${files.length} 个输入文件，digest=${actual.slice(0, 12)}…，与打包器版本/构建路径无关）`,
      );
    }
    if (failed) {
      console.error("");
      console.error("处置：改了 bundle 输入源码后须重打并回填清单——");
      console.error("  executor-node：npm run build:executor（apps/executor-desktop），");
      console.error("    摘要用 node scripts/check-desktop-bundle-drift.mjs --print，回填 executor-node-bundle.sha256");
      console.error("  agent-worker：npm run build:agent-worker（apps/executor-desktop），");
      console.error("    摘要同上取 agent-worker 段，回填 agent-worker-bundle.sha256（字节行 sha256sum resources/agent-worker/dist/index.js）");
      console.error("  两闸与构建器版本/构建路径无关，本地即可判定——本地红就是真漂移。");
    }
    if (failed || structureFailed) process.exit(1);
  }
}
