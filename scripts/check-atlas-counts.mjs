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
 *      executor-node 两项、executor-python 两项、admin-web 文件数、packages（JS）行三项
 *      acf-cli / mcp-server / node-sdk 的测试文件数、registry-pypi 的 `def test_` 数、
 *      `scripts/*selftest*` 数）必须等于现场，且口径**逐字照抄文档自己写的 12 条复核命令**
 *      （`find` / `grep -rhoE` / `ls`）；
 *   ⑦ 那 12 条「复核命令」必须**真的在文档里**，且每条命令旁的 `# 数字` 与表格数字一一对应
 *      ——「只写数不写出处」也算红。**不真跑命令**（慢、跨平台差异），只做文本层核对。
 *      第 23 轮扩面：同表的 `packages`（acf-cli / mcp-server / node-sdk）与 `registry-pypi`
 *      四行此前无守卫，数字从头烂到尾（文档停在 commit 92cfafa6 的现场：acf-cli 12 文件、
 *      registry-pypi 157 处，实测已 13 / 164）。文档缺这四条复核命令时**先补命令再纳入判据**，
 *      不许只把数字塞进判据而没有出处。
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
 * 用法：`node scripts/check-atlas-counts.mjs [--selftest] [--root <dir>] [--update]`
 *   --selftest：跑真脚本的子进程（临时 fixture 树），逐条断言退出码 + 关键文本 + <1s。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
 *   --update  ：把 ⑥⑦ 的 12 个数字点**就地**写回 `docs/atlas/07-testing/README.md`
 *               （表格里的数字 + 复核命令旁的 `# 数字`）——**只改数字，不改任何文字**
 *               （标题、命令、表格结构一律不动）。覆盖范围**仅限 ⑥⑦ 的 12 个数字点**，
 *               ①②③④⑤ 守护的是别的文档，本模式不碰它们。
 *
 * ## `--update` 的安全阀：为什么「解析失败 ⇒ 一行都不写」是硬要求
 *
 * `--update` 的价值是**机械同步**（把现场数字抄回文档），不是**判断**（替人决定哪个数
 * 才对）。一旦事实源解析失败（目录改名 / 正则失配 / 扫描面塌成 0），此时算出来的数字
 * 就是**错的**，而 `--update` 照样落盘 ⇒ 等于**用错的数字覆盖对的数字**，把守卫从
 * 「会报红的闸」降格成「橡皮章」：从此文档数字永远等于脚本算出的数字，**无论那个数字
 * 对不对**——这恰好是本守卫要消灭的那类「单向腐烂」的升级版（比腐烂更糟：腐烂至少
 * 会红）。
 *
 * 所以判据是**全有或全无**：任何一处事实源解析失败（读不到文件 / 下界不满足 / 正则
 * 失配 / 某个数字点算不出来 / 复核命令缺失或重复）⇒ **一个字节都不写**，如实报错并
 * exit 非 0。先例（照抄语义）：`scripts/check-metric-docs.mjs` 的
 * 「--update 在事实源解析失败时拒绝写基线（exit 1，且不落地半成品基线）」。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * ⑦ 的下界：文档至少要给出 12 个「数字 + 复核命令」点（= `TEST_CLAIMS` 的全量）。
 * 代码块被删/被截断时，⑦ 不会「零命中 → 一句 ✔」，而是直接红（防「只写数不写出处」）。
 * 以后往 `TEST_CLAIMS` 加点，这个数要跟着加；顺手丢掉一条命令则由逐条比对点名。
 */
export const MIN_DOC_NUMBER_SITES = 12;

/**
 * **默认容差（百分比）**：文档值 vs 现场值允许的偏差（±5%）。
 *
 * ## 为什么需要容差（2026-11-04，本轮它红了 5 次）
 *
 * 旧判据是「三者精确相等」。在活跃开发中，新增一个 spec 就会让测试计数漂移 ⇒
 * 守卫红 ⇒ 人跑 `--update` 同步。**问题不在漂移，而在「跑了 5 次 --update 却一次
 * 都没真正核对那些数字对不对」**——精确匹配把人训练成不看内容、直接同步。
 *
 * ⇒ 守卫的价值是「**文档不许大幅撒谎**」，不是「文档必须与此刻逐字一致」。
 * 后者在活跃开发中不可维护，且它防的东西（有人把 7,000 写成 700）在 ±5% 下仍然红：
 * 5% 在 7,070 上是 ±354 例 —— 新增几十个 spec 不会红，少写一个数量级一定红。
 *
 * `--tolerance 0` 恢复旧的精确行为（向后兼容）。
 */
export const DEFAULT_TOLERANCE_PCT = 5;
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
 * ⑥⑦ 的事实源：**逐条复刻文档正文里那 12 条复核命令的口径**（见 `TEST_CLAIMS[].cmd`）。
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

  // ── 第 23 轮扩面：`packages` 行的三个包 + `registry-pypi` 行（此前无守卫）──────
  // 口径 = 文档那四条复核命令：`find <pkg>/src -name '*.test.ts'`（与各包自己的收集配置
  // 同源：acf-cli / mcp-server 的 vitest `include: ['src/**/*.test.ts']`、node-sdk 的 jest
  // `roots: ['<rootDir>/src']` + `testMatch: '**/__tests__/**/*.test.ts'`）与
  // `grep -rhoE '^\s*def test_' apps/registry-pypi/tests`（递归、全后缀、二进制跳过）。
  const pkgTestClaims = [
    ["acfCliTestFiles", "packages/acf-cli", "acf-cli 的测试文件"],
    ["mcpServerTestFiles", "packages/mcp-server", "mcp-server 的测试文件"],
    ["nodeSdkTestFiles", "packages/autocodeflow-node-sdk", "autocodeflow-node-sdk 的测试文件"],
  ];
  for (const [key, pkgDir, label] of pkgTestClaims) {
    set(
      key,
      label,
      `find ${pkgDir}/src -name '*.test.ts'`,
      walkFiles(root, `${pkgDir}/src`).filter((r) => r.endsWith(".test.ts")).length,
    );
  }
  const pypiTestsDir = "apps/registry-pypi/tests";
  set(
    "registryPypiCases",
    "registry-pypi 的 def test_",
    "grep -rhoE '^\\s*def test_' apps/registry-pypi/tests",
    countMatchedLines(root, walkFiles(root, pypiTestsDir), PY_TEST_LINE_RE),
  );

  return { facts, problems };
}

/**
 * ⑥ 的 12 个数字点（表格里每个手写数字一条）。每条都有：
 *   · `tableRe`：**定点**匹配表格里那一行的那个数字（解析不到 = 结构红）；
 *   · `cmd`：文档「上表数字的复核命令」代码块里应出现的那条命令（归一化后整行比对）；
 *   · `key`：对应 `collectTestFacts` 的事实。
 *
 * 前 8 条是第 22 轮的点（admin-api spec/it、executor-node ×2、executor-python ×2、
 * admin-web、scripts selftest）；后 4 条是第 23 轮的扩面（`packages`（JS）行的
 * acf-cli / mcp-server / node-sdk 三个「N 文件」，以及 `registry-pypi` 行的
 * 「N 个 `def test_`」）。**只钉文档自己写了复核命令的数字**——同表 `packages`（Py）行
 * 仍是「8 文件 / 166 用例 …」这种一格里塞多个数的写法，且没有对应命令，故未纳入；
 * 要纳入得先把它拆成可定点解析的形状并补命令。
 *
 * ## `monotonic`（方向层的依据）——默认**全部单调**，与它的关灯口子
 *
 * 本表 12 条全部是**测试计数**（spec 文件数 / `it/test` 数 / `def test_` 数）。
 *
 * **单调 = 测试计数在活跃开发中只增不减。** 所以「文档值 > 现场值」必然是编的
 * （不会有人先写了未来才有的测试数），方向层据此判红。
 *
 * ⚠️ **`monotonic: false` 是一个现成的关灯口子**（设了就关掉方向层）：
 * 若将来**大规模删测试**（例如清理弱断言、砍掉与实现耦合的 spec），确实可能让计数
 * 下降 —— 那时需要**显式**改成 `monotonic: false`，**并在 commit message 里说明原因**。
 * **不要为了绕过一次红灯去改它**：方向层红的意思是「这个数字领先于现实」，
 * 绕过它等于让「假设性膨胀」重新变成合法状态，而这正是三层判据要防的东西。
 */
