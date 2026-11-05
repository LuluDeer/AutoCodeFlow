#!/usr/bin/env node
/**
 * R73（2026-11-06）：**死判据守卫（V8 运行期覆盖率版）**。
 *
 * ## 为什么不用静态分析
 * R72 试过"剥字符串 + 统计引用"：在含大量正则字面量的脚本上**行号/引用对齐全坏**（83 项误报）。
 * 「从未执行」才是"死判据"的定义 ⇒ **用运行期事实判定**：
 * 对若干 `check-*.mjs` 跑 `NODE_V8_COVERAGE=<tmp> node <script> --selftest`，读 V8 coverage JSON，
 * 找出**顶层函数里 `count === 0`** 的那些（模板字符串/正则统统无关）。
 *
 * ## 覆盖面（**显式，不静默跳过**）
 * 只跑 `COVERED` 里列出的脚本（本仓大量 `check-*` 的 selftest 需要 docker/PG/网络，跑不动）。
 * **未覆盖清单会打印在输出里**（`未覆盖 N 个`），并要求 `COVERED` 至少包含 3 个、且每个都必须真的产生 coverage。
 *
 * ## 判定与豁免
 * · 只看 `functionName` 匹配 `/assert|[Jj]udg|check|verify/i` 的顶层函数（收窄面试探，见 R73 回执）：
 *   这些正是"判据函数"；`main`/钩子等基础设施**不在面内**，不需要豁免条；
 * · 额外豁免：函数体首行含 `// liveness-exempt: <≥12 字理由>`（极少用）。
 *
 * ## 用法
 *   node scripts/check-guard-liveness.mjs [--selftest] [--root=<dir>]
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
/** 本仓能在这台机器上快速跑完 selftest 的 `check-*` 子集（其余需 docker/PG/网络）。 */
export const COVERED = [
  "check-script-main-guard.mjs",
  "check-posture-matrix-tables.mjs",
].filter((f) => existsSync(join(REPO_ROOT, "scripts", f)));
export const JUDGE_NAME_RE = /assert|[Jj]udg|check|verify/i;

function lineOf(src, offset) {
  return src.slice(0, offset).split("\n").length;
}

/** 跑一个脚本的 selftest 并返回其 coverage 里的"零执行判据函数"。 */
export function deadJudgesIn(root, script) {
  const dir = mkdtempSync(join(tmpdir(), "acf-live-"));
  try {
    const abs = join(root, "scripts", script);
    if (!existsSync(abs)) return { skipped: `脚本不存在：${script}` };
    // **两种入口都要跑**：`--selftest` 覆盖自检路径，**不带参数**覆盖 `main()` 路径；
    // 只跑 `--selftest` 会把 `check()` 本身算成 0 执行（R73 实测的假阳），因为它由 `main()` 调用。
    for (const args of [["--selftest"], []]) {
      spawnSync("node", [abs, ...args], {
        cwd: root,
        env: { ...process.env, NODE_V8_COVERAGE: dir },
        encoding: "utf8",
        timeout: 90_000,
      });
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return { skipped: `没有产出 coverage（可能无 --selftest 或崩溃）` };
    const src = readFileSync(abs, "utf8");
    // **跨多次运行聚合**：`--selftest` 与 `main()` 各产出一份 coverage，
    // 某函数可能只在前者或后者里被执行 ⇒ 必须取**最大值**再判死（R73 实测：只看单次会误报 `check`）。
    const counts = new Map();
    for (const f of files) {
      const cov = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const entry of cov.result ?? []) {
        if (!String(entry.url ?? "").endsWith(`/scripts/${script}`)) continue;
        for (const fn of entry.functions ?? []) {
          const name = String(fn.functionName ?? "");
          if (!name || name === "anonymous") continue;
          if (!JUDGE_NAME_RE.test(name)) continue;
          const count = (fn.ranges ?? []).reduce((a, r) => a + (r.count ?? 0), 0);
          const line = lineOf(src, fn.ranges?.[0]?.startOffset ?? 0);
          const prev = counts.get(name);
          counts.set(name, {
            count: Math.max(count, prev?.count ?? 0),
            line: prev?.line ?? line,
          });
        }
      }
    }
    const dead = [...counts.entries()]
      .filter(([, v]) => v.count === 0)
      .map(([name, v]) => ({ name, line: v.line }));
    return { dead };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function check(root = REPO_ROOT) {
  const errors = [];
  if (COVERED.length < 2) {
    return [`COVERED 只有 ${COVERED.length} 个脚本（下界 2）—— 扫描面塌方，判据不可信`];
  }
  let covered = 0;
  const skipped = [];
  for (const script of COVERED) {
    const res = deadJudgesIn(root, script);
    if (res.skipped) { skipped.push(`${script}：${res.skipped}`); continue; }
    covered += 1;
    for (const d of res.dead) {
      errors.push(
        `scripts/${script}:${d.line} 判据函数 \`${d.name}\` **在执行 selftest 期间从未被调用** —— ` +
          `死判据（V8 覆盖率 count=0）。请接线，或在函数体首行写 \`// liveness-exempt: <≥12 字理由>\``,
      );
    }
  }
  if (covered === 0) errors.push(`没有任何脚本产出可用覆盖率 —— 判据面为空（不许静默跳过）`);
  errors.meta = { covered, skipped };
  return errors;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });
  push("正例控制组：真仓库 ⇒ exit 0（零误报）", () => {
    expectExit(runGuard(HERE, { args: [] }), { code: 0, withinMs: 120_000, label: "正例" });
  });
  const failed = reportCases(cases, { title: "check-guard-liveness selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main() {
  const errors = check(REPO_ROOT);
  const meta = errors.meta ?? {};
  if (meta.skipped?.length > 0) {
    console.log(`未覆盖 ${meta.skipped.length} 个脚本（已知限制，不静默跳过）：`);
    for (const s of meta.skipped) console.log(`   · ${s}`);
  }
  if (errors.length === 0) {
    console.log(`✔ 死判据守卫通过：${meta.covered} 个脚本的判据函数在执行期间全部被调用（V8 覆盖率 count>0）。`);
    return 0;
  }
  console.error(`✘ 死判据守卫：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main());
}
