#!/usr/bin/env node
/**
 * N-06：agent-worker / 打包态 Playwright 的**跨文件配置一致性**守卫（T4 迁 harness）。
 *
 * 本任务把 Agent 托管拆成独立子进程并把 Chromium 随包分发，接线分散在
 * 10 个事实源（esbuild 脚本 / electron-builder.yml / 发布流水线 / 路径解析 /
 * 漂移清单 / .gitignore / 两个 package.json / worker tsconfig / electron stub）。
 * 这类「同一条契约写在多处」的接线，历史上最典型的失效形态就是改一处忘其余
 * （desktop-v1.5.1 漏打 uv、v1.5.0 artifactName 错位都是同型事故）。本守卫把每处
 * 锚点钉死：任何一处被静默拆除即红，失败信息直接指出该补哪。
 *
 * 分工（不重复别的闸的职责）：
 *   · 语义/字节漂移 → check-desktop-bundle-drift.mjs（本守卫只检查清单存在）
 *   · worker 运行时契约 → agent-worker-paths/protocol/process selftest（真 spawn）
 *   · 本守卫：配置面锚点齐全性，纯静态读，秒级零依赖。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **整篇 `includes` = 注释也算接线**：旧实现直接对文件全文做 `content.includes(needle)`，
 *     于是 `.gitignore` 里的 `#apps/executor-desktop/resources/agent-worker/`、
 *     yaml 里 `# to: agent-worker/`、ts 里 `// ELECTRON_RUN_AS_NODE` 全部满足锚点——
 *     把接线**注释掉**（最省事的「临时关掉」手法）在本闸下是绿的。现在先按文件类型
 *     剥掉注释（`#` 行 / `//` 与块注释，字符串字面量原样保留——锚点里有一半是路径
 *     字面量），再匹配。
 *   · **针尾没有边界（前缀误配）**：`build:agent-worker` 是 `build:agent-worker2` 的
 *     前缀，`ACF_BUNDLE_PLAYWRIGHT: '1'` 是 `…: '10'` 的前缀。旧实现按纯子串判定，
 *     于是「把脚本改名成 build:agent-worker2 并在别处留一行旧注释」也能过。现在针尾是
 *     标识符字符时要求后接非标识符字符（`"`、空白、`/`、行尾…）。
 *   · **崩溃 / 空跑 ≠ 红灯**：`apps/executor-desktop` 整棵不在时旧实现产出 10 条
 *     「文件不存在」，混在真实漂移里；而事实源全缺时「0 条锚点被违反」读起来像绿。
 *     现在事实源文件数 < 下界、锚点表 < 下界各自**结构红**。
 *   · **字节行必须在行首或换行后**：旧正则 `/\n[0-9a-f]{64}\s+\S/` 要求哈希前有换行，
 *     清单首行就是哈希时判红（假红）；现在允许行首。
 *   · `--root` + 导出 `check()`：import 时不实扫、不 `process.exit`。
 *   · `--selftest`：从「删一个文件看 errors 非空」改为**跑真脚本的子进程**，逐条断言
 *     退出码 + 关键文本（旧版删掉 `process.exit(1)` 也照样全绿，且只验证「文件级」
 *     缺失，针级/注释级/前缀级三种假绿一个都没钉）。
 *
 * 用法：`node scripts/check-desktop-agent-packaging.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本；每条断言退出码 + 关键文本 + <1s。
 *   --root    ：把该目录当仓库根（默认 process.cwd()）；selftest 专用。
 *
 * 退出码：0=配置面一致；1=漂移或结构性失败。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

/**
 * 事实源清单：锚点的落点。**只读**——本守卫不写任何文件。
 * key 与 `buildAnchors` 里的 `fileKey` 对应。
 */
