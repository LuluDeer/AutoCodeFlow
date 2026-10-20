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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "packages", "mcp-server", "src", "tools.ts");
const DOC = join(ROOT, "docs", "atlas", "05-interfaces", "mcp-tools.md");

/** 规模下界：工具数只会增不会骤降；低于它说明**扫描器**坏了，不是工具变少。 */
const MIN_EXPECTED_TOOLS = 40;

const src = readFileSync(SRC, "utf8");
const doc = readFileSync(DOC, "utf8");

const names = [
  ...src.matchAll(/server\.(?:tool|registerTool)\(\s*["'`]([a-z0-9_]+)["'`]/g),
].map((m) => m[1]);

if (names.length < MIN_EXPECTED_TOOLS) {
  console.error(
    "✖ 只解析出 " + names.length + " 个 MCP 工具（下界 " + MIN_EXPECTED_TOOLS + "）—— 扫描器失效了，不是工具变少。",
  );
  process.exit(1);
}

const missing = names.filter((n) => !doc.includes(n));

if (missing.length > 0) {
  console.error("");
  console.error("✖ MCP 工具地图漂移：源码注册 " + names.length + " 个，文档缺 " + missing.length + " 个");
  for (const n of missing) console.error("  · " + n);
  console.error("");
  console.error("  修法：把上面每个工具补进 docs/atlas/05-interfaces/mcp-tools.md 的对应域表格，");
  console.error("  并同步该域的小标题计数与文首总数。**不要**改守卫放行。");
  process.exit(1);
}

console.log(
  "✔ MCP 工具地图一致：源码注册的 " + names.length + " 个工具全部在文档中出现。",
);
