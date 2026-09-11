#!/usr/bin/env node
/**
 * load-test.mjs 纯函数自检。
 * 直接 `node scripts/load-test.selftest.mjs` 运行，全部断言通过退出码 0。
 * 覆盖：百分位、终态/重复判定、429 退避、错误分类、API envelope、参数边界。
 */
import assert from "node:assert/strict";
import {
  TERMINAL_STATUSES,
  SCENARIOS,
  isTerminalStatus,
  computePercentile,
  classifyExecutions,
  isRetryDerivedExecution,
  nextBackoffDelayMs,
  classifyError,
  unwrapApiData,
  parseArgs,
  throughputCounts,
  throughputPerMinute,
  completeSseHold,
  isSseHoldSuccess,
  cleanupTimeoutMs,
  validateCallbackBinding,
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
test("p50 偶数个取第 ceil(n/2) 个", () => {
  assert.equal(computePercentile([4, 1, 3, 2], 50), 2);
});
test("p95 最近秩取值", () => {
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(computePercentile(values, 95), 19);
  assert.equal(computePercentile(values, 100), 20);
  assert.equal(computePercentile(values, 5), 1);
});
test("非法/非有限样本不会污染百分位", () => {
  // 有效样本为 [1, 3]，nearest-rank p50 为第 1 个值。
  assert.equal(computePercentile([1, NaN, Infinity, 3], 50), 1);
  assert.equal(computePercentile([NaN, Infinity], 95), null);
  assert.equal(computePercentile([], 95), null);
  assert.equal(computePercentile(null, 95), null);
  assert.equal(computePercentile([1], 0), null);
  assert.equal(computePercentile([1], 101), null);
  assert.equal(computePercentile([1], NaN), null);
});
test("百分位不修改原数组", () => {
  const arr = [3, 1, 2];
  computePercentile(arr, 50);
  assert.deepEqual(arr, [3, 1, 2]);
});

// ---- isTerminalStatus ----
test("终态集合不含 pending/running/cancelled", () => {
  for (const status of ["success", "failed", "timeout", "killed"]) {
    assert.ok(isTerminalStatus(status), status);
  }
  for (const status of ["pending", "running", "cancelled", undefined, null, ""]) {
    assert.ok(!isTerminalStatus(status), String(status));
  }
  assert.deepEqual(TERMINAL_STATUSES, ["success", "failed", "timeout", "killed"]);
});

// ---- isRetryDerivedExecution + classifyExecutions ----
test("retryCount>0 是重试派生行", () => {
  assert.ok(isRetryDerivedExecution({ retryCount: 1, triggerType: "manual" }));
  assert.ok(isRetryDerivedExecution({ retryCount: 3 }));
  assert.ok(!isRetryDerivedExecution({ retryCount: 0, triggerType: "manual" }));
  assert.ok(!isRetryDerivedExecution({ retryCount: -1, triggerType: "manual" }));
});
test("恢复 triggerType 作为防御性兜底", () => {
  assert.ok(isRetryDerivedExecution({ triggerType: "stale_recovery" }));
  assert.ok(isRetryDerivedExecution({ triggerType: "executor_restart" }));
  assert.ok(!isRetryDerivedExecution({ triggerType: "cron" }));
});
test("单条 primary 终态无违规，pending/running 忽略", () => {
  const result = classifyExecutions([
    { id: "e1", status: "pending" },
    { id: "e2", status: "running" },
    { id: "e3", status: "success", retryCount: 0 },
  ]);
  assert.deepEqual(result, {
    primaryTerminal: 1,
    retryDerived: 0,
    duplicateViolation: false,
  });
});
test("cancelled 不计 primary，重试派生行不计违规", () => {
  const result = classifyExecutions([
    { id: "e1", status: "cancelled" },
    { id: "e2", status: "failed", retryCount: 0 },
    { id: "e3", status: "success", retryCount: 1 },
  ]);
  assert.equal(result.primaryTerminal, 1);
  assert.equal(result.retryDerived, 1);
  assert.equal(result.duplicateViolation, false);
});
test("两条非重试终态行是重复执行违规", () => {
  const result = classifyExecutions([
    { id: "e1", status: "success", retryCount: 0 },
    { id: "e2", status: "success", retryCount: 0 },
  ]);
  assert.equal(result.primaryTerminal, 2);
  assert.equal(result.duplicateViolation, true);
});
test("空输入/null 安全", () => {
  for (const input of [undefined, null, []]) {
    assert.deepEqual(classifyExecutions(input), {
      primaryTerminal: 0,
      retryDerived: 0,
      duplicateViolation: false,
    });
  }
});

// ---- nextBackoffDelayMs ----
test("指数退避 1s → 2s → 4s → 8s → 16s", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => nextBackoffDelayMs(attempt)),
    [1000, 2000, 4000, 8000, 16000],
  );
});
test("退避封顶 30s 和自定义 base/max", () => {
  assert.equal(nextBackoffDelayMs(10), 30_000);
  assert.equal(nextBackoffDelayMs(6), 30_000);
  assert.equal(nextBackoffDelayMs(2, { baseMs: 250, maxMs: 400 }), 400);
  assert.equal(nextBackoffDelayMs(1, { baseMs: 250 }), 250);
});
test("非法 attempt 回退为 1", () => {
  assert.equal(nextBackoffDelayMs(0), 1000);
  assert.equal(nextBackoffDelayMs(-3), 1000);
  assert.equal(nextBackoffDelayMs(NaN), 1000);
});

