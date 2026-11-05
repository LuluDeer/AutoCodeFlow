#!/usr/bin/env node
/**
 * R46（2026-11-05）：**main-guard 守卫** —— 防「`import` 就触发副作用」。
 *
 * ## 为什么要它
 * R45 实测踩到两次：`import { readJunit } from "./health-snapshot.mjs"` **连带跑了一次全量体检**（12 分钟），
 * 因为脚本尾部是裸的 `process.exit(main())`。这类缺陷的共同特征是：
 * **既能被 import（有 `export`）又会在顶层就执行** —— import 的人根本不知道自己触发了什么。
 *
 * ## 判据（只咬"可 import 且顶层有动作"这一类）
 * 对 `scripts/**\/*.mjs` 每个文件：
 * ① 有 `export`（⇒ 理论上可被 import 复用）**且** 顶层有动作（`process.exit(` / `main()` / 顶层 `await`）
 *    **且** 没有 main-guard ⇒ **红**（点名文件）；
 * ② 没有 `export` 的可执行脚本 ⇒ **豁免**（不可被 import 复用，引入即无意义）——但在输出里**逐类说明**，
 *    并在 `scripts/script-main-guard-exempt.json` 里登记（文件 + 原因），不许默认放过；
 * ③ 无顶层动作的纯库 ⇒ 天然通过。
 *
 * ## 用法
 *   node scripts/check-script-main-guard.mjs [--selftest] [--root=<dir>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(HERE, "../..");
export const EXEMPT_FILE = "scripts/script-main-guard-exempt.json";
export const GUARD_SELF = "scripts/check-script-main-guard.mjs";

/** main-guard 的两种等价写法（本仓既有两种都用过）。 */
const GUARD_PATTERNS = [
  /process\.argv\[1\][\s\S]{0,120}import\.meta\.url/,
  /import\.meta\.url[\s\S]{0,120}process\.argv\[1\]/,
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === "node_modules" || name.name === "lib") walk(abs, out);
      else walk(abs, out);
    } else if (name.name.endsWith(".mjs")) {
      out.push(abs);
    }
  }
  return out;
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const scriptDir = join(root, "scripts");
  if (!existsSync(scriptDir)) return ["读不到 scripts/ —— 扫描面缺失"];
  const files = walk(scriptDir);
  if (files.length < 50) {
    return [`扫描面塌方：只找到 ${files.length} 个 .mjs（下界 50）——判据不可信`];
  }

  let exempt = [];
  const exemptPath = join(root, EXEMPT_FILE);
  if (existsSync(exemptPath)) {
    try {
      exempt = JSON.parse(readFileSync(exemptPath, "utf8")).files ?? [];
    } catch {
      errors.push(`${EXEMPT_FILE} 不是合法 JSON —— 豁免清单不可读`);
    }
  }
  const exemptSet = new Set(exempt.map((e) => e.path));

  let needGuard = 0;
  let guarded = 0;
  for (const abs of files) {
    const rel = relative(root, abs).split("\\").join("/");
    if (rel === GUARD_SELF) continue;
    const text = readFileSync(abs, "utf8");
    const hasGuard = GUARD_PATTERNS.some((re) => re.test(text));
    const hasExport = /^export\s/m.test(text);
    const topAction =
      /^process\.exit\(/m.test(text) ||
      /^(?:main|run|selftest)\(\)/m.test(text) ||
      /^await\s/m.test(text);
    if (hasGuard) {
      guarded += 1;
      continue;
    }
    if (!hasExport && topAction) {
      // 可豁免类别：无 export ⇒ 不可被 import 复用；但必须登记
      if (!exemptSet.has(rel)) {
        errors.push(
          `${rel}：无 export 的可执行脚本，但**未登记豁免** —— 在 ${EXEMPT_FILE} 里写明原因（"不可被 import 复用"）`,
        );
      }
      continue;
    }
    if (hasExport && topAction) {
      needGuard += 1;
      errors.push(
        `${rel}：**有 export 且顶层有动作，却没有 main-guard** —— \`import\` 它会连带执行（R45 实测踩过）；` +
          ` 加 \`if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)\` 包住顶层动作`,
      );
    }
  }
  errors.meta = { guarded, needGuard, total: files.length };
  return errors;
}

// ── 自检：正例 + 两个反例 ────────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });
  const baseTree = () => {
    const t = {};
    // 60 个合规文件满足下界
    for (let i = 0; i < 60; i += 1) {
      t[`scripts/ok-${i}.mjs`] = 'export function f() { return 1; }\n';
    }
    t["scripts/script-main-guard-exempt.json"] = JSON.stringify({ files: [] });
    return t;
  };

  push("正例控制组：全部是纯库 ⇒ exit 0", () => {
    const repo = makeFixtureRepo(baseTree());
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally {
      repo.cleanup();
    }
  });

  push("反例①：有 export + 顶层 process.exit 且无 guard ⇒ exit 1 点名", () => {
    const t = baseTree();
    t["scripts/bad-import-side-effect.mjs"] = "export function f() { return 1; }\nprocess.exit(0);\n";
    const repo = makeFixtureRepo(t);
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["bad-import-side-effect.mjs", "main-guard"], withinMs: 20000, label: "缺 guard",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例②：无 export 的可执行脚本未登记豁免 ⇒ exit 1 点名豁免清单", () => {
    const t = baseTree();
    t["scripts/cli-only.mjs"] = "function main() { return 0; }\nmain();\n";
    const repo = makeFixtureRepo(t);
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["cli-only.mjs", "未登记豁免"], withinMs: 20000, label: "未登记豁免",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-script-main-guard selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const at = argv.indexOf("--root");
  const rootArg = eq ? eq.slice("--root=".length) : at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  const errors = check(resolve(rootArg ?? REPO_ROOT));
  const meta = errors.meta ?? {};
  if (errors.length === 0) {
    console.log(
      `✔ main-guard 守卫通过：扫描 ${meta.total} 个 .mjs，${meta.guarded} 个已有 guard；` +
        `「有 export 且顶层有动作」的脚本全部带 guard；无 export 的可执行脚本均已登记豁免。`,
    );
    return 0;
  }
  console.error(`✘ main-guard 守卫：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
