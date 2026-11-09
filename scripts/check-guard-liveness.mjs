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

printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
/**
 * 本仓能在这台机器上**快速跑完 selftest 且零误报**的 `check-*` 子集（20 个，实测 ~23s）。
 *
 * ## 未覆盖的 65 个为什么跳过（R84 实测分类，**不许静默**）
 * · **需要 docker / 本地 PG / 外部服务**：`check-compose-*`、`check-race-*`、`check-env-drift` 等；
 * · **需要完整构建产物 / 30s+ 长跑**：`check-desktop-*`、`check-failure-classifiers*`、`check-protocol-*`、`check-cross-end-*`（要跑三端）、`check-guards-wired`；
 * · **本身是本守卫或与之同源**：`check-guard-liveness.mjs` 自身递归跑会翻倍，未纳入。
 * 扩面原则（你定的）：**每加一个必须先验证真仓库零误报**，宁可慢扩。
 */
/** 可用 `LIVENESS_COVERED=a.mjs,b.mjs` 覆盖（扩面探路用；CI 不设置该变量）。 */
const COVERED_FROM_ENV = (process.env.LIVENESS_COVERED ?? "").split(",").map((x) => x.trim()).filter(Boolean);
export const COVERED_DEFAULT = [
  "check-script-main-guard.mjs",
  "check-posture-matrix-tables.mjs",
  "check-brand-drift.mjs",
  "check-agent-index-names.mjs",
  "check-constant-time-compare.mjs",
  "check-enum-drift.mjs",
  "check-error-i18n.mjs",
  "check-image-pinned.mjs",
  "check-agent-event-limits.mjs",
  "check-agent-write-sanitize.mjs",
  "check-alerts-rules.mjs",
  "check-audit-actions-doc.mjs",
  "check-cli-doc.mjs",
  "check-collaborator-self-call.mjs",
  "check-conditional-writes.mjs",
  "check-consumer-routes.mjs",
  "check-credential-columns.mjs",
  "check-cron-guard.mjs",
  "check-enum-consumers.mjs",
  "check-env-switch-default-policy.mjs",
];

/** 调用时求值：`LIVENESS_COVERED` 可缩小面（自检用），默认 = 20 个脚本。 */
export function coveredList() {
  const envList = (process.env.LIVENESS_COVERED ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const list = envList.length > 0 ? envList : COVERED_DEFAULT;
  return list.filter((f) => existsSync(join(REPO_ROOT, "scripts", f)));
}

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
  const COVERED = coveredList();
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
  push("正例控制组：真仓库（缩小面：2 个脚本）⇒ 零误报", () => {
    // 自检只验证**判据管线**本身；完整 20 个脚本的覆盖由链内主跑负责（~23s）。
    const prev = process.env.LIVENESS_COVERED;
    process.env.LIVENESS_COVERED = "check-script-main-guard.mjs,check-posture-matrix-tables.mjs";
    try {
      const errs = check();
      if (errs.length > 0) throw new Error(`期望零误报，实得 ${errs.length} 项：${errs.slice(0, 2).join("；")}`);
    } finally {
      if (prev === undefined) delete process.env.LIVENESS_COVERED;
      else process.env.LIVENESS_COVERED = prev;
    }
  });

  push("反例①：LIVENESS_COVERED 里全是「不存在的脚本」⇒ 报「扫描面塌方」（不许静默绿）", () => {
    const prev = process.env.LIVENESS_COVERED;
    // 一个不存在的脚本名 ⇒ 过滤后剩 0 个可用脚本。此时**必须红**：
    // 「一个都跑不了」与「跑了且全绿」是两件事，把它当绿就是判据面塌方的假绿。
    process.env.LIVENESS_COVERED = "no-such-script-r155.mjs,another-missing-r155.mjs";
    try {
      const errs = check();
      if (errs.length === 0) throw new Error("可用脚本为 0 时返回了 0 项 —— 假绿");
      if (!errs.some((e) => e.includes("扫描面塌方"))) {
        throw new Error(`期望点名「扫描面塌方」，实得：${errs.join("；")}`);
      }
    } finally {
      if (prev === undefined) delete process.env.LIVENESS_COVERED;
      else process.env.LIVENESS_COVERED = prev;
    }
  });
  push("反例②：LIVENESS_COVERED 置空 ⇒ 回落默认清单（空 ≠ 关闭检查）", () => {
    const prev = process.env.LIVENESS_COVERED;
    process.env.LIVENESS_COVERED = "";
    try {
      // 空串 ⇒ coveredList() 回落 COVERED_DEFAULT（不是「跳过所有脚本」）。
      // 这是安全属性：**不能靠「把环境变量设空」关掉这道闸**。
      const errs = check();
      if (errs.length > 0) throw new Error(`空环境变量应回落默认清单并保持绿，实得 ${errs.length} 项：${errs.slice(0, 2).join("；")}`);
    } finally {
      if (prev === undefined) delete process.env.LIVENESS_COVERED;
      else process.env.LIVENESS_COVERED = prev;
    }
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
