#!/usr/bin/env node
/**
 * executor-desktop 的 **selftest 必须被 `test:main` 执行** 守卫。
 *
 * 由来：`src/main` 下有 48 个 `*.selftest.ts`，而 `test:main` 只列了 46 个 ——
 * 漏掉的 `agent/browser.selftest.ts`（P7b 浏览器工具的**动作枚举 + 域名白名单**闸）与
 * `agent/package-candidate.selftest.ts`（P7d 的 ZIP 写入器 + **穿越载荷在写入层被拒**）
 * 都是**安全相关**的闸，却从来没在 CI 里跑过。
 *
 * 更刺眼的是：这两个文件的头注里都写着 `Run via: npm run test:main` —— **文档说它跑，实际不跑**。
 * 这与 `R82` 修的「守卫没接 CI」是同一类失败：**你以为有防线，其实没有**。
 *
 * 判据（双向）：
 *   ① 每个 `src/main/**` 的 `*.selftest.ts` 都必须在 `test:main` 里出现；
 *   ② `test:main` 里列的每一项都必须有对应源文件（删了 selftest 却忘删清单 = 命令直接报 ENOENT）。
 *
 * 用法：node scripts/check-desktop-selftests-wired.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "apps", "executor-desktop", "src", "main");
const PKG = join(ROOT, "apps", "executor-desktop", "package.json");

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".selftest.ts")) {
      out.push(
        p
          .slice(SRC.length + 1)
          .split("\\")
          .join("/")
          .replace(/\.ts$/, ""),
      );
    }
  }
}

const files = [];
walk(SRC, files);
if (files.length === 0) {
  console.error("✖ 一个 selftest 都没扫到 —— 路径或后缀变了。");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const cmd = pkg.scripts?.["test:main"] ?? "";
const listed = [...cmd.matchAll(/dist-selftest\/([^\s&]+)\.js/g)].map((m) => m[1]);

const listedSet = new Set(listed);
const notRun = files.filter((f) => !listedSet.has(f)).sort();
const noSource = listed.filter((l) => !files.includes(l)).sort();

if (notRun.length > 0 || noSource.length > 0) {
  console.error("");
  if (notRun.length > 0) {
    console.error("✖ " + notRun.length + " 个 selftest **没有被 test:main 执行**：");
    for (const f of notRun) console.error("  · src/main/" + f + ".ts");
  }
  if (noSource.length > 0) {
    console.error("✖ test:main 列了 " + noSource.length + " 个**没有源文件**的 selftest：");
    for (const f of noSource) console.error("  · dist-selftest/" + f + ".js");
  }
  console.error("");
  console.error("  修法：改 apps/executor-desktop/package.json 的 test:main 清单（补上/删掉对应项）。");
  console.error("  删 selftest 时记得同步删清单，否则命令会在 CI 里 ENOENT。");
  process.exit(1);
}

console.log(
  "✔ desktop selftest 接线一致：" + files.length + " 个 selftest 全部在 test:main 中，且都有源文件。",
);
