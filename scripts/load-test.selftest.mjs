#!/usr/bin/env node
/**
 * load-test.mjs 纯函数自检（对齐 executor-desktop `test:main` 自检先例）。
 * 直接 `node scripts/load-test.selftest.mjs` 运行，全部断言通过退出码 0。
 * 覆盖：p95 计算、重复执行判定（retry 语义）、429 退避曲线、终态判定。
 */
import assert from "node:assert/strict";
import {
  TERMINAL_STATUSES,
  isTerminalStatus,
  computePercentile,
  classifyExecutions,
  isRetryDerivedExecution,
  nextBackoffDelayMs,
} from "./load-test.mjs";

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("load-test.selftest");

// ---- computePercentile（nearest-rank）----
test("p50 取中位（奇数个）", () => {
  assert.equal(computePercentile([3, 1, 2], 50), 2);
});
test("p50 偶数个取第 ceil(n/2) 个（nearest-rank）", () => {
  // 4 个值 → ceil(0.5*4)=2 → sorted[1]=2
  assert.equal(computePercentile([4, 1, 3, 2], 50), 2);
});
test("p95 最近秩取值", () => {
  // 20 个值 1..20，nearest-rank p95 → ceil(0.95*20)=19 → 19
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(computePercentile(values, 95), 19);
  assert.equal(computePercentile(values, 100), 20);
  assert.equal(computePercentile(values, 5), 1);
});
test("p95 输入未排序也能正确计算", () => {
  assert.equal(computePercentile([900, 100, 500, 300, 700], 95), 900);
});
test("空数组 / 非法 p 返回 null", () => {
  assert.equal(computePercentile([], 95), null);
  assert.equal(computePercentile(null, 95), null);
  assert.equal(computePercentile([1], 0), null);
  assert.equal(computePercentile([1], 101), null);
  assert.equal(computePercentile([1], NaN), null);
});
test("不修改原数组", () => {
  const arr = [3, 1, 2];
  computePercentile(arr, 50);
  assert.deepEqual(arr, [3, 1, 2]);
});

// ---- isTerminalStatus ----
test("终态集合含 success/failed/timeout/killed，不含 pending/running/cancelled", () => {
  for (const s of ["success", "failed", "timeout", "killed"]) {
    assert.ok(isTerminalStatus(s), s);
  }
  for (const s of ["pending", "running", "cancelled", undefined, null, ""]) {
    assert.ok(!isTerminalStatus(s), String(s));
  }
  assert.equal(TERMINAL_STATUSES.includes("cancelled"), false);
});

// ---- isRetryDerivedExecution ----
test("retryCount>0 的行为重试派生行", () => {
  assert.ok(isRetryDerivedExecution({ retryCount: 1, triggerType: "manual" }));
  assert.ok(isRetryDerivedExecution({ retryCount: 3 }));
});
test("retryCount 缺失/为 0 的 manual 行不是重试派生", () => {
  assert.ok(!isRetryDerivedExecution({ retryCount: 0, triggerType: "manual" }));
  assert.ok(!isRetryDerivedExecution({ triggerType: "manual" }));
  assert.ok(!isRetryDerivedExecution({}));
});
test("回退 triggerType（stale_recovery/executor_restart）按重试派生兜底", () => {
  assert.ok(isRetryDerivedExecution({ triggerType: "stale_recovery" }));
  assert.ok(isRetryDerivedExecution({ triggerType: "executor_restart" }));
  assert.ok(!isRetryDerivedExecution({ triggerType: "cron" }));
});

// ---- classifyExecutions（重复执行判定核心）----
test("单条成功 primary → 无违规", () => {
  const r = classifyExecutions([
    { id: "e1", status: "success", retryCount: 0, triggerType: "manual" },
  ]);
  assert.equal(r.primaryTerminal, 1);
  assert.equal(r.retryDerived, 0);
  assert.equal(r.duplicateViolation, false);
});
test("pending/running 未终态行被忽略", () => {
  const r = classifyExecutions([
    { id: "e1", status: "pending" },
    { id: "e2", status: "running" },
    { id: "e3", status: "success", retryCount: 0 },
  ]);
  assert.equal(r.primaryTerminal, 1);
  assert.equal(r.duplicateViolation, false);
});
test("cancelled 行不计入 primary 也不违规", () => {
  const r = classifyExecutions([
    { id: "e1", status: "cancelled" },
    { id: "e2", status: "success", retryCount: 0 },
  ]);
  assert.equal(r.primaryTerminal, 1);
  assert.equal(r.duplicateViolation, false);
});
test("重试派生行（stale sweep 兑现重试预算）不判违规", () => {
  const r = classifyExecutions([
    { id: "e1", status: "failed", retryCount: 0, triggerType: "manual" },
    { id: "e2", status: "success", retryCount: 1, triggerType: "manual" },
  ]);
  assert.equal(r.primaryTerminal, 1);
  assert.equal(r.retryDerived, 1);
  assert.equal(r.duplicateViolation, false);
});
test("两条非重试终态行 → 重复执行违规", () => {
  const r = classifyExecutions([
    { id: "e1", status: "success", retryCount: 0 },
    { id: "e2", status: "success", retryCount: 0 },
  ]);
  assert.equal(r.primaryTerminal, 2);
  assert.equal(r.duplicateViolation, true);
});
test("primary 与重试派生混合时仅按 primary 计违规", () => {
  const r = classifyExecutions([
    { id: "e1", status: "success", retryCount: 0 },
    { id: "e2", status: "failed", retryCount: 0 },
    { id: "e3", status: "success", retryCount: 2 },
    { id: "e4", status: "running" },
    { id: "e5", status: "cancelled" },
  ]);
  assert.equal(r.primaryTerminal, 2);
  assert.equal(r.retryDerived, 1);
  assert.equal(r.duplicateViolation, true);
});
test("空输入 / null 安全", () => {
  for (const input of [undefined, null, []]) {
    const r = classifyExecutions(input);
    assert.equal(r.primaryTerminal, 0);
    assert.equal(r.retryDerived, 0);
    assert.equal(r.duplicateViolation, false);
  }
});

// ---- nextBackoffDelayMs（429 退避曲线）----
test("指数退避: 1s → 2s → 4s → 8s → 16s", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((a) => nextBackoffDelayMs(a)),
    [1000, 2000, 4000, 8000, 16000],
  );
});
test("退避封顶 30s", () => {
  assert.equal(nextBackoffDelayMs(10), 30_000);
  assert.equal(nextBackoffDelayMs(6), 30_000);
});
test("自定义 base/max", () => {
  assert.equal(
    nextBackoffDelayMs(2, { baseMs: 250, maxMs: 400 }),
    400,
  );
  assert.equal(nextBackoffDelayMs(1, { baseMs: 250 }), 250);
});
test("非法 attempt 回退为 1", () => {
  assert.equal(nextBackoffDelayMs(0), 1000);
  assert.equal(nextBackoffDelayMs(-3), 1000);
  assert.equal(nextBackoffDelayMs(NaN), 1000);
});

console.log(`\n${passed} 个断言组全部通过`);