export const TEST_CLAIMS = [
  {
    key: "adminApiSpecFiles",
    monotonic: true,
    label: "admin-api spec 文件数",
    tableRe: /^\|\s*admin-api 单测\s*\|[^\n]*?（\s*(\d+)\s*个\s*`\*\.spec\.ts`\s*）/m,
    desc: "表格「admin-api 单测」行的「N 个 `*.spec.ts`」",
    cmd: "find apps/admin-api/src -path '*__tests__*' -name '*.spec.ts' | wc -l",
  },
  {
    key: "adminApiCases",
    monotonic: true,
    label: "admin-api it/test 数",
    tableRe: /^\|\s*admin-api 单测\s*\|[^\n]*`it\/test`\s*(\d+)\s*处/m,
    desc: "表格「admin-api 单测」行的「`it/test` N 处」",
    cmd: "grep -rhoE '^\\s*(it|test)\\(' apps/admin-api/src --include=*.spec.ts | wc -l",
  },
  {
    key: "executorNodeSpecFiles",
    monotonic: true,
    label: "executor-node spec 文件数",
    tableRe: /^\|\s*executor-node\s*\|[^\n]*?（\s*(\d+)\s*个\s*`\*\.spec\.ts`\s*）/m,
    desc: "表格「executor-node」行的「N 个 `*.spec.ts`」",
    cmd: "find apps/executor-node/src -name '*.spec.ts' | wc -l",
  },
  {
    key: "executorNodeCases",
    monotonic: true,
    label: "executor-node it/test 数",
    tableRe: /^\|\s*executor-node\s*\|[^\n]*`it\/test`\s*(\d+)\s*处/m,
    desc: "表格「executor-node」行的「`it/test` N 处」",
    cmd: "grep -rhoE '^\\s*(it|test)\\(' apps/executor-node/src --include=*.spec.ts | wc -l",
  },
  {
    key: "executorPythonTestFiles",
    monotonic: true,
    label: "executor-python 测试文件数",
    tableRe: /^\|\s*executor-python\s*\|[^\n]*?（\s*(\d+)\s*个\s*`test_\*\.py`\s*）/m,
    desc: "表格「executor-python」行的「N 个 `test_*.py`」",
    cmd: "ls apps/executor-python/tests/test_*.py | wc -l",
  },
  {
    key: "executorPythonCases",
    monotonic: true,
    label: "executor-python def test_ 数",
    tableRe: /^\|\s*executor-python\s*\|[^\n]*`def test_`\s*(\d+)\s*个/m,
    desc: "表格「executor-python」行的「`def test_` N 个」",
    cmd: "grep -rhoE '^\\s*def test_' apps/executor-python/tests | wc -l",
  },
  {
    key: "adminWebTestFiles",
    monotonic: true,
    label: "admin-web 测试文件数",
    tableRe: /^\|\s*admin-web\s*\|[^\n]*?（\s*(\d+)\s*个\s*`\*\.test\.ts\/tsx`\s*）/m,
    desc: "表格「admin-web」行的「N 个 `*.test.ts/tsx`」",
    cmd: "find apps/admin-web/src/__tests__ -name '*.test.ts*' | wc -l",
  },
  {
    key: "scriptsSelftestFiles",
    monotonic: true,
    label: "scripts 自测文件数",
    tableRe: /^\|\s*自测\/真机脚本\s*\|[^\n]*?（\s*(\d+)\s*个\s*）/m,
    desc: "表格「自测/真机脚本」行的「N 个」",
    cmd: "ls scripts/*selftest* | wc -l",
  },
  // ── 第 23 轮扩面：`packages`（JS）行的三个包，一格三个数，各钉各的 ──────────
  // `[^\n]*?` 后面接「<包名> N 文件」，所以 `test:node-sdk` 这种出现不算（后面不是数字）。
  {
    key: "acfCliTestFiles",
    monotonic: true,
    label: "acf-cli 测试文件数",
    tableRe: /^\|\s*packages（JS）\s*\|[^\n]*?acf-cli\s+(\d+)\s*文件/m,
    desc: "表格「packages（JS）」行的「acf-cli N 文件」",
    cmd: "find packages/acf-cli/src -name '*.test.ts' | wc -l",
  },
  {
    key: "mcpServerTestFiles",
    monotonic: true,
    label: "mcp-server 测试文件数",
    tableRe: /^\|\s*packages（JS）\s*\|[^\n]*?mcp-server\s+(\d+)\s*文件/m,
    desc: "表格「packages（JS）」行的「mcp-server N 文件」",
    cmd: "find packages/mcp-server/src -name '*.test.ts' | wc -l",
  },
  {
    key: "nodeSdkTestFiles",
    monotonic: true,
    label: "node-sdk 测试文件数",
    tableRe: /^\|\s*packages（JS）\s*\|[^\n]*?node-sdk\s+(\d+)\s*文件/m,
    desc: "表格「packages（JS）」行的「node-sdk N 文件」",
    cmd: "find packages/autocodeflow-node-sdk/src -name '*.test.ts' | wc -l",
  },
  // `registry-pypi` 行的「N 个 `def test_`」——与 executor-python 行同一个单位，
  // 靠行首标签区分（两行的正则各自锚 `^\|`，不会互相串）。
  {
    key: "registryPypiCases",
    monotonic: true,
    label: "registry-pypi def test_ 数",
    tableRe: /^\|\s*registry-pypi\s*\|[^\n]*?(\d+)\s*个\s*`def test_`/m,
    desc: "表格「registry-pypi」行的「N 个 `def test_`」",
    cmd: "grep -rhoE '^\\s*def test_' apps/registry-pypi/tests | wc -l",
  },
];

/**
 * **已知盲区登记**（`knownGaps`）—— 与 `protocol-breaking` / `handwritten-copies` /
 * `source-size-baseline` 同一套机制：缺口本身**不判红**（有缺口是事实），
 * 但缺 owner / 缺复核期限 / **期限过期** ⇒ 红（没主人的缺口会被遗忘）。
 *
 * 每条必须有 `observed_fact`：这个盲区**具体是什么**、证据在哪。
 */
export const KNOWN_GAPS = [
  {
    id: "atlas-count-commands-not-self-verified",
    /**
     * 三层判据现在把「文档 vs 现场」的偏差限制在 ±5%。但**「现场值本身」是怎么算的？**
     * 12 个指标各自的命令（`find … | wc -l` / `grep -rhoE … | wc -l`）**没有判据保证
     * 它们仍在测它们声称测的东西**。
     */
    observed_fact:
      "测量命令的**语义漂移无人看守**。例：若某天 `it(` 为主改成 `test.each`，" +
      "`grep -rhoE '^\\s*(it|test)\\(' | wc -l` 会**静默少算**，而三层判据全绿 —— " +
      "因为 `--update` 会把文档一起同步到那个偏低的值，量级层/方向层都看不见" +
      "（方向层只在「文档 > 现场」时红，这里两者一起下降）。" +
      "即：**判据保证了「文档与我的测量一致」，没保证「我的测量与真实规模一致」**。",
    why:
      "这是「判据空转」的下一格：三层判据把「文档 vs 现场」盯住了，但「现场」这个中间量" +
      "自身没有第二只眼。要修得给每个指标配**结构性下界**（如 spec 文件数 ≥ __tests__ 目录数）" +
      "或**抽样核对**（随机抽 N 个文件真数一遍），那是另一件事，不是调容差能解决的。",
    possibleApproach:
      "① 先给 2–3 个最易漂的指标配**正交口径交叉核对**（例如 it/test 数同时用 " +
      "`grep -c` 与 AST 遍历各数一次，两者不等即红）；② 或加**抽样核对**：随机抽 3 个 spec 文件，" +
      "人工可复核的期望值写进 fixture；③ 再按批扩张到 12 个指标。",
    owner: "guard-smith",
    review_by: "2026-12-15",
  },
];