export const FACT_FILES = {
  builderYml: "apps/executor-desktop/electron-builder.yml",
  pathsTs: "apps/executor-desktop/src/main/agent-worker-paths.ts",
  releaseYml: ".github/workflows/release-desktop.yml",
  bundleScript: "apps/executor-desktop/scripts/bundle-agent-worker.cjs",
  gitignore: ".gitignore",
  desktopPkg: "apps/executor-desktop/package.json",
  rootPkg: "package.json",
  workerTsconfig: "apps/executor-desktop/tsconfig.worker.json",
  stubIndex: "apps/executor-desktop/src/agent-worker/electron-stub/index.cjs",
  workerManifest: "apps/executor-desktop/agent-worker-bundle.sha256",
};

/** 锚点表下界（2026-10-29 实测 18 条）。删锚点≠修好，塌到下界即结构红。 */
export const MIN_ANCHORS = 18;

/** 事实源下界（共 10 个）。低于它说明仓库根不对或 desktop 整棵不在。 */
export const MIN_FACT_FILES = 8;

/**
 * 剥注释（保留字符串字面量）。按文件类型选风格：
 *   · `hash` —— .gitignore / *.yml / *.sha256：整行的 `#…`；
 *   · `code` —— .ts / .cjs：`//` 行注释与块注释（状态机，引号内的原样保留）；
 *   · `none` —— .json（JSON 本来不许注释）。
 *
 * 为什么要保留字符串：各锚点里有一半是**路径字面量**（`'agent-worker'`、`'index.js'`），
 * 若把字符串一并抹掉，判据就只剩空文件可匹配。
 */
export function stripComments(text, style = "none") {
  const src = String(text ?? "");
  if (style === "none") return src;
  if (style === "hash") {
    return src
      .split(/\r?\n/)
      .map((line) => (/^\s*#/.test(line) ? "" : line))
      .join("\n");
  }

  const out = [];
  let state = "code";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        state = "block";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      out.push(c);
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out.push("\n");
      } else {
        out.push(" ");
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        out.push("  ");
        i += 2;
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }
    // 字符串内部：原样保留，只处理转义与收尾引号
    if (c === "\\") {
      out.push(c, src[i + 1] ?? "");
      i += 2;
      continue;
    }
    const closer = state === "sq" ? "'" : state === "dq" ? '"' : "`";
    out.push(c);
    if (c === closer) state = "code";
    i += 1;
  }
  return out.join("");
}

/** 文件扩展名/名 → 注释风格。 */
export function commentStyleOf(rel) {
  const base = String(rel).split("/").pop();
  if (base === ".gitignore") return "hash";
  if (/\.(ya?ml)$/.test(base)) return "hash";
  if (/\.(sha256)$/.test(base)) return "hash";
  if (/\.(ts|tsx|js|cjs|mjs)$/.test(base)) return "code";
  return "none";
}

/** 针尾是标识符字符时需要边界；避免 `build:agent-worker` 命中 `build:agent-worker2`。 */
const NEEDS_BOUNDARY = /[A-Za-z0-9_]$/;
const CONTINUES = /[A-Za-z0-9_.-]/;

/**
 * 带边界的子串查找（找到返回下标，找不到返回 -1）。
 *
 * 只对**针尾是标识符字符**的针加边界（以引号/斜杠/冒号结尾的针本身已有边界）。
 */
export function findNeedle(haystack, needle) {
  const hay = String(haystack ?? "");
  const pin = String(needle ?? "");
  if (pin === "") return hay.length >= 0 ? 0 : -1;
  const bounded = NEEDS_BOUNDARY.test(pin);
  let from = 0;
  for (;;) {
    const at = hay.indexOf(pin, from);
    if (at < 0) return -1;
    if (!bounded) return at;
    const after = hay[at + pin.length];
    if (after === undefined || !CONTINUES.test(after)) return at;
    from = at + 1;
  }
}

/**
 * 锚点表：每项 = { desc, fileKey, needles }。needles 全部出现才算过。
 * @param {Record<string, string|null>} files 已读入的原始文本（未剥注释）
 */
