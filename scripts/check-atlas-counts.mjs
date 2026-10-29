#!/usr/bin/env node
/**
 * atlas 里**自述计数**与代码事实的守卫。
 *
 * 病还是同一个：**手写枚举/手写数字单向腐烂**。今天已经为四个接口面建了守卫
 * （CLI 命令表 / REST 全量附录 / 审计动作表 / MCP+域地图），但 atlas 的**结构描述**里还有一批
 * 「N 个 X」式的自述数字，它们同样会静静地过期 —— 本轮实测三处：
 *
 *   · `01-apps/admin-api/README.md`：「60 个 TypeORM 迁移」→ 实际 **103**；末尾迁移名也停在 1790000000015；
 *   · 同文件模块索引表：列了 **21** 行，而 `src/modules` 下有 **22** 个真实模块（漏了 `agent`）；
 *   · `atlas/README.md`：「7 个应用」→ 实际 7 ✓（这条是对的，守卫照样钉住它）。
 *
 * 判据（七项，均带规模下界）：
 *   ① 迁移数与**首尾文件名**必须与磁盘一致；
 *   ② 模块索引表的行必须**恰好等于** `src/modules` 下的真实模块集合（排除 `__tests__`）：
 *      漏行 = 真实模块没文档；多行 = 文档还在写一个已经不存在的模块；
 *   ③ `atlas/README.md` 的「N 个应用」必须等于 `apps/` 下真实应用数（排除非应用目录）；
 *   ④ 「（下一批次）」占位标记不得挂在**已存在**的文档上；
 *   ⑤ `07-testing/e2e-testing.md` 的「合计（入口口径）9 组 / 51 例」必须等于三份
 *      legacy spec 里**行首** `test(` / `test.only(` 声明数之和（排除 `test.skip(` 与注释）。
 *   ⑥ `07-testing/README.md` 的**测试数字表**（admin-api spec 文件数与 `it/test` 数、
 *      executor-node 两项、executor-python 两项、admin-web 文件数、`scripts/*selftest*` 数）
 *      必须等于现场，且口径**逐字照抄文档自己写的 8 条复核命令**（`find` / `grep -rhoE` / `ls`）；
 *   ⑦ 那 8 条「复核命令」必须**真的在文档里**，且每条命令旁的 `# 数字` 与表格数字一一对应
 *      ——「只写数不写出处」也算红。**不真跑命令**（慢、跨平台差异），只做文本层核对。
 *
 * ## ⑥⑦ 为什么必须存在（第 22 轮的反证）
 *
 * 把 `07-testing/README.md` 的 spec 数 / `it/test` 数 / selftest 数改回旧值，
 * 4 条验证命令 + `check-guards-wired` **全绿**：这几个数是**手写的**，描述的对象却由
 * 文件系统决定。⑥ 钉住「表格数字 = 现场」，⑦ 钉住「每个数字旁边有一行能复现它的命令」——
 * 后者防的是「只把数字改对、出处删掉」：下一轮没人知道该跑什么，于是又一次单向腐烂。
 *
 * 解析策略（与 ①③⑤ 同一条纪律）：表格行与命令块都**定点解析**，解析不到即**结构红**
 * （句子被改写 / 代码块被删 ≠ 数字没问题）；命令按**归一化后的整行**比对，改口径
 * （例如删掉 `--include=*.spec.ts`、把 `find` 换成 `ls`）同样是红，因为那已经不是同一个数。
 *
 * ## ⑤ 为什么是「e2e 例数」（第 5 轮的同一个腐烂点，换了个位置）
 *
 * `07-testing/e2e-testing.md` 2026-10-29 被整篇重写成 **51 例 / 9 组**（逐文件点数：
 * `e2e-full.spec.js` 48 + `e2e-python-executor.spec.js` 1 + `e2e-ui09-mobile.spec.js` 2）。
 * 但**没有任何守卫看过这个数**：把文档里的 51 改成 45，`check-docs` / `check-atlas-counts`
 * 全绿——和 ①③ 的病一模一样（数字是手写的，描述的对象却由代码/文件决定）。
 *
 * 判据的形状刻意「窄且硬」：
 *   · 只认**行首**的 `test(` / `test.only(`（允许缩进：三份 spec 里 19 例在 `describe`
 *     体内，按顶格数会漏成 29 例）；`test.skip(` / `test.fixme(` 是**跳过声明**，不算例数；
 *   · 注释里的 `test(` 不算，块注释先整段抹成空白（保留换行）再逐行点数；
 *   · 文档那行必须**整行解析得到**（`| **合计（入口口径）** | **9** | **51** | …`），
 *     解析不到即**结构红**——否则「句子被改写 → 没有可比的东西 → 永真」；
 *   · 组数（第 2 列）与例数（第 3 列）一起核对：它们是同一句话里的同一个断言，
 *     只钉一个等于让另一半继续手抄。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的三处假绿
 *
 *   · **数字前缀误配**：旧实现用 `doc.includes(`${n} 个 TypeORM 迁移`)`，于是文档写
 *     「**1122** 个 TypeORM 迁移」时，`includes("122 个 TypeORM 迁移")` 为真 —— 迁移数
 *     错了也报绿。现在要求数字**前后都不是数字**（`(?<!\d)122\s*\*{0,2}\s*个`）。
 *     应用数「17 个应用」冒充「7 个应用」是同一个洞。
 *   · **迁移名前缀误配**：旧实现 `doc.includes(name)`，`…-InitialSchema` 会被
 *     `…-InitialSchemaV2` 满足（文档停在旧名也绿）。现在要求名字后面不是 `[-\w]`。
 *   · **模块表只查漏、不查多**：旧实现只判 `缺行`，文档里留着一堆**已删除模块**的行
 *     依然绿 —— 与「模块索引表行数 = 真实模块数」的自述判据不符。现在双向判。
 *
 * 另外：四项判据的事实源（迁移目录 / modules 目录 / 文档文件）读不到时**显式红**，
 * 而不是让 readdirSync 抛栈 —— 「目录改名 → 零命中 → 一句 ✔」是本仓反复踩过的形态。
 *
 * 用法：`node scripts/check-atlas-counts.mjs [--selftest] [--root <dir>]`
 *   --selftest：跑真脚本的子进程（临时 fixture 树），逐条断言退出码 + 关键文本 + <1s。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const MIGRATIONS_DIR = "apps/admin-api/src/migrations";
export const MODULES_DIR = "apps/admin-api/src/modules";
export const ADMIN_DOC = "docs/atlas/01-apps/admin-api/README.md";
export const ATLAS_DOC = "docs/atlas/README.md";
export const APPS_DOC_DIR = "docs/atlas/01-apps";
export const E2E_DOC = "docs/atlas/07-testing/e2e-testing.md";
/**
 * 入口口径的三份 legacy spec（`playwright.e2e.config.js` 的 `testDir`
 * = `apps/admin-web/e2e/legacy`，`testMatch` 圈 `e2e-*.spec.js`）。
 * `apps/admin-web/e2e-full.spec.js`（顶层旧快照）与 `apps/admin-web/e2e/e2e-ui09-mobile.spec.js`
 * （同名副本）**都不在入口内**，绝不能拿来凑数（见 e2e-testing.md 开头那节）。
 */
export const E2E_SPECS = [
  "apps/admin-web/e2e/legacy/e2e-full.spec.js",
  "apps/admin-web/e2e/legacy/e2e-python-executor.spec.js",
  "apps/admin-web/e2e/legacy/e2e-ui09-mobile.spec.js",
];

/** 扫描面下界（2026-10-29 实测：迁移 122 / 模块 22 / 应用 7 / e2e 51 例）。只增不减，防「分母塌了」。 */
export const MIN_MIGRATION_FILES = 20;
export const MIN_MODULES = 10;
export const MIN_APPS = 5;
export const MIN_E2E_TESTS = 10;

