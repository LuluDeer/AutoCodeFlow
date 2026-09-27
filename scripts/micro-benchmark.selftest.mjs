#!/usr/bin/env node
/**
 * micro-benchmark.mjs 纯函数自检。
 * `node scripts/micro-benchmark.selftest.mjs`，断言全过退出码 0。
 */
import assert from "node:assert/strict";
import {
  benchmarkDispatchDecision,
  benchmarkLoadScore,
  benchmarkHandleCallbackBatch,
  benchmarkStoreLogLines,
  computeExecutorLoadScoreModel,
  levelOfLineModel,
  longTaskPenalty,
  makeCallbackBatch,
  makeEstimatedDurationsByAddress,
  makeExecutors,
  parseArgs,
  percentile,
} from "./micro-benchmark.mjs";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("micro-benchmark.selftest");

test("parseArgs 支持场景、采样、预热、JSON 与阈值", () => {
  const opts = parseArgs([
    "--scenario",
    "dispatch-decision",
    "--iterations",
    "7",
    "--warmup",
    "1",
    "--json",
    "--threshold-ms",
    "dispatch-decision=12.5",
  ]);
  assert.equal(opts.scenario, "dispatch-decision");
  assert.equal(opts.iterations, 7);
  assert.equal(opts.warmup, 1);
  assert.equal(opts.json, true);
  assert.deepEqual(opts.thresholdsMs, { "dispatch-decision": 12.5 });
});

test("percentile 使用 nearest-rank 且不修改原数组", () => {
  const values = [5, 1, 3, 2, 4];
  assert.equal(percentile(values, 50), 3);
  assert.equal(percentile(values, 95), 5);
  assert.deepEqual(values, [5, 1, 3, 2, 4]);
});

test("levelOfLineModel 识别常见级别标记", () => {
  assert.equal(levelOfLineModel("2026-09-09T10:00:00Z INFO ready"), "info");
  assert.equal(levelOfLineModel("[WARN] slow path"), "warn");
  assert.equal(levelOfLineModel("level=ERROR failed"), "error");
  assert.equal(levelOfLineModel("plain output"), null);
});

test("handleCallback 批量模型固定 100 条并统计终态/缺日志", () => {
  const batch = makeCallbackBatch(100);
  const r = benchmarkHandleCallbackBatch(batch);
  assert.equal(r.total, 100);
  assert.equal(r.terminal, 100);
  assert.equal(r.success + r.failed, 100);
  assert.equal(r.missingLogs, 20);
  assert.equal(r.auditDetails.length, 100);
});

test("storeLogLines 万行模型生成 500 行 chunk", () => {
  const logs = Array.from({ length: 1000 }, (_, i) => `INFO line ${i}`).join("\n");
  const r = benchmarkStoreLogLines(logs, "e1");
  assert.equal(r.lines, 1000);
  assert.equal(r.entities, 1000);
  assert.equal(r.chunks, 2);
  assert.equal(r.firstLevel, "info");
  assert.equal(r.lastLineNumber, 999);
});

test("longTaskPenalty 忽略空值并按 1 小时封顶", () => {
  assert.equal(longTaskPenalty([]), 0);
  assert.equal(longTaskPenalty([null, 0, -1]), 0);
  assert.equal(longTaskPenalty([1800]), 0.5);
  assert.equal(longTaskPenalty([7200]), 1);
});

test("computeExecutorLoadScoreModel 与 CORE-05 权重语义一致", () => {
  const score = computeExecutorLoadScoreModel(
    { runningTaskCount: 5, maxConcurrentTasks: 10, cpuUsage: 20, memUsage: 40 },
    { estimatedDurations: [3600] },
  );
  assert.equal(Number(score.toFixed(3)), 0.5);
});

test("dispatch 决策模型从候选里返回可用执行器", () => {
  const executors = makeExecutors(20);
  const durations = makeEstimatedDurationsByAddress(executors);
  const r = benchmarkDispatchDecision(executors, durations);
  assert.equal(r.candidates, 20);
  assert.equal(r.available > 0, true);
  assert.match(r.chosenId, /^executor-/);
  assert.equal(typeof r.chosenScore, "number");
});

test("load-score 场景：兜底路径不产生 NaN（缺 cpu/mem/max 的真实注册早期形态）", () => {
  const r = benchmarkLoadScore(makeExecutors(20), makeEstimatedDurationsByAddress(makeExecutors(20)));
  assert.equal(r.nonFinite, 0, "任何执行器的 score 都不应为 NaN/Infinity");
  assert.equal(Number.isFinite(r.bareScore), true, "缺 cpu/mem/maxConcurrentTasks 时必须走 ?? 兜底");
  // 注意：**刻意断言 Infinity 而非有限值**——模型如实复现了真实公式的除零行为
  // （`maxConcurrentTasks ?? 10` 只兜 null/undefined，0 会穿透 → runningTaskCount/0）。
  // 这不是 benchmark 的 bug，而是把生产缺陷暴露出来的探针；修法在写入侧
  // （register 采纳域，见 executor.service.ts 的 N-09 注记），不在公式侧。
  // 之所以钉住它：一旦有人给公式加 `|| 10` 兜底（看似无害），这里会红，
  // 从而强制他去看"为什么会有 0 落库"——那才是真问题。
  assert.equal(r.zeroMaxScore, Infinity, "0 容量在公式侧确实除零得 Infinity（探针价值所在）");
  assert.equal(typeof r.checksum, "number");
});

test("load-score 场景：与真实公式同序（权重 0.5/0.25/0.25/0.1）", () => {
  // 单点复核：load=1.0 时 score 应恰为 0.5（其余项为 0）
  const score = computeExecutorLoadScoreModel(
    { id: "e", address: "e:1", runningTaskCount: 10, maxConcurrentTasks: 10, cpuUsage: 0, memUsage: 0 },
    { estimatedDurations: [] },
  );
  assert.equal(Number(score.toFixed(3)), 0.5);
});

test("parseArgs 接受 load-score 场景", () => {
  const opts = parseArgs(["--scenario", "load-score"]);
  assert.equal(opts.scenario, "load-score");
});

console.log(`\n${passed} assertions passed`);
process.exit(0);
