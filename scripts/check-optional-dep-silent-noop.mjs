#!/usr/bin/env node
/**
 * R126（2026-11-07）：**「可选依赖 + 可选调用」= 静默 no-op** 守卫。
 *
 * ## 真事故（R124 引入、R125 发现）
 * `releaseBroadcastSlot` 被声明成**可选依赖**（`?:`）且只在调用点写了 `this.releaseBroadcastSlot?.()`，
 * **依赖从未接线** ⇒ 调用永远是 no-op ⇒ **广播释放在生产里根本不发生** ⇒ `broadcastReservedCount` 永久泄漏
 * （持续少派单），而**没有任何测试会失败** —— 因为「没人调用」不等于「调用失败」。
 * 修法 = 依赖改**必填**（漏接线立刻 TS2345）。
 *
 * ## 覆盖面与**已知盲区**（R128）
 * 覆盖：① 声明 `name?: T` 与 `name: T | undefined`；② 调用 `x?.(` / `x?.m(` / `x && x(` / `if (x) x(` / `x ? x(`；
 * ③ 副作用语义命名（见下）。**盲区（明确不覆盖，别把这里当"全覆盖"）**：
 * · `Partial<T>` 解构后再取字段（类型层可选、源码里看不到 `?`）；
 * · 先赋给别名变量再条件调用（`const f = this.releaseX; if (f) f()`）；
 * · 跨文件间接调用（A 文件声明可选、B 文件调用）；
 * · 运行时注入的可选依赖（`Object.assign` / DI 容器装配）。
 *
 * ## 判据（同一文件内三条同时满足才算命中）
 * ① 某字段声明为**可选**：`name?:` / `name?: () => …` / `| undefined`；
 * ② 该字段被**可选调用**：`x?.()` / `x?.method(` / `if (x) x(`（且同文件里没有 else 抛错）；
 * ③ 字段名带「必须发生」的副作用语义：`release|consume|settle|persist|write|delete|commit|enqueue`。
 * 命中即红，报文给**精确改法**：改成**必填**（漏接线=编译错误），或显式写 no-op 分支并注释为什么安全。
 * 豁免：`// optional-dep-ok: <≥12 字理由>`（同一行或上一行），**每次运行打印**。
 *
 * 用法：node scripts/check-optional-dep-silent-noop.mjs [--root=<dir>] [--selftest]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
/** 扫描面：控制面源码（`apps/**` 只读）。 */
export const SCAN_DIRS = ["apps/admin-api/src"];
export const SIDE_EFFECT_RE = /(release|consume|settle|persist|write|delete|commit|enqueue)/i;
export const EXEMPT_RE = /optional-dep-ok:\s*(.+)$/;
export const FIX_HINT =
  "改成**必填依赖**（`field: () => …`，漏接线立刻 TS2345），或显式写出 no-op 分支并注释为什么安全；" +
  "确属可选项就写 `// optional-dep-ok: <≥12 字理由>`";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__" || e.name === "dist") continue;
      walk(abs, out);
    } else if (/\.(ts)$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(abs);
  }
  return out;
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const printed = [];
  let scanned = 0;
  for (const d of SCAN_DIRS) {
    for (const abs of walk(join(root, d))) {
      scanned += 1;
      const rel = relative(root, abs).split("\\").join("/");
      const text = readFileSync(abs, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return;
        // 声明形态两种：`name?: T` / `name: T | undefined`（R128 扩面）
        const decl = line.match(/([A-Za-z_$][\w$]*)\?\s*:/) ?? line.match(/([A-Za-z_$][\w$]*)\s*:\s*[^;]*\bundefined\b/);
        if (!decl) return;
        const name = decl[1];
        if (!SIDE_EFFECT_RE.test(name)) return;
        // 调用形态（R128 扩面）：`x?.(` / `x?.m(` / `x && x(` / `if (x) x(` / `x ? x(`（条件调用）
        const optionalCall = new RegExp(
          `\\b${name}\\?\\.|\\b${name}\\?\\(` +
            `|\\b${name}\\s*&&\\s*(this\\.)?${name}\\(` +
            `|if\\s*\\(\\s*(this\\.)?${name}\\s*\\)[^\\n]*\\b(this\\.)?${name}\\(`,
        ).test(text);
        if (!optionalCall) return;
        const exempt = EXEMPT_RE.test(line) || (i > 0 && EXEMPT_RE.test(lines[i - 1]));
        if (exempt) {
          printed.push(`${rel}:${i + 1} 豁免（${name}）`);
          return;
        }
        errors.push(
          `${rel}:${i + 1} **可选依赖 + 可选调用**：\`${name}?\` 被 \`${name}?.(...)\` 调用 ⇒ 未接线时**静默 no-op**` +
            `（副作用依赖漏了不会报错，测试也不会红）。⇒ ${FIX_HINT}`,
        );
      });
    }
  }
  console.log(`（可选依赖 no-op 判据：扫描 ${scanned} 个源文件；豁免 ${printed.length} 处）`);
  for (const p of printed) console.log(`   · ${p}`);
  errors.meta = { scanned, exempt: printed.length };
  return errors;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });
  const base = (extra) => {
    const t = { "apps/admin-api/src/ok.ts": "export const a = 1;\n" };
    return { ...t, ...extra };
  };
  push("正例控制组：无命中 ⇒ exit 0", () => {
    const repo = makeFixtureRepo(base({}));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally { repo.cleanup(); }
  });
  push("反例①：可选副作用依赖 + 可选调用 ⇒ exit 1 且给精确改法", () => {
    const repo = makeFixtureRepo(
      base({
        "apps/admin-api/src/bad.ts":
          "class S { releaseBroadcastSlot?: () => Promise<void>;\n  async run() { await this.releaseBroadcastSlot?.(); } }\n",
      }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["可选依赖 + 可选调用", "改成**必填依赖**"], withinMs: 20000, label: "反例①",
      });
    } finally { repo.cleanup(); }
  });
  push("反例①b：`x && x()` 条件调用 ⇒ exit 1", () => {
    const repo = makeFixtureRepo(
      base({
        "apps/admin-api/src/bad2.ts":
          "class S { releaseX?: () => void;\n  run() { this.releaseX && this.releaseX(); } }\n",
      }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 1, contains: ["可选依赖 + 可选调用"], withinMs: 20000, label: "反例①b" });
    } finally { repo.cleanup(); }
  });
  push("反例①c：`if (x) x()` 条件调用 ⇒ exit 1", () => {
    const repo = makeFixtureRepo(
      base({
        "apps/admin-api/src/bad3.ts":
          "class S { releaseX?: () => void;\n  run() { if (this.releaseX) this.releaseX(); } }\n",
      }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 1, contains: ["可选依赖 + 可选调用"], withinMs: 20000, label: "反例①c" });
    } finally { repo.cleanup(); }
  });
  push("反例①d：`x: T | undefined` 显式联合 ⇒ exit 1", () => {
    const repo = makeFixtureRepo(
      base({
        "apps/admin-api/src/bad4.ts":
          "class S { releaseX: (() => void) | undefined;\n  run() { this.releaseX?.(); } }\n",
      }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 1, contains: ["可选依赖 + 可选调用"], withinMs: 20000, label: "反例①d" });
    } finally { repo.cleanup(); }
  });
  push("反例②（防误报）：可选 logger/metrics ⇒ 不得报红", () => {
    const repo = makeFixtureRepo(
      base({
        "apps/admin-api/src/ok-optional.ts":
          "class S { logger?: { warn: (m: string) => void };\n  run() { this.logger?.warn('x'); } }\n",
      }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "反例②" });
    } finally { repo.cleanup(); }
  });
  push("反例③（防自匹配）：本守卫源码不得被自己抓", () => {
    const repo = makeFixtureRepo(base({}));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "反例③" });
    } finally { repo.cleanup(); }
  });
  const failed = reportCases(cases, { title: "check-optional-dep-silent-noop selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const errors = check(eq ? resolve(eq.slice("--root=".length)) : REPO_ROOT);
  if (errors.length === 0) {
    console.log(`✔ 无可选依赖静默 no-op：${errors.meta?.scanned ?? 0} 个源文件（豁免 ${errors.meta?.exempt ?? 0} 处已打印）。`);
    return 0;
  }
  console.error(`✘ 可选依赖静默 no-op：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