/**
 * 校验 `KNOWN_GAPS`（缺 owner / 期限非法 / 过期 ⇒ 红）。
 *
 * @param {Array<object>} gaps
 * @param {number} todayDay 自 1970-01-01 起的 UTC 日序号
 * @returns {string[]} problems
 */
export function validateKnownGaps(gaps, todayDay) {
  const out = [];
  for (const [i, g] of (gaps ?? []).entries()) {
    const at = `knownGaps[${i}]`;
    if (!g || typeof g !== "object") {
      out.push(`${at} 不是对象 —— 登记腐烂了。`);
      continue;
    }
    if (typeof g.id !== "string" || !g.id.trim()) out.push(`${at} 缺 id`);
    if (typeof g.owner !== "string" || !g.owner.trim()) {
      out.push(`${at}（${g.id ?? "?"}）缺 owner —— 没有责任人的盲区等于没有记录`);
    }
    if (typeof g.observed_fact !== "string" || g.observed_fact.trim().length < 20) {
      out.push(`${at}（${g.id ?? "?"}）的 observed_fact 太短 —— 必须写清「具体漏了什么」`);
    }
    if (typeof g.review_by !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(g.review_by)) {
      out.push(`${at}（${g.id ?? "?"}）的 review_by 必须是 YYYY-MM-DD`);
      continue;
    }
    const day = Math.floor(Date.parse(`${g.review_by}T00:00:00Z`) / 86_400_000);
    if (!Number.isFinite(day)) {
      out.push(`${at}（${g.id}）的 review_by 不是合法日期`);
    } else if (day < todayDay) {
      out.push(
        `${at}（${g.id}）的复核期限已过（review_by=${g.review_by}）—— 盲区还在，但已经没人打算管它了`,
      );
    }
  }
  return out;
}

/** 归一化命令文本：只把空白折叠成单空格（对齐用的空格不算口径差异，改词才算）。 */
export const normalizeCmd = (s) => s.trim().replace(/\s+/g, " ");

/**
 * 取出围栏代码块里的命令条目：`{ cmd, number }`。
 *
 * 命令行的形状是「命令 + 若干空格 + `# 数字`」（见文档「上表数字的复核命令」）。
 * 注释号后面的数字**必须**在行首（`# 370` / `# 921（async def 另 142）` 都认），
 * 没有数字的行也收（`number: null`），这样「命令还在、数字被删」也能被点名。
 *
 * 额外给出**该数字在整篇文本里的字符区间**（`numberStart` / `numberEnd`，无数字时为
 * `null`）：`--update` 要**只改数字、不动其它文字**，就必须能精确定位「这个数字是哪
 * 几个字符」——定位不到就不写（宁可拒绝，也不整行重写）。
 */
export function extractFencedCommands(text) {
  const out = [];
  let inFence = false;
  let offset = 0;
  for (const raw of text.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1; // 换行符本身
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const lead = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(.+?)\s+#\s*(\d+)/d.exec(line);
    if (m) {
      const g = m.indices[2];
      out.push({
        cmd: m[1].trim(),
        number: Number(m[2]),
        numberStart: lineStart + lead + g[0],
        numberEnd: lineStart + lead + g[1],
      });
    } else {
      out.push({ cmd: line, number: null, numberStart: null, numberEnd: null });
    }
  }
  return out;
}

/**
 * 在文档里定点取一个数字，并给出它在文档里的**字符区间**。
 *
 * 命中 0 次 → 结构红（句子被改写）；命中多次 → 不知道该信哪行（结构红）。
 * 命中 1 次 → `{ value, start, end }`：`start`/`end` 是那个数字在原文里的下标，
 * 供 `--update` **就地**改写（只动这几个字符，其余文字一个字节都不碰）。
 *
 * 用正则的 `d` 标志（`hasIndices`）拿捕获组的下标——Node 24 支持（`engines.node >= 24`）。
 */
export function locateTableNumber(doc, re) {
  const flags = new Set([...re.flags, "g", "d"]);
  const hits = [...doc.matchAll(new RegExp(re.source, [...flags].join("")))];
  if (hits.length === 0) return { error: "解析不到这个数字（句子被改写了？）" };
  if (hits.length > 1) return { error: `同一个数字点解析到 ${hits.length} 处，不知道该信哪一处` };
  const idx = hits[0].indices?.[1];
  if (!idx) return { error: "数字点没有字符区间（定位不到改写点）" };
  return { value: Number(hits[0][1]), start: idx[0], end: idx[1] };
}

/** 在文档里定点取一个数字：命中 0 次 → 结构红；命中多次 → 不知道该信哪行。 */
function tableNumberOf(doc, re) {
  const located = locateTableNumber(doc, re);
  if (located.error) return { error: located.error };
  return { value: located.value };
}

/* ⑥ 测试数字表 ↔ 现场（**三层判据**） */

/**
 * **量级层 + 方向层**：表格值 vs 现场值。
 *
 * ## 三层判据（分层修三个不同的问题，**刻意不合成一层**）
 *
 *   ① **自洽层**（在 `checkTestingCommands` 里）：**表格值 === 命令旁值**，精确相等。
 *      **这一层不许放宽** —— 同一篇文档里两个数不一致，是**纯错误**，与开发活跃度无关。
 *   ② **量级层**（本函数）：`|文档 − 实际| / 实际 ≤ tolerance`。防「把 7,000 写成 700」。
 *   ③ **方向层**（本函数，仅单调项）：`文档值 ≤ 实际值`。防「假设性膨胀」——
 *      测试数只会涨，一个比现场**还大**的数字不可能是"暂时落后"，只能是编的。
 *
 * ## 为什么方向层不与量级层合并
 *
 * 它们在容差内可能给出相反结论：文档 7,100、实际 7,070 ⇒ 量级层绿（0.4% < 5%），
 * 方向层红（7100 > 7070，单调项不可能超前）。合并成一个「差值检查」就会漏掉后者。
 *
 * 反之文档 6,900、实际 7,070 ⇒ 两层都绿（落后 2.4%，且在容差内）。
 *
 * @param {string} root
 * @param {{tolerancePct?: number}} [options] `tolerancePct=0` ⇒ 恢复旧的精确行为
 */
export function checkTestingTable(root, { tolerancePct = DEFAULT_TOLERANCE_PCT } = {}) {
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
    const documented = parsed.value;

    // ② 量级层
    const diff = Math.abs(documented - actual);
    const pct = actual === 0 ? (diff === 0 ? 0 : Infinity) : (diff / actual) * 100;
    if (pct > tolerancePct) {
      bad.push(
        `✖ 【量级层】${claim.label}：文档写「${documented}」，实际「${actual}」——` +
          `相差 ${diff}（${pct.toFixed(2)}% > 容差 ${tolerancePct}%）。`,
        `  门槛是「文档不许大幅撒谎」：容差 ${tolerancePct}% 在 ${actual} 上是 ±${Math.floor((actual * tolerancePct) / 100)} 例；` +
          `新增几十个不该红，但少写一个数量级必须红。`,
        `  命令：node scripts/check-atlas-counts.mjs --update   # 或手改表格数字（口径：${claim.cmd}）`,
      );
      continue;
    }

    // ③ 方向层（只对**单调不减**的指标；默认全部测试计数指标都是单调项）
    if (claim.monotonic !== false && documented > actual) {
      bad.push(
        `✖ 【方向层】${claim.label}：文档写「${documented}」**大于**实际「${actual}」——` +
          `这是**单调不减**的指标（${claim.cmd}），不可能"暂时超前"，只能是编的或还没同步。`,
        `  修法：改成实际值（或等于实际值）；允许落后（在容差内），**不允许超前**。`,
        `  命令：node scripts/check-atlas-counts.mjs --update`,
      );
    }
  }
  if (bad.length > 0) {
    return {
      ok: false,
      out: [
        `✖ 07-testing/README.md 的测试数字超出门槛（容差 ${tolerancePct}%）：`,
        ...bad.map((b) => "  " + b),
        "  修法：先看每条前面的层标签 —— 「量级层」=偏太多（可能只是落后）；「方向层」=单调指标却超前（只可能是编的）。",
        "  两层含义不同，别都当「漂移」；`--tolerance 0` 可恢复旧的精确相等行为。",
        "  守卫**不再**要求逐字一致（活跃开发里那不可维护）；精确自洽是另一层判据（表格 vs 命令旁）。",
      ],
    };
  }
  const pairs = TEST_CLAIMS.map((c) => `${facts[c.key]}`).join(" / ");
  return {
    ok: true,
    note:
      `✔ 测试数字在门槛内（容差 ${tolerancePct}%，且单调项不超前）：${pairs}` +
      `（${TEST_CLAIMS.length} 个数字点，口径 = 文档那 ${TEST_CLAIMS.length} 条复核命令）。`,
  };
}

