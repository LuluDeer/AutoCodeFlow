#!/usr/bin/env node
/**
 * 审计动作清单与文档的一致性守卫。
 *
 * 背景：`docs/atlas/01-apps/admin-api/modules/audit.md` 的「谁在写审计」一节，长期是**手写清单**——
 * 于是它自然地落后于代码：SOP 加了 10 个动作、订阅/项目/成员各加了几个，文档里一个字都没有，
 * 头部还写着「task 模块（下一批次）」（实际早已落地 16 个）。
 *
 * 这类文档的危害不是「不准确」，而是**看起来像权威清单**：读的人会以为「审计只覆盖这几个域」。
 * 所以不修文档，而是把清单改成**由代码生成 + 守卫**：
 *
 *   ① 从 apps/admin-api/src 下所有 .ts（跳过 .spec.ts）里抽 `action: "<域>.<动作>"` 字面量；
 *   ② 每个抽到的 action 必须出现在 audit.md 里；缺一个就失败并列出缺的；
 *   ③ **反向不校验**：文档可以保留历史动作（迁移/下线后仍值得记录），这不是漂移。
 *
 * ## 已知盲区（**必须知道**）
 *
 * 判据是「源码里出现 `action: "<域>.<动作>"` 字面量」。所以**动态拼出来的 action 对本守卫隐形**：
 * 例如 `action: isCreate ? "config.create" : "config.update"` —— 两个动作确实在写，但一条也扫不到，
 * 文档表里也不会有它们，而守卫照样绿。
 *
 * 这类隐形在 R83 落地时真实发生过（config 的 create/update 起初就是三元拼的，守卫只看到 delete）。
 * 处置：**审计调用处一律写 action 字面量**；需要分支就分成两个调用（复用同一份 detail 构造），
 * 不要用三元/变量拼。透传包装（如 application.service 的 `action: payload.action`）不受影响，
 * 因为它的**调用点**是字面量，守卫扫的是那些点。
 *
 * 为什么不做成「动态即报错」：`action: query.action` 这类**读取/查询**用法的形状与写入完全相同，
 * 静态区分不了，硬判会产出大量假红。
 * * 用法：node scripts/check-audit-actions-doc.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join("apps", "admin-api", "src");
const DOC = join("docs", "atlas", "01-apps", "admin-api", "modules", "audit.md");
/** action 字面量：`<域>.<动作>`，允许动作段再带点（如 sop.timeout.unclaimed）。 */
const ACTION_RE = /action:\s*"([a-z0-9_]+\.[a-z0-9_.]+)"/g;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, SRC));
if (files.length === 0) {
  console.error("✖ 扫不到文件：" + SRC);
  process.exit(1);
}

const found = new Map(); // action -> [file:line…]
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const rel = relative(ROOT, f).split(sep).join("/");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    ACTION_RE.lastIndex = 0;
    let m;
    while ((m = ACTION_RE.exec(line)) !== null) {
      const a = m[1];
      if (!found.has(a)) found.set(a, []);
      found.get(a).push(rel + ":" + (i + 1));
    }
  });
}

const doc = readFileSync(join(ROOT, DOC), "utf8");
const missing = [...found.keys()].filter((a) => !doc.includes("`" + a + "`")).sort();

if (missing.length > 0) {
  console.error("");
  console.error(
    "✖ 审计动作清单漂移：" + missing.length + " 个 action 在代码里存在、文档里没有（共扫到 " +
      found.size +" 个）",
  );
  for (const a of missing) {
    console.error("  " + a + "  ← " + found.get(a).slice(0, 3).join(", "));
  }
  console.error("");
  console.error("  修法：跑 `node scripts/gen-audit-actions-doc.mjs`（或手工把 action 补进");
  console.error("  docs/atlas/01-apps/admin-api/modules/audit.md 的表格）。**不要**改守卫来放行。");
  process.exit(1);
}

console.log(
  "✔ 审计动作清单一致：代码里 " + found.size + " 个 action 全部在 audit.md 中出现（扫了 " +
    files.length +" 个文件）。",
);