// ---- classifyError ----
test("HTTP 错误分类覆盖鉴权/限流/客户端/服务端", () => {
  assert.equal(classifyError({ status: 401 }), "auth");
  assert.equal(classifyError({ status: 403 }), "auth");
  assert.equal(classifyError({ status: 429 }), "throttle");
  assert.equal(classifyError({ status: 400 }), "validation");
  assert.equal(classifyError({ status: 422 }), "validation");
  assert.equal(classifyError({ status: 404 }), "not_found");
  assert.equal(classifyError({ status: 409 }), "conflict");
  assert.equal(classifyError({ status: 500 }), "server");
  assert.equal(classifyError({ status: 503 }), "server");
});
test("超时/网络/协议/未知与显式停止分类", () => {
  assert.equal(classifyError({ name: "TimeoutError" }), "timeout");
  assert.equal(classifyError({ code: "ETIMEDOUT" }), "timeout");
  assert.equal(classifyError({ name: "AbortError" }), "network");
  assert.equal(classifyError({ code: "ECONNREFUSED" }), "network");
  assert.equal(classifyError({ name: "ProtocolError" }), "protocol");
  assert.equal(classifyError(new Error("something else")), "unknown");
  assert.equal(classifyError({ name: "AbortError" }, { cancelled: true }), "cancelled");
});

// ---- unwrapApiData ----
test("兼容 admin-api response envelope 与裸数据", () => {
  assert.deepEqual(unwrapApiData({ code: 200, message: "success", data: { id: "t1" } }), { id: "t1" });
  assert.deepEqual(unwrapApiData({ data: [1, 2] }), { data: [1, 2] });
  assert.deepEqual(unwrapApiData({ id: "raw" }), { id: "raw" });
  assert.equal(unwrapApiData(null), null);
});

