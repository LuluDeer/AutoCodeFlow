#!/usr/bin/env node
/**
 * AutoFlow 全栈压测工具（Node 原生，零第三方依赖，需 Node >= 18）。
 *
 * 默认 tasks 场景验证「登录 → 创建 → 触发 → 回调/终态」；另支持：
 *   - sse：受控建立 SSE 长连接（默认 /api/metrics/stream）；
 *   - callback：使用调用方提供的回调 token/执行 ID 对回调入口做受控请求。
 *
 * 本工具是可重复运行的观测/回归工具，不把目标并发当作已验收容量。真实容量结论
 * 必须连同 compose、账号、在线 executor、限流配置和监控水位一并记录，见
 * scripts/load-test.README.md 与 docs/QA-05-capacity-boundaries.md。
 */
import { pathToFileURL } from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// 纯函数区（scripts/load-test.selftest.mjs 用 node:assert 覆盖）
// ---------------------------------------------------------------------------

/** 非取消终态（cancelled 单列：等待循环需提前返回，但判违不计入 primary）。 */
export const TERMINAL_STATUSES = ["success", "failed", "timeout", "killed"];
export const CANCELLED_STATUS = "cancelled";
export const SCENARIOS = ["tasks", "sse", "callback"];
export const ERROR_CATEGORIES = [
  "auth",
  "throttle",
  "validation",
  "not_found",
  "conflict",
  "server",
  "timeout",
  "network",
  "cancelled",
  "protocol",
  "unknown",
];

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value) {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

/**
 * Validate the callback binding before sending a request. The API requires a
 * UUID v4 in every item; legacy shared/per-executor tokens additionally need
 * the executor address because that address is part of authentication.
 */
export function validateCallbackBinding({
  token,
  executionId,
  executorAddress = null,
}) {
  if (!isUuidV4(executionId)) {
    return { ok: false, reason: "executionId" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "token" };
  }
  const address = typeof executorAddress === "string" ? executorAddress.trim() : "";
  if (/\s/.test(address)) {
    return { ok: false, reason: "executorAddress" };
  }
  if (token.startsWith("v1.")) {
    const match = /^v1\.([^\.\s]+)\.(\d+)\.([0-9a-f]{64})$/.exec(token);
    if (!match) return { ok: false, reason: "token" };
    if (match[1] !== executionId) {
      return { ok: false, reason: "executionIdBinding" };
    }
    return { ok: true, kind: "per_execution", executorAddress: address || null };
  }
  if (!address) return { ok: false, reason: "executorAddress" };
  return { ok: true, kind: "legacy", executorAddress: address };
}

/** Return successful and attempted units; failed requests never enter completion throughput. */
export function throughputCounts(scenario, stats, callbackBatchSize = 1) {
  const multiplier = scenario === "callback" ? callbackBatchSize : 1;
  const attempted = Number(stats?.attempted ?? stats?.jobs ?? 0);
  const successfulRequests = Number(
    scenario === "tasks" ? stats?.success ?? 0 : stats?.successful ?? 0,
  );
  return {
    attemptedUnits: Math.max(0, attempted) * multiplier,
    completedUnits: Math.max(0, successfulRequests) * multiplier,
  };
}

export function throughputPerMinute(scenario, stats, elapsedMs, callbackBatchSize = 1) {
  const counts = throughputCounts(scenario, stats, callbackBatchSize);
  const minutes = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs / 60_000 : 0;
  return {
    ...counts,
    attemptedPerMinute: minutes > 0 ? counts.attemptedUnits / minutes : 0,
    completedPerMinute: minutes > 0 ? counts.completedUnits / minutes : 0,
  };
}

/** Only a connected stream stopped by its own hold timer is a successful hold. */
export function isSseHoldSuccess({ held, connected, parentAborted = false } = {}) {
  return Boolean(held && connected && !parentAborted);
}

/** Preserve the measured response-header latency when a hold timer closes SSE. */
export function completeSseHold(startedAt, headerMs, endedAt = Date.now()) {
  return {
    durationMs: Math.max(0, endedAt - startedAt),
    headerMs: Number.isFinite(headerMs) ? headerMs : null,
  };
}

export function cleanupTimeoutMs(taskCount, requestTimeoutSec) {
  const count = Math.max(1, Math.ceil(Number(taskCount) || 1));
  const requestMs = Math.max(1, Number(requestTimeoutSec) || 1) * 1000;
  // Cleanup is independent from load rate limiting and runs with 16 workers.
  // Allow a full per-request timeout for every worker wave; cap at one hour
  // so a huge duration run still has a bounded teardown phase.
  return Math.max(60_000, Math.min(3_600_000, Math.ceil(count / 16) * requestMs + 30_000));
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * nearest-rank 百分位数。values 中只接受有限数字；p ∈ (0, 100]。
 * 空数组/非法输入返回 null，且不修改调用方数组。
 */
export function computePercentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(p) || p <= 0 || p > 100) return null;
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/**
 * 恢复路径的重试行兜底 triggerType。正常情况下重试派生行继承原行
 * triggerType 并带 retryCount>0；仅在原行 triggerType 缺失时才落到这两个回退值。
 */
const RETRY_TRIGGER_FALLBACKS = new Set(["stale_recovery", "executor_restart"]);

/** 重试派生行判定：retryCount>0 即可，回退 triggerType 仅作防御性兜底。 */
export function isRetryDerivedExecution(exec) {
  if (Number(exec?.retryCount ?? 0) > 0) return true;
  return RETRY_TRIGGER_FALLBACKS.has(exec?.triggerType ?? "");
}

/**
 * 对齐 admin-api 重试语义：只把非取消、非重试派生的终态行作为 primary。
 * primary > 1 才是重复执行违规；pending/running 不计入违规。
 */
export function classifyExecutions(executions) {
  const primary = [];
  let retryDerived = 0;
  for (const execution of executions ?? []) {
    if (execution?.status === CANCELLED_STATUS) continue;
    if (!isTerminalStatus(execution?.status)) continue;
    if (isRetryDerivedExecution(execution)) retryDerived += 1;
    else primary.push(execution);
  }
  return {
    primaryTerminal: primary.length,
    retryDerived,
    duplicateViolation: primary.length > 1,
  };
}

/**
 * 429 指数退避（attempt 从 1 开始）：base * 2^(attempt-1)，封顶 max。
 * 纯函数不含抖动——调用方自行叠加随机抖动，保证测试确定性。
 */
export function nextBackoffDelayMs(
  attempt,
  { baseMs = 1000, maxMs = 30_000 } = {},
) {
  const a = Math.max(1, Math.floor(attempt) || 1);
  return Math.min(baseMs * 2 ** (a - 1), maxMs);
}

/**
 * 将 admin-api 的 HTTP 状态/Node fetch 错误归一到有限分类，报告中按分类聚合。
 * cancelled 由调用方显式传入，避免把普通请求超时误报为用户停止。
 */
export function classifyError(error, { cancelled = false } = {}) {
  if (cancelled) return "cancelled";
  const status = Number(error?.status);
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422 || status === 400) return "validation";
  if (status === 429) return "throttle";
  if (status >= 500) return "server";
  if (
    error?.name === "TimeoutError" ||
    error?.code === "ETIMEDOUT" ||
    /timed out|timeout/i.test(String(error?.message ?? ""))
  ) {
    return "timeout";
  }
  if (
    error?.name === "AbortError" ||
    ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "UND_ERR_SOCKET"].includes(
      error?.code,
    ) ||
    /fetch failed|network|socket|connect/i.test(String(error?.message ?? ""))
  ) {
    return "network";
  }
  if (error?.name === "ProtocolError") return "protocol";
  return "unknown";
}

