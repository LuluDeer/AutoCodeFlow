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
 * 判据（四项，均带规模下界）：
 *   ① 迁移数与**首尾文件名**必须与磁盘一致；
 *   ② 模块索引表的行必须**恰好等于** `src/modules` 下的真实模块集合（排除 `__tests__`）：
 *      漏行 = 真实模块没文档；多行 = 文档还在写一个已经不存在的模块；
 *   ③ `atlas/README.md` 的「N 个应用」必须等于 `apps/` 下真实应用数（排除非应用目录）；
 *   ④ 「（下一批次）」占位标记不得挂在**已存在**的文档上。
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

/** 扫描面下界（2026-10-29 实测：迁移 122 / 模块 22 / 应用 7）。只增不减，防「分母塌了」。 */
export const MIN_MIGRATION_FILES = 20;
export const MIN_MODULES = 10;
export const MIN_APPS = 5;

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

/** 四项判据的聚合；`root` 是仓库根（selftest 传 fixture 树）。 */
export function check(root) {
  return [
    checkMigrationsClaim(root),
    checkModuleTable(root),
    checkAppsCount(root),
    checkPendingMarkers(root),
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

/** 造一棵 fixture 仓库树；只传要变的部分。`migrations/apps/modules` 传 [] 即「目录被改名/清空」。 */
function atlasTree({ migrations = MIG, modules = MODULES, apps = APPS, admin, atlas, extra = {}, drop = [] } = {}) {
  const files = {};
  for (const m of migrations) files[`${MIGRATIONS_DIR}/${m}.ts`] = "export class M {}\n";
  for (const m of modules) files[`${MODULES_DIR}/${m}/index.ts`] = "export {};\n";
  for (const a of apps) files[`apps/${a}/package.json`] = { name: a };
  files[ADMIN_DOC] = admin ?? adminDoc({ modules });
  files[ATLAS_DOC] = atlas ?? atlasDoc({ apps });
  files[`${APPS_DOC_DIR}/admin-api/modules/auth.md`] = "# auth\n";
  Object.assign(files, extra);
  for (const d of drop) delete files[d];
  return files;
}

/**
 * 自检：11 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树），断言退出码与关键文本。
 *
 * 旧版**没有 selftest**：四段 IIFE 用模块级 `process.cwd()` 实扫真仓库，`process.exit(1)`
 * 是唯一的红通道，没人验证它还在；而「数字前缀误配」「模块表只查漏」这两处假绿
 * 恰好都能让迁移数/模块数写错时依然全绿。现在逐条反证。
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

  subprocess("① 干净树：迁移数/首尾、模块表、应用数、占位标记四项全绿", atlasTree(), {
    code: 0,
    contains: [
      "迁移自述一致：22 个",
      "模块索引一致：12 个真实模块全部在表内（表内 12 行）",
      "应用数自述一致：6 个",
      "无「（下一批次）」占位标记",
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
