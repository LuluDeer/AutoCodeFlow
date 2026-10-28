#!/usr/bin/env node
/**
 * MCP 工具地图 vs 源码 守卫。
 *
 * 由来：`docs/atlas/05-interfaces/mcp-tools.md` 长期写着「40 个」，而 `tools.ts` 实际注册 **56** 个 ——
 * **漏了 16 个**（export/import task、模板清单、mutex 四件套、project 三件套、SOP 六件套）。
 * 这正是本仓已经踩过三次的**「手写枚举单向腐烂」**：CLI 命令表（R69 已加 `check-cli-doc.mjs`）、
 * REST 端点附录（已加 `gen-api-reference-appendix --check`）、审计动作表（已加 `check-audit-actions-doc.mjs`）——
 * **MCP 是最后一个没人守的对外接口面**。
 *
 * 判据：
 *   ① 源码里每个 `server.tool("<name>"` / `server.registerTool("<name>"` 必须出现在文档里；
 *   ② 规模下界（≥ 40）：正则失效时「0 个缺失」是**永真断言**，宁可红。
 *
 * 反向不做：文档可以描述已废弃/未注册的工具（历史沿革），那是叙事不是漂移。
 *
 * 用法：node scripts/check-mcp-tools-doc.mjs
 */
/**
 * 接口地图 vs 代码守卫（两类自述清单，同一个病）。
 *
 * 病名：**手写枚举单向腐烂** —— 加功能的人不会回头改清单，删功能的人才会（因为删了会报错）。
 * 本仓已为此建过三道：CLI 命令表（`check-cli-doc.mjs`）、REST 全量附录
 * （`gen-api-reference-appendix --check`）、审计动作表（`check-audit-actions-doc.mjs`）。
 * 本脚本盯另外两处：
 *
 * ① `docs/atlas/05-interfaces/mcp-tools.md` —— 曾长期写「40 个」，而 `tools.ts` 实际注册 **56** 个，
 *    **漏了 16 个**且是**有序地漏**（越新的域越不在表里：Mutex / Project / SOP 三节整节缺失）。
 * ② `docs/atlas/05-interfaces/rest-api.md` —— 头部曾写「24 个 controller 文件，21 个路由前缀」，
 *    而实际 30 / 28；更糟的是 **7 个路由前缀整域未出现**（agent / agent-collab / auth-oidc / mutex-groups /
 *    sop / task-templates / webhooks-tasks）。本页是「地图」不是全量清单，但**整个域缺失**属于漂移。
 *
 * 判据（两组，均带规模下界防「0 条 → 0 缺失」的永真断言）：
 *   ① 源码每个 `server.tool("<name>")` 必须出现在 mcp-tools.md；
 *   ② 源码每个 `@Controller("<prefix>")` 的**非空前缀**必须出现在 rest-api.md。
 * 反向均不校验：文档可以记叙已废弃/未注册项，那是沿革不是漂移。
 *
 * 用法：node scripts/check-interface-maps.mjs
 */import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failures = 0;

