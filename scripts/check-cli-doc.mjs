#!/usr/bin/env node
/**
 * CLI 命令地图（docs/atlas/05-interfaces/cli.md）与 `acf` 实际注册的命令之间的**计数守卫**。
 *
 * 背景：那份文档的每一节标题都带一个手写计数（`### task（23）— commands/tasks.ts`），
 * 总数又在标题里写死（`# CLI 命令地图（acf，67 个子命令）`）。R69 发现它**整整漏掉**了
 * `acf mutex` 一节（4 个子命令）—— 而计数「63」恰好就是「漏掉 mutex」的那个数，说明数字本身
 * 也在跟着错。手写计数没有任何东西校验，就一定会漂。
 *
 * 判据（两条，都只做**确定能判**的事）：
 *   ① 每个含 `.command(` 的 commands/*.ts，其父命令名在文档里必须有一节，且**计数与代码一致**；
 *   ② 文档标题里的总数 = 全部 `.command(` 数 + `login.ts` 里用 `new Command` 注册的根命令数。
 *
 * 刻意**不判**的：
 *   · `login.ts` 不按节判（它的 3 个根命令与 `config` 的 3 个子命令合写在 `login / config（6）`
 *     一节里，1:1 映射不成立）；它的存在性由 ② 的总数间接覆盖。
 *   · 子命令的**选项/描述**是否与文档一致 —— 那是描述性内容，不是清单，不做机械比对。
 *
 * 用法：node scripts/check-cli-doc.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CMD_DIR = join(ROOT, "packages", "acf-cli", "src", "commands");
const DOC = join(ROOT, "docs", "atlas", "05-interfaces", "cli.md");

const doc = readFileSync(DOC, "utf8");

/** 文档里所有 `### …（N）…` 标题里的 name→count（支持「与」拼起来的合并标题）。 */
const docCounts = new Map();
for (const line of doc.split("\n")) {
  if (!line.startsWith("### ")) continue;
  for (const m of line.matchAll(/([a-z][a-z0-9-]*)（(\d+)）/g)) {
    docCounts.set(m[1], Number(m[2]));
  }
}

const files = readdirSync(CMD_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const problems = [];
let totalCommands = 0;
let rootCommands = 0;

// 总数还要算上 index.ts 里 `config` 的 3 个子命令（它不在 commands/ 目录里）。
totalCommands += (
  readFileSync(join(ROOT, "packages", "acf-cli", "src", "index.ts"), "utf8").match(/\.command\(/g) ?? []
).length;

for (const f of files) {
  const src = readFileSync(join(CMD_DIR, f), "utf8");
  const subCount = (src.match(/\.command\(/g) ?? []).length;
  const parentMatch = /new Command\(\s*['"]([^'"]+)['"]/.exec(src);
  totalCommands += subCount;

  // login.ts 是三个**根命令**（login / whoami / logout）的工厂，不是子命令集合：
  // 它们与 config 的 3 个子命令合写在 `login / config（6）` 一节，1:1 映射不成立。
  if (f === "login.ts") {
    rootCommands += (src.match(/new Command\(/g) ?? []).length;
    continue;
  }
  if (!parentMatch) continue;
  const parent = parentMatch[1];
  if (parent === "config") continue; // 合写在 login / config 一节，见文件头「刻意不判的」
  if (subCount === 0) continue;

  const documented = docCounts.get(parent);
  if (documented === undefined) {
    problems.push(`缺少「${parent}」一节（代码里 ${subCount} 个子命令，来自 commands/${f}）`);
  } else if (documented !== subCount) {
    problems.push(
      `「${parent}」计数不符：文档 ${documented}，代码 ${subCount}（commands/${f}）`,
    );
  }
}

const actualTotal = totalCommands + rootCommands;
const headerMatch = /#\s*CLI\s*命令地图（acf，(\d+)\s*个子命令）/.exec(doc);
const headerTotal = headerMatch ? Number(headerMatch[1]) : null;
if (headerTotal === null) {
  problems.push("标题里找不到「（acf，N 个子命令）」——标题格式变了，守卫需要同步（不是放宽）");
} else if (headerTotal !== actualTotal) {
  problems.push(`标题总数不符：文档 ${headerTotal}，代码 ${actualTotal}（${totalCommands} 个 .command( + ${rootCommands} 个根命令）`);
}

if (problems.length > 0) {
  console.error("");
  console.error("✖ CLI 命令地图与代码不一致：");
  for (const p of problems) console.error("  · " + p);
  console.error("");
  console.error("  修法：改 docs/atlas/05-interfaces/cli.md（补节 / 改计数 / 改标题总数）。**不要**改守卫放行。");
  process.exit(1);
}

console.log(
  "✔ CLI 命令地图一致：" + docCounts.size + " 节计数与代码相符，总数 " + actualTotal + " = " + totalCommands +
    " 个 .command( + " + rootCommands + " 个根命令。",
);