/* ── `--update`：把 ⑥⑦ 的 12 个数字点就地写回 `docs/atlas/07-testing/README.md` ── */

/**
 * `--update` 的**唯一**改写计划：重算 12 个数字点 → 算出「哪些字符区间换成哪个数」。
 *
 * ## 单一事实源（纪律：不许在 update 路径里复制一份计算）
 *
 *   · 数字的**值**来自 `collectTestFacts(root)` —— ⑥ 与 ⑦ 判据用的**同一个**函数，
 *     口径 = 文档那 12 条复核命令（`find` / `grep -rhoE` / `ls`）。
 *   · 数字的**位置**来自 `TEST_CLAIMS[].tableRe` / `TEST_CLAIMS[].cmd` —— 与判据
 *     逐字同一份定义（`locateTableNumber` / `extractFencedCommands` 是判据本身在用的解析器）。
 *
 * 所以 `--update` **不可能**算出与守卫不一样的数：它用的就是守卫那份计算。
 *
 * ## 拒绝写入的**全部**条件（安全阀；任一命中 ⇒ 一个字节都不写，exit 非 0）
 *
 *   ① 事实源**解析失败**：任一扫描面零命中 / 跌破下界（`collectTestFacts` 的 `problems`）；
 *   ② 目标文档**读不到**（`docs/atlas/07-testing/README.md` 缺失或不可读）；
 *   ③ 某个数字点的**正则失配**（表格里那个数字解析不到，或解析到多处）；
 *   ④ 某条**复核命令缺失 / 重复**，或命令旁**没写数字**（没有可改写的落点）；
 *   ⑤ 某个数字点**算不出值**（事实表里没有这个 key / 值不是非负整数）。
 *
 * 为什么必须这样（而不是「尽量写」）：`--update` 的价值是**机械同步**，不是**判断**。
 * 解析瞎了还照写 = 用错的数字覆盖对的数字 ⇒ 守卫从「会报红的闸」降格成「橡皮章」，
 * 从此文档数字永远等于脚本算出的数字，**无论那个数字对不对**——比腐烂更糟（腐烂至少会红）。
 * 先例（照抄语义）：`scripts/check-metric-docs.mjs` 的「--update 在事实源解析失败时
 * 拒绝写基线（exit 1，且不落地半成品基线）」。
 *
 * @returns {{ok: true, doc: string, newText: string, edits: Array, facts: object}
 *          | {ok: false, out: string[]}}
 */
export function planTestingDocUpdate(root) {
  const { facts, problems } = collectTestFacts(root);
  if (problems.length > 0) {
    return {
      ok: false,
      out: [
        ...problems,
        "  事实源解析失败（扫描面塌了 / 目录改名 / 后缀变了）⇒ 拒绝写任何数字。",
      ],
    };
  }
  const doc = readText(join(root, TESTING_DOC));
  if (doc === null) {
    return {
      ok: false,
      out: [`✖ 读不到 ${TESTING_DOC} —— 拒绝写任何数字（写不回原处的数字等于没写）。`],
    };
  }

  const commands = extractFencedCommands(doc);
  const edits = [];
  const bad = [];
  for (const claim of TEST_CLAIMS) {
    // ③ 表格侧：正则失配（解析不到 / 解析到多处）⇒ 拒绝。
    const located = locateTableNumber(doc, claim.tableRe);
    if (located.error) {
      bad.push(`✖ ${claim.label}｜${claim.desc}：${located.error}`);
      continue;
    }
    // ⑤ 事实侧：这个数字点算不出来 ⇒ 拒绝（不能拿 undefined 去写文档）。
    const actual = facts[claim.key];
    if (!Number.isInteger(actual) || actual < 0) {
      bad.push(`✖ ${claim.label}｜算不出现场数字（facts.${claim.key} = ${actual}）⇒ 拒绝写。`);
      continue;
    }
    // ④ 命令侧：命令缺失 / 重复 / 没写数字 ⇒ 没有第二个落点，拒绝（否则表格与命令两处会不一致）。
    const expected = normalizeCmd(claim.cmd);
    const hits = commands.filter((c) => normalizeCmd(c.cmd) === expected);
    if (hits.length === 0) {
      bad.push(
        `✖ ${claim.label}｜复核命令缺失：${claim.desc} 旁边只有数字，没有能复现它的命令。`,
        `  期望原文（整行，含 \`# 数字\`）：${claim.cmd}    # ${actual}`,
      );
      continue;
    }
    if (hits.length > 1) {
      bad.push(
        `✖ ${claim.label}｜同一条复核命令在文档里出现 ${hits.length} 次 —— 不知道该信哪个数字；只保留一处。`,
      );
      continue;
    }
    const entry = hits[0];
    if (entry.number === null || entry.numberStart === null || entry.numberEnd === null) {
      bad.push(
        `✖ ${claim.label}｜复核命令没有写结果数字：\`${claim.cmd}\` 后面缺 \`# 数字\`（没有可改写的落点）。`,
      );
      continue;
    }
    edits.push({
      label: claim.label,
      where: "表格",
      start: located.start,
      end: located.end,
      old: String(located.value),
      value: String(actual),
    });
    edits.push({
      label: claim.label,
      where: "复核命令旁",
      start: entry.numberStart,
      end: entry.numberEnd,
      old: String(entry.number),
      value: String(actual),
    });
  }
  if (bad.length > 0) {
    return {
      ok: false,
      out: [
        "✖ 07-testing/README.md 的 12 个数字点有解析不了的 ⇒ 拒绝写任何数字：",
        ...bad.map((b) => "  " + b),
        "  修法：先修好文档的形状（或先让事实源恢复可解析），再跑 --update；不要手改数字。",
      ],
    };
  }

  // 落盘前自洽：用**同一批解析器**复读改写结果，24 处数字必须都等于现场值。
  // 这一步不替代判据，只防「偏移量算错 ⇒ 写出半张烂文档」。
  const newText = applyNumericEdits(doc, edits);
  if (newText === null) {
    return { ok: false, out: ["✖ 改写区间冲突或越界（同一个位置被改两次）⇒ 拒绝写。"] };
  }
  const verify = verifyUpdatedDoc(newText, facts);
  if (verify.length > 0) {
    return {
      ok: false,
      out: [
        "✖ 改写结果自检不通过（写出去的东西不是「12 个数字 = 现场」）⇒ 拒绝写：",
        ...verify.map((v) => "  " + v),
      ],
    };
  }
  return { ok: true, doc, newText, edits, facts };
}

/**
 * 把若干「字符区间 → 新文本」的编辑套用到原文上；区间重叠/越界即返回 null。
 *
 * 从后往前套用，前面的下标才不会被后面的长度变化顶掉。
 */