/** admin-api 全局 ResponseInterceptor 的 { code, message, data } 解包。 */
export function unwrapApiData(value) {
  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "data") &&
    (Object.prototype.hasOwnProperty.call(value, "code") ||
      Object.prototype.hasOwnProperty.call(value, "message"))
  ) {
    return value.data;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 小工具与参数
// ---------------------------------------------------------------------------

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("请求已停止");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("请求已停止"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function parseNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} 必须是数字`);
  return number;
}

/** 导出供 selftest 覆盖参数边界；直接 --help 仍在 CLI 层退出。 */
export function parseArgs(argv) {
  const opts = {
    scenario: "tasks",
    baseUrl: process.env.LOAD_TEST_BASE_URL || "http://localhost:3105",
    username: process.env.LOAD_TEST_USERNAME || "admin",
    password: process.env.LOAD_TEST_PASSWORD || "Admin@123456",
    concurrency: 10,
    count: null,
    durationSec: null,
    maxRpm: 55,
    writeRate: 40,
    callbackRate: null,
    pollIntervalMs: 1000,
    taskTimeoutSec: 180,
    requestTimeoutSec: 30,
    ssePath: "/api/metrics/stream",
    sseHoldSec: 10,
    callbackToken: process.env.LOAD_TEST_CALLBACK_TOKEN || null,
    callbackExecutionId: process.env.LOAD_TEST_CALLBACK_EXECUTION_ID || null,
    callbackStatus: "success",
    callbackBatchSize: 1,
    callbackExecutorAddress:
      process.env.LOAD_TEST_CALLBACK_EXECUTOR_ADDRESS || null,
    executor: null,
    glueLanguage: "javascript",
    keepTasks: false,
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
      case "--base-url":
        opts.baseUrl = next();
        break;
      case "--username":
        opts.username = next();
        break;
      case "--password":
        opts.password = next();
        break;
      case "--concurrency":
        opts.concurrency = parseNumber(next(), "--concurrency");
        break;
      case "--count":
        opts.count = parseNumber(next(), "--count");
        break;
      case "--duration":
        opts.durationSec = parseNumber(next(), "--duration");
        break;
      case "--max-rpm":
        opts.maxRpm = parseNumber(next(), "--max-rpm");
        break;
      case "--write-rpm":
        opts.writeRate = parseNumber(next(), "--write-rpm");
        break;
      case "--create-rate":
        // Backward-compatible alias; reports/help use the unambiguous write-rpm name.
        opts.writeRate = parseNumber(next(), "--create-rate");
        break;
      case "--callback-rate":
        opts.callbackRate = parseNumber(next(), "--callback-rate");
        break;
      case "--poll-interval":
        opts.pollIntervalMs = parseNumber(next(), "--poll-interval");
        break;
      case "--task-timeout":
        opts.taskTimeoutSec = parseNumber(next(), "--task-timeout");
        break;
      case "--request-timeout":
        opts.requestTimeoutSec = parseNumber(next(), "--request-timeout");
        break;
      case "--sse-path":
        opts.ssePath = next();
        break;
      case "--sse-hold":
        opts.sseHoldSec = parseNumber(next(), "--sse-hold");
        break;
      case "--callback-token":
        opts.callbackToken = next();
        break;
      case "--callback-execution-id":
        opts.callbackExecutionId = next();
        break;
      case "--callback-status":
        opts.callbackStatus = next();
        break;
      case "--callback-batch-size":
        opts.callbackBatchSize = parseNumber(next(), "--callback-batch-size");
        break;
      case "--callback-executor-address":
        opts.callbackExecutorAddress = next();
        break;
      case "--executor":
        opts.executor = next();
        break;
      case "--glue-language":
        opts.glueLanguage = next();
        break;
      case "--keep-tasks":
        opts.keepTasks = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数: ${arg}（--help 查看用法）`);
    }
  }

  if (!SCENARIOS.includes(opts.scenario)) {
    throw new Error(`--scenario 必须是 ${SCENARIOS.join(" | ")}`);
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error("--concurrency 必须是 >= 1 的整数");
  }
  if (opts.count === null && opts.durationSec === null) opts.count = 10;
  if (
    opts.count !== null &&
    (!Number.isInteger(opts.count) || opts.count < 1)
  ) {
    throw new Error("--count 必须是 >= 1 的整数");
  }
  if (opts.durationSec !== null && opts.durationSec <= 0) {
    throw new Error("--duration 必须 > 0 秒");
  }
  for (const [name, value] of [
    ["--max-rpm", opts.maxRpm],
    ["--write-rpm", opts.writeRate],
    ["--poll-interval", opts.pollIntervalMs],
    ["--task-timeout", opts.taskTimeoutSec],
    ["--request-timeout", opts.requestTimeoutSec],
    ["--sse-hold", opts.sseHoldSec],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} 必须 > 0`);
    }
  }
  if (opts.callbackRate !== null && opts.callbackRate <= 0) {
    throw new Error("--callback-rate 必须 > 0");
  }
  if (!opts.ssePath.startsWith("/")) {
    throw new Error("--sse-path 必须是以 / 开头的路径");
  }
  if (!["success", "failed"].includes(opts.callbackStatus)) {
    throw new Error("--callback-status 必须是 success | failed");
  }
  if (
    !Number.isInteger(opts.callbackBatchSize) ||
    opts.callbackBatchSize < 1 ||
    opts.callbackBatchSize > 100
  ) {
    throw new Error("--callback-batch-size 必须是 1..100 的整数");
  }
  if (opts.scenario === "callback") {
    if (!opts.callbackToken) {
      throw new Error("callback 场景必须提供 --callback-token 或 LOAD_TEST_CALLBACK_TOKEN");
    }
    if (!opts.callbackExecutionId) {
      throw new Error(
        "callback 场景必须提供 --callback-execution-id 或 LOAD_TEST_CALLBACK_EXECUTION_ID",
      );
    }
    const binding = validateCallbackBinding({
      token: opts.callbackToken,
      executionId: opts.callbackExecutionId,
      executorAddress: opts.callbackExecutorAddress,
    });
    if (!binding.ok) {
      const messages = {
        executionId: "--callback-execution-id 必须是 UUID v4",
        executionIdBinding: "--callback-execution-id 必须与 v1 callback token 绑定的 executionId 一致",
        executorAddress:
          "legacy callback token 必须提供非空 --callback-executor-address（且不能含空白）",
        token: "--callback-token 格式无效（v1 token 必须包含 executionId、过期时间和 64 位签名）",
      };
      throw new Error(messages[binding.reason] ?? "callback 参数校验失败");
    }
  }
  if (opts.scenario === "tasks" && opts.glueLanguage !== "javascript") {
    throw new Error("当前 tasks 场景仅支持 --glue-language javascript");
  }
  return opts;
}

export function printHelp() {
  console.log(`AutoFlow 全栈压测工具（详见 scripts/load-test.README.md）

用法: node scripts/load-test.mjs [options]

通用选项:
  --scenario NAME       tasks（默认）| sse | callback
  --base-url URL        admin-api 地址（默认 http://localhost:3105）
  --username NAME       管理员用户名（env LOAD_TEST_USERNAME，默认 admin）
  --password PASS       管理员密码（env LOAD_TEST_PASSWORD，默认 Admin@123456）
  --concurrency N       在途工作数（默认 10）
  --count N             工作单元数（默认 10；和 --duration 同给时先到者停）
  --duration SEC        按时长派发（秒）
  --max-rpm N           所有压测请求的总预算/分钟（默认 55；读写都受此约束）
  --write-rpm N         压测写请求预算/分钟（默认 40；--create-rate 为兼容别名）
  --callback-rate N     callback 场景写请求预算/分钟（默认使用 --write-rpm）
  --request-timeout SEC 单个 HTTP 请求超时（默认 30）
  --keep-tasks          tasks 场景结束后保留任务（默认删除）

tasks 选项:
  --poll-interval MS    executions 轮询间隔（默认 1000）
  --task-timeout SEC    单任务等待终态超时（默认 180）
  --executor UUID       固定派发到指定执行器
  --glue-language LANG  javascript（当前唯一支持，默认 javascript）

sse 选项:
  --sse-path PATH       SSE 地址（默认 /api/metrics/stream）
  --sse-hold SEC        每条连接保持秒数（默认 10）

callback 选项:
  --callback-token TOKEN       回调 Bearer token（或 LOAD_TEST_CALLBACK_TOKEN）
  --callback-execution-id UUID 回调绑定 execution ID（或 LOAD_TEST_CALLBACK_EXECUTION_ID）
  --callback-status STATUS     success | failed（默认 success）
  --callback-batch-size N      每个 HTTP 请求的回调条目数 1..100（默认 1）
  --callback-executor-address ADDRESS
                           legacy/shared executor token 时随条目发送的地址（v1 可省略）
  -h, --help                   显示帮助`);
}

// ---------------------------------------------------------------------------
// 限速 HTTP 客户端
// ---------------------------------------------------------------------------

/** 滑动窗口限速器：每 60s 最多 max 个请求，支持 AbortSignal 安全停止排队。 */
class RateLimiter {
  constructor(maxPerMinute) {
    this.max = maxPerMinute;
    this.timestamps = [];
  }

  async acquire(signal) {
    for (;;) {
      if (signal?.aborted) {
        throw Object.assign(new Error("请求已停止"), { name: "AbortError" });
      }
      const now = Date.now();
      this.timestamps = this.timestamps.filter((timestamp) => now - timestamp < 60_000);
      if (this.timestamps.length < this.max) {
        this.timestamps.push(now);
        return;
      }
      await sleep(60_000 - (now - this.timestamps[0]) + 1, signal);
    }
  }
}

function makeHttpError(method, path, status, text) {
  const error = new Error(
    `${method} ${path} → HTTP ${status}: ${String(text ?? "").slice(0, 300)}`,
  );
  error.status = status;
  return error;
}

class ApiClient {
  constructor(baseUrl, { maxRpm, writeRate, requestTimeoutSec }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    // --max-rpm is the aggregate budget for every load request. The write
    // limiter is a narrower budget for mutating load requests; cleanup can
    // explicitly bypass both via rateLimit:false.
    this.requestLimiter = new RateLimiter(maxRpm);
    this.writeLimiter = new RateLimiter(writeRate);
    this.requestTimeoutMs = requestTimeoutSec * 1000;
    this.token = null;
    this.stats = { requests: 0, retries429: 0 };
  }

  async request(
    method,
    path,
    { body, auth = true, write = false, signal, rateLimit = true } = {},
  ) {
    const max429Retries = 5;
    let attempt = 0;
    for (;;) {
      if (rateLimit) {
        await this.requestLimiter.acquire(signal);
        if (write) await this.writeLimiter.acquire(signal);
      }
      if (signal?.aborted) {
        throw Object.assign(new Error("请求已停止"), { name: "AbortError" });
      }
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.requestTimeoutMs);
      this.stats.requests += 1;
      let response;
      try {
        response = await fetch(this.baseUrl + path, {
          method,
          headers: {
            "content-type": "application/json",
            ...(auth && this.token
              ? { authorization: `Bearer ${this.token}` }
              : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut && !signal?.aborted) {
          throw Object.assign(new Error(`HTTP 请求超时: ${method} ${path}`), {
            name: "TimeoutError",
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      if (response.status === 429 && attempt < max429Retries) {
        attempt += 1;
        this.stats.retries429 += 1;
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : nextBackoffDelayMs(attempt) + Math.floor(Math.random() * 250);
        logWarn(`HTTP 429，${delayMs}ms 后第 ${attempt} 次重试: ${method} ${path}`);
        await sleep(delayMs, signal);
        continue;
      }
      return response;
    }
  }

  async json(method, path, opts = {}) {
    const response = await this.request(method, path, opts);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) throw makeHttpError(method, path, response.status, text);
    return unwrapApiData(data);
  }

  login(username, password, options = {}) {
    return this.json("POST", "/api/auth/login", {
      ...options,
      body: { username, password },
      auth: false,
      write: true,
    });
  }
  createTask(payload, options = {}) {
    return this.json("POST", "/api/tasks", {
      ...options,
      body: payload,
      write: true,
    });
  }
  triggerTask(id, options = {}) {
    return this.json("POST", `/api/tasks/${id}/trigger`, {
      ...options,
      body: {},
      write: true,
    });
  }
  listExecutions(id, options = {}) {
    return this.json("GET", `/api/tasks/${id}/executions?page=1&pageSize=50`, options);
  }
  deleteTask(id, options = {}) {
    return this.json("DELETE", `/api/tasks/${id}`, { ...options, write: true });
  }
}

// ---------------------------------------------------------------------------
// 场景流程
// ---------------------------------------------------------------------------

const GLUE_SOURCE = {
  javascript: "console.log('autoflow-load-test');",
  python: "print('autoflow-load-test')",
  shell: "echo autoflow-load-test",
};

function buildTaskPayload(opts, seq, runId) {
  return {
    name: `loadtest-${runId}-${seq}`,
    triggerType: "manual",
    runtime: "node",
    glueLanguage: opts.glueLanguage,
    glueSource: GLUE_SOURCE[opts.glueLanguage] ?? GLUE_SOURCE.javascript,
    timeoutSeconds: 60,
    // maxRetry=0 → BullMQ attempts=1，隔离重试语义，重复执行判定保持严格。
    maxRetry: 0,
    status: "active",
    ...(opts.executor ? { executorId: opts.executor } : {}),
  };
}

/** 轮询单个 execution 至终态；返回终态行 + 观测到的全部 executions（去重）。 */
async function pollUntilTerminal(client, taskId, execId, opts, triggeredAt, signal) {
  const deadline = Date.now() + opts.taskTimeoutSec * 1000;
  const seen = new Map();
  for (;;) {
    const page = await client.listExecutions(taskId, { signal });
    for (const execution of page?.items ?? []) {
      if (execution?.id) seen.set(execution.id, execution);
    }
    const mine = seen.get(execId);
    if (mine) {
      if (isTerminalStatus(mine.status)) {
        return {
          status: mine.status,
          durationMs: Number.isFinite(mine.duration)
            ? mine.duration
            : Date.now() - triggeredAt,
          executions: [...seen.values()],
          timedOut: false,
        };
      }
      if (mine.status === CANCELLED_STATUS) {
        return {
          status: CANCELLED_STATUS,
          durationMs: Date.now() - triggeredAt,
          executions: [...seen.values()],
          timedOut: false,
        };
      }
    }
    if (Date.now() >= deadline) {
      return {
        status: "poll_timeout",
        durationMs: Date.now() - triggeredAt,
        executions: [...seen.values()],
        timedOut: true,
      };
    }
    await sleep(opts.pollIntervalMs, signal);
  }
}

/** 固定并发工作池；count/duration 均给出时先达到者停止派发。 */
async function runPool(opts, workerFn, signal, onWorkerError) {
  const deadline =
    opts.durationSec === null ? null : Date.now() + opts.durationSec * 1000;
  let next = 0;
  const shouldStop = () =>
    Boolean(signal?.aborted) ||
    (deadline !== null && Date.now() >= deadline) ||
    (opts.count !== null && next >= opts.count);
  const worker = async () => {
    for (;;) {
      if (shouldStop()) return;
      const index = next;
      next += 1;
      try {
        await workerFn(index);
      } catch (error) {
        onWorkerError?.(index, error);
      }
    }
  };
  const size =
    opts.durationSec !== null
      ? opts.concurrency
      : Math.max(1, Math.min(opts.concurrency, opts.count));
  await Promise.all(Array.from({ length: size }, worker));
}

function logWarn(message) {
  console.error(`[load-test] ${message}`);
}

function newStats(scenario) {
  return {
    scenario,
    // attempted is the number of work units actually claimed by the pool;
    // completed/successful are only successful units eligible for completion throughput.
    attempted: 0,
    jobs: 0,
    completed: 0,
    created: 0,
    createFailed: 0,
    triggered: 0,
    triggerFailed: 0,
    success: 0,
    successful: 0,
    failed: 0,
    failedRequests: 0,
    killed: 0,
    cancelled: 0,
    pollTimeout: 0,
    duplicateTasks: [],
    retryDerivedRows: 0,
    durationsMs: [],
    headerDurationsMs: [],
    taskIds: [],
    errorCategories: Object.fromEntries(ERROR_CATEGORIES.map((name) => [name, 0])),
    errorSamples: [],
    stopped: false,
    cleanupSucceeded: 0,
    cleanupFailed: 0,
    cleanupIncomplete: false,
  };
}

function recordError(stats, error, stage, { cancelled = false } = {}) {
  const category = classifyError(error, { cancelled });
  stats.errorCategories[category] = (stats.errorCategories[category] ?? 0) + 1;
  if (stats.errorSamples.length < 20) {
    stats.errorSamples.push({
      category,
      stage,
      message: String(error?.message ?? error),
    });
  }
  return category;
}

async function runTasks(client, opts, signal, stats) {
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  await runPool(
    opts,
    async (index) => {
      stats.jobs += 1;
      stats.attempted += 1;
      const payload = buildTaskPayload(opts, index, runId);
      let task;
      try {
        task = await client.createTask(payload, { signal });
        if (!task?.id) throw Object.assign(new Error("创建响应缺少 task.id"), { name: "ProtocolError" });
        stats.created += 1;
        stats.taskIds.push(task.id);
      } catch (error) {
        stats.createFailed += 1;
        recordError(stats, error, "create", { cancelled: signal.aborted });
        logWarn(`任务创建失败 (${payload.name}): ${error.message}`);
        return;
      }

      let execution;
      try {
        execution = await client.triggerTask(task.id, { signal });
        if (!execution?.id) throw Object.assign(new Error("触发响应缺少 execution.id"), { name: "ProtocolError" });
        stats.triggered += 1;
      } catch (error) {
        stats.triggerFailed += 1;
        recordError(stats, error, "trigger", { cancelled: signal.aborted });
        logWarn(`任务触发失败 (${payload.name}): ${error.message}`);
        return;
      }

      const triggeredAt = Date.now();
      let result;
      try {
        result = await pollUntilTerminal(client, task.id, execution.id, opts, triggeredAt, signal);
      } catch (error) {
        stats.failed += 1;
        if (signal.aborted) stats.cancelled += 1;
        recordError(stats, error, "poll", { cancelled: signal.aborted });
        logWarn(`任务轮询失败 (${payload.name}): ${error.message}`);
        return;
      }
      stats.completed += 1;
      if (Number.isFinite(result.durationMs)) stats.durationsMs.push(result.durationMs);
      const verdict = classifyExecutions(result.executions);
      stats.retryDerivedRows += verdict.retryDerived;
      if (verdict.duplicateViolation) {
        stats.duplicateTasks.push(task.name);
        logWarn(`重复执行违规: ${payload.name} primary=${verdict.primaryTerminal}`);
      }
      switch (result.status) {
        case "success":
          if (verdict.duplicateViolation) stats.failed += 1;
          else stats.success += 1;
          break;
        case "failed":
        case "timeout":
          stats.failed += 1;
          break;
        case "killed":
          stats.killed += 1;
          break;
        case CANCELLED_STATUS:
          stats.cancelled += 1;
          break;
        default:
          stats.pollTimeout += 1;
          stats.failed += 1;
          recordError(
            stats,
            Object.assign(new Error("execution 在规定时间内未终态"), {
              name: "TimeoutError",
            }),
            "poll_timeout",
          );
      }
    },
    signal,
    (_index, error) => {
      stats.failed += 1;
      recordError(stats, error, "worker", { cancelled: signal.aborted });
    },
  );
}

async function runSseConnection(client, opts, signal) {
  const startedAt = Date.now();
  const child = new AbortController();
  let held = false;
  const onParentAbort = () => child.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    held = true;
    child.abort();
  }, opts.sseHoldSec * 1000);
  let reader;
  let connected = false;
  let headerMs = null;
  try {
    const response = await client.request("GET", opts.ssePath, { signal: child.signal });
    if (!response.ok) {
      const text = await response.text();
      throw makeHttpError("GET", opts.ssePath, response.status, text);
    }
    if (!response.body) {
      throw Object.assign(new Error("SSE 响应缺少可读 body"), { name: "ProtocolError" });
    }
    headerMs = Date.now() - startedAt;
    connected = true;
    reader = response.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    if (!held && !signal?.aborted) {
      throw Object.assign(new Error("SSE 在保持窗口结束前断开"), { name: "ProtocolError" });
    }
    return { durationMs: Date.now() - startedAt, headerMs };
  } catch (error) {
    // 只有已收到有效 SSE body 后的 hold timer 中止才算成功；连接阶段超时
    // 不能伪装成“已保持到期”。
    if (
      isSseHoldSuccess({
        held,
        connected,
        parentAborted: signal?.aborted,
      })
    ) {
      return completeSseHold(startedAt, headerMs, Date.now());
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
    try {
      await reader?.cancel();
    } catch {
      // body 已由 AbortSignal 关闭时 cancel 可能抛错，忽略即可。
    }
  }
}

async function runSse(client, opts, signal, stats) {
  await runPool(
    opts,
    async () => {
      stats.jobs += 1;
      stats.attempted += 1;
      try {
        const result = await runSseConnection(client, opts, signal);
        stats.completed += 1;
        stats.successful += 1;
        stats.durationsMs.push(result.durationMs);
        stats.headerDurationsMs.push(result.headerMs);
      } catch (error) {
        stats.failedRequests += 1;
        if (signal.aborted) stats.cancelled += 1;
        recordError(stats, error, "sse", { cancelled: signal.aborted });
      }
    },
    signal,
    (_index, error) => {
      stats.jobs += 1;
      stats.attempted += 1;
      stats.failedRequests += 1;
      recordError(stats, error, "sse_worker", { cancelled: signal.aborted });
    },
  );
}

function buildCallbackItems(opts) {
  return Array.from({ length: opts.callbackBatchSize }, () => ({
    executionId: opts.callbackExecutionId,
    status: opts.callbackStatus,
    ...(opts.callbackExecutorAddress
      ? { executorAddress: opts.callbackExecutorAddress }
      : {}),
  }));
}

async function runCallbacks(client, opts, signal, stats) {
  const body = buildCallbackItems(opts);
  await runPool(
    opts,
    async () => {
      stats.jobs += 1;
      stats.attempted += 1;
      try {
        await client.json("POST", "/api/executions/callback", {
          body,
          signal,
          write: true,
        });
        stats.completed += 1;
        stats.successful += 1;
      } catch (error) {
        stats.failedRequests += 1;
        if (signal.aborted) stats.cancelled += 1;
        recordError(stats, error, "callback", { cancelled: signal.aborted });
      }
    },
    signal,
    (_index, error) => {
      stats.jobs += 1;
      stats.attempted += 1;
      stats.failedRequests += 1;
      recordError(stats, error, "callback_worker", { cancelled: signal.aborted });
    },
  );
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function fmtErrors(stats) {
  return ERROR_CATEGORIES
    .filter((name) => stats.errorCategories[name] > 0)
    .map((name) => `${name}=${stats.errorCategories[name]}`)
    .join(", ") || "无";
}

function printReport(opts, stats, elapsedMs, client) {
  const rates = throughputPerMinute(
    stats.scenario,
    stats,
    elapsedMs,
    opts.callbackBatchSize,
  );
  const p50 = computePercentile(stats.durationsMs, 50);
  const p95 = computePercentile(stats.durationsMs, 95);
  const successRate =
    rates.attemptedUnits > 0
      ? (rates.completedUnits / rates.attemptedUnits) * 100
      : 0;
  const unitName = stats.scenario === "callback" ? "回调条目" : stats.scenario === "sse" ? "连接" : "任务";

  console.log(`\n==== 压测报告 ====\n目标:                ${client.baseUrl}\n场景:                ${stats.scenario}\n规模:                ${opts.durationSec !== null ? `duration=${opts.durationSec}s` : `count=${opts.count}`} / 并发度=${opts.concurrency}\n总耗时:              ${fmtMs(elapsedMs)}\n工作单元 attempted:   ${stats.attempted}\n成功完成:             ${rates.completedUnits} ${unitName}\n成功率:               ${successRate.toFixed(1)}%\n尝试吞吐:             ${rates.attemptedPerMinute.toFixed(1)} ${unitName}/分钟\n完成吞吐:             ${rates.completedPerMinute.toFixed(1)} ${unitName}/分钟\np50 / p95:            ${fmtMs(p50)} / ${fmtMs(p95)}\n错误分类:            ${fmtErrors(stats)}\nHTTP 请求 / 429:     ${client.stats.requests} / ${client.stats.retries429}\n安全停止:            ${stats.stopped ? "是" : "否"}`);

  if (stats.scenario === "tasks") {
    console.log(`创建成功/失败:       ${stats.created} / ${stats.createFailed}\n触发成功/失败:       ${stats.triggered} / ${stats.triggerFailed}\n终态 success/failed:  ${stats.success} / ${stats.failed}\nkilled/cancelled:     ${stats.killed} / ${stats.cancelled}\n轮询超时:             ${stats.pollTimeout}\n重复执行违规任务:     ${stats.duplicateTasks.length}\n重试派生行(不计违):   ${stats.retryDerivedRows}\n清理成功/失败:        ${stats.cleanupSucceeded} / ${stats.cleanupFailed}`);
  } else if (stats.scenario === "sse") {
    console.log(`连接成功/失败:       ${stats.successful} / ${stats.failedRequests}\n建连 p50 / p95:      ${fmtMs(computePercentile(stats.headerDurationsMs, 50))} / ${fmtMs(computePercentile(stats.headerDurationsMs, 95))}`);
  } else {
    console.log(`HTTP 请求成功/失败:   ${stats.successful} / ${stats.failedRequests}\n每请求回调条目:       ${opts.callbackBatchSize}`);
  }
  if (stats.cleanupIncomplete) {
    console.log("清理结论:             FAILED（存在未清理任务，请人工复核）");
  }
  if (stats.errorSamples.length > 0) {
    console.log(`错误样例:             ${stats.errorSamples.map((sample) => `${sample.category}/${sample.stage}: ${sample.message}`).join(" | ")}`);
  }
}

async function cleanupTasks(client, stats, requestTimeoutSec) {
  if (stats.taskIds.length === 0) return;
  const controller = new AbortController();
  const timeoutMs = cleanupTimeoutMs(stats.taskIds.length, requestTimeoutSec);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let next = 0;
  let failed = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= stats.taskIds.length) return;
      const id = stats.taskIds[index];
      try {
        // Teardown has its own bounded concurrent lane and deliberately bypasses
        // load read/write buckets, so a saturated write budget cannot starve it.
        await client.deleteTask(id, {
          signal: controller.signal,
          rateLimit: false,
        });
        stats.cleanupSucceeded += 1;
      } catch (error) {
        failed += 1;
        stats.cleanupFailed += 1;
        recordError(stats, error, "cleanup", { cancelled: controller.signal.aborted });
        logWarn(`清理任务失败 (${id}): ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, stats.taskIds.length) }, worker));
  clearTimeout(timer);
  if (failed > 0 || controller.signal.aborted) {
    stats.cleanupFailed = Math.max(stats.cleanupFailed, failed);
    stats.cleanupIncomplete = true;
    logWarn(`清理未完成: failed=${failed}, timeoutMs=${timeoutMs}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const writeRate = opts.scenario === "callback" ? opts.callbackRate ?? opts.writeRate : opts.writeRate;
  const client = new ApiClient(opts.baseUrl, {
    maxRpm: opts.maxRpm,
    writeRate,
    requestTimeoutSec: opts.requestTimeoutSec,
  });
  const stopController = new AbortController();
  const onSignal = () => {
    if (!stopController.signal.aborted) {
      console.error("\n[load-test] 收到停止信号：停止派发并中止在途请求，等待清理。");
      stopController.abort();
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const startedAt = Date.now();
  const stats = newStats(opts.scenario);

  console.log("==== AutoFlow 全栈压测 ====");
  console.log(`目标: ${client.baseUrl}`);
  console.log(`场景=${opts.scenario} 并发度=${opts.concurrency} 规模=${opts.durationSec !== null ? `duration=${opts.durationSec}s` : `count=${opts.count}`} maxRpm=${opts.maxRpm} writeRate=${writeRate}/min`);

  try {
    if (opts.scenario === "callback") {
      client.token = opts.callbackToken;
      await runCallbacks(client, opts, stopController.signal, stats);
    } else {
      const login = await client.login(opts.username, opts.password, {
        signal: stopController.signal,
      });
      if (!login?.accessToken) {
        throw Object.assign(new Error("登录响应缺少 accessToken"), { name: "ProtocolError" });
      }
      client.token = login.accessToken;
      console.log("登录成功，JWT 已获取。\n");
      if (opts.scenario === "sse") {
        await runSse(client, opts, stopController.signal, stats);
      } else {
        await runTasks(client, opts, stopController.signal, stats);
      }
    }
  } catch (error) {
    const category = recordError(stats, error, "bootstrap", {
      cancelled: stopController.signal.aborted,
    });
    if (opts.scenario !== "callback" && !stopController.signal.aborted) {
      console.error(`\n登录/启动失败 [${category}]: ${error.message}`);
      console.error("检查 compose、账号密码、API 地址、限流与在线 executor。");
      process.exitCode = 2;
    }
  } finally {
    stats.stopped = stopController.signal.aborted;
    if (opts.scenario === "tasks" && !opts.keepTasks) {
      console.log(`\n清理 ${stats.taskIds.length} 个压测任务（独立并发/超时，不占用压测限速）...`);
      await cleanupTasks(client, stats, opts.requestTimeoutSec);
    } else if (opts.scenario === "tasks") {
      console.log(`\n--keep-tasks: 保留 ${stats.taskIds.length} 个任务不清理。`);
    }
    printReport(opts, stats, Date.now() - startedAt, client);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  if (process.exitCode === 2) return 2;
  const pass =
    !stats.stopped &&
    stats.jobs > 0 &&
    stats.errorCategories.cancelled === 0 &&
    (opts.scenario === "tasks"
      ? stats.success === stats.attempted &&
        stats.duplicateTasks.length === 0 &&
        stats.pollTimeout === 0
      : stats.successful === stats.attempted) &&
    !stats.cleanupIncomplete;
  return pass ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => {
      if (Number.isInteger(code)) process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[load-test] 运行错误: ${error?.stack || error}`);
      process.exitCode = 2;
    });
}