export function buildAnchors(files) {
  const spec = [
    [
      "electron-builder.yml: agent-worker extraResources 条目（to: agent-worker/）",
      "builderYml",
      ["from: resources/agent-worker/", "to: agent-worker/"],
    ],
    [
      "electron-builder.yml: playwright extraResources 条目（to: playwright/）",
      "builderYml",
      ["from: resources/playwright/", "to: playwright/"],
    ],
    [
      "agent-worker-paths.ts: worker 落点解析（agent-worker/dist/index.js）",
      "pathsTs",
      ["'agent-worker'", "'dist'", "'index.js'"],
    ],
    [
      "agent-worker-paths.ts: 随包浏览器目录解析（resourcesPath/playwright）",
      "pathsTs",
      ["'playwright'"],
    ],
    [
      "agent-worker-paths.ts: ELECTRON_RUN_AS_NODE 注入",
      "pathsTs",
      ["ELECTRON_RUN_AS_NODE"],
    ],
    [
      "release-desktop.yml: ACF_BUNDLE_PLAYWRIGHT=1（发布必须带浏览器）",
      "releaseYml",
      ["ACF_BUNDLE_PLAYWRIGHT: '1'"],
    ],
    [
      "release-desktop.yml: ACF_PLAYWRIGHT_REQUIRED=1（缺浏览器即硬失败）",
      "releaseYml",
      ["ACF_PLAYWRIGHT_REQUIRED: '1'"],
    ],
    [
      "bundle-agent-worker.cjs: 只装 chromium-headless-shell（bundle 体积纪律）",
      "bundleScript",
      ["chromium-headless-shell"],
    ],
    [
      "bundle-agent-worker.cjs: electron 走 stub alias（防 223MB 资产入包）",
      "bundleScript",
      ["alias: { electron:", "electron-stub"],
    ],
    [
      "bundle-agent-worker.cjs: packageRoot 契约文件复制（browsers.json/package.json）",
      "bundleScript",
      ["'browsers.json'", "'package.json'"],
    ],
    [
      ".gitignore: agent-worker 产物不入库（防 7MB bundle 被误 add）",
      "gitignore",
      ["apps/executor-desktop/resources/agent-worker/"],
    ],
    [
      ".gitignore: playwright 浏览器不入库（防 266MB 被误 add）",
      "gitignore",
      ["apps/executor-desktop/resources/playwright/"],
    ],
    ["desktop package.json: build 链含 build:agent-worker", "desktopPkg", ["build:agent-worker"]],
    [
      "desktop package.json: test:main 链含真 bundle 冒烟 selftest",
      "desktopPkg",
      ["agent-worker-process.selftest.js"],
    ],
    ["根 package.json: typecheck:desktop 覆盖 worker tsconfig", "rootPkg", ["tsconfig.worker.json"]],
    ["tsconfig.worker.json 存在（worker 面独立 typecheck）", "workerTsconfig", ["src/agent-worker"]],
    [
      "electron-stub 包存在（electron-stub/index.cjs + package.json）",
      "stubIndex",
      ["commandLine"],
    ],
    [
      "agent-worker-bundle.sha256 清单存在且含 source-digest 与字节行",
      "workerManifest",
      ["source-digest:"],
    ],
  ];
  return spec.map(([desc, fileKey, needles]) => ({
    desc,
    fileKey,
    needles,
    content: files?.[fileKey] ?? null,
  }));
}

/**
 * 读全部事实源（只读）。缺失的记 null。
 * @param {string} root 仓库根
 * @returns {Record<string, string|null>}
 */
export function loadFiles(root = process.cwd()) {
  const files = {};
  for (const [key, rel] of Object.entries(FACT_FILES)) {
    const abs = join(root, rel);
    files[key] = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }
  return files;
}

/**
 * 锚点判据（纯函数，不读盘）。
 *
 * @param {Record<string, string|null>} files
 * @returns {{errors: string[], anchors: number}}
 */