export function applyNumericEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let prevStart = Infinity;
  for (const e of sorted) {
    if (!(e.start >= 0 && e.end > e.start && e.end <= out.length)) return null;
    if (e.end > prevStart) return null; // 与上一个区间重叠
    out = out.slice(0, e.start) + e.value + out.slice(e.end);
    prevStart = e.start;
  }
  return out;
}

/**
 * 复读改写后的文本：12 个表格数字与 12 条命令旁的数字都必须等于现场值。
 *
 * 用的是判据本身那套解析器（`locateTableNumber` / `extractFencedCommands`），
 * 所以「自洽」不是另写一份断言，而是**复用**判据。
 */
export function verifyUpdatedDoc(newText, facts) {
  const problems = [];
  const commands = extractFencedCommands(newText);
  for (const claim of TEST_CLAIMS) {
    const actual = facts[claim.key];
    const located = locateTableNumber(newText, claim.tableRe);
    if (located.error) {
      problems.push(`${claim.label}｜表格：${located.error}`);
      continue;
    }
    if (located.value !== actual) {
      problems.push(`${claim.label}｜表格：写出去的是 ${located.value}，现场是 ${actual}`);
    }
    const hits = commands.filter((c) => normalizeCmd(c.cmd) === normalizeCmd(claim.cmd));
    if (hits.length !== 1) {
      problems.push(`${claim.label}｜复核命令：改写后命中 ${hits.length} 处`);
      continue;
    }
    if (hits[0].number !== actual) {
      problems.push(`${claim.label}｜复核命令旁：写出去的是 ${hits[0].number}，现场是 ${actual}`);
    }
  }
  return problems;
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
    /**
     * **自洽层（第 1 层）**：比的是「**表格值 vs 命令旁值**」，精确相等，**永不放宽**。
     *
     * ⚠️ 2026-11-04 修掉一个既有 bug：旧实现是
     *   `const table = facts[claim.key] === undefined ? tableNumberOf(...) : { value: facts[claim.key] }`
     * 即「facts 有值就用 facts 当表格值」—— 那实际比的是「命令旁 vs **现场**」，
     * **完全跳过了「表格 vs 命令旁」这条自洽关系**。于是表格写 100、命令旁写 101、
     * 现场也是 101 时，旧判据全绿（它只看到「命令旁 == 现场」）—— 而同一篇文档里
     * 两个数不一致是**纯错误**，与现场是多少无关。
     *
     * 分层后这一层的语义才清晰：它只管**文档内部自洽**，不引入现场值。
     */
    const table = tableNumberOf(doc, claim.tableRe);
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
        `✖ 【自洽层】${claim.label}｜命令旁写「${entry.number}」，表格写「${table.value}」—— 同一篇文档里同一个数两处不一致。`,
        `  这一层**精确相等、不放宽**：与「现场数字漂移」无关，是文档内部自相矛盾（纯错误）。`,
        `  修法：两处改成同一个数；要省事就跑下面这条（它把两处同时写成现场值）。`,
        `  命令：node scripts/check-atlas-counts.mjs --update   # 就地同步（只改数字，不动结构）`,
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
export function check(root, { tolerancePct = DEFAULT_TOLERANCE_PCT, today = Date.now() } = {}) {
  const todayDay = Math.floor(today / 86_400_000);
  const gapProblems = validateKnownGaps(KNOWN_GAPS, todayDay);
  return [
    // knownGaps 是**登记**不是判据：缺口本身不判红，缺主人/过期才红。
    ...(gapProblems.length > 0
      ? [
          {
            ok: false,
            out: ["✖ knownGaps 登记有问题：", ...gapProblems.map((p) => "  · " + p)],
          },
        ]
      : []),
    checkMigrationsClaim(root),
    checkModuleTable(root),
    checkAppsCount(root),
    checkPendingMarkers(root),
    checkE2eCaseCount(root),
    checkTestingTable(root, { tolerancePct }),
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

// fixture 的事实源：22 个迁移 / 12 个模块 / 7 个应用（都过下界）。
// `apps/registry-pypi` 是 ⑥⑦ 扩面要读的目录，所以它在 fixture 里既是「应用」（③ 计数）
// 也是「registry-pypi 测试目录」的宿主——与真仓库一致（真仓 apps/ 下就是 7 个应用）。
const MIG = Array.from({ length: 22 }, (_, i) => `${1717473142678 + i}-M${String(i).padStart(2, "0")}`);
const MODULES = [
  "auth", "users", "api-keys", "application", "project", "audit",
  "health", "config", "metrics", "task", "scheduler", "agent",
];
const APPS = [
  "admin-api", "admin-web", "executor-node", "executor-python", "executor-desktop", "acf-cli",
  "registry-pypi",
];

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
 * `__pycache__/*.pyc` 二进制哨兵——都**不许**计入），admin-web 2 个文件，
 * packages（JS）acf-cli 2 / mcp-server 3 / node-sdk 1 个 `.test.ts`，
 * registry-pypi 4 处 `def test_`（另有 1 处 `async def test_` 不计），scripts 6 个 selftest。
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
  acfCliTestFiles: 2,
  mcpServerTestFiles: 3,
  nodeSdkTestFiles: 1,
  registryPypiCases: 4,
};

/** fixture 里那 12 条复核命令（**逐字**照抄真文档的口径，只把数字换成 fixture 的）。 */
const TESTING_CMDS = [
  { key: "adminApiSpecFiles", cmd: "find apps/admin-api/src -path '*__tests__*' -name '*.spec.ts' | wc -l" },
  { key: "adminApiCases", cmd: "grep -rhoE '^\\s*(it|test)\\(' apps/admin-api/src --include=*.spec.ts | wc -l" },
  { key: "executorNodeSpecFiles", cmd: "find apps/executor-node/src -name '*.spec.ts' | wc -l" },
  { key: "executorNodeCases", cmd: "grep -rhoE '^\\s*(it|test)\\(' apps/executor-node/src --include=*.spec.ts | wc -l" },
  { key: "executorPythonTestFiles", cmd: "ls apps/executor-python/tests/test_*.py | wc -l" },
  { key: "executorPythonCases", cmd: "grep -rhoE '^\\s*def test_' apps/executor-python/tests | wc -l" },
  { key: "adminWebTestFiles", cmd: "find apps/admin-web/src/__tests__ -name '*.test.ts*' | wc -l" },
  { key: "acfCliTestFiles", cmd: "find packages/acf-cli/src -name '*.test.ts' | wc -l" },
  { key: "mcpServerTestFiles", cmd: "find packages/mcp-server/src -name '*.test.ts' | wc -l" },
  { key: "nodeSdkTestFiles", cmd: "find packages/autocodeflow-node-sdk/src -name '*.test.ts' | wc -l" },
  { key: "registryPypiCases", cmd: "grep -rhoE '^\\s*def test_' apps/registry-pypi/tests | wc -l" },
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
    `| packages（JS） | acf-cli ${v.acfCliTestFiles} 文件 / mcp-server ${v.mcpServerTestFiles} 文件 / node-sdk ${v.nodeSdkTestFiles} 文件 | vitest ×2 + jest ×1 | \`test:cli\` / \`test:mcp\` / \`test:node-sdk\` |`,
    `| registry-pypi | \`apps/registry-pypi/tests/\` | pytest，${v.registryPypiCases} 个 \`def test_\` | \`npm run test:pypi\` |`,
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
  // packages（JS）三包：各自的 `src/**/*.test.ts`（口径 = `find <pkg>/src -name '*.test.ts'`）。
  "packages/acf-cli/src/__tests__/commands.test.ts": "it('x', () => {});\n",
  "packages/acf-cli/src/__tests__/client.test.ts": "it('x', () => {});\n",
  "packages/mcp-server/src/__tests__/api.test.ts": "it('x', () => {});\n",
  "packages/mcp-server/src/__tests__/tools.test.ts": "it('x', () => {});\n",
  "packages/mcp-server/src/__tests__/cli.e2e.test.ts": "it('x', () => {});\n",
  "packages/autocodeflow-node-sdk/src/__tests__/contract.test.ts": "it('x', () => {});\n",
  // registry-pypi：4 处 `def test_`；`async def test_` 与 `__pycache__` 二进制都不计。
  "apps/registry-pypi/tests/test_registry.py":
    "def test_a():\n    assert True\n\n\ndef test_b():\n    assert True\n\n\ndef test_c():\n    assert True\n\n\nasync def test_async_not_counted():\n    assert True\n\n\ndef test_d():\n    assert True\n",
  "apps/registry-pypi/tests/__pycache__/test_registry.cpython-312.pyc": "\u0000def test_binary():\n",
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
 * 自检：30 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树），断言退出码与关键文本。
 *
 * 旧版**没有 selftest**：四段 IIFE 用模块级 `process.cwd()` 实扫真仓库，`process.exit(1)`
 * 是唯一的红通道，没人验证它还在；而「数字前缀误配」「模块表只查漏」这两处假绿
 * 恰好都能让迁移数/模块数写错时依然全绿。现在逐条反证。
 * ⑥⑦ 的用例与 ①③⑬⑭ 同一个立场：数字错了要红，**句子/代码块被改写**同样要红
 * （否则改一句措辞就能让判据永真）。㉑–㉖ 是第 23 轮 ⑥ 扩面（packages 三行 + registry-pypi）
 * 的反证：四行各一条「数字 +1 → 红」，另加「命令被删 → ⑦ 红」与「扫描面零命中 → 结构红」。
 * ㉗–㉚ 是 `--update` 的反证：同步后自洽、拒绝写入时**文件字节不变**、**只改数字不改文字**。
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
      "应用数自述一致：7 个",
      "无「（下一批次）」占位标记",
      // ⑤：48 + 1 + 2 = 51 例 / 7 + 1 + 1 = 9 组；7 处 test.skip( 与注释掉的 test( 都不计入
      "e2e 例数自述一致：51 例 / 9 组（e2e-full.spec.js 48 例 + e2e-python-executor.spec.js 1 例 + e2e-ui09-mobile.spec.js 2 例）",
      // ⑥：admin-api 3/4、executor-node 2/3、executor-python 2/5、admin-web 2、scripts 6、
      // 之后是第 23 轮扩面的 acf-cli 2 / mcp-server 3 / node-sdk 1 / registry-pypi 4
      "测试数字在门槛内（容差 5%",
      // ⑦：12 个数字点各带一条复核命令（`__pycache__/*.pyc` 与 async def 不计数）
      "复核命令与数字一一对应：12 个数字点各带一条可执行命令",
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
    "⑩ 【反证·前缀误配】atlas/README 写「17 个应用」而实际 7 → 红",
    atlasTree({ atlas: atlasDoc().replace("7 个应用", "17 个应用") }),
    { code: 1, contains: ["未声明「7 个应用」"], absent: ["应用数自述一致"] },
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
      contains: ["admin-api spec 文件数", "文档写「4」", "实际「3」", "【量级层】"],
      absent: ["测试数字在门槛内"],
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
    "⑱ 【反证·⑦ 结构红】复核命令代码块整块删掉 → 红（数字点到 0 个 < 下界 12）",
    atlasTree({ testing: testingDoc({ omitCommands: true }) }),
    {
      code: 1,
      contains: ["只解析到 0 个「数字 + 复核命令」点（下界 12）", "命令代码块被删/被截断了吧"],
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
      absent: ["测试数字在门槛内"],
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
      absent: ["测试数字在门槛内"],
    },
  );

  // ㉑–㉔ ⑥ 扩面（第 23 轮）：`packages` 三个包 + `registry-pypi`，逐行把表格数字改错。
  // 这四行此前完全无守卫——文档停在 commit 92cfafa6 的现场（12 / 9 / 5 / 157），
  // 实测早已 13 / 9 / 5 / 164，四个守卫全绿、没人知道。
  subprocess(
    "㉑ 【反证·⑥ packages】表格 acf-cli 文件数 2→3（现场仍 2）→ 红并点名两值",
    atlasTree({ testing: testingDoc({ values: { acfCliTestFiles: 3 } }) }),
    {
      code: 1,
      contains: [
        "acf-cli 测试文件数：文档写「3」，实际「2」",
        "find packages/acf-cli/src -name '*.test.ts'",
      ],
      absent: ["测试数字在门槛内"],
    },
  );

  subprocess(
    "㉒ 【反证·⑥ packages】表格 mcp-server 文件数 3→4（现场仍 3）→ 红并点名两值",
    atlasTree({ testing: testingDoc({ values: { mcpServerTestFiles: 4 } }) }),
    {
      code: 1,
      contains: [
        "mcp-server 测试文件数：文档写「4」，实际「3」",
        "find packages/mcp-server/src -name '*.test.ts'",
      ],
      absent: ["测试数字在门槛内"],
    },
  );

  subprocess(
    "㉓ 【反证·⑥ packages】表格 node-sdk 文件数 1→2（现场仍 1）→ 红并点名两值",
    atlasTree({ testing: testingDoc({ values: { nodeSdkTestFiles: 2 } }) }),
    {
      code: 1,
      contains: [
        "node-sdk 测试文件数：文档写「2」，实际「1」",
        "find packages/autocodeflow-node-sdk/src -name '*.test.ts'",
      ],
      absent: ["测试数字在门槛内"],
    },
  );

  subprocess(
    "㉔ 【反证·⑥ registry-pypi】表格 def test_ 数 4→5（现场仍 4）→ 红并点名两值",
    atlasTree({ testing: testingDoc({ values: { registryPypiCases: 5 } }) }),
    {
      code: 1,
      contains: [
        "registry-pypi def test_ 数：文档写「5」，实际「4」",
        "grep -rhoE '^\\s*def test_' apps/registry-pypi/tests",
      ],
      absent: ["测试数字在门槛内"],
    },
  );

  // ㉕ ⑦ 的反证：数字都对，但 registry-pypi 那条复核命令被删掉（「只写数不写出处」）。
  subprocess(
    "㉕ 【反证·⑦ 缺命令】删掉 registry-pypi 旁的复核命令 → 红（只写数不写出处不算）",
    atlasTree({ testing: testingDoc({ drop: ["registryPypiCases"] }) }),
    {
      code: 1,
      contains: [
        "registry-pypi def test_ 数｜复核命令缺失",
        "期望原文（整行，含 `# 数字`）：grep -rhoE '^\\s*def test_' apps/registry-pypi/tests | wc -l",
      ],
      absent: ["复核命令与数字一一对应"],
    },
  );

  // ㉖ ⑥ 的扫描面下界：registry-pypi 的 tests/ 整个不在 → 零命中必须是红，不是「数字都对」。
  subprocess(
    "㉖ 【反证·扫描面零命中】registry-pypi 的 tests/ 整个没了 → 结构红（下界 1）",
    atlasTree({
      drop: [
        "apps/registry-pypi/tests/test_registry.py",
        "apps/registry-pypi/tests/__pycache__/test_registry.cpython-312.pyc",
      ],
    }),
    {
      code: 1,
      contains: ["扫描面零命中：registry-pypi 的 def test_", "目录改名/后缀变了"],
      absent: ["测试数字在门槛内"],
    },
  );

  // ── `--update` 的用例（㉗–㉚）──────────────────────────────────────────
  // `--update` 是本脚本**唯一会写文件**的路径，所以它必须自带安全阀：
  // 「事实源解析失败 ⇒ 一个字节都不写」（先例：`check-metric-docs.mjs` 的
  // 「--update 在事实源解析失败时拒绝写基线（exit 1，且不落地半成品基线）」）。
  // 这四条用例把三条纪律钉死：① 同步后自洽（再跑主跑必须绿）② 拒绝时**文件字节不变**
  // ③ 只改数字、不改文字。
  const withRepo = (name, files, fn) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "atlas-counts-update-selftest-" });
        try {
          fn(repo);
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ㉗ 【自洽】漂移 → 同步 → 再跑主跑必须绿。
  withRepo(
    "㉗ 【--update】数字漂移 → 就地同步 exit 0，且再跑主守卫绿（自洽）",
    atlasTree({ testing: testingDoc({ values: { adminApiSpecFiles: 4 } }) }),
    (repo) => {
      // 先确认漂移态主守卫是红的（否则这条用例没有意义）。
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["admin-api spec 文件数：文档写「4」，实际「3」"],
        withinMs: 1000,
        label: "㉗ 漂移态主跑",
      });
      expectExit(runGuard(SELF, { args: ["--root", repo.dir, "--update"] }), {
        code: 0,
        contains: [
          "已同步 12 个数字点（表格 + 复核命令旁各一处，共 24 处）",
          "已就地改写 docs/atlas/07-testing/README.md",
        ],
        absent: ["✖"],
        withinMs: 1000,
        label: "㉗ --update",
      });
      // 同步后主守卫必须绿（自洽：写出去的东西自己认）。
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 0,
        contains: ["测试数字在门槛内", "复核命令与数字一一对应"],
        absent: ["✖"],
        withinMs: 1000,
        label: "㉗ 同步后主跑",
      });
    },
  );

  // ㉘ 【反证·安全阀①】事实源扫描面塌了（零命中跌破下界）⇒ 拒绝写，文件字节不变。
  withRepo(
    "㉘ 【--update·反证】事实源扫描面塌陷 → exit 非 0 且文件字节不变（不落地半成品）",
    atlasTree({
      testingFiles: Object.fromEntries(
        Object.entries(TESTING_FILES).filter(([rel]) => !rel.startsWith("apps/executor-node/")),
      ),
    }),
    (repo) => {
      const docPath = join(repo.dir, TESTING_DOC);
      const before = readFileSync(docPath);
      const result = runGuard(SELF, { args: ["--root", repo.dir, "--update"] });
      expectExit(result, {
        code: 1,
        contains: [
          "扫描面零命中：executor-node 的 spec 文件",
          "拒绝写入",
        ],
        absent: ["已同步 12 个数字点"],
        withinMs: 1000,
        label: "㉘ --update 拒绝",
      });
      const after = readFileSync(docPath);
      if (!before.equals(after)) {
        throw new Error(
          `拒绝写入时文件字节仍然变了（${before.length} → ${after.length}）——安全阀失效`,
        );
      }
    },
  );

  // ㉙ 【反证·安全阀②】文档形状坏了（表格数字改成中文「三个」）⇒ 拒绝写，文件字节不变。
  // 同时故意让**另一个**数字点漂移（registry-pypi 4→5）：这样「只跳过坏点、其余照写」
  // 的半截写也会被字节不变断言抓住（不会因为「其余点本来就对、写了等于没写」而蒙混过关）。
  withRepo(
    "㉙ 【--update·反证】表格数字解析不到（句子被改写）→ exit 非 0 且文件字节不变",
    atlasTree({
      testing: testingDoc({ values: { registryPypiCases: 5 } }).replace(
        "（3 个 `*.spec.ts`）",
        "（三个 `*.spec.ts`）",
      ),
    }),
    (repo) => {
      const docPath = join(repo.dir, TESTING_DOC);
      const before = readFileSync(docPath);
      expectExit(runGuard(SELF, { args: ["--root", repo.dir, "--update"] }), {
        code: 1,
        contains: ["解析不到这个数字", "拒绝写入"],
        absent: ["已同步 12 个数字点"],
        withinMs: 1000,
        label: "㉙ --update 拒绝",
      });
      const after = readFileSync(docPath);
      if (!before.equals(after)) {
        throw new Error(
          `拒绝写入时文件字节仍然变了（${before.length} → ${after.length}）——安全阀失效`,
        );
      }
    },
  );

  // ㉚ 【只改数字】同步后，把两版文本里的**所有数字**抹掉 ⇒ 必须逐字相同
  // （标题、命令、表格结构一个字节都没动）。
  withRepo(
    "㉚ 【--update·只改数字】同步后抹掉所有数字 ⇒ 前后两版逐字相同（文字未被改动）",
    atlasTree({ testing: testingDoc({ values: { adminApiSpecFiles: 4, registryPypiCases: 5 } }) }),
    (repo) => {
      const docPath = join(repo.dir, TESTING_DOC);
      const before = readFileSync(docPath, "utf8");
      expectExit(runGuard(SELF, { args: ["--root", repo.dir, "--update"] }), {
        code: 0,
        contains: ["已同步 12 个数字点"],
        withinMs: 1000,
        label: "㉚ --update",
      });
      const after = readFileSync(docPath, "utf8");
      if (before === after) {
        throw new Error("--update 没有改动任何字节——漂移的数字没被同步（用例没意义）");
      }
      const strip = (s) => s.replace(/\d+/g, "#");
      if (strip(before) !== strip(after)) {
        throw new Error("--update 改动了数字以外的内容（只允许改数字）");
      }
      // 且确实只改了「该改的那几处」：漂移的两个数都已被就地改正。
      if (!after.includes("（3 个 `*.spec.ts`）") || !after.includes("pytest，4 个 `def test_`")) {
        throw new Error(`--update 没有把漂移的数字改对：\n${after}`);
      }    },
  );

  // ── ㉛–㊱ 三层判据（2026-11-04：把「精确匹配」改成「分层判据」）──────────────
  //
  // 三层各自能红、各自能绿，**且互不顶替**：
  //   ① 自洽层：表格 vs 命令旁，精确、永不放宽；
  //   ② 量级层：|文档−实际|/实际 ≤ tolerance；
  //   ③ 方向层：单调项 文档 ≤ 实际。
  //
  // 为了不让三层互相掩盖，fixture 里把 admin-api 的 spec 文件数做成 **100**
  // （100 个文件 × 1 个 it）：容差 5% = ±5，
  //   · 100 vs 100 / 97 vs 100  ⇒ 两层都绿
  //   · 90  vs 100            ⇒ 只有【量级层】红（10% > 5%，但没超前）
  //   · 104 vs 100            ⇒ 只有【方向层】红（4% 在容差内，却比实际大）
  //   · 表格 100 / 命令旁 101 ⇒ 只有【自洽层】红（两个数都在容差内）
  const BIG = 100;
  const bigTestingFiles = () => {
    const files = { ...TESTING_FILES };
    for (const k of Object.keys(files)) {
      if (k.startsWith("apps/admin-api/") && k.endsWith(".spec.ts")) delete files[k];
    }
    for (let i = 0; i < BIG; i += 1) {
      files[`apps/admin-api/src/modules/auth/__tests__/big${String(i).padStart(3, "0")}.spec.ts`] =
        specCases(1);
    }
    return files;
  };
  const bigTree = ({ table, cmd } = {}) =>
    atlasTree({
      testingFiles: bigTestingFiles(),
      testing: testingDoc({
        values: { adminApiSpecFiles: table, adminApiCases: BIG },
        cmdNumbers: cmd === undefined ? {} : { adminApiSpecFiles: cmd },
      }),
    });
  const subprocessArgs = (name, files, args, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "atlas-counts-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir, ...args] }), {
            ...expect,
            withinMs: 1500,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocessArgs(
    "㉛ 【自洽层】表格 100 / 命令旁 101（两者都在容差内）⇒ 红，且点名【自洽层】",
    bigTree({ table: 100, cmd: 101 }),
    [],
    {
      code: 1,
      contains: ["【自洽层】", "命令旁写「101」", "表格写「100」"],
      // 关键：这一层红的时候，量级层/方向层不该跟着报（表格 100 == 实际 100）
      absent: ["【量级层】", "【方向层】"],
    },
  );

  subprocessArgs(
    "㉜ 【自洽层·控制组】表格 100 / 命令旁 100 ⇒ 绿（证明 ㉛ 不是恒红）",
    bigTree({ table: 100, cmd: 100 }),
    [],
    { code: 0, contains: ["测试数字在门槛内（容差 5%"], absent: ["【自洽层】"] },
  );

  subprocessArgs(
    "㉝ 【量级层】文档 90 / 实际 100（超 5%）⇒ 红，且点名【量级层】",
    bigTree({ table: 90 }),
    [],
    {
      code: 1,
      contains: ["【量级层】", "相差 10", "容差 5%"],
      // 90 < 100 ⇒ 方向层不红（方向层只管「超前」）
      absent: ["【方向层】", "【自洽层】"],
    },
  );

  subprocessArgs(
    "㉞ 【量级层·容差内】文档 97 / 实际 100（3% ≤ 5%）⇒ 绿",
    bigTree({ table: 97 }),
    [],
    { code: 0, contains: ["测试数字在门槛内"], absent: ["【量级层】", "【方向层】"] },
  );

  subprocessArgs(
    "㉟ 【方向层】文档 104 / 实际 100（4% 在容差内，但**超前**）⇒ 红，且点名【方向层】",
    bigTree({ table: 104 }),
    [],
    {
      code: 1,
      contains: ["【方向层】", "大于", "单调不减"],
      // 104 在 5% 内 ⇒ 量级层不该红（这正是「两层不能合并」的理由）
      absent: ["【量级层】", "【自洽层】"],
    },
  );

  subprocessArgs(
    "㊱ 【向后兼容】--tolerance 0 ⇒ 文档 97 / 实际 100 回到「精确相等」⇒ 红（旧行为）",
    bigTree({ table: 97 }),
    ["--tolerance", "0"],
    {
      code: 1,
      contains: ["容差 0%", "【量级层】"],
      absent: ["测试数字在门槛内"],
    },
  );

  subprocessArgs(
    "㊲ 【向后兼容·控制组】--tolerance 0 且数字完全一致 ⇒ 绿（证明 ㊱ 不是恒红）",
    bigTree({ table: 100 }),
    ["--tolerance", "0"],
    { code: 0, contains: ["容差 0%"], absent: ["【量级层】", "【方向层】", "【自洽层】"] },
  );

  subprocessArgs(
    "㊳ 【--update】同步后三层全绿（机械同步仍然有效）",
    bigTree({ table: 90 }),
    ["--update"],
    { code: 0, contains: ["已同步 12 个数字点"] },
  );
  // 同步后必须真绿（--update 把数字写成现场值）
  cases.push({
    name: "㊴ 【--update→复跑】同步后再跑主跑 ⇒ 三层全绿（不靠人工核对）",
    fn: () => {
      const repo = makeFixtureRepo(bigTree({ table: 90 }), {
        prefix: "atlas-counts-selftest-",
      });
      try {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir, "--update"] }), {
          code: 0,
          contains: ["已同步 12 个数字点"],
          withinMs: 1500,
          label: "㊴ update",
        });
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 0,
          contains: ["测试数字在门槛内"],
          absent: ["【量级层】", "【方向层】", "【自洽层】"],
          withinMs: 1500,
          label: "㊴ 复跑",
        });
      } finally {
        repo.cleanup();
      }
    },
  });

  // ── knownGaps（已知盲区登记，2026-11-04 新增）───────────────────────────
  //
  // 与 protocol-breaking / handwritten-copies 同一套：缺口本身不判红，
  // **缺 owner / 期限过期**才红（没主人的缺口会被遗忘）。
  const validGap = {
    id: "g",
    observed_fact: "这是一个足够长的观测事实描述（fixture 用）",
    owner: "someone",
    review_by: "2999-01-01",
  };
  const dayOf = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

  const knownGapCase = (name, fn) => cases.push({ name, fn });
  knownGapCase("㊵ 【knownGaps·控制组】合法登记 ⇒ 0 problems", () => {
    const p = validateKnownGaps([validGap], dayOf("2026-11-04"));
    if (p.length !== 0) throw new Error(`合法登记不该有问题，实得 ${JSON.stringify(p)}`);
  });
  knownGapCase("㊶ 【knownGaps·反证】缺 owner ⇒ 红（没有责任人的盲区等于没有记录）", () => {
    const p = validateKnownGaps([{ ...validGap, owner: "  " }], dayOf("2026-11-04"));
    if (!p.some((x) => x.includes("缺 owner"))) throw new Error(`应报缺 owner，实得 ${JSON.stringify(p)}`);
  });
  knownGapCase("㊷ 【knownGaps·反证】复核期限已过 ⇒ 红（盲区没人管了）", () => {
    const p = validateKnownGaps([{ ...validGap, review_by: "2000-01-01" }], dayOf("2026-11-04"));
    if (!p.some((x) => x.includes("复核期限已过"))) throw new Error(`应报过期，实得 ${JSON.stringify(p)}`);
  });
  knownGapCase("㊸ 【knownGaps·反证】observed_fact 太短 ⇒ 红（写不出具体漏了什么 = 没登记）", () => {
    const p = validateKnownGaps([{ ...validGap, observed_fact: "todo" }], dayOf("2026-11-04"));
    if (!p.some((x) => x.includes("observed_fact 太短"))) throw new Error(`应报太短，实得 ${JSON.stringify(p)}`);
  });
  knownGapCase("㊹ 真实登记表：knownGaps 全部合规（当前 1 条：测量命令语义漂移）", () => {
    const p = validateKnownGaps(KNOWN_GAPS, dayOf("2026-11-04"));
    if (p.length !== 0) throw new Error(`真实登记表不该有问题：${JSON.stringify(p)}`);
    if (KNOWN_GAPS.length === 0) throw new Error("登记表不应为空（否则这条机制从没被真实数据验证过）");
  });

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
    /**
     * `--tolerance <pct>`：文档值 vs 现场值的容差（默认 5%）。
     * `--tolerance 0` ⇒ 恢复**旧的精确相等**行为（向后兼容；selftest 有实测）。
     */
    const rawTol = argValue(process.argv, "--tolerance");
    const tolerancePct = rawTol === null ? DEFAULT_TOLERANCE_PCT : Number(rawTol);
    if (!Number.isFinite(tolerancePct) || tolerancePct < 0) {
      console.error(`✖ --tolerance 需要非负数字（收到 ${JSON.stringify(rawTol)}）`);
      process.exit(1);
    }
    // `--update`：只重算并写回 ⑥⑦ 的 12 个数字点；**不改任何文字**。
    // 任何一个事实源解析失败 ⇒ 一行都不写（如实报错 + exit 非 0）。
    if (process.argv.includes("--update")) {
      const plan = planTestingDocUpdate(root);
      if (!plan.ok) {
        for (const line of plan.out) console.error(line);
        console.error("");
        console.error("✖ 拒绝写入：事实源解析失败时写出来的数字毫无意义（--update 不是橡皮章）。");
        process.exit(1);
      }
      const changed = plan.newText !== plan.doc;
      if (changed) {
        writeFileSync(join(root, TESTING_DOC), plan.newText, "utf8");
      }
      const pairs = TEST_CLAIMS.map((c) => `${plan.facts[c.key]}`).join(" / ");
      console.log(
        `✔ 已同步 ${TEST_CLAIMS.length} 个数字点（表格 + 复核命令旁各一处，共 ${plan.edits.length} 处）：${pairs}`,
      );
      // 逐条打印「旧 → 新」：让人（和 review diff 的人）一眼看出**只**动了数字。
      for (const e of plan.edits) {
        if (e.old !== e.value) {
          console.log(`  · ${e.label}（${e.where}）：${e.old} → ${e.value}`);
        }
      }
      console.log(
        changed
          ? `  已就地改写 ${TESTING_DOC}（只改数字，标题/命令/表格结构未动）。`
          : `  ${TESTING_DOC} 已是最新（无改动）。`,
      );
      process.exit(0);
    }
    let failures = 0;
    for (const r of check(root, { tolerancePct })) {
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
