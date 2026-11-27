#!/usr/bin/env node
/**
 * 守卫牙齿的**反向实证**（可重跑证据，不是装饰）。
 *
 * 做法：在 /tmp 造一棵最小 fixture 树，拷入真实契约、生成物、三端 wrapper 与保留差异的证据文件，
 * 把生成器 `--check` 桩掉（`process.exit(0)`）—— 这样 drift 层不会先红，
 * 只有被测判据能红。然后**构造违反并断言必须报警**。
 *
 * 破坏面（每种都必须让对应判据变红）：
 *   ① node app 生成物少一条规则；
 *   ② node app 生成物规则体变窄；
 *   ③ node wrapper 不再调用生成物；
 *   ④ admin wrapper 不再调用生成物；
 *   ⑤ python wrapper 不再调用生成物；
 *   ⑥ 保留差异 CLS-11 的证据串消失（差异消失即红）；
 *   ⑦ 保留差异 KD-HEALTH 的证据串消失；
 *   ⑧【负例】两条零重叠规则对调 order ⇒ 探针必须保持绿（不产生可观测差异时不误报）。
 *
 * 退出码：0 = 所有正例变红且负例保持绿；1 = 至少一个判据是装饰/误报。
 *
 * 用法：node scripts/check-failure-classifiers-reverse-proof.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

console.log("=== 步骤 1：未破坏时的基线（应绿）===");

// 事实源与登记
copy("packages/executor-protocol/protocol.json");
copy("packages/contract-fixtures/contract.json");
copy("scripts/failure-classifier-divergence-baseline.json");
copy("scripts/protocol-breaking-acknowledgements.json");

// 生成器：桩掉（drift 层不参与这次实证）
put("scripts/generate-failure-classifiers.mjs", "process.exit(0);\n");

// 五份生成物（真实内容）
copy("packages/contract-fixtures/generated/failure-classifier.mjs");
copy("packages/contract-fixtures/generated/failure-classifier.py");
copy("apps/admin-api/src/common/failure-classification/generated/failure-classifier.ts");
copy("apps/executor-node/src/generated/failure-classifier.ts");
copy("apps/executor-python/generated/failure_classifier.py");

// 三端 wrapper（守卫要核对消费点）
copy("apps/admin-api/src/common/failure-classification/failure-patterns.ts");
copy("apps/executor-node/src/routes/execute.ts");
copy("apps/executor-python/routers/execute.py");

// 保留差异的可证文件
copy("apps/executor-python/routers/config.py");
copy("apps/executor-python/main.py");
copy("apps/executor-node/src/routes/health.ts");

// 守卫本体：跑真实脚本（--root 指向这棵树）
const GUARD = join(R, "scripts/check-failure-classifiers.mjs");
const runGuard = () => {
  const res = spawnSync(process.execPath, [GUARD, "--root", root], { encoding: "utf8" });
  return { code: res.status, out: (res.stdout || "") + (res.stderr || "") };
};

const before = runGuard();
console.log(`exit=${before.code}`);
if (before.code !== 0) {
  console.error("✖ 基线就不绿 —— 实证的前提不成立（fixture 树有问题）");
  for (const l of before.out.split("\n")) if (l.includes("FAIL") || l.includes("·")) console.error("  " + l);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}
console.log("  ✔ 基线绿");

const tsPath = join(root, "apps/executor-node/src/generated/failure-classifier.ts");
const adminTsPath = join(root, "apps/admin-api/src/common/failure-classification/generated/failure-classifier.ts");
const nodePath = join(root, "apps/executor-node/src/routes/execute.ts");
const adminPath = join(root, "apps/admin-api/src/common/failure-classification/failure-patterns.ts");
const pyPath = join(root, "apps/executor-python/routers/execute.py");
const healthPath = join(root, "apps/executor-node/src/routes/health.ts");

const BREAKS = [
  {
    id: "break-1-app-generated-missing-rule",
    file: tsPath,
    desc: "从 node app 生成物 RULES 里删掉 sandbox_unavailable（守卫 .mjs 保留）",
    needle: "FAIL D-13：node 两份生成物行为等价",
    apply: (src) => src.replace(/\n\s*\{\n\s*"id": "sandbox_unavailable",[\s\S]*?\n\s*\},/, ""),
  },
  {
    id: "break-2-app-generated-changed-body",
    file: tsPath,
    desc: "把 node app 生成物的 sandbox_unavailable body 改窄（少一个 alternative）",
    needle: "FAIL D-13：node 两份生成物行为等价",
    apply: (src) =>
      src.replace(
        /("id": "sandbox_unavailable",[\s\S]*?"body": ")([^"]*)(")/,
        (whole, head, body, tail) => head + body.replace("task_launcher|资源限制启动器", "") + tail,
      ),
  },
  {
    id: "break-3-admin-generated-consumption",
    file: adminTsPath,
    desc: "把 admin 生成物的 admin fallback 改坏（admin 阶段不再给码）",
    needle: "FAIL D-13：admin 生成物与守卫 .mjs 行为等价",
    apply: (src) => src.replace(/"admin":"unknown"/g, '"admin":null'),
  },
  {
    id: "break-4-node-wrapper-consumption",
    file: nodePath,
    desc: "node prepareFailureReason 不再调用生成物（退回硬编码）",
    needle: "FAIL wrapper 接线：node prepareFailureReason 调用生成物 executor 阶段",
    apply: (src) => src.replace("return asCallbackFailureReason(classify([message], 'executor'));", "return null;"),
  },
  {
    id: "break-5-admin-wrapper-consumption",
    file: adminPath,
    desc: "admin 文本分支不再把输入交给生成物",
    needle: 'FAIL wrapper 接线：admin 文本分支调用生成物 admin 阶段',
    apply: (src) => src.replace('classifyByProtocol(parts, "admin")', 'classifyByProtocol([], "admin")'),
  },
  {
    id: "break-6-python-wrapper-consumption",
    file: pyPath,
    desc: "python _refine_failure_reason 不再调用生成物",
    needle: "FAIL wrapper 接线：python _refine_failure_reason 调用生成物 executor 阶段",
    apply: (src) => src.replace("return _classify_failure_reason([message], 'executor')", "return None"),
  },
  {
    id: "break-7-divergence-vanished-cls11",
    file: nodePath,
    desc: "CLS-11 的证据串消失 ⇒ 差异消失即红",
    needle: "FAIL 登记可证（证据仍在）：CLS-11@runtime-bwrap-log-entry",
    apply: (src) => src.replace(/runtimeSandboxStartupFailureReason/g, "legacySandboxReason"),
  },
  {
    id: "break-8-divergence-vanished-health",
    file: healthPath,
    desc: "KD-HEALTH 的证据串消失 ⇒ 差异消失即红",
    needle: "FAIL 登记可证（证据仍在）：KD-HEALTH@health-endpoints@python",
    apply: (src) => src.replace(/\/health\/live/g, "/health/alive"),
  },
  {
    id: "break-9-unobservable-order-flip（负例：必须保持绿）",
    file: tsPath,
    desc: "terminal_timeout 与 git_fetch_failed 零重叠 ⇒ 顺序不可观测，探针不该报警",
    needle: "FAIL D-13：node 两份生成物行为等价",
    expectRed: false,
    apply: (src) =>
      src
        .replace(/("id": "terminal_timeout",\n\s*"order": )30(,)/, "$133$2")
        .replace(/("id": "git_fetch_failed",\n\s*"order": )32(,)/, "$129$2"),
  },
];

let allOk = true;
for (const brk of BREAKS) {
  const src0 = readFileSync(brk.file, "utf8");
  const mutated = brk.apply(src0);
  if (mutated === src0) {
    console.log(`\n=== ${brk.id}：破坏未生效（产物形态变了？）⇒ 判为实证失败 ===`);
    allOk = false;
    continue;
  }
  writeFileSync(brk.file, mutated, "utf8");
  console.log(`\n=== ${brk.id}：${brk.desc} ===`);
  const after = runGuard();
  const red = after.code === 1 && after.out.includes(brk.needle);
  const expectRed = brk.expectRed !== false;
  if (expectRed) {
    console.log(`  守卫 exit=${after.code}；目标判据${red ? "**变红**（符合预期）" : "仍绿（✘ 装饰）"}`);
    if (!red) allOk = false;
    else {
      const line = after.out.split("\n").find((l) => l.includes(brk.needle));
      if (line) console.log("    " + line.trim());
    }
  } else {
    const falseAlarm = after.code !== 0 || red;
    console.log(`  守卫 exit=${after.code}；目标判据${falseAlarm ? "变红（✘ 误报）" : "保持绿（符合预期）"}`);
    if (falseAlarm) allOk = false;
  }
  writeFileSync(brk.file, src0, "utf8");
}

console.log("\n=== 结论 ===");
if (allOk) {
  console.log("✔ 反向实证成立：生成物/消费点/差异证据的 8 种破坏全部让对应判据变红，零重叠负例保持绿。");
} else {
  console.log("✖ 反向实证不成立：至少一种破坏下守卫仍绿，或负例误报。");
}
rmSync(root, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);
