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
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\  const absent = [...prefixes].filter((p) => !doc.includes(p)).sort();");
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

if (failures > 0) process.exit(1);