/** ① MCP 工具名 */
(function checkMcpTools() {
  const SRC = join(ROOT, "packages", "mcp-server", "src", "tools.ts");
  const DOC = join(ROOT, "docs", "atlas", "05-interfaces", "mcp-tools.md");
  const MIN_EXPECTED_TOOLS = 40;

  const src = readFileSync(SRC, "utf8");
  const doc = readFileSync(DOC, "utf8");
  const names = [...src.matchAll(/server\.(?:tool|registerTool)\(\s*["'`]([a-z0-9_]+)["'`]/g)].map((m) => m[1]);

  if (names.length < MIN_EXPECTED_TOOLS) {
    console.error("✖ MCP：只解析出 " + names.length + " 个工具（下界 " + MIN_EXPECTED_TOOLS + "）—— 扫描器失效了。");
    failures += 1;
    return;
  }
  const missing = names.filter((n) => !doc.includes(n));
  if (missing.length > 0) {
    console.error("✖ MCP 工具地图漂移：源码注册 " + names.length + " 个，文档缺 " + missing.length + " 个");
    for (const n of missing) console.error("  · " + n);
    console.error("  修法：补进 docs/atlas/05-interfaces/mcp-tools.md 的对应域表格，并同步各域计数与文首总数。");
    failures += 1;
    return;
  }
  // ② 分域计数：文档每个 `### <域> 域 — register<X>Tools（N 个…）` 的 N 必须等于该函数实际注册数。
  // 只校验工具名（上面那段）是不够的：R95 修文档时手改过 `18 → 21`、`40 → 56` 这类数字，
  // 而名字全对、数字全错的地图同样会误导人（「Task 域 18 个」而实际 21 个）。
  const fnPositions = [...src.matchAll(/export function (register\w+Tools)\(/g)].map((m) => ({
    name: m[1],
    idx: m.index,
  }));
  if (fnPositions.length < 5) {
    console.error(`✖ MCP：只解析出 ${fnPositions.length} 个 register*Tools 函数（<5）—— 解析器失效。`);
    failures += 1;
    return;
  }
  const actualByFn = new Map();
  for (let i = 0; i < fnPositions.length; i++) {
    const start = fnPositions[i].idx;
    const end = i + 1 < fnPositions.length ? fnPositions[i + 1].idx : src.length;
    const seg = src.slice(start, end);
    actualByFn.set(
      fnPositions[i].name,
      [...seg.matchAll(/server\.(?:tool|registerTool)\(\s*["'`]([a-z0-9_]+)["'`]/g)].length,
    );
  }
  // 标题形如 `### Task 域 — registerTaskTools（21 个）` / `（9 个，DEP-04 审批语义）`
  const docCounts = new Map();
  for (const m of doc.matchAll(/^###[^\n]*—\s*(register\w+Tools)（(\d+) 个[^）]*）/gm)) {
    docCounts.set(m[1], Number(m[2]));
  }
  const countProblems = [];
  for (const [fn, actual] of actualByFn) {
    const documented = docCounts.get(fn);
    if (documented === undefined) {
      countProblems.push(`${fn}：文档没有带计数的分节标题（实际 ${actual} 个）`);
    } else if (documented !== actual) {
      countProblems.push(`${fn}：文档写 ${documented} 个，实际 ${actual} 个`);
    }
  }
  if (countProblems.length > 0) {
    console.error("✖ MCP 工具地图**分域计数**漂移：");
    for (const p of countProblems) console.error("  · " + p);
    console.error("  修法：改 docs/atlas/05-interfaces/mcp-tools.md 里对应小标题的计数。");
    failures += 1;
    return;
  }

  console.log("✔ MCP 工具地图一致：" + names.length + " 个工具全部在文档中出现。");
})();

/** ② REST 路由前缀 */
(function checkRestControllerPrefixes() {
  const SRC_DIR = join(ROOT, "apps", "admin-api", "src");
  const DOC = join(ROOT, "docs", "atlas", "05-interfaces", "rest-api.md");
  const MIN_EXPECTED_PREFIXES = 20;

  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.controller\.ts$/.test(e.name) && !e.name.endsWith(".spec.ts")) files.push(p);
    }
  })(SRC_DIR);

  const prefixes = new Set();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const m = /@Controller\(\s*(?:"([^"]*)"|'([^']*)'|)\s*\)/.exec(src);
    const p = (m?.[1] ?? m?.[2] ?? "").trim();
    if (p) prefixes.add(p);
  }

  if (prefixes.size < MIN_EXPECTED_PREFIXES) {
    console.error("✖ REST：只解析出 " + prefixes.size + " 个路由前缀（下界 " + MIN_EXPECTED_PREFIXES + "）—— 扫描器失效了。");
    failures += 1;
    return;
  }
  const doc = readFileSync(DOC, "utf8");
  // 必须作为**反引号包住的路由路径**出现（`/sop` 或 `/sop/...`），而不是随便在正文里提一句：
  // 只做 `doc.includes(prefix)` 时，删掉整个 SOP 一节仍会因为别处的 `/sop/assignments/...` 而假绿
  // （实测反证时踩到：删掉「## SOP」整节，守卫仍然通过）。
  // 正则转义：把前缀里的正则元字符字面化。**注意**：替换串必须是 "\\$&"，
  // 历史版本这里被写坏过（替换串里塞进了一整行 JS 源码），后果是含 `.` `(`
  // 等元字符的路由前缀被替换成垃圾串 → 该前缀永远匹配不上 → 守卫对这类
  // 前缀永久假绿（当前前缀恰好都是普通字符，所以从未暴露）。反证见
  // scripts/check-interface-maps.selftest.mjs 的 escapeRe 用例。
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 自检（判据自身的判据）：历史版本这里曾被写坏成「替换串里塞一整行 JS 源码」——
  // 语法仍合法，含 `.` `(` 等元字符的前缀被替换成垃圾串后**永久匹配不上**，
  // 于是这类前缀的缺失检查静默失效（当前前缀恰好都是普通字符，所以从未暴露）。
  // 一旦转义逻辑被改坏，下面这条立即红，不再依赖「恰好没有元字符」的运气。
  {
    const probe = escapeRe("a.b(c)");
    if (probe !== "a\\.b\\(c\\)") {
      console.error(
        "✖ escapeRe 自检失败：期望 a\\.b\\(c\\)，实际 " + JSON.stringify(probe) +
          " —— 判据对含正则元字符的路由前缀会永久假绿。",
      );
      failures += 1;
      return;
    }
  }
  const absent = [...prefixes]
    .filter((p) => !new RegExp("`/" + escapeRe(p) + "(`|/)").test(doc))
    .sort();
  if (absent.length > 0) {
    console.error("✖ REST 地图漂移：源码有 " + prefixes.size + " 个路由前缀，文档完全没出现 " + absent.length + " 个");
    for (const p of absent) console.error("  · /" + p);
    console.error("  修法：在 docs/atlas/05-interfaces/rest-api.md 补该域一节（至少列出主要路由），并同步头部计数。");
    failures += 1;
    return;
  }
  console.log("✔ REST 地图一致：" + prefixes.size + " 个路由前缀全部在文档中出现（" + files.length + " 个 controller 文件）。");
})();

/** ③ SDK 文档里的 lockstep 版本声明 */
(function checkSdkVersionClaim() {
  const DOC = join(ROOT, "docs", "atlas", "05-interfaces", "sdks.md");
  const MCP_PKG = join(ROOT, "packages", "mcp-server", "package.json");

  const doc = readFileSync(DOC, "utf8");
  const mcpVersion = JSON.parse(readFileSync(MCP_PKG, "utf8")).version;
  const claimed = /当前\s*\**\s*(\d+\.\d+\.\d+)/.exec(doc);
  if (!claimed) {
    console.error("✖ sdks.md 里找不到「当前 X.Y.Z」版本声明 —— 判据失配（不是声明消失了就是格式变了）。");
    failures += 1;
    return;
  }
  if (claimed[1] !== mcpVersion) {
    console.error(
      `✖ sdks.md 版本声明与实际不符：文档写 ${claimed[1]}，mcp-server 实际 ${mcpVersion}（lockstep 单版本线）。`,
    );
    console.error("  修法：把 sdks.md 的「当前 X.Y.Z」改成实际版本；不要改守卫。");
    failures += 1;
    return;
  }
  console.log(`✔ SDK 版本声明一致：sdks.md 与 mcp-server 均为 ${mcpVersion}。`);
})();

/** ④ 审计动作 → 前端标签与双语词条 */
(function checkAuditActionLabels() {
  const API_SRC = join(ROOT, "apps", "admin-api", "src");
  const UI = join(ROOT, "apps", "admin-web", "src", "pages", "audit", "index.tsx");
  const ZH = join(ROOT, "apps", "admin-web", "src", "locales", "zh.ts");
  const EN = join(ROOT, "apps", "admin-web", "src", "locales", "en.ts");

  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) files.push(p);
    }
  })(API_SRC);

  const actions = new Set();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/action:\s*"([a-z0-9_]+\.[a-z0-9_.]+)"/g)) actions.add(m[1]);
  }
  if (actions.size < 40) {
    console.error(`✖ 只解析出 ${actions.size} 个审计动作 —— 扫描器失效了。`);
    failures += 1;
    return;
  }

  const ui = readFileSync(UI, "utf8");
  const block = /const ACTION_LABEL_KEYS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(ui);
  if (!block) {
    console.error("✖ 找不到 ACTION_LABEL_KEYS 字面量 —— 判据失配。");
    failures += 1;
    return;
  }
  const mapped = new Set([...block[1].matchAll(/'([a-z0-9_.]+)'\s*:/g)].map((m) => m[1]));
  const labelKeys = new Set([...block[1].matchAll(/:\s*'(audit\.action\.[a-z0-9_]+)'/g)].map((m) => m[1]));

  const unmapped = [...actions].filter((a) => !mapped.has(a)).sort();
  const zh = readFileSync(ZH, "utf8");
  const en = readFileSync(EN, "utf8");
  const missingI18n = [...labelKeys].flatMap((k) => {
    const out = [];
    if (!zh.includes(`'${k}'`)) out.push(`${k} (zh)`);
    if (!en.includes(`'${k}'`)) out.push(`${k} (en)`);
    return out;
  });

  if (unmapped.length > 0 || missingI18n.length > 0) {
    if (unmapped.length) console.error(`✖ ${unmapped.length} 个审计动作在前端没有标签映射（会显示原始码）：`);
    for (const a of unmapped) console.error("  · " + a);
    if (missingI18n.length) console.error(`✖ ${missingI18n.length} 个标签键缺少词条：`);
    for (const k of missingI18n) console.error("  · " + k);
    console.error("  修法：补 ACTION_LABEL_KEYS 与 zh/en 词条；不要改守卫。");
    failures += 1;
    return;
  }
  console.log(`✔ 审计动作标签一致：${actions.size} 个动作全部有标签，${labelKeys.size} 个键在 zh/en 都有词条。`);
})();

if (failures > 0) process.exit(1);
