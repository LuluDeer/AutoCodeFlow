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
 * 判据③（R102-A1 实证）：`build:main` 必须接 `scripts/bundle-preload.cjs`。
 *   沙箱（sandbox: true）里的 preload 只支持受限 require，**相对 require 直接
 *   加载失败**。tsc 是逐文件 emit，preload 一旦 import 同目录模块（bridge-args）
 *   就会编译出 `require("./bridge-args")` → preload 整体不执行 →
 *   window.electronAPI 为 undefined → 渲染层落进错误边界（CI desktop-e2e-smoke
 *   10 条全红）。这道闸盯的是构建接线本身，不依赖先跑一遍 e2e 才发现。
 *
 * 用法：node scripts/check-desktop-selftests-wired.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const buildMain = pkg.scripts?.["build:main"] ?? "";
const preloadBundler = join(ROOT, "apps", "executor-desktop", "scripts", "bundle-preload.cjs");
if (!buildMain.includes("bundle-preload.cjs") || !existsSync(preloadBundler)) {
  console.error("");
  console.error("✖ build:main 没有接 preload 自包含打包（scripts/bundle-preload.cjs）。");
  console.error("  沙箱 preload 只能 require('electron') 这类受限模块，相对 require 会导致");
  console.error("  整个 preload 加载失败（window.electronAPI 消失 → 界面落进错误边界）。");
  console.error("  修法：build:main = \"tsc -p tsconfig.json && node scripts/bundle-preload.cjs\"。");
  process.exit(1);
}

console.log(
  "✔ desktop 脚本接线一致：" +
    files.length +
    " 个 selftest 全部在 test:main 中且都有源文件；build:main 已接 preload 自包含打包。",
);