export function checkFiles(files) {
  const errors = [];
  const anchors = buildAnchors(files);
  for (const { desc, fileKey, needles, content } of anchors) {
    const rel = FACT_FILES[fileKey];
    if (content === null) {
      errors.push(`${desc} —— 文件不存在（${rel}）`);
      continue;
    }
    const hay = stripComments(content, commentStyleOf(rel));
    for (const needle of needles) {
      if (findNeedle(hay, needle) < 0) {
        errors.push(
          `${desc} —— 缺片段 ${JSON.stringify(needle)}（${rel}；改了一处忘其余？回看 N-06 的接线清单）`,
        );
      }
    }
  }

  // 字节行存在性（source-digest 之外的末行）：行首或换行后都算，注释行不算。
  if (files.workerManifest !== null && files.workerManifest !== undefined) {
    const manifest = stripComments(files.workerManifest, "hash");
    if (!/(?:^|\n)[0-9a-f]{64}[ \t]+\S/.test(manifest)) {
      errors.push(
        `${FACT_FILES.workerManifest} 缺末行字节哈希（应形如 '<64hex>  dist/index.js'）—— ` +
          "漂移闸 F-19 只能靠它在打包后比对。",
      );
    }
  }
  return { errors, anchors: anchors.length };
}

/**
 * 全量判据。
 *
 * @param {string} [root] 仓库根
 * @returns {{errors: string[], structure: string[], anchors: number, filesPresent: number}}
 *   `structure` = **判据本身不可信**（事实源整棵不在、锚点表被削），不是代码漂移。
 */
