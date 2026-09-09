#!/usr/bin/env node
/**
 * AutoFlow 关键路径微基准（QA-10，Node 原生零依赖，需 Node >= 18）
 *
 * 覆盖三类容易退化的热路径模型：
 *   1) handleCallback 批量 100：模拟执行器回调批处理中的状态归一、日志缺失判断、
 *      终态分布与回调摘要构造。
 *   2) storeLogLines 万行：对齐 TaskService.storeLogLines 的日志 split、level 推断、
 *      entity 构造与 500 行 chunk 切分成本。
 *   3) dispatch 决策：对齐 CORE-05 评分模型，对候选执行器计算 loadScore 并排序选主。
 *
 * 这是可选的本机微基准，不连接数据库/Redis/HTTP，也不替代 E2E 压测。
 * 默认只打印耗时分位数；如需 CI 防退化，可传 --threshold-ms name=value。
 */
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import process from "node:process";

const DEFAULT_ITERATIONS = 20;
const DEFAULT_WARMUP = 3;
const STORE_LOG_LINES_COUNT = 10_000;
const CALLBACK_BATCH_SIZE = 100;
const DISPATCH_CANDIDATES = 500;
const LOG_CHUNK = 500;

const STATUS_SUCCESS = "success";
const STATUS_FAILED = "failed";
const TERMINAL = new Set(["success", "failed", "timeout", "killed", "cancelled"]);

const LOAD_SCORE_WEIGHTS = {
  load: 0.5,
  cpu: 0.25,
  mem: 0.25,
  estimated: 0.1,
};

const LEVEL_WORDS = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  WARNING: "warn",
  ERROR: "error",
  ERR: "error",
};
const TIMESTAMP_PREFIX_RE = /^\s*(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*)?/;
const LEVEL_MARKER_RE = /(?:^|[\s[({])(?:level=|lvl=)?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|ERR)(?:\]|\)|:|\s|$)/i;

function usage() {
  console.log(`AutoFlow 关键路径微基准

用法: node scripts/micro-benchmark.mjs [options]

选项:
  --scenario NAME          all | handle-callback | store-log-lines | dispatch-decision（默认 all）
  --iterations N           每个场景正式采样次数（默认 ${DEFAULT_ITERATIONS}）
  --warmup N               每个场景预热次数（默认 ${DEFAULT_WARMUP}）
  --threshold-ms NAME=MS   场景 p95 阈值，超过则退出码 1；可重复传
  --json                   输出 JSON，便于 CI 采集
  -h, --help               显示帮助

示例:
  node scripts/micro-benchmark.mjs
  node scripts/micro-benchmark.mjs --scenario dispatch-decision --iterations 50
  node scripts/micro-benchmark.mjs --threshold-ms dispatch-decision=8 --threshold-ms store-log-lines=40`);
}