// ---- 吞吐、SSE hold、teardown 与 callback 绑定 ----
test("吞吐区分 attempted 与 successful，失败请求不计完成吞吐", () => {
  const stats = { attempted: 4, successful: 3 };
  assert.deepEqual(throughputCounts("callback", stats, 10), {
    attemptedUnits: 40,
    completedUnits: 30,
  });
  const rates = throughputPerMinute("callback", stats, 60_000, 10);
  assert.equal(rates.attemptedPerMinute, 40);
  assert.equal(rates.completedPerMinute, 30);
});
test("SSE hold 只有已建连且非外部停止才算成功，并保留真实 headerMs", () => {
  assert.equal(isSseHoldSuccess({ held: true, connected: true }), true);
  assert.equal(isSseHoldSuccess({ held: true, connected: false }), false);
  assert.equal(isSseHoldSuccess({ held: true, connected: true, parentAborted: true }), false);
  assert.deepEqual(completeSseHold(1000, 37, 11_000), {
    durationMs: 10_000,
    headerMs: 37,
  });
});
test("teardown 超时随任务数增长且至少 60 秒", () => {
  assert.equal(cleanupTimeoutMs(1, 30), 60_000);
  assert.ok(cleanupTimeoutMs(1000, 30) > cleanupTimeoutMs(1, 30));
});
test("v1 callback token 必须绑定同一 UUID v4，legacy 必须有地址", () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const token = `v1.${id}.9999999999.${"a".repeat(64)}`;
  assert.deepEqual(validateCallbackBinding({ token, executionId: id }), {
    ok: true,
    kind: "per_execution",
    executorAddress: null,
  });
  assert.equal(validateCallbackBinding({ token, executionId: "00000000-0000-4000-8000-000000000001" }).reason, "executionIdBinding");
  assert.equal(validateCallbackBinding({ token: "legacy-token", executionId: id }).reason, "executorAddress");
  assert.equal(validateCallbackBinding({ token: "legacy-token", executionId: id, executorAddress: "executor-a:8001" }).ok, true);
});

// ---- parseArgs 边界 ----
test("默认参数与场景集合", () => {
  const opts = parseArgs([]);
  assert.equal(opts.scenario, "tasks");
  assert.equal(opts.count, 10);
  assert.equal(opts.concurrency, 10);
  assert.deepEqual(SCENARIOS, ["tasks", "sse", "callback"]);
});
test("SSE 参数解析并拒绝非法路径/并发", () => {
  const opts = parseArgs(["--scenario", "sse", "--duration", "2", "--sse-path", "/api/executions/stream"]);
  assert.equal(opts.scenario, "sse");
  assert.equal(opts.durationSec, 2);
  assert.equal(opts.ssePath, "/api/executions/stream");
  assert.throws(() => parseArgs(["--concurrency", "0"]), /--concurrency/);
  assert.throws(() => parseArgs(["--scenario", "wat"]), /--scenario/);
  assert.throws(() => parseArgs(["--scenario", "sse", "--sse-path", "metrics/stream"]), /--sse-path/);
});
test("callback 参数边界要求 token/id，并限制 batch 1..100", () => {
  assert.throws(() => parseArgs(["--scenario", "callback"]), /callback-token/);
  const opts = parseArgs([
    "--scenario", "callback",
    "--callback-token", `v1.00000000-0000-4000-8000-000000000000.9999999999.${"a".repeat(64)}`,
    "--callback-execution-id", "00000000-0000-4000-8000-000000000000",
    "--callback-batch-size", "100",
  ]);
  assert.equal(opts.callbackBatchSize, 100);
  assert.equal(opts.writeRate, 40);
  assert.throws(() => parseArgs([
    "--scenario", "callback",
    "--callback-token", `v1.00000000-0000-4000-8000-000000000000.9999999999.${"a".repeat(64)}`,
    "--callback-execution-id", "x",
    "--callback-batch-size", "101",
  ]), /callback-batch-size/);
});

test("参数拒绝 count/duration 非法值和非正速率", () => {
  assert.throws(() => parseArgs(["--count", "1.5"]), /--count/);
  assert.throws(() => parseArgs(["--duration", "0"]), /--duration/);
  assert.throws(() => parseArgs(["--max-rpm", "0"]), /--max-rpm/);
  assert.throws(() => parseArgs(["--request-timeout", "-1"]), /--request-timeout/);
});

console.log(`\n${passed} 个断言组全部通过`);