export function check(root = process.cwd()) {
  const structure = [];
  const files = loadFiles(root);
  const present = Object.entries(files).filter(([, v]) => v !== null);
  const { errors, anchors } = checkFiles(files);

  if (anchors < MIN_ANCHORS) {
    structure.push(
      `锚点表只剩 ${anchors} 条（下界 ${MIN_ANCHORS}）—— 删锚点不是修好，判据被削了。`,
    );
  }
  if (present.length < MIN_FACT_FILES) {
    const missing = Object.entries(files)
      .filter(([, v]) => v === null)
      .map(([k]) => FACT_FILES[k]);
    structure.push(
      `事实源缺失：只读到 ${present.length}/${Object.keys(FACT_FILES).length} 个文件` +
        `（下界 ${MIN_FACT_FILES}）—— 仓库根不对或 apps/executor-desktop 整棵不在：` +
        missing.join("、"),
    );
  }
  return { errors, structure, anchors, filesPresent: present.length };
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

const HEX64 = "904ffc29208c7f2496fa70adbf8e51b6d596a4fe72f0d150ce5b280606d436f3";

/** 一份「全齐」的 fixture：10 个事实源，18 条锚点全部命中。 */
function okFiles() {
  return {
    [FACT_FILES.builderYml]: [
      "appId: com.autocodeflow.executor-desktop",
      "extraResources:",
      "  # N-06①：Agent 托管子进程，必须经 extraResources 出 asar",
      "  - from: resources/agent-worker/",
      "    to: agent-worker/",
      "    filter:",
      '      - "**/*"',
      "  - from: resources/playwright/",
      "    to: playwright/",
      "",
    ].join("\n"),
    [FACT_FILES.pathsTs]: [
      "export function resolveAgentWorker(resourcesPath: string) {",
      "  const dir = join(resourcesPath, 'agent-worker', 'dist');",
      "  const entry = join(dir, 'index.js');",
      "  const browser = join(resourcesPath, 'playwright');",
      "  const env: NodeJS.ProcessEnv = { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' };",
      "  return { entry, browser, env };",
      "}",
      "",
    ].join("\n"),
    [FACT_FILES.releaseYml]: [
      "jobs:",
      "  build:",
      "    env:",
      "      ACF_BUNDLE_PLAYWRIGHT: '1'",
      "      ACF_PLAYWRIGHT_REQUIRED: '1'",
      "",
    ].join("\n"),
    [FACT_FILES.bundleScript]: [
      "const stub = path.join(__dirname, 'electron-stub');",
      "esbuild.buildSync({ bundle: true, alias: { electron: stub } });",
      "run(cli, ['install', 'chromium-headless-shell']);",
      "copy('browsers.json');",
      "copy('package.json');",
      "",
    ].join("\n"),
    [FACT_FILES.gitignore]: [
      "node_modules/",
      "apps/executor-desktop/resources/agent-worker/",
      "apps/executor-desktop/resources/playwright/",
      "",
    ].join("\n"),
    [FACT_FILES.desktopPkg]: JSON.stringify(
      {
        name: "executor-desktop",
        scripts: {
          "build:agent-worker": "node scripts/bundle-agent-worker.cjs",
          "build:main": "tsc -p tsconfig.json",
          "test:main": "npm run build:agent-worker && node dist-selftest/agent-worker-process.selftest.js",
        },
      },
      null,
      2,
    ),
    [FACT_FILES.rootPkg]: JSON.stringify(
      {
        name: "fixture",
        scripts: {
          "typecheck:desktop":
            "cd apps/executor-desktop && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.worker.json --noEmit",
        },
      },
      null,
      2,
    ),
    [FACT_FILES.workerTsconfig]: JSON.stringify({ include: ["src/agent-worker/**/*"] }, null, 2),
    [FACT_FILES.stubIndex]: [
      "module.exports = { app: { commandLine: { appendSwitch() {} } } };",
      "",
    ].join("\n"),
    [FACT_FILES.workerManifest]: [
      "# agent-worker bundle 清单",
      "#   · source-digest 行：bundle 输入源码的语义摘要",
      "source-digest: 3f26e393f55cf6175f3c9a2b13538a0ba96531a71572e4a8a9229556df41cbff",
      `${HEX64}  dist/index.js`,
      "",
    ].join("\n"),
  };
}

/** 覆盖若干事实源（路径 → 内容）；值为 null 表示「这个文件不存在」。 */
function tree(overrides = {}) {
  const files = okFiles();
  for (const [rel, content] of Object.entries(overrides)) {
    if (content === null) delete files[rel];
    else files[rel] = content;
  }
  return files;
}

/**
 * 自检：10 条子进程用例。
 *
 * 每条用例改**一处**接线，断言真脚本的退出码与关键文本——本守卫的历史事故形态
 * 全在 CLI 层（有没有 exit(1) / 文案是否还在）与判据的边界层（前缀、注释），
 * 抽函数在内存里断言对这两层都盲。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "agent-packaging-selftest-" });
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

  subprocess("① 合规树：10 个事实源、18 条锚点全命中 → 绿", tree(), {
    code: 0,
    contains: ["agent packaging 配置面一致", "18 条锚点"],
    absent: ["漂移", "结构错误", "✖"],
  });

  subprocess(
    "② 事实源整棵不在（空树）→ 结构红，不是 10 条「文件不存在」也不是绿",
    { "package.json": { name: "empty", private: true } },
    {
      code: 1,
      contains: ["结构错误", "事实源缺失", `下界 ${MIN_FACT_FILES}`],
      absent: ["配置面一致", "Error:", "ENOENT"],
    },
  );

  subprocess(
    "③ 单个事实源缺失（electron-builder.yml 不在）→ 红且点名文件",
    tree({ [FACT_FILES.builderYml]: null }),
    {
      code: 1,
      contains: ["electron-builder.yml", "文件不存在", "agent-worker extraResources"],
      absent: ["配置面一致"],
    },
  );

  subprocess(
    "④ 【反证·前缀误配】build:agent-worker 只剩 build:agent-worker2 → 红",
    tree({
      [FACT_FILES.desktopPkg]: JSON.stringify(
        {
          name: "executor-desktop",
          scripts: {
            "build:agent-worker2": "node scripts/bundle-agent-worker.cjs",
            "test:main": "npm run build:agent-worker2 && node dist-selftest/agent-worker-process.selftest.js",
          },
        },
        null,
        2,
      ),
    }),
    {
      code: 1,
      contains: ['缺片段 "build:agent-worker"'],
      absent: ["配置面一致"],
    },
  );

  subprocess(
    "⑤ 【反证·注释算数】.gitignore 两条改成注释 → 红（注释掉的忽略规则等于没写）",
    tree({
      [FACT_FILES.gitignore]: [
        "node_modules/",
        "#apps/executor-desktop/resources/agent-worker/",
        "#apps/executor-desktop/resources/playwright/",
        "",
      ].join("\n"),
    }),
    {
      code: 1,
      contains: ['缺片段 "apps/executor-desktop/resources/agent-worker/"'],
      absent: ["配置面一致"],
    },
  );

  subprocess(
    "⑥ 【反证·代码注释】ELECTRON_RUN_AS_NODE 只出现在 // 注释里 → 红",
    tree({
      [FACT_FILES.pathsTs]: [
        "export function resolveAgentWorker(resourcesPath: string) {",
        "  const dir = join(resourcesPath, 'agent-worker', 'dist');",
        "  const entry = join(dir, 'index.js');",
        "  const browser = join(resourcesPath, 'playwright');",
        "  // 旧实现：env.ELECTRON_RUN_AS_NODE = '1'（已移到 spawn 处，此处不应再需要）",
        "  return { entry, browser };",
        "}",
        "",
      ].join("\n"),
    }),
    {
      code: 1,
      contains: ['缺片段 "ELECTRON_RUN_AS_NODE"'],
      absent: ["配置面一致"],
    },
  );

  subprocess(
    "⑦ 【反证·needle 抠一行】builder 的 to: agent-worker/ 改成 to: agent-worker-old/ → 红",
    tree({
      [FACT_FILES.builderYml]: okFiles()[FACT_FILES.builderYml].replace(
        "    to: agent-worker/\n",
        "    to: agent-worker-old/\n",
      ),
    }),
    {
      code: 1,
      contains: ['缺片段 "to: agent-worker/"'],
      absent: ["配置面一致"],
    },
  );

  subprocess(
    "⑧ 漂移清单缺末行字节哈希 → 红（F-19 的比对锚点）",
    tree({ [FACT_FILES.workerManifest]: "# 清单\nsource-digest: aabb\n" }),
    {
      code: 1,
      contains: ["末行字节哈希", "dist/index.js"],
      absent: ["配置面一致"],
    },
  );

  subprocess(
    "⑨ 发布门被关掉（ACF_PLAYWRIGHT_REQUIRED: '0'）→ 红",
    tree({
      [FACT_FILES.releaseYml]: [
        "jobs:",
        "  build:",
        "    env:",
        "      ACF_BUNDLE_PLAYWRIGHT: '1'",
        "      ACF_PLAYWRIGHT_REQUIRED: '0'",
        "",
      ].join("\n"),
    }),
    {
      code: 1,
      contains: ['缺片段 "ACF_PLAYWRIGHT_REQUIRED: \'1\'"'],
      absent: ["配置面一致"],
    },
  );

  subprocess(
    "⑩ 字节行在清单首行 → 仍算数（旧正则要求前面有换行，会假红）",
    tree({ [FACT_FILES.workerManifest]: `${HEX64}  dist/index.js\nsource-digest: aabb\n` }),
    { code: 0, contains: ["配置面一致"], absent: ["末行字节哈希", "✖"] },
  );

  const failed = reportCases(cases, { title: "check-desktop-agent-packaging selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, "/").split("/").pop();

if (invoked === "check-desktop-agent-packaging.mjs") {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, structure, anchors, filesPresent } = check(root);

    if (structure.length > 0) {
      console.error("");
      console.error("✖ agent packaging 守卫结构错误（判据本身不可信，先修扫描面）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (errors.length > 0) {
      console.error(`✖ agent packaging 配置面漂移（${errors.length} 项）：`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }

    console.log(
      `✔ agent packaging 配置面一致（${anchors} 条锚点全命中，${filesPresent} 个事实源；注释不算接线）`,
    );
  }
}
