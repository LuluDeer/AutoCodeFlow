#!/usr/bin/env node
/**
 * D-13「行为等价探针」的**反向实证**（可重跑的证据，不是装饰）。
 *
 * ## 为什么需要它
 *
 * 「探针能发现两份 emit 的分歧」这句话本身需要**证据**，否则它就是一句断言 ——
 * 而本轮的方法论纪律正是「凡『保护机制』必须有一段『构造违反 ⇒ 必须报警』的证据」。
 * 本脚本**构造违反**并断言**必须报警**。
 *
 * ## 做法
 *
 * 在 `/tmp` 造一棵最小 fixture 树（拷入**真实**的契约、向量、生成物、三端现状判据），
 * 把「生成器的 --check」**桩掉**（`process.exit(0)`）—— 这样 drift 那一层不会先红，
 * **只有行为等价探针能红** ⇒ 若守卫仍然绿，说明探针是装饰。
 *
 * ## 四种破坏方式（每种都必须让探针变红）
 *
 *   ① 少一条规则 —— 从 `.ts` 的 RULES 里删掉 `sandbox_unavailable`。
 *   ② 判据体变窄 —— 把该规则的 body 改窄（少一个 alternative ⇒ 少命中一类文本）。
 *   ③ 相对顺序对调（git_fetch_failed ↔ package_fetch_failed）—— 两者在 2 条探针上同时命中 ⇒ 顺序可观测。
 *   ④ 相对顺序对调（dependency_install_failed ↔ package_fetch_failed）—— 3 条探针同时命中。
 *
 * ⚠️ **一条重要的负例教训**（本脚本 v1 踩到）：最初选的规则对是
 * `terminal_timeout` × `git_fetch_failed`，实测**零重叠** ⇒ 两者的相对顺序
 * **在任何探针上都不可观测** ⇒ 破坏后守卫**正确地**保持绿。
 * 那不是探针的缺陷，是「破坏本身不产生可观测差异」—— 但它暴露了一个真问题：
 * **探针集必须覆盖「规则对的重叠面」**，否则顺序类分歧永远测不出来。
 * ⇒ 本脚本 v2 改用**实测有重叠**的规则对；并把这个教训写进
 * `check-failure-classifiers.mjs` 的探针构造器注释（新增「重叠面」探针）。
 *
 * ## 退出码
 *
 * 0 = 四种破坏**全部**让探针变红（证据成立）；1 = 至少一种破坏守卫仍绿（探针是装饰）。
 *
 * 用法：node scripts/check-failure-classifiers-reverse-proof.mjs
 */

