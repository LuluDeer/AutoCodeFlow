#!/usr/bin/env node
/**
 * R91：`health-snapshot.mjs` 的**测量正确性**自检（测量工具本身会撒谎的那一类缺陷）。
 *
 * 覆盖三件事：
 * ① `vitestSummary()` 必须能解析**带失败**的摘要行（旧正则只认 `passed` ⇒ 一有失败就 null）；
 * ② `classifyStep()` 必须把 `signal` 非空判成 `killed`，与 `failed` 区分开；
 * ③ 真实被信号杀的进程样本（`node -e process.kill(...)`）确实上报 `signal === "SIGTERM"`。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { classifyStep, vitestSummary } from "./health-snapshot.mjs";

let passed = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.error(`  ✘ ${name}\n     ${err.message}`);
  }
};

// ① 表驱动：真实样本（取自本仓实测输出）
const SUMMARIES = [
  { name: "失败行（R91 缺陷样本）", out: " Tests  2 failed | 5 passed (7)\n", want: { passed: 5, failed: 2, skipped: 0, total: 7 } },
  { name: "全绿 + skipped（R53 实测样本）", out: " Tests  2390 passed | 1 skipped (2391)\n", want: { passed: 2390, failed: 0, skipped: 1, total: 2391 } },
  { name: "只有 passed", out: " Tests  285 passed (285)\n", want: { passed: 285, failed: 0, skipped: 0, total: 285 } },
  { name: "带 Test Files 行 + 结果行", out: " Test Files  285 passed (285)\n      Tests  2357 passed | 1 skipped (2358)\n", want: { passed: 2357, failed: 0, skipped: 1, total: 2358 } },
  { name: "无 Tests 行 ⇒ null 面（不伪造 0）", out: "no summary here\n", want: { passed: null, failed: null, skipped: null, total: null } },
];
for (const c of SUMMARIES) {
  t(`vitestSummary：${c.name}`, () => {
    assert.deepEqual(vitestSummary(c.out), c.want);
  });
}

// ② 终态分类
t("classifyStep：exit 0 ⇒ ok", () => assert.equal(classifyStep({ code: 0, signal: null }), "ok"));
t("classifyStep：exit 1 且无 signal ⇒ failed", () => assert.equal(classifyStep({ code: 1, signal: null }), "failed"));
t("classifyStep：signal=SIGTERM ⇒ killed（与 failed 不同形）", () =>
  assert.equal(classifyStep({ code: 1, signal: "SIGTERM" }), "killed"));

// ③ 真实被信号杀的进程
t("真实 SIGTERM 子进程 ⇒ signal === 'SIGTERM'（不是 exit 1）", () => {
  const r = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { encoding: "utf8" });
  assert.equal(r.signal, "SIGTERM");
  assert.equal(classifyStep({ code: r.status ?? 1, signal: r.signal }), "killed");
});

console.log(`\n自检结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) process.exit(1);