export function parseArgs(argv) {
  const opts = {
    scenario: "all",
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    json: false,
    thresholdsMs: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`参数 ${arg} 缺少值`);
      return argv[i];
    };
    switch (arg) {
      case "--scenario":
        opts.scenario = next();
        break;
      case "--iterations":
        opts.iterations = Number(next());
        break;
      case "--warmup":
        opts.warmup = Number(next());
        break;
      case "--threshold-ms": {
        const raw = next();
        const [name, value] = raw.split("=");
        if (!name || value === undefined) {
          throw new Error("--threshold-ms 格式必须为 name=ms");
        }
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms <= 0) {
          throw new Error(`--threshold-ms ${name} 的值必须 > 0`);
        }
        opts.thresholdsMs[name] = ms;
        break;
      }
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}（--help 查看用法）`);
    }
  }
  if (!Number.isInteger(opts.iterations) || opts.iterations < 1) {
    throw new Error("--iterations 必须是 >= 1 的整数");
  }
  if (!Number.isInteger(opts.warmup) || opts.warmup < 0) {
    throw new Error("--warmup 必须是 >= 0 的整数");
  }
  const allowed = new Set(["all", "handle-callback", "store-log-lines", "dispatch-decision"]);
  if (!allowed.has(opts.scenario)) {
    throw new Error(`--scenario 不支持: ${opts.scenario}`);
  }
  return opts;
}

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function levelOfLineModel(line) {
  if (typeof line !== "string" || line.length === 0) return null;
  const withoutTimestamp = line.replace(TIMESTAMP_PREFIX_RE, "");
  const m = LEVEL_MARKER_RE.exec(withoutTimestamp);
  if (!m) return null;
  return LEVEL_WORDS[m[1].toUpperCase()] ?? null;
}

export function longTaskPenalty(estimatedDurations) {
  const values = (estimatedDurations ?? []).filter(
    (n) => typeof n === "number" && Number.isFinite(n) && n > 0,
  );
  if (values.length === 0) return 0;
  const avg = values.reduce((sum, n) => sum + n, 0) / values.length;
  return Math.min(avg / 3600, 1);
}

export function computeExecutorLoadScoreModel(executor, options = {}) {
  const w = options.weights ?? LOAD_SCORE_WEIGHTS;
  const max = executor.maxConcurrentTasks ?? 10;
  const loadRatio = executor.runningTaskCount / max;
  const cpuRatio = (executor.cpuUsage ?? 0) / 100;
  const memRatio = (executor.memUsage ?? 0) / 100;
  const penalty = longTaskPenalty(options.estimatedDurations ?? []);
  return w.load * loadRatio + w.cpu * cpuRatio + w.mem * memRatio + w.estimated * penalty;
}

export function makeCallbackBatch(size = CALLBACK_BATCH_SIZE) {
  return Array.from({ length: size }, (_, i) => {
    const status = i % 17 === 0 ? STATUS_FAILED : STATUS_SUCCESS;
    return {
      executionId: `exec-${i}`,
      status,
      exitCode: status === STATUS_SUCCESS ? 0 : 1,
      logs: i % 5 === 0 ? "" : `2026-09-09T10:00:00Z INFO callback ${i}\nWARN retry probe ${i}`,
      error: status === STATUS_FAILED ? `failure ${i}` : null,
      metrics: { durationMs: 100 + i, memoryMb: 64 + (i % 8) },
    };
  });
}

export function benchmarkHandleCallbackBatch(batch = makeCallbackBatch()) {
  const summary = {
    total: 0,
    terminal: 0,
    success: 0,
    failed: 0,
    missingLogs: 0,
    needsLogBackfill: [],
    auditDetails: [],
  };
  for (const cb of batch) {
    summary.total += 1;
    if (TERMINAL.has(cb.status)) summary.terminal += 1;
    if (cb.status === STATUS_SUCCESS) summary.success += 1;
    if (cb.status === STATUS_FAILED) summary.failed += 1;
    if (!cb.logs) {
      summary.missingLogs += 1;
      summary.needsLogBackfill.push(cb.executionId);
    }
    summary.auditDetails.push({
      executionId: cb.executionId,
      status: cb.status,
      exitCode: cb.exitCode,
      durationMs: cb.metrics?.durationMs ?? null,
      hasError: Boolean(cb.error),
    });
  }
  return summary;
}

export function makeLogPayload(lines = STORE_LOG_LINES_COUNT) {
  const levels = ["INFO", "DEBUG", "WARN", "ERROR", "plain"];
  return Array.from({ length: lines }, (_, i) => {
    const level = levels[i % levels.length];
    if (level === "plain") return `line ${i} without marker`;
    return `2026-09-09T10:00:00Z ${level} worker line ${i}`;
  }).join("\n");
}

export function benchmarkStoreLogLines(logs = makeLogPayload(), executionId = "bench-exec") {
  const lines = typeof logs === "string" ? logs.split("\n") : logs;
  const entities = lines.map((content, i) => ({
    executionId,
    lineNumber: i,
    content,
    level: levelOfLineModel(content),
  }));
  const chunks = [];
  for (let i = 0; i < entities.length; i += LOG_CHUNK) {
    chunks.push(entities.slice(i, i + LOG_CHUNK));
  }
  return {
    lines: lines.length,
    entities: entities.length,
    chunks: chunks.length,
    firstLevel: entities[0]?.level ?? null,
    lastLineNumber: entities.at(-1)?.lineNumber ?? null,
  };
}

export function makeExecutors(size = DISPATCH_CANDIDATES) {
  return Array.from({ length: size }, (_, i) => ({
    id: `executor-${i}`,
    address: `10.0.${Math.floor(i / 255)}.${i % 255}:3105`,
    runningTaskCount: i % 11,
    maxConcurrentTasks: 10 + (i % 5),
    cpuUsage: (i * 17) % 100,
    memUsage: (i * 29) % 100,
    status: "ONLINE",
  }));
}

export function makeEstimatedDurationsByAddress(executors) {
  const map = new Map();
  for (const [i, e] of executors.entries()) {
    const count = Math.max(0, e.runningTaskCount);
    map.set(
      e.address,
      Array.from({ length: count }, (_, j) => (i % 7 === 0 ? 3600 : 30 + j * 15)),
    );
  }
  return map;
}

export function benchmarkDispatchDecision(
  executors = makeExecutors(),
  estimatedDurations = makeEstimatedDurationsByAddress(executors),
) {
  const scored = executors
    .filter((e) => e.runningTaskCount < (e.maxConcurrentTasks ?? Infinity))
    .map((executor) => ({
      executor,
      score: computeExecutorLoadScoreModel(executor, {
        estimatedDurations: estimatedDurations.get(executor.address) ?? [],
      }),
    }))
    .sort((a, b) => a.score - b.score);
  return {
    candidates: executors.length,
    available: scored.length,
    chosenId: scored[0]?.executor.id ?? null,
    chosenScore: scored[0]?.score ?? null,
  };
}

function benchOne(name, fn, { iterations, warmup }) {
  for (let i = 0; i < warmup; i += 1) fn();
  const samplesMs = [];
  let lastResult;
  const memoryBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    lastResult = fn();
    samplesMs.push(performance.now() - start);
  }
  const memoryAfter = process.memoryUsage().heapUsed;
  return {
    name,
    iterations,
    minMs: Math.min(...samplesMs),
    p50Ms: percentile(samplesMs, 50),
    p95Ms: percentile(samplesMs, 95),
    maxMs: Math.max(...samplesMs),
    avgMs: samplesMs.reduce((sum, n) => sum + n, 0) / samplesMs.length,
    heapDeltaBytes: memoryAfter - memoryBefore,
    lastResult,
  };
}

function scenariosFor(name) {
  const all = {
    "handle-callback": () => benchmarkHandleCallbackBatch(),
    "store-log-lines": () => benchmarkStoreLogLines(),
    "dispatch-decision": () => benchmarkDispatchDecision(),
  };
  if (name === "all") return all;
  return { [name]: all[name] };
}

function round(n) {
  return typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(3)) : n;
}

function compactResult(result) {
  return {
    ...result,
    minMs: round(result.minMs),
    p50Ms: round(result.p50Ms),
    p95Ms: round(result.p95Ms),
    maxMs: round(result.maxMs),
    avgMs: round(result.avgMs),
  };
}

function printTable(results, thresholdsMs) {
  console.log("AutoFlow 关键路径微基准");
  console.log("");
  console.log("场景                 iter   avg(ms)  p50(ms)  p95(ms)  max(ms)  heapΔ(KB)  阈值");
  console.log("--------------------------------------------------------------------------------");
  for (const r of results) {
    const threshold = thresholdsMs[r.name];
    const verdict = threshold ? (r.p95Ms <= threshold ? `<=${threshold}` : `>${threshold}`) : "-";
    console.log(
      `${r.name.padEnd(20)} ${String(r.iterations).padStart(4)} ${round(r.avgMs).toFixed(3).padStart(9)} ${round(r.p50Ms).toFixed(3).padStart(8)} ${round(r.p95Ms).toFixed(3).padStart(8)} ${round(r.maxMs).toFixed(3).padStart(8)} ${round(r.heapDeltaBytes / 1024).toFixed(1).padStart(10)}  ${verdict}`,
    );
  }
}

export function runBenchmarks(opts) {
  return Object.entries(scenariosFor(opts.scenario)).map(([name, fn]) =>
    benchOne(name, fn, opts),
  );
}

function failuresFor(results, thresholdsMs) {
  return results.filter((r) => thresholdsMs[r.name] && r.p95Ms > thresholdsMs[r.name]);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  const results = runBenchmarks(opts).map(compactResult);
  const failures = failuresFor(results, opts.thresholdsMs);
  if (opts.json) {
    console.log(JSON.stringify({ results, thresholdsMs: opts.thresholdsMs, pass: failures.length === 0 }, null, 2));
  } else {
    printTable(results, opts.thresholdsMs);
    console.log("");
    console.log(`结论: ${failures.length === 0 ? "PASS" : "FAIL"}`);
    for (const r of failures) {
      console.log(`  - ${r.name}: p95=${r.p95Ms}ms > threshold=${opts.thresholdsMs[r.name]}ms`);
    }
  }
  if (failures.length > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[micro-benchmark] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
