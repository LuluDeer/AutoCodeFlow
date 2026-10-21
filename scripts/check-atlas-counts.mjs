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
 * 判据（三项，均带规模下界）：
 *   ① 迁移数与**首尾文件名**必须与磁盘一致；
 *   ② 模块索引表的数据行数必须等于 `src/modules` 下真实模块数（排除 `__tests__`）；
 *   ③ `atlas/README.md` 的「N 个应用」必须等于 `apps/` 下真实应用数（排除非应用目录）。
 *
 * 用法：node scripts/check-atlas-counts.mjs
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
let failures = 0;

/** `apps/` 下不是应用的两个目录（测试产物）。 */
const NON_APP_DIRS = new Set([".pytest-tmp", "test-results"]);

/* ① 迁移数 + 首尾 */
(function checkMigrationsClaim() {
  const DOC = join(ROOT, "docs", "atlas", "01-apps", "admin-api", "README.md");
  const DIR = join(ROOT, "apps", "admin-api", "src", "migrations");
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && !f.endsWith(".d.ts"))
    .sort();
  if (files.length < 20) {
    console.error(`✖ 迁移目录只扫到 ${files.length} 个文件 —— 扫描器失效了。`);
    failures += 1;
    return;
  }
  const doc = readFileSync(DOC, "utf8");
  const first = files[0].replace(/\.ts$/, "");
  const last = files[files.length - 1].replace(/\.ts$/, "");
  const problems = [];
  if (!doc.includes(`${files.length}** 个 TypeORM 迁移`) && !doc.includes(`${files.length} 个 TypeORM 迁移`)) {
    problems.push(`文档未声明迁移数 ${files.length}`);
  }
  if (!doc.includes(first)) problems.push(`文档未出现首个迁移 ${first}`);
  if (!doc.includes(last)) problems.push(`文档未出现末个迁移 ${last}`);
  if (problems.length > 0) {
    console.error("✖ atlas 迁移自述与实际不符：");
    for (const p of problems) console.error("  · " + p);
    failures += 1;
    return;
  }
  console.log(`✔ 迁移自述一致：${files.length} 个（${first} … ${last}）。`);
})();

/* ② 模块索引表行数 */
(function checkModuleTableRows() {
  const DOC = join(ROOT, "docs", "atlas", "01-apps", "admin-api", "README.md");
  const DIR = join(ROOT, "apps", "admin-api", "src", "modules");
  const real = readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "__tests__")
    .map((d) => d.name);
  if (real.length < 10) {
    console.error(`✖ modules 目录只扫到 ${real.length} 个 —— 扫描器失效了。`);
    failures += 1;
    return;
  }
  const doc = readFileSync(DOC, "utf8");
  const section = doc.split("## 模块索引")[1];
  if (!section) {
    console.error("✖ 找不到「## 模块索引」小节。");
    failures += 1;
    return;
  }
  const rows = section
    .split("\n")
    .filter((l) => /^\|\s*[a-z][a-z0-9-]*\s*\|/.test(l) && !l.startsWith("| 模块"));
  const listed = new Set(rows.map((l) => l.split("|")[1].trim()));
  const missing = real.filter((m) => !listed.has(m)).sort();
  if (missing.length > 0) {
    console.error("✖ 模块索引漏了真实模块：" + missing.join(", "));
    console.error("  修法：在 docs/atlas/01-apps/admin-api/README.md 的模块索引补行；不要改守卫。");
    failures += 1;
    return;
  }
  console.log(`✔ 模块索引一致：${real.length} 个真实模块全部在表内（表内 ${listed.size} 行）。`);
})();

/* ③ apps 数自述 */
(function checkAppsCountClaim() {
  const DOC = join(ROOT, "docs", "atlas", "README.md");
  const apps = readdirSync(join(ROOT, "apps"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NON_APP_DIRS.has(d.name))
    .map((d) => d.name);
  if (apps.length < 5) {
    console.error(`✖ apps 目录只扫到 ${apps.length} 个 —— 扫描器失效了。`);
    failures += 1;
    return;
  }
  const doc = readFileSync(DOC, "utf8");
  if (!doc.includes(`${apps.length} 个应用`)) {
    console.error(`✖ atlas/README.md 未声明「${apps.length} 个应用」（实际 apps/ 下有 ${apps.length} 个：${apps.join(", ")}）。`);
    failures += 1;
    return;
  }
  console.log(`✔ 应用数自述一致：${apps.length} 个。`);
})();

/* ④ 「（下一批次）」占位标记：文件已存在就不该再挂这个标记 */
(function checkPendingBatchMarkers() {
  const DOC_DIR = join(ROOT, "docs", "atlas", "01-apps");
  const stale = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith(".md")) continue;
      const text = readFileSync(p, "utf8");
      const rel = p.slice(ROOT.length + 1).split("\\").join("/");
      for (const m of text.matchAll(/\]\(([^)]+\.md)\)（下一批次）/g)) {
        const target = join(dirname(p), m[1]);
        if (existsSync(target)) stale.push(rel + " → " + m[1]);
      }
    }
  };
  walk(DOC_DIR);
  if (stale.length > 0) {
    console.error(`✖ ${stale.length} 处「（下一批次）」标记挂在**已存在**的文档上（读者会以为还没写）：`);
    for (const s of stale) console.error("  · " + s);
    console.error("  修法：删掉标记（文档已经写好了）。");
    failures += 1;
    return;
  }
  console.log("✔ 无「（下一批次）」占位标记挂在已有文档上。");
})();

if (failures > 0) process.exit(1);