/** ⑥⑦ 的文档：测试数字表 + 「上表数字的复核命令」代码块。 */
export const TESTING_DOC = "docs/atlas/07-testing/README.md";
/**
 * ⑦ 的下界：文档至少要给出 5 个「数字 + 复核命令」点。
 * 代码块被删/被截断时，⑦ 不会「零命中 → 一句 ✔」，而是直接红（防「只写数不写出处」）。
 */
export const MIN_DOC_NUMBER_SITES = 5;
/**
 * 每条测试数字扫描面的下界：**零命中即红**。
 *
 * 与 `MIN_MIGRATION_FILES` 不同，这里没法钉绝对值（fixture 与真仓库差两个数量级）；
 * 真正有齿的是「文档数字 = 现场数字」（⑥ 的等值比较）——路径改名后现场变 0，
 * 文档还写着 370，照样红。这条下界专门拦「文档也顺手改成 0」那种自残式对齐。
 */
export const MIN_TEST_COUNT = 1;

/** 与文档命令 `grep -rhoE '^\s*(it|test)\('` 同口径：行首（允许缩进）出现 `it(` / `test(` 的行。 */
export const CASE_LINE_RE = /^\s*(?:it|test)\(/;
/** 与文档命令 `grep -rhoE '^\s*def test_'` 同口径。 */
export const PY_TEST_LINE_RE = /^\s*def test_/;

/** 行首的用例声明：`test(` / `test.only(`（缩进允许，见文件头 ⑤）。 */
export const E2E_TEST_DECL_RE = /^test(?:\.only)?\s*\(/;
/** 跳过声明：`test.skip(` / `test.fixme(`（这些**不是**新用例，不能计入例数）。 */
export const E2E_SKIP_DECL_RE = /^test\.(?:skip|fixme)(?:\.[a-z]+)?\s*\(/;
/** describe 组：`describe(` / `test.describe(`（含 `.serial` / `.parallel`）。 */
export const E2E_GROUP_DECL_RE = /^(?:test\.)?describe(?:\.(?:serial|parallel))?\s*\(/;
/**
 * 合计那行：`| **合计（入口口径）** | **9** | **51** | **7** | …`
 * 捕获 `[1]` = describe 组数，`[2]` = `test()` 声明数。粗体、空白宽松；标签与列序不放宽
 * （这正是要钉的形状，改写即结构红）。
 */
export const E2E_TOTAL_ROW_RE = /^\|\s*\*\*合计（入口口径）\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/gm;

/** `apps/` 下不是应用的两个目录（测试产物）。 */
export const NON_APP_DIRS = new Set([".pytest-tmp", "test-results"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 文档是否声明了「<n> 个 <unit>」。
 *
 * 数字两侧都不许是数字：`.includes()` 会让「1122 个」满足「122 个」（T4 修掉的假绿）。
 * 允许 markdown 加粗（`**122** 个`）与任意空白。
 */
export function claimsCount(text, n, unit) {
  return new RegExp(`(?<!\\d)${n}\\s*\\*{0,2}\\s*个\\s*${escapeRe(unit)}`).test(text);
}

/** 文档是否提到该名字；名字后面不许紧跟标识符字符（防 `init` 被 `initial` 冒充）。 */
export function mentionsName(text, name) {
  return new RegExp(`${escapeRe(name)}(?![-\\w])`).test(text);
}

function readText(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const relOf = (root, abs) => relative(root, abs).split(sep).join("/");

const docMissing = (rel) => ({
  ok: false,
  out: [`✖ 读不到 ${rel} —— 文档路径/文件名变了，本判据已经瞎了（不是「文档没问题」）。`],
});

/* ① 迁移数 + 首尾 */
export function checkMigrationsClaim(root) {
  const files = listDir(join(root, MIGRATIONS_DIR))
    .filter(
      (d) =>
        d.isFile() &&
        d.name.endsWith(".ts") &&
        !d.name.endsWith(".spec.ts") &&
        !d.name.endsWith(".d.ts"),
    )
    .map((d) => d.name)
    .sort();
  if (files.length < MIN_MIGRATION_FILES) {
    return {
      ok: false,
      out: [
        `✖ 迁移目录只扫到 ${files.length} 个文件 —— 扫描器失效了（${MIGRATIONS_DIR}，下界 ${MIN_MIGRATION_FILES}）。`,
      ],
    };
  }
  const doc = readText(join(root, ADMIN_DOC));
  if (doc === null) return docMissing(ADMIN_DOC);
  const first = files[0].replace(/\.ts$/, "");
  const last = files[files.length - 1].replace(/\.ts$/, "");
  const problems = [];
  if (!claimsCount(doc, files.length, "TypeORM 迁移")) {
    problems.push(`文档未声明迁移数 ${files.length}`);
  }
  if (!mentionsName(doc, first)) problems.push(`文档未出现首个迁移 ${first}`);
  if (!mentionsName(doc, last)) problems.push(`文档未出现末个迁移 ${last}`);
  if (problems.length > 0) {
    return {
      ok: false,
      out: ["✖ atlas 迁移自述与实际不符：", ...problems.map((p) => "  · " + p)],
    };
  }
  return { ok: true, note: `✔ 迁移自述一致：${files.length} 个（${first} … ${last}）。` };
}

/* ② 模块索引表：真实模块集合 ↔ 表内行集合（双向） */
export function checkModuleTable(root) {
  const real = listDir(join(root, MODULES_DIR))
    .filter((d) => d.isDirectory() && d.name !== "__tests__")
    .map((d) => d.name);
  if (real.length < MIN_MODULES) {
    return {
      ok: false,
      out: [
        `✖ modules 目录只扫到 ${real.length} 个 —— 扫描器失效了（${MODULES_DIR}，下界 ${MIN_MODULES}）。`,
      ],
    };
  }
  const doc = readText(join(root, ADMIN_DOC));
  if (doc === null) return docMissing(ADMIN_DOC);
  // 只取「## 模块索引」这一节（到下一个二级标题为止）：后面的小节里也可能有
  // 首列是小写标识符的表格，混进来会污染行集合。
  const section = (doc.split("## 模块索引")[1] ?? "").split(/\n## /)[0];
  if (!section) {
    return { ok: false, out: ["✖ 找不到「## 模块索引」小节。"] };
  }
  const rows = section
    .split("\n")
    .filter((l) => /^\|\s*[a-z][a-z0-9-]*\s*\|/.test(l) && !l.startsWith("| 模块"));
  const listed = new Set(rows.map((l) => l.split("|")[1].trim()));
  const missing = real.filter((m) => !listed.has(m)).sort();
  const stale = [...listed].filter((m) => !real.includes(m)).sort();
  if (missing.length > 0) {
    return {
      ok: false,
      out: [
        "✖ 模块索引漏了真实模块：" + missing.join(", "),
        "  修法：在 docs/atlas/01-apps/admin-api/README.md 的模块索引补行；不要改守卫。",
      ],
    };
  }
  if (stale.length > 0) {
    return {
      ok: false,
      out: [
        "✖ 模块索引列了**不存在**的模块：" + stale.join(", "),
        "  修法：删掉这些行（模块已删/改名），或把模块目录补回来；不要改守卫。",
      ],
    };
  }
  return {
    ok: true,
    note: `✔ 模块索引一致：${real.length} 个真实模块全部在表内（表内 ${listed.size} 行）。`,
  };
}

/* ③ apps 数自述 */
export function checkAppsCount(root) {
  const apps = listDir(join(root, "apps"))
    .filter((d) => d.isDirectory() && !NON_APP_DIRS.has(d.name))
    .map((d) => d.name);
  if (apps.length < MIN_APPS) {
    return {
      ok: false,
      out: [`✖ apps 目录只扫到 ${apps.length} 个 —— 扫描器失效了（下界 ${MIN_APPS}）。`],
    };
  }
  const doc = readText(join(root, ATLAS_DOC));
  if (doc === null) return docMissing(ATLAS_DOC);
  if (!claimsCount(doc, apps.length, "应用")) {
    return {
      ok: false,
      out: [
        `✖ atlas/README.md 未声明「${apps.length} 个应用」（实际 apps/ 下有 ${apps.length} 个：${apps.join(", ")}）。`,
      ],
    };
  }
  return { ok: true, note: `✔ 应用数自述一致：${apps.length} 个。` };
}

/* ④ 「（下一批次）」占位标记：文件已存在就不该再挂这个标记 */
export function checkPendingMarkers(root) {
  const docDir = join(root, APPS_DOC_DIR);
  if (!existsSync(docDir)) {
    return {
      ok: false,
      out: [`✖ 文档目录不存在：${APPS_DOC_DIR} —— 目录改名后本判据会零命中，那是假绿。`],
    };
  }
  const stale = [];
  const walk = (dir) => {
    for (const d of listDir(dir)) {
      const p = join(dir, d.name);
      if (d.isDirectory()) {
        walk(p);
        continue;
      }
      if (!d.name.endsWith(".md")) continue;
      const text = readText(p) ?? "";
      for (const m of text.matchAll(/\]\(([^)]+\.md)\)（下一批次）/g)) {
        if (existsSync(join(dirname(p), m[1]))) stale.push(relOf(root, p) + " → " + m[1]);
      }
    }
  };
  walk(docDir);
  if (stale.length > 0) {
    return {
      ok: false,
      out: [
        `✖ ${stale.length} 处「（下一批次）」标记挂在**已存在**的文档上（读者会以为还没写）：`,
        ...stale.map((s) => "  · " + s),
        "  修法：删掉标记（文档已经写好了）。",
      ],
    };
  }
  return { ok: true, note: "✔ 无「（下一批次）」占位标记挂在已有文档上。" };
}

/**
 * 把 `/* … *​/` 块注释抹成空白（保留换行，行号不变）。
 *
 * 只为 ⑤ 服务：注释里的 `test(` 不是用例声明（`// test('死用例')` 由「trim 后以 `//` 开头」
 * 跳过；块注释跨行，逐行判断不了，所以先整段抹掉）。
 *
 * **`//` 之后的 `/*` 不算块注释起点**——这不是洁癖，是实仓踩到的坑：
 * `e2e-full.spec.js` 第 5 行的路径注释里写着 `apps/admin-web/e2e/*.spec.ts`，
 * 朴素的「见 `/*` 就开块」会从那里一直吞到下一个块注释收尾（约 8 万字符、42 个 `test(`），
 * 实测只剩 6 例。所以块注释只在「本行此前没有 `//`」时才开——行注释本身由下面的 trim 判定跳过。
 * 字符串里的 `/*` 仍可能误开块：方向是**少数**（红），不会多数（假绿）。
 */
export function stripBlockComments(src) {
  let out = "";
  let i = 0;
  let lineStart = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      lineStart = i + 1;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*" && !src.slice(lineStart, i).includes("//")) {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") {
          lineStart = i + 1;
          out += "\n";
        } else {
          out += " ";
        }
        i += 1;
      }
      i += 2;
      out += "  ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 点一份 spec 的「行首声明数」：`{ tests, groups, skips }`。
 *
 * `tests` 只收 `test(` / `test.only(`（允许缩进——19 例在 describe 体内）；
 * `skips` 单列 `test.skip(` / `test.fixme(`，只用于输出与自检反证，**不进合计**。
 */
export function countSpecCases(text) {
  let tests = 0;
  let groups = 0;
  let skips = 0;
  for (const raw of stripBlockComments(text).split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    if (E2E_TEST_DECL_RE.test(line)) tests += 1;
    else if (E2E_SKIP_DECL_RE.test(line)) skips += 1;
    else if (E2E_GROUP_DECL_RE.test(line)) groups += 1;
  }
  return { tests, groups, skips };
}

/** 三份 spec 的逐份例数（只留文件名）；绿字与红字共用，保证「是哪份变了」一眼可见。 */
const e2eBreakdown = (per) =>
  per.map((p) => `${p.file.split("/").pop()} ${p.tests} 例`).join(" + ");

/* ⑤ 三份 legacy spec 的例数 ↔ e2e-testing.md 的「合计（入口口径）」行 */
export function checkE2eCaseCount(root) {
  const per = [];
  const unreadable = [];
  for (const rel of E2E_SPECS) {
    const text = readText(join(root, rel));
    if (text === null) {
      unreadable.push(rel);
      continue;
    }
    per.push({ file: rel, ...countSpecCases(text) });
  }
  if (unreadable.length > 0) {
    return {
      ok: false,
      out: [
        `✖ 读不到 e2e spec：${unreadable.join(", ")} —— 文件改名/删除后本判据零命中（不是「例数没问题」）。`,
        "  修法：把 docs/atlas/07-testing/e2e-testing.md 的入口口径与真实 spec 对齐；不要改守卫。",
      ],
    };
  }
  const tests = per.reduce((n, p) => n + p.tests, 0);
  const groups = per.reduce((n, p) => n + p.groups, 0);
  if (tests < MIN_E2E_TESTS) {
    return {
      ok: false,
      out: [
        `✖ 三份 legacy spec 只点到 ${tests} 个 \`test(\` 声明（下界 ${MIN_E2E_TESTS}）—— 解析器失效了，不是用例变少了。`,
        `  明细：${e2eBreakdown(per)}`,
      ],
    };
  }

  const doc = readText(join(root, E2E_DOC));
  if (doc === null) return docMissing(E2E_DOC);
  const hits = [...doc.matchAll(E2E_TOTAL_ROW_RE)];
  if (hits.length === 0) {
    return {
      ok: false,
      out: [
        `✖ 解析不到「| **合计（入口口径）** | **${groups}** | **${tests}** |」这一行（${E2E_DOC}）——`,
        "   句子被改写/删掉后数字就没人核对，本判据会永真变绿。",
        `  实测：${e2eBreakdown(per)} = ${tests} 例 / ${groups} 组。`,
        "  修法：把这行原样补回（见文件头 ⑤ 的列序），不要改守卫。",
      ],
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      out: [
        `✖ 「合计（入口口径）」行在 ${E2E_DOC} 里出现 ${hits.length} 次 —— 不知道该信哪行；只保留一处。`,
      ],
    };
  }
  const docGroups = Number(hits[0][1]);
  const docTests = Number(hits[0][2]);
  if (docGroups !== groups || docTests !== tests) {
    const wrong = [];
    if (docTests !== tests) wrong.push(`例数 文档写 ${docTests} / 实际 ${tests}`);
    if (docGroups !== groups) wrong.push(`组数 文档写 ${docGroups} / 实际 ${groups}`);
    return {
      ok: false,
      out: [
        `✖ e2e 例数自述与实际不符：${wrong.join("；")}。`,
        `  实际明细：${e2eBreakdown(per)} = ${tests} 例 / ${groups} 组（入口口径：三份 legacy spec 的行首 test( / test.only( 声明，排除 test.skip( 与注释）。`,
        "  修法：改 docs/atlas/07-testing/e2e-testing.md 的合计行；不要改守卫。",
      ],
    };
  }
  return {
    ok: true,
    note: `✔ e2e 例数自述一致：${tests} 例 / ${groups} 组（${e2eBreakdown(per)}）。`,
  };
}

/* ── ⑥⑦：`07-testing/README.md` 的测试数字表 + 复核命令块 ─────────────────── */

/** 读文件字节；读不到返回 null（二进制判定需要原始字节）。 */
function readBytes(abs) {
  try {
    return readFileSync(abs);
  } catch {
    return null;
  }
}

/**
 * 递归列出 `relDir` 下的普通文件（仓库相对路径，`/` 分隔）。
 *
 * 与 `find` 的差别只有一处：不跟随符号链接（`Dirent.isDirectory()` 对链接为 false，
 * 于是链接既不当目录递归、也不当文件计数——`find` 同款）。目录不存在 → `[]`。
 */
export function walkFiles(root, relDir) {
  const out = [];
  const walk = (rel) => {
    for (const d of listDir(join(root, rel))) {
      const childRel = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(childRel);
      else if (d.isFile()) out.push(childRel);
    }
  };
  walk(relDir);
  return out;
}

/**
 * 在一批文件里数「匹配行数」（= `grep -rhoE '<re>' <文件…>` 的行数口径）。
 *
 * 含 NUL 的文件按二进制跳过：`grep -o` 对二进制文件不输出匹配行（会说
 * `Binary file … matches`），若把 `.pyc` 数进去，`executor-python` 那条会虚高。
 */
export function countMatchedLines(root, rels, re) {
  let n = 0;
  for (const rel of rels) {
    const buf = readBytes(join(root, rel));
    if (buf === null || buf.includes(0)) continue;
    for (const line of buf.toString("utf8").split("\n")) {
      if (re.test(line)) n += 1;
    }
  }
  return n;
}

/**
 * ⑥⑦ 的事实源：**逐条复刻文档正文里那 8 条复核命令的口径**（见 `TEST_CLAIMS[].cmd`）。
 *
 * 刻意不另立口径（例如「递归数所有目录」）：一旦实现与文档写的命令不是同一个数，
 * 守卫就会逼着人改文档去迁就实现，反过来也一样。
 */
export function collectTestFacts(root) {
  const facts = {};
  const problems = [];
  const set = (key, label, hint, value) => {
    facts[key] = value;
    if (value < MIN_TEST_COUNT) {
      problems.push(
        `✖ 扫描面零命中：${label}（下界 ${MIN_TEST_COUNT}）——命令是 \`${hint}\`；` +
          "目录改名/后缀变了，或者解析面失效了。这不是「数字都对」。",
      );
    }
  };

  const adminSrc = walkFiles(root, "apps/admin-api/src");
  const adminSpecs = adminSrc.filter((r) => r.includes("__tests__") && r.endsWith(".spec.ts"));
  set(
    "adminApiSpecFiles",
    "admin-api 的 spec 文件",
    "find apps/admin-api/src -path '*__tests__*' -name '*.spec.ts'",
    adminSpecs.length,
  );
  // ⚠ 两条命令的**范围不同**：文件数那条带 `-path '*__tests__*'`，用例数那条没有
  // （`--include=*.spec.ts` 扫整个 `src`，同目录放置的 `*.spec.ts` 也算）。实测忽略这
  // 一点会少 306 处（370 个文件里只有一部分在 `__tests__` 下）。照抄口径，不「统一」它。
  const adminAllSpecs = adminSrc.filter((r) => r.endsWith(".spec.ts"));
  set(
    "adminApiCases",
    "admin-api 的 it/test 声明",
    "grep -rhoE '^\\s*(it|test)\\(' apps/admin-api/src --include=*.spec.ts",
    countMatchedLines(root, adminAllSpecs, CASE_LINE_RE),
  );

  const nodeSpecs = walkFiles(root, "apps/executor-node/src").filter((r) => r.endsWith(".spec.ts"));
  set(
    "executorNodeSpecFiles",
    "executor-node 的 spec 文件",
    "find apps/executor-node/src -name '*.spec.ts'",
    nodeSpecs.length,
  );
  set(
    "executorNodeCases",
    "executor-node 的 it/test 声明",
    "grep -rhoE '^\\s*(it|test)\\(' apps/executor-node/src --include=*.spec.ts",
    countMatchedLines(root, nodeSpecs, CASE_LINE_RE),
  );

  // `ls apps/executor-python/tests/test_*.py`：**只数该目录下这一层**（不递归）。
  const pyTestsDir = "apps/executor-python/tests";
  const pyTestFiles = listDir(join(root, pyTestsDir))
    .filter((d) => d.isFile() && /^test_.*\.py$/.test(d.name))
    .map((d) => `${pyTestsDir}/${d.name}`)
    .sort();
  set(
    "executorPythonTestFiles",
    "executor-python 的测试文件",
    "ls apps/executor-python/tests/test_*.py",
    pyTestFiles.length,
  );
  // `grep -rhoE '^\s*def test_' apps/executor-python/tests`：**递归且不限后缀**
  // （所以 `__pycache__/*.pyc` 要靠二进制跳过排除，见 `countMatchedLines`）。
  set(
    "executorPythonCases",
    "executor-python 的 def test_",
    "grep -rhoE '^\\s*def test_' apps/executor-python/tests",
    countMatchedLines(root, walkFiles(root, pyTestsDir), PY_TEST_LINE_RE),
  );

  const webTests = walkFiles(root, "apps/admin-web/src/__tests__").filter((r) =>
    r.split("/").pop().includes(".test.ts"),
  );
  set(
    "adminWebTestFiles",
    "admin-web 的测试文件",
    "find apps/admin-web/src/__tests__ -name '*.test.ts*'",
    webTests.length,
  );

  // `ls scripts/*selftest*`：该目录这一层、文件名含 `selftest`（`check-desktop-selftests-wired.mjs` 也算）。
  const selftests = listDir(join(root, "scripts")).filter(
    (d) => d.isFile() && d.name.includes("selftest"),
  );
  set(
    "scriptsSelftestFiles",
    "scripts/*selftest* 文件",
    "ls scripts/*selftest*",
    selftests.length,
  );

  return { facts, problems };
}

/**
 * ⑥ 的 8 个数字点。每条都有：
 *   · `tableRe`：**定点**匹配表格里那一行的那个数字（解析不到 = 结构红）；
 *   · `cmd`：文档「上表数字的复核命令」代码块里应出现的那条命令（归一化后整行比对）；
 *   · `key`：对应 `collectTestFacts` 的事实。
 *
 * 只取任务点名的那 8 个数（admin-api spec/it、executor-node ×2、executor-python ×2、
 * admin-web、scripts selftest）。同表的 packages/registry-pypi 等行不在本判据范围内。
 */
export const TEST_CLAIMS = [
  {
    key: "adminApiSpecFiles",
    label: "admin-api spec 文件数",
    tableRe: /^\|\s*admin-api 单测\s*\|[^\n]*?（\s*(\d+)\s*个\s*`\*\.spec\.ts`\s*）/m,
    desc: "表格「admin-api 单测」行的「N 个 `*.spec.ts`」",
    cmd: "find apps/admin-api/src -path '*__tests__*' -name '*.spec.ts' | wc -l",
  },
  {
    key: "adminApiCases",
    label: "admin-api it/test 数",
    tableRe: /^\|\s*admin-api 单测\s*\|[^\n]*`it\/test`\s*(\d+)\s*处/m,
    desc: "表格「admin-api 单测」行的「`it/test` N 处」",
    cmd: "grep -rhoE '^\\s*(it|test)\\(' apps/admin-api/src --include=*.spec.ts | wc -l",
  },
  {
    key: "executorNodeSpecFiles",
    label: "executor-node spec 文件数",
    tableRe: /^\|\s*executor-node\s*\|[^\n]*?（\s*(\d+)\s*个\s*`\*\.spec\.ts`\s*）/m,
    desc: "表格「executor-node」行的「N 个 `*.spec.ts`」",
    cmd: "find apps/executor-node/src -name '*.spec.ts' | wc -l",
  },
  {
    key: "executorNodeCases",
    label: "executor-node it/test 数",
    tableRe: /^\|\s*executor-node\s*\|[^\n]*`it\/test`\s*(\d+)\s*处/m,
    desc: "表格「executor-node」行的「`it/test` N 处」",
    cmd: "grep -rhoE '^\\s*(it|test)\\(' apps/executor-node/src --include=*.spec.ts | wc -l",
  },
  {
    key: "executorPythonTestFiles",
    label: "executor-python 测试文件数",
    tableRe: /^\|\s*executor-python\s*\|[^\n]*?（\s*(\d+)\s*个\s*`test_\*\.py`\s*）/m,
    desc: "表格「executor-python」行的「N 个 `test_*.py`」",
    cmd: "ls apps/executor-python/tests/test_*.py | wc -l",
  },
  {
    key: "executorPythonCases",
    label: "executor-python def test_ 数",
    tableRe: /^\|\s*executor-python\s*\|[^\n]*`def test_`\s*(\d+)\s*个/m,
    desc: "表格「executor-python」行的「`def test_` N 个」",
    cmd: "grep -rhoE '^\\s*def test_' apps/executor-python/tests | wc -l",
  },
  {
    key: "adminWebTestFiles",
    label: "admin-web 测试文件数",
    tableRe: /^\|\s*admin-web\s*\|[^\n]*?（\s*(\d+)\s*个\s*`\*\.test\.ts\/tsx`\s*）/m,
    desc: "表格「admin-web」行的「N 个 `*.test.ts/tsx`」",
    cmd: "find apps/admin-web/src/__tests__ -name '*.test.ts*' | wc -l",
  },
  {
    key: "scriptsSelftestFiles",
    label: "scripts 自测文件数",
    tableRe: /^\|\s*自测\/真机脚本\s*\|[^\n]*?（\s*(\d+)\s*个\s*）/m,
    desc: "表格「自测/真机脚本」行的「N 个」",
    cmd: "ls scripts/*selftest* | wc -l",
  },
];

/** 归一化命令文本：只把空白折叠成单空格（对齐用的空格不算口径差异，改词才算）。 */
export const normalizeCmd = (s) => s.trim().replace(/\s+/g, " ");

/**
 * 取出围栏代码块里的命令条目：`{ cmd, number }`。
 *
 * 命令行的形状是「命令 + 若干空格 + `# 数字`」（见文档「上表数字的复核命令」）。
 * 注释号后面的数字**必须**在行首（`# 370` / `# 921（async def 另 142）` 都认），
 * 没有数字的行也收（`number: null`），这样「命令还在、数字被删」也能被点名。
 */
export function extractFencedCommands(text) {
  const out = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^(.+?)\s+#\s*(\d+)/);
    out.push(m ? { cmd: m[1].trim(), number: Number(m[2]) } : { cmd: line, number: null });
  }
  return out;
}

/** 在文档里定点取一个数字：命中 0 次 → 结构红；命中多次 → 不知道该信哪行。 */
function tableNumberOf(doc, re) {
  const hits = [...doc.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))];
  if (hits.length === 0) return { error: "解析不到这个数字（句子被改写了？）" };
  if (hits.length > 1) return { error: `同一个数字点解析到 ${hits.length} 处，不知道该信哪一处` };
  return { value: Number(hits[0][1]) };
}

/* ⑥ 测试数字表 ↔ 现场 */
export function checkTestingTable(root) {
  const { facts, problems } = collectTestFacts(root);
  if (problems.length > 0) {
    return {
      ok: false,
      out: [
        ...problems,
        "  修法：先确认目录/后缀没变（`07-testing/README.md` 的复核命令就是口径）；扫描面塌了不等于数字都对。",
      ],
    };
  }
  const doc = readText(join(root, TESTING_DOC));
  if (doc === null) return docMissing(TESTING_DOC);
  const bad = [];
  for (const claim of TEST_CLAIMS) {
    const parsed = tableNumberOf(doc, claim.tableRe);
    if (parsed.error) {
      bad.push(`✖ ${claim.label}｜${claim.desc}：${parsed.error}`);
      continue;
    }
    const actual = facts[claim.key];
    if (parsed.value !== actual) {
      bad.push(
        `✖ ${claim.label}：文档写「${parsed.value}」，实际「${actual}」（${claim.cmd}）。`,
      );
    }
  }
  if (bad.length > 0) {
    return {
      ok: false,
      out: [
        "✖ 07-testing/README.md 的测试数字与现场不符（或已无法解析）：",
        ...bad.map((b) => "  " + b),
        "  修法：改文档表格里的数字（口径见同文件的「上表数字的复核命令」）；不要改守卫。",
      ],
    };
  }
  const pairs = TEST_CLAIMS.map((c) => `${facts[c.key]}`).join(" / ");
  return { ok: true, note: `✔ 测试数字自述一致：${pairs}（8 个数字点，口径 = 文档那 8 条复核命令）。` };
}

/* ⑦ 「复核命令」必须在文档里，且命令旁的数字与表格/现场一一对应（不真跑命令） */
export function checkTestingCommands(root) {
  const doc = readText(join(root, TESTING_DOC));
  if (doc === null) return docMissing(TESTING_DOC);
  const { facts } = collectTestFacts(root);
  const commands = extractFencedCommands(doc);
  const problems = [];
  let points = 0;

  for (const claim of TEST_CLAIMS) {
    const expected = normalizeCmd(claim.cmd);
    const hits = commands.filter((c) => normalizeCmd(c.cmd) === expected);
    const table =
      facts[claim.key] === undefined
        ? tableNumberOf(doc, claim.tableRe)
        : { value: facts[claim.key] };
    if (hits.length === 0) {
      problems.push(
        `✖ ${claim.label}｜复核命令缺失：${claim.desc} 旁边只有数字，没有能复现它的命令。`,
        `  期望原文（整行，含 \`# 数字\`）：${claim.cmd}    # ${table.value ?? "…"}`,
        "  修法：把命令原样补回「上表数字的复核命令」代码块；只写数不写出处 = 下一轮没人能复现。",
      );
      continue;
    }
    if (hits.length > 1) {
      problems.push(
        `✖ ${claim.label}｜同一条复核命令在文档里出现 ${hits.length} 次 —— 不知道该信哪个数字；只保留一处。`,
      );
      continue;
    }
    const entry = hits[0];
    if (entry.number === null) {
      problems.push(
        `✖ ${claim.label}｜复核命令没有写结果数字：\`${claim.cmd}\` 后面缺 \`# 数字\`。`,
        "  修法：命令旁补 `# 现场数字`（与表格同一个数），否则命令只是装饰。",
      );
      continue;
    }
    points += 1;
    if (table.error) {
      problems.push(
        `✖ ${claim.label}｜命令旁写「${entry.number}」，但表格里的数字${table.error}`,
        "  修法：让表格与命令两侧同时可解析、且是同一个数。",
      );
      continue;
    }
    if (entry.number !== table.value) {
      problems.push(
        `✖ ${claim.label}｜命令旁写「${entry.number}」，表格写「${table.value}」—— 同一个数两处不一致。`,
        `  修法：两处都改成现场值（${claim.cmd} 的输出）；不要只改一处。`,
      );
    }
  }

  if (points < MIN_DOC_NUMBER_SITES) {
    problems.unshift(
      `✖ 只解析到 ${points} 个「数字 + 复核命令」点（下界 ${MIN_DOC_NUMBER_SITES}）——`,
      `  命令代码块被删/被截断了吧？「上表数字的复核命令」整块必须留在 ${TESTING_DOC} 里。`,
    );
  }

  if (problems.length > 0) return { ok: false, out: problems };
  return {
    ok: true,
    note: `✔ 复核命令与数字一一对应：${points} 个数字点各带一条可执行命令（文本层核对，未真跑）。`,
  };
}

/** 七项判据的聚合；`root` 是仓库根（selftest 传 fixture 树）。 */
export function check(root) {
  return [
    checkMigrationsClaim(root),
    checkModuleTable(root),
    checkAppsCount(root),
    checkPendingMarkers(root),
    checkE2eCaseCount(root),
    checkTestingTable(root),
    checkTestingCommands(root),
  ];
}

// ── 自检（T4：全部跑真脚本子进程，断言退出码 + 关键文本）───────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

// fixture 的事实源：22 个迁移 / 12 个模块 / 6 个应用（都过下界）。
const MIG = Array.from({ length: 22 }, (_, i) => `${1717473142678 + i}-M${String(i).padStart(2, "0")}`);
const MODULES = [
  "auth", "users", "api-keys", "application", "project", "audit",
  "health", "config", "metrics", "task", "scheduler", "agent",
];
const APPS = ["admin-api", "admin-web", "executor-node", "executor-python", "executor-desktop", "acf-cli"];

const claimLine = (n, first = MIG[0], last = MIG[MIG.length - 1]) =>
  `| \`migrations/\` | **${n}** 个 TypeORM 迁移（\`${first}\` 起，\`${last}\` 止） |`;

const adminDoc = ({ modules = MODULES, claim = claimLine(MIG.length), extraRows = [], omitRow = null } = {}) => {
  const rows = modules.filter((m) => m !== omitRow).concat(extraRows);
  return [
    "# admin-api 应用总览",
    "",
    "## 模块索引（src/modules 下全部真实模块）",
    "",
    "| 模块 | 一句话职责 | 文档 |",
    "|---|---|---|",
    ...rows.map((m) => `| ${m} | 职责 | [${m}](modules/${m}.md) |`),
    "",
    "## 运行要素",
    "",
    "| 目录 | 说明 |",
    "|---|---|",
    claim,
    "",
  ].join("\n");
};

const atlasDoc = ({ apps = APPS } = {}) =>
  [
    "# AutoCodeFlow 知识图谱",
    "",
    "```",
    "docs/",
    "├── 00-overview/",
    `├── 01-apps/                           ← ${apps.length} 个应用逐一拆解`,
    "```",
    "",
  ].join("\n");

/**
 * 一份 spec 的合成源：`groups` 个 describe，共 `count` 个 `test(` 声明（前 `skips` 例体内
 * 带一行 `test.skip(`），并可掺入注释掉的 `test(`（注释**不该**被点数）。
 */
function specSource({ count, groups = 1, skips = 0, only = 0, deadComment = false } = {}) {
  const lines = [
    'const { test, expect } = require("@playwright/test");',
    // 实仓第 5 行就是这个形状（行注释里的路径带 `/*`）——它必须不被当成块注释起点。
    "// 权威套件在 apps/admin-web/e2e/*.spec.ts，本文件只跑根级全链",
    "",
  ];
  if (deadComment) {
    lines.push("// test('注释掉的用例，不算数', async () => {});", "/*", "test('块注释里的用例，也不算数', async () => {});", "*/", "");
  }
  let n = 0;
  for (let g = 0; g < groups; g += 1) {
    lines.push(`describe('group ${g + 1}', () => {`);
    while (n < count && n < Math.ceil((count * (g + 1)) / groups)) {
      lines.push(`  ${n < only ? "test.only" : "test"}('case ${n + 1}', async ({ page }) => {`);
      lines.push("    expect(page).toBeTruthy();");
      if (n < skips) lines.push("    test.skip(!process.env.SEED, '未 seed 时跳过');");
      lines.push("  });");
      n += 1;
    }
    lines.push("});", "");
  }
  return lines.join("\n");
}

// fixture 的 e2e 事实源：48 + 1 + 2 = 51 例 / 7 + 1 + 1 = 9 组（与真实仓库同口径），
// 并掺入 7 处 `test.skip(`（5 / 1 / 1）与注释掉的 `test(`——它们都不许被点数。
const E2E_FIXTURE = {
  [E2E_SPECS[0]]: { count: 48, groups: 7, skips: 5, deadComment: true },
  [E2E_SPECS[1]]: { count: 1, groups: 1, skips: 1 },
  [E2E_SPECS[2]]: { count: 2, groups: 1, skips: 1, only: 1 },
};

/** `07-testing/e2e-testing.md` 的最小形态：只需要「合计（入口口径）」那行 + 一张明细表。 */
const e2eDoc = ({ groups = 9, tests = 51, totalRow = null } = {}) =>
  [
    "# 全链 E2E 测试（根级 Playwright）",
    "",
    "## 用例总数（逐文件静态点数）",
    "",
    "| spec（均在 `apps/admin-web/e2e/legacy/`） | describe 组 | `test()` 声明 | 条件 `test.skip()` | 说明 |",
    "|---|---|---|---|---|",
    "| `e2e-full.spec.js` | 7 | **48** | 5 | 编号 1–47 连续 + 1 个 `E-3` |",
    "| `e2e-python-executor.spec.js` | 1 | **1** | 1 | 整组条件跳 |",
    "| `e2e-ui09-mobile.spec.js` | 1 | **2** | 1 | 用例体内条件跳 |",
    totalRow ?? `| **合计（入口口径）** | **${groups}** | **${tests}** | **7** | 别名：顶层 29 + 7 组 19 |`,
    "",
    "默认实跑的用例数（不是声明数）：CI 基线 50 例。",
    "",
  ].join("\n");

/**
 * ⑥⑦ 的 fixture 事实源：admin-api 3 个 `__tests__` 下的 spec + 1 个同目录放置的
 * `*.spec.ts`（共 5 处 `it(`——文件数与用例数两条命令**范围不同**，见 `collectTestFacts`），
 * executor-node 2 / 3，
 * executor-python 2 个文件 / 5 个 `def test_`（含 1 处 `async def test_` 与 1 个
 * `__pycache__/*.pyc` 二进制哨兵——都**不许**计入），admin-web 2 个文件，scripts 6 个 selftest。
 */
const TESTING_FIXTURE = {
  adminApiSpecFiles: 3,
  adminApiCases: 5,
  executorNodeSpecFiles: 2,
  executorNodeCases: 3,
  executorPythonTestFiles: 2,
  executorPythonCases: 5,
  adminWebTestFiles: 2,
  scriptsSelftestFiles: 6,
};

/** fixture 里那 8 条复核命令（**逐字**照抄真文档的口径，只把数字换成 fixture 的）。 */
const TESTING_CMDS = [
  { key: "adminApiSpecFiles", cmd: "find apps/admin-api/src -path '*__tests__*' -name '*.spec.ts' | wc -l" },
  { key: "adminApiCases", cmd: "grep -rhoE '^\\s*(it|test)\\(' apps/admin-api/src --include=*.spec.ts | wc -l" },
  { key: "executorNodeSpecFiles", cmd: "find apps/executor-node/src -name '*.spec.ts' | wc -l" },
  { key: "executorNodeCases", cmd: "grep -rhoE '^\\s*(it|test)\\(' apps/executor-node/src --include=*.spec.ts | wc -l" },
  { key: "executorPythonTestFiles", cmd: "ls apps/executor-python/tests/test_*.py | wc -l" },
  { key: "executorPythonCases", cmd: "grep -rhoE '^\\s*def test_' apps/executor-python/tests | wc -l" },
  { key: "adminWebTestFiles", cmd: "find apps/admin-web/src/__tests__ -name '*.test.ts*' | wc -l" },
  { key: "scriptsSelftestFiles", cmd: "ls scripts/*selftest* | wc -l" },
];

/**
 * `07-testing/README.md` 的最小形态：**照抄真文档的措辞结构**（表格行 + 带 `# 数字`
 * 注释的 bash 块），这样 selftest 走的就是真文档会走的正则路径。
 *
 * `values` 改表格数字，`cmdNumbers` 只改命令旁的数字（造「两处不一致」），
 * `drop` 删某条命令（造「只写数不写出处」），`omitCommands` 整块删（造结构红）。
 */
const testingDoc = ({ values = {}, cmdNumbers = {}, drop = [], omitCommands = false } = {}) => {
  const v = { ...TESTING_FIXTURE, ...values };
  const lines = [
    "# 测试体系总览",
    "> 所属: docs/atlas/07-testing · 最后核对: 2026-10-30",
    "",
    "| 层 | 位置 | 规模（静态核实） | 运行命令 |",
    "|---|---|---|---|",
    `| admin-api 单测 | \`apps/admin-api/src/**/__tests__\`（${v.adminApiSpecFiles} 个 \`*.spec.ts\`） | jest，\`it/test\` ${v.adminApiCases} 处（静态统计，实跑数以 CI 输出为准） | \`npm run test:api\` |`,
    `| executor-node | \`apps/executor-node/src\`（${v.executorNodeSpecFiles} 个 \`*.spec.ts\`） | jest，\`it/test\` ${v.executorNodeCases} 处（静态） | \`npm run test:node\` |`,
    `| executor-python | \`apps/executor-python/tests/\`（${v.executorPythonTestFiles} 个 \`test_*.py\`） | pytest，\`def test_\` ${v.executorPythonCases} 个（静态） | \`npm run test:python\` |`,
    `| admin-web | \`apps/admin-web/src/__tests__/\`（${v.adminWebTestFiles} 个 \`*.test.ts/tsx\`） | vitest（jsdom） | \`npm run test:web\` |`,
    `| 自测/真机脚本 | \`scripts/*selftest*\`（${v.scriptsSelftestFiles} 个） | 见 contract-and-selftest.md | 各自独立命令 |`,
    "",
  ];
  if (!omitCommands) {
    lines.push(
      "**上表数字的复核命令**（口径：文件数用 `find`/`ls` 点数；用例数用 `grep -o` 数声明，**静态**）：",
      "",
      "```bash",
    );
    for (const c of TESTING_CMDS) {
      if (drop.includes(c.key)) continue;
      lines.push(`${c.cmd.padEnd(90)} # ${cmdNumbers[c.key] ?? v[c.key]}`);
    }
    lines.push("```", "");
  }
  return lines.join("\n");
};

/** 生成 `n` 条 `it(` 声明的 spec 源（行首允许缩进——与 `grep -rhoE '^\s*(it|test)\('` 同口径）。 */
const specCases = (n) =>
  `${Array.from({ length: n }, (_, i) => `  it('case ${i + 1}', () => {});`).join("\n")}\n`;

/** ⑥⑦ 的 fixture 文件：口径与 `TESTING_FIXTURE` 一一对应（改数字必须同步这里）。 */
const TESTING_FILES = {
  "apps/admin-api/src/modules/auth/__tests__/auth.spec.ts": specCases(2),
  "apps/admin-api/src/modules/auth/__tests__/auth.serializer.spec.ts": specCases(1),
  // 同目录放置（不在 `__tests__` 下）：进用例数、不进文件数——真仓实测差 306 处的那个坑。
  "apps/admin-api/src/modules/auth/auth.policy.spec.ts": specCases(1),
  "apps/admin-api/src/modules/users/__tests__/users.spec.ts": specCases(1),
  "apps/executor-node/src/runner.spec.ts": specCases(2),
  "apps/executor-node/src/config.spec.ts": specCases(1),
  "apps/executor-python/tests/test_a.py":
    "def test_one():\n    assert True\n\n\ndef test_two():\n    assert True\n\n\ndef test_three():\n    assert True\n",
  "apps/executor-python/tests/test_b.py":
    "def test_four():\n    assert True\n\n\ndef test_five():\n    assert True\n\n\nasync def test_async_not_counted():\n    assert True\n",
  // 二进制哨兵：`grep -o` 不数二进制文件，本守卫也必须跳过（否则 5 变 6）。
  "apps/executor-python/tests/__pycache__/test_a.cpython-312.pyc": "\u0000def test_binary():\n",
  "apps/admin-web/src/__tests__/a.test.tsx": "it('a', () => {});\n",
  "apps/admin-web/src/__tests__/b.test.ts": "it('b', () => {});\n",
  "scripts/a.selftest.mjs": "// x\n",
  "scripts/b-selftest.mjs": "// x\n",
  "scripts/c.selftest.sh": "# x\n",
  "scripts/d-selftest.mjs": "// x\n",
  "scripts/e.selftest.mjs": "// x\n",
  "scripts/f-selftest.mjs": "// x\n",
};

/** 造一棵 fixture 仓库树；只传要变的部分。`migrations/apps/modules` 传 [] 即「目录被改名/清空」。 */
function atlasTree({
  migrations = MIG,
  modules = MODULES,
  apps = APPS,
  admin,
  atlas,
  e2e,
  e2eSpecs = E2E_FIXTURE,
  testing,
  testingFiles = TESTING_FILES,
  extra = {},
  drop = [],
} = {}) {
  const files = {};
  for (const m of migrations) files[`${MIGRATIONS_DIR}/${m}.ts`] = "export class M {}\n";
  for (const m of modules) files[`${MODULES_DIR}/${m}/index.ts`] = "export {};\n";
  for (const a of apps) files[`apps/${a}/package.json`] = { name: a };
  files[ADMIN_DOC] = admin ?? adminDoc({ modules });
  files[ATLAS_DOC] = atlas ?? atlasDoc({ apps });
  files[`${APPS_DOC_DIR}/admin-api/modules/auth.md`] = "# auth\n";
  for (const [rel, opts] of Object.entries(e2eSpecs)) files[rel] = specSource(opts);
  files[E2E_DOC] = e2e ?? e2eDoc();
  Object.assign(files, testingFiles);
  files[TESTING_DOC] = testing ?? testingDoc();
  Object.assign(files, extra);
  for (const d of drop) delete files[d];
  return files;
}

/**
 * 自检：20 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树），断言退出码与关键文本。
 *
 * 旧版**没有 selftest**：四段 IIFE 用模块级 `process.cwd()` 实扫真仓库，`process.exit(1)`
 * 是唯一的红通道，没人验证它还在；而「数字前缀误配」「模块表只查漏」这两处假绿
 * 恰好都能让迁移数/模块数写错时依然全绿。现在逐条反证。
 * ⑥⑦ 的用例与 ①③⑬⑭ 同一个立场：数字错了要红，**句子/代码块被改写**同样要红
 * （否则改一句措辞就能让判据永真）。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "atlas-counts-selftest-" });
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

  subprocess("① 干净树：迁移数/首尾、模块表、应用数、占位标记、e2e 例数、测试数字、复核命令七项全绿", atlasTree(), {
    code: 0,
    contains: [
      "迁移自述一致：22 个",
      "模块索引一致：12 个真实模块全部在表内（表内 12 行）",
      "应用数自述一致：6 个",
      "无「（下一批次）」占位标记",
      // ⑤：48 + 1 + 2 = 51 例 / 7 + 1 + 1 = 9 组；7 处 test.skip( 与注释掉的 test( 都不计入
      "e2e 例数自述一致：51 例 / 9 组（e2e-full.spec.js 48 例 + e2e-python-executor.spec.js 1 例 + e2e-ui09-mobile.spec.js 2 例）",
      // ⑥：admin-api 3/4、executor-node 2/3、executor-python 2/5、admin-web 2、scripts 6
      "测试数字自述一致：3 / 5 / 2 / 3 / 2 / 5 / 2 / 6",
      // ⑦：8 个数字点各带一条复核命令（`__pycache__/*.pyc` 与 async def 不计数）
      "复核命令与数字一一对应：8 个数字点各带一条可执行命令",
    ],
    absent: ["✖"],
  });

  subprocess("② 迁移数自述过期（文档写 21、实际 22）→ 红", atlasTree({ admin: adminDoc({ claim: claimLine(21) }) }), {
    code: 1,
    contains: ["atlas 迁移自述与实际不符", "文档未声明迁移数 22"],
    absent: ["迁移自述一致"],
  });

  // ③ 修掉的假绿：`includes("122 个 …")` 会让「1122 个 …」通过
  subprocess(
    "③ 【反证·前缀误配】文档写「122 个 TypeORM 迁移」而实际 22 → 红（不是子串命中）",
    atlasTree({ admin: adminDoc({ claim: claimLine(122) }) }),
    { code: 1, contains: ["文档未声明迁移数 22"], absent: ["迁移自述一致"] },
  );

  subprocess(
    "④ 末个迁移名过期（文档停在旧名）→ 红，且报出磁盘上的真名",
    atlasTree({ admin: adminDoc({ claim: claimLine(22, MIG[0], "1790000000000-OldTailMigration") }) }),
    { code: 1, contains: [`文档未出现末个迁移 ${MIG[MIG.length - 1]}`], absent: ["迁移自述一致"] },
  );

  // ⑤ 修掉的假绿：`includes(name)` 会让「…-M21V2」满足「…-M21」
  subprocess(
    "⑤ 【反证·名字前缀误配】末个迁移名多出后缀（…-M21V2）→ 红",
    atlasTree({ admin: adminDoc({ claim: claimLine(22, MIG[0], `${MIG[MIG.length - 1]}V2`) }) }),
    { code: 1, contains: ["文档未出现末个迁移"], absent: ["迁移自述一致"] },
  );

  subprocess("⑥ 模块索引漏一行（真实模块 metrics 缺文档）→ 红", atlasTree({ admin: adminDoc({ omitRow: "metrics" }) }), {
    code: 1,
    contains: ["模块索引漏了真实模块：metrics", "补行；不要改守卫"],
    absent: ["模块索引一致"],
  });

  // ⑦ 修掉的假绿：旧实现只查「漏行」，多出的陈旧行照样绿
  subprocess(
    "⑦ 【反证·多行】模块索引留着一个已删除模块的行 → 红",
    atlasTree({ admin: adminDoc({ extraRows: ["ghost-module"] }) }),
    { code: 1, contains: ["列了**不存在**的模块：ghost-module"], absent: ["模块索引一致"] },
  );

  subprocess(
    "⑧ 扫描面下界：迁移目录只剩 3 个文件（零命中不许全绿）→ 结构红",
    atlasTree({ migrations: MIG.slice(0, 3), admin: adminDoc({ claim: claimLine(3, MIG[0], MIG[2]) }) }),
    { code: 1, contains: ["迁移目录只扫到 3 个文件", "扫描器失效", "下界 20"], absent: ["迁移自述一致"] },
  );

  subprocess(
    "⑨ 目录改名（migrations 整个不见了）→ 结构红，不是崩栈也不是绿",
    atlasTree({ migrations: [] }),
    { code: 1, contains: ["迁移目录只扫到 0 个文件", "扫描器失效"], absent: ["迁移自述一致", "Error:"] },
  );

  // ⑩ 修掉的假绿：`includes("7 个应用")` 也会被「17 个应用」满足
  subprocess(
    "⑩ 【反证·前缀误配】atlas/README 写「16 个应用」而实际 6 → 红",
    atlasTree({ atlas: atlasDoc().replace("6 个应用", "16 个应用") }),
    { code: 1, contains: ["未声明「6 个应用」"], absent: ["应用数自述一致"] },
  );

  subprocess(
    "⑪ 「（下一批次）」标记挂在已存在的文档上 → 红",
    atlasTree({
      extra: {
        [`${APPS_DOC_DIR}/admin-api/modules/index.md`]: "- [auth](auth.md)（下一批次）\n",
      },
    }),
    { code: 1, contains: ["1 处「（下一批次）」标记挂在**已存在**的文档上", "admin-api/modules/index.md"], absent: ["无「（下一批次）」"] },
  );

  subprocess("⑫ 文档缺失（admin-api README 被删）→ 红且点名路径", atlasTree({ drop: [ADMIN_DOC] }), {
    code: 1,
    contains: [`读不到 ${ADMIN_DOC}`],
    absent: ["迁移自述一致", "模块索引一致"],
  });

  // ⑬ 2026-10-29 的原始症状：e2e 文档被整篇重写成 51 例后，把 51 改成 45，
  // check-docs / check-atlas-counts 全绿——没有人看这个数。现在必须红，且两值都给。
  subprocess(
    "⑬ 【反证·e2e 例数】合计行写 45 例（三份 spec 实际 51）→ 红并点名两值",
    atlasTree({ e2e: e2eDoc({ tests: 45 }) }),
    {
      code: 1,
      contains: [
        "e2e 例数自述与实际不符",
        "例数 文档写 45 / 实际 51",
        "e2e-full.spec.js 48 例",
        "= 51 例 / 9 组",
      ],
      absent: ["e2e 例数自述一致"],
    },
  );

  // ⑭ 结构红：把「合计（入口口径）」那行改写成一句话（数字还写对了）。
  // 「整行删掉」走的是同一条「解析不到」分支，所以这条同时钉住删与改写两种绕法。
  subprocess(
    "⑭ 【反证·合计行被改写】合计行换成散文（数字写对也不算）→ 结构红，不是绿",
    atlasTree({ e2e: e2eDoc({ totalRow: "三份 spec 合计 9 组、51 例。" }) }),
    {
      code: 1,
      contains: ["解析不到「| **合计（入口口径）** | **9** | **51** |」这一行", "实测：e2e-full.spec.js 48 例"],
      absent: ["e2e 例数自述一致"],
    },
  );

  // ⑮ ⑥ 的反证（第 22 轮的任务形态）：把 admin-api 的 spec 数 +1，其它一概不动。
  subprocess(
    "⑮ 【反证·⑥ 测试数字】表格 admin-api spec 数 3→4（现场仍 3）→ 红并点名两值",
    atlasTree({ testing: testingDoc({ values: { adminApiSpecFiles: 4 } }) }),
    {
      code: 1,
      contains: ["admin-api spec 文件数：文档写「4」，实际「3」", "find apps/admin-api/src -path '*__tests__*'"],
      absent: ["测试数字自述一致"],
    },
  );

  // ⑯ ⑦ 的反证：数字都对，但把 executor-node 那条命令删掉（「只写数不写出处」）。
  subprocess(
    "⑯ 【反证·⑦ 缺命令】删掉 executor-node it/test 旁的复核命令 → 红（只写数不写出处不算）",
    atlasTree({ testing: testingDoc({ drop: ["executorNodeCases"] }) }),
    {
      code: 1,
      contains: [
        "executor-node it/test 数｜复核命令缺失",
        "期望原文（整行，含 `# 数字`）：grep -rhoE '^\\s*(it|test)\\(' apps/executor-node/src",
      ],
      absent: ["复核命令与数字一一对应"],
    },
  );

  // ⑰ ⑦ 的反证：命令旁的 `# 数字` 与表格不一致（同一个数两处不一致 = 没人知道该信哪个）。
  subprocess(
    "⑰ 【反证·⑦ 数字不对应】命令旁写 4、表格写 3 → 红（两处必须同一个数）",
    atlasTree({ testing: testingDoc({ cmdNumbers: { executorNodeCases: 4 } }) }),
    {
      code: 1,
      contains: ["executor-node it/test 数｜命令旁写「4」，表格写「3」"],
      absent: ["复核命令与数字一一对应"],
    },
  );

  // ⑱ ⑦ 的结构红：整个命令代码块被删（数字还在表格里）。没有出处 = 下一轮无法复现。
  subprocess(
    "⑱ 【反证·⑦ 结构红】复核命令代码块整块删掉 → 红（数字点到 0 个 < 下界 5）",
    atlasTree({ testing: testingDoc({ omitCommands: true }) }),
    {
      code: 1,
      contains: ["只解析到 0 个「数字 + 复核命令」点（下界 5）", "命令代码块被删/被截断了吧"],
      absent: ["复核命令与数字一一对应"],
    },
  );

  // ⑲ ⑥ 的结构红：把「3 个 `*.spec.ts`」改写成「三个 `*.spec.ts`」——数字对，句子不可解析。
  subprocess(
    "⑲ 【反证·⑥ 结构红】表格数字改成中文「三个」→ 红（解析不到，不是静默跳过）",
    atlasTree({ testing: testingDoc().replace("（3 个 `*.spec.ts`）", "（三个 `*.spec.ts`）") }),
    {
      code: 1,
      contains: ["admin-api spec 文件数｜表格「admin-api 单测」行", "解析不到这个数字"],
      absent: ["测试数字自述一致"],
    },
  );

  // ⑳ ⑥ 的扫描面下界：executor-node 源码目录整个不在 → 零命中必须是红，不是「数字都对」。
  subprocess(
    "⑳ 【反证·扫描面零命中】executor-node 的 spec 全没了 → 结构红（下界 1）",
    atlasTree({
      testingFiles: Object.fromEntries(
        Object.entries(TESTING_FILES).filter(([rel]) => !rel.startsWith("apps/executor-node/")),
      ),
    }),
    {
      code: 1,
      contains: ["扫描面零命中：executor-node 的 spec 文件", "目录改名/后缀变了"],
      absent: ["测试数字自述一致"],
    },
  );

  const failed = reportCases(cases, { title: "check-atlas-counts selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    let failures = 0;
    for (const r of check(root)) {
      if (r.ok) {
        console.log(r.note);
      } else {
        for (const line of r.out) console.error(line);
        failures += 1;
      }
    }
    if (failures > 0) process.exit(1);
  }
}