/**
 * D-13 附加条件 ② 的**反向实证**：
 * 故意让 `.ts` 那份与 `.mjs` 差一条规则，断言探针**变红**。
 *
 * 方法：在 /tmp 造一棵最小 fixture 树（用**真实**的生成物内容），
 *       把「生成器的 --check」**桩掉**（stub 成 process.exit(0)），
 *       这样 drift 那一层不会先红 —— 只有「行为等价探针」能红。
 *       ⇒ 若守卫仍然绿，说明探针只是装饰。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// R155：补覆盖计数行。它**天生是反向实证**（跑真守卫 + 造 fixture + 故意破坏 4 种
// ⇒ 探针必须变红），没有 `--selftest` 形态 ⇒ **只进覆盖计数面、不进自检面**。
// helper 用本文件里的真实函数名 `runGuard`（本文件里它被调用 1 次 = 1 条用例：
// 「四种人为分歧全部让被守卫变红」）。floor=1 的含义：保证它**还在被跑**
// （整个文件被删 ⇒ 计数行缺失 ⇒ 哨兵结构红）。
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
printCoverageBanner(import.meta.url, "runGuard");
const R = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "d13-reverse-proof-"));

const put = (rel, content) => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
};
const copy = (rel) => put(rel, readFileSync(join(R, rel), "utf8"));

// ── 事实源与向量 ──
copy("packages/executor-protocol/protocol.json");
copy("packages/contract-fixtures/contract.json");
copy("scripts/failure-classifier-divergence-baseline.json");
copy("scripts/protocol-breaking-acknowledgements.json");

// ── 生成器：桩掉（drift 层不参与这次实证）──
put("scripts/generate-failure-classifiers.mjs", "process.exit(0);\n");

// ── 四份生成物（**真实内容**）──
copy("packages/contract-fixtures/generated/failure-classifier.mjs");
copy("packages/contract-fixtures/generated/failure-classifier.py");
copy("apps/executor-node/src/generated/failure-classifier.ts");
copy("apps/executor-python/generated/failure_classifier.py");

// ── 三端现状判据（现状模拟器要读）──
copy("apps/admin-api/src/common/failure-classification/failure-patterns.ts");
copy("apps/executor-node/src/routes/execute.ts");
copy("apps/executor-python/routers/execute.py");
// capability 类登记的**证据文件**（在他人写域 ⇒ 只读复制进 fixture 树）
copy("apps/executor-python/routers/config.py");
copy("apps/executor-python/main.py");
copy("apps/executor-node/src/routes/health.ts");

// ── 守卫本体：跑真实脚本（--root 指向这棵树）──
const GUARD = join(R, "scripts/check-failure-classifiers.mjs");

const runGuard = () => {
  const res = spawnSync(process.execPath, [GUARD, "--root", root], { encoding: "utf8" });
  return { code: res.status, out: (res.stdout || "") + (res.stderr || "") };
};

console.log("=== 步骤 1：未破坏时的基线（应绿）===");
const before = runGuard();
console.log(`exit=${before.code}`);
const d13Lines = (t) => t.split("\n").filter((l) => l.includes("D-13"));
for (const l of d13Lines(before.out)) console.log("  " + l);

if (before.code !== 0) {
  console.error("✖ 基线就不绿 —— 实证的前提不成立（fixture 树有问题）");
  console.error("--- 全部 FAIL 行 ---");
  for (const l of before.out.split("\n")) if (l.includes("FAIL")) console.error("  " + l);
  console.error("--- 结构错误 ---");
  for (const l of before.out.split("\n")) if (l.includes("·")) console.error("  " + l);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

const tsPath = join(root, "apps/executor-node/src/generated/failure-classifier.ts");
const mjsPath = join(root, "packages/contract-fixtures/generated/failure-classifier.mjs");

/** 两种破坏方式：① 少一条规则；② 规则数相同但**判据体**不同（更隐蔽）。 */
const BREAKS = [
  {
    id: "break-1-missing-rule",
    desc: "从 .ts 的 RULES 里删掉 sandbox_unavailable 那一条（.mjs 保留）",
    apply: (src) => src.replace(/\n\s*\{\n\s*"id": "sandbox_unavailable",[\s\S]*?\n\s*\},/, ""),
  },
  {
    id: "break-2-changed-body",
    desc: "把 .ts 里 sandbox_unavailable 规则的 body 改窄（少一个 alternative ⇒ 少命中一类文本）",
    apply: (src) =>
      src.replace(
        /("id": "sandbox_unavailable",[\s\S]*?"body": ")([^"]*)(")/,
        (whole, head, body, tail) => {
          const narrowed = body.replace("task_launcher|资源限制启动器", "");
          return head + narrowed + tail;
        },
      ),
  },
  {
    id: "break-3-relative-order-flip",
    desc: "把 .ts 里 git_fetch_failed(32) 与 package_fetch_failed(80) 的**相对** order 对调（两者在 2 条探针上同时命中 ⇒ 顺序可观测）",
    apply: (src) =>
      src
        .replace(/("id": "git_fetch_failed",\n\s*"order": )32(,)/, '$185$2')
        .replace(/("id": "package_fetch_failed",\n\s*"order": )80(,)/, '$130$2'),
  },
  {
    // ⚠️ **负例**：这两条规则**零重叠** ⇒ 相对顺序在任何探针上都不可观测
    //    ⇒ 人为对调它们之后，守卫**必须保持绿**（绿是**正确**的：破坏不产生
    //    可观测差异）。这一条断言的是「探针不误报」—— 探针若在这里变红，
    //    说明它对**不产生差异**的破坏也报警 ⇒ 那不是更严，是**噪音**。
    id: "break-5-unobservable-order-flip（负例：必须保持绿）",
    desc: "把 .ts 里 terminal_timeout(30) 与 git_fetch_failed(32) 对调（两者零重叠 ⇒ 顺序不可观测）",
    expectRed: false,
    apply: (src) =>
      src
        .replace(/("id": "terminal_timeout",\n\s*"order": )30(,)/, '$133$2')
        .replace(/("id": "git_fetch_failed",\n\s*"order": )32(,)/, '$129$2'),
  },
  {
    id: "break-4-swapped-body-order",
    desc: "把 .ts 里 dependency_install_failed(34) 与 package_fetch_failed(80) 对调（3 条探针同时命中）",
    apply: (src) =>
      src
        .replace(/("id": "dependency_install_failed",\n\s*"order": )34(,)/, '$186$2')
        .replace(/("id": "package_fetch_failed",\n\s*"order": )80(,)/, '$129$2'),
  },
];

let allRed = true;
for (const brk of BREAKS) {
  const src0 = readFileSync(tsPath, "utf8");
  const mutated = brk.apply(src0);
  if (mutated === src0) {
    console.log(`\n=== ${brk.id}：破坏未生效（产物形态变了？）⇒ 跳过 ===`);
    allRed = false;
    continue;
  }
  writeFileSync(tsPath, mutated, "utf8");
  console.log(`\n=== ${brk.id}：${brk.desc} ===`);
  console.log("  .ts 的 RULES 条数：", (mutated.match(/"id": "/g) || []).length,
              "；.mjs 的 RULES 条数：",
              (readFileSync(mjsPath, "utf8").match(/"id": "/g) || []).length);
  const after = runGuard();
  console.log(`  守卫 exit=${after.code}`);
  for (const l of d13Lines(after.out)) console.log("    " + l);
  const probeRed = after.code === 1 && after.out.includes("FAIL D-13：node 两份生成物行为等价");
  const expectRed = brk.expectRed !== false;
  if (expectRed) {
    console.log(`  ⇒ 探针${probeRed ? "**变红**（符合预期）" : "仍然绿（✘ 探针是装饰！）"}`);
    if (probeRed) {
      const m = after.out.match(/actual\s+:.*/);
      if (m) console.log("    红灯内容（首行）：", m[0].trim());
    } else {
      allRed = false;
    }
  } else {
    console.log(`  ⇒ 探针${probeRed ? "变红（✘ **误报**：破坏不产生可观测差异，探针不该报警）" : "保持绿（符合预期：这两条规则零重叠 ⇒ 顺序不可观测）"}`);
    if (probeRed) allRed = false;
  }
  writeFileSync(tsPath, src0, "utf8"); // 还原
}

console.log("\n=== 结论 ===");
if (allRed) {
  console.log("✔ 反向实证成立：四种人为分歧（少一条规则 / 判据体变窄 / 相对顺序对调 ×2）");
  console.log("  **全部**让「行为等价探针」变红（exit=1）⇒ 探针不是装饰。");
} else {
  console.log("✖ 反向实证**不成立**：至少一种分歧下守卫仍然绿 ⇒ 探针是装饰。");
}
rmSync(root, { recursive: true, force: true });
process.exit(allRed ? 0 : 1);
