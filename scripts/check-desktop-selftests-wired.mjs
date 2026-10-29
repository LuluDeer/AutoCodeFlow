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
 * 判据④（CIR-02 实证，2026-10-29）：`test:main` 必须至少有一个**随 push 跑**的
 *   CI job 在执行。原先只有 desktop-linux-bundle / desktop-macos-bundle 调它，
 *   而两者都是 `pull_request || workflow_dispatch` 门控——本仓常规路径是直接
 *   push develop，于是 48 个 selftest 在主干上零覆盖，本守卫却只检查「有没有
 *   出现在 test:main 清单里」而发绿。判据④补上「接线是否在主干生效」。
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

// 判据④：至少一个非 PR/手动门控的 job 执行 test:main（随 push 生效）。
const ciPath = join(ROOT, ".github", "workflows", "ci.yml");
if (!existsSync(ciPath)) {
  console.error("✖ 找不到 .github/workflows/ci.yml——无法验证 selftest 是否随 push 运行。");
  process.exit(1);
}
const ciLines = readFileSync(ciPath, "utf8").split("\n");
const jobStarts = [];
for (let i = 0; i < ciLines.length; i++) {
  if (/^ {2}[a-zA-Z0-9_-]+:\s*$/.test(ciLines[i])) jobStarts.push(i);
}
const pushTriggered = [];
for (let i = 0; i < ciLines.length; i++) {
  // 只认 YAML 的 run 指令；注释/步骤名里提到 test:main 不算接线
  if (!/^\s*(?:-\s*)?run:\s*npm run test:main\b/.test(ciLines[i])) continue;
  const start = [...jobStarts].reverse().find((j) => j < i) ?? -1;
  if (start < 0) continue;
  const end = jobStarts.find((j) => j > start) ?? ciLines.length;
  const block = ciLines.slice(start, end).join("\n");
  const jobName = ciLines[start].trim().replace(/:$/, "");
  // PR / 手动门控的 job：if 里出现 pull_request 但没有 push 语义
  const prGated = /if:\s*[^\n]*pull_request/.test(block);
  if (!prGated) pushTriggered.push(jobName);
}
if (pushTriggered.length === 0) {
  console.error("");
  console.error("✖ 没有任何**随 push 运行**的 CI job 执行 `npm run test:main`。");
  console.error("  现状：test:main 只挂在 pull_request / workflow_dispatch 门控的 job 上，");
  console.error("  而本仓常规路径是直接 push develop——48 个 selftest 在主干上零覆盖。");
  console.error("  修法：保留一个不加 `if`（或 if 含 push 语义）的 job 跑 npm run test:main");
  console.error("  （见 ci.yml 的 desktop-selftests）。");
  process.exit(1);
}

console.log(
  "✔ desktop 脚本接线一致：" +
    files.length +
    " 个 selftest 全部在 test:main 中且都有源文件；build:main 已接 preload 自包含打包；" +
    "push 触发 job：" + pushTriggered.join(", ") + "。",
);
