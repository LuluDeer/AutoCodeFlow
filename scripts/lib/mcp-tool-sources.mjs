// MCP 工具注册面的**单一取数点**（2026-11-04 R6「工具清单化」拆分组后补）。
//
// ## 为什么必须有这一个文件
//
// 工具注册已按组拆到 `packages/mcp-server/src/tools/*.ts`。而**4 个守卫**都靠读
// `tools.ts` 的**源码文本**推导工具名（`agent-sop-check` / `agent-boundary-check` /
// `check-interface-maps` / `check-consumer-routes`）。只读 `tools.ts` 时：
//   · 搬出去的工具被误判成「不来自 mcp 的收编项」⇒ `agent-sop-check` 直接红（有牙）；
//   · 另三个的**下界（40 / 20）仍然满足** ⇒ **静默缩水**（实测：56 → 49 仍绿）。
//
// 「有牙的那个会红、没牙的三个会沉默」是本仓反复出现的形态。所以这里不只统一取数面，
// 还**内置扫描面自检**：连接后的源码里 `server.tool(` 的出现次数必须恰好等于
// `EXPECTED_TOOL_COUNT`。少一个 ⇒ 结构错（不是"工具变少了"，是"取数面漏了文件"）。
//
// ## 新增工具时要做的事
//
// 改工具数量 ⇒ 同步改 `EXPECTED_TOOL_COUNT`，并在 commit message 说明。**这不是可以
// 通融的常量**：它的作用就是让"取数面缩水"与"工具真的增减"这两件事区分开。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 是否是**真实仓库根**（不是 selftest 的 fixture 树）。
 *
 * 判据 = 根 package.json 的 name 为 `autocodeflow-monorepo`。用它来给「扫描面计数自检」
 * 划作用域：真实仓库要求 `server.tool(` 恰好 56 次；fixture 树里工具数是刻意造的小样本，
 * 在那里强制 56 会把「fixture 精简」误判成「取数面缩水」。
 */
export function isRealRepoRoot(rootDir) {
  try {
    const j = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
    return j?.name === "autocodeflow-monorepo";
  } catch {
    return false;
  }
}

/** 当前 `server.tool(` 的**真实**出现次数（56 个工具）。新增/删除工具时必须同步。 */
export const EXPECTED_TOOL_COUNT = 56;

/**
 * 拼接 `tools.ts` 与 `tools/*.ts` 的源码文本，并**自证扫描面完整**。
 *
 * @param {string} rootDir 仓库根
 * @returns {string} 拼接后的源码文本
 * @throws {Error} 取数面缺失，或 `server.tool(` 计数 ≠ EXPECTED_TOOL_COUNT
 */
export function toolSourceText(rootDir, { enforce = isRealRepoRoot(rootDir) } = {}) {
  const srcDir = join(rootDir, "packages/mcp-server/src");
  const toolsDir = join(srcDir, "tools");
  const main = join(srcDir, "tools.ts");
  if (!existsSync(main)) {
    throw new Error(
      `读不到 ${main} —— 工具注册面不存在了（不是「工具变少了」）。`,
    );
  }
  const extra = existsSync(toolsDir)
    ? readdirSync(toolsDir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
        .sort()
        .map((f) => join(toolsDir, f))
    : [];
  const text = [main, ...extra].map((f) => readFileSync(f, "utf8")).join("\n");
  const actual = (text.match(/server\.tool\(/g) ?? []).length;
  // 只在**真实仓库**上启用计数自检：selftest 的 fixture 树里工具数是刻意造的小样本，
  // 若在那里也要求 56，会把「fixture 故意精简」误判成「取数面缩水」。
  if (enforce && actual !== EXPECTED_TOOL_COUNT) {
    throw new Error(
      `MCP 工具扫描面自检失败：拼接后 server.tool( 出现 ${actual} 次，期望 ` +
        `${EXPECTED_TOOL_COUNT} 次。\n` +
        `  这几乎总是「工具定义被搬到了取数面之外的目录」而不是「工具真的增删」——` +
        `请检查 packages/mcp-server/src/tools/ 下是否有新文件未被读入。\n` +
        `  若确实是增删工具，请同步改 ${import.meta.url} 的 EXPECTED_TOOL_COUNT 并在 commit 说明。`,
    );
  }
  return text;
}

/** 与 `toolSourceText` 同源的文件清单（需要逐文件解析行号时用）。 */
export function toolSourceFiles(rootDir) {
  const srcDir = join(rootDir, "packages/mcp-server/src");
  const toolsDir = join(srcDir, "tools");
  const main = join(srcDir, "tools.ts");
  const extra = existsSync(toolsDir)
    ? readdirSync(toolsDir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
        .sort()
        .map((f) => join(toolsDir, f))
    : [];
  return [main, ...extra];
}
