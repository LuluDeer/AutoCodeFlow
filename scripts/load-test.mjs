#!/usr/bin/env node
/**
 * AutoFlow 全栈并发压测工具（Node 原生，零第三方依赖，需 Node >= 18）
 *
 * 对运行中的全栈（admin-api + 至少 1 个在线执行器）做受控并发的任务压测，
 * 验证调度核心的正确性与吞吐：
 *   1) 登录取 JWT（POST /api/auth/login）
 *   2) 以并发度 C 创建 glue 脚本任务（POST /api/tasks，执行最快、必有终态）
 *      并手动触发（POST /api/tasks/:id/trigger）
 *   3) 轮询 executions 至终态，统计吞吐 / 成功率 / p50 / p95
 *   4) 重复执行检测：同一任务出现 >1 条「非取消终态且非重试派生」execution
 *      视为调度违规（retryCount>0 的行是 stale-sweep/重试预算兑现产生的
 *      合法派生行，不计违规——见 classifyExecutions 注释）
 *   5) 打印报告表；成功率 <100% 或发现重复执行时以非零码退出（供 CI/巡检）
 *
 * 限流：admin-api 全局 THROTTLE 默认 60 req/min，登录另有 LOGIN_THROTTLE_LIMIT。
 * 工具内置两层客户端限速（--max-rpm 总请求预算 / --create-rate 写操作预算），
 * 并对 429 做指数退避重试。压测前建议调高服务端 THROTTLE_LIMIT，
 * 详见 scripts/load-test.README.md。
 *
 * 用法示例：
 *   node scripts/load-test.mjs --base-url http://localhost:3105 \
 *     --username admin --password 'Admin@123456' --count 20 --concurrency 5
 */
import { pathToFileURL } from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// 纯函数区（scripts/load-test.selftest.mjs 用 node:assert 冒烟覆盖）
// ---------------------------------------------------------------------------

/** 非取消终态（cancelled 单列：等待循环需提前返回，但判违不计入 primary） */
export const TERMINAL_STATUSES = ["success", "failed", "timeout", "killed"];
export const CANCELLED_STATUS = "cancelled";

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * nearest-rank 百分位数。values 为非空数值数组，p ∈ (0, 100]。
 * 空数组/非法输入返回 null。
 */
export function computePercentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(p) || p <= 0 || p > 100) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/**
 * 恢复路径的重试行兜底 triggerType。正常情况下重试派生行继承原行
 * triggerType 并带 retryCount>0；仅在原行 triggerType 缺失时才落到这两个
 * 回退值（executor.service.scheduleRetryAfterRecovery 的 fallbackTriggerType）。
 */
const RETRY_TRIGGER_FALLBACKS = new Set(["stale_recovery", "executor_restart"]);

/** 重试派生行判定：retryCount>0 即可，回退 triggerType 仅作防御性兜底。 */
export function isRetryDerivedExecution(exec) {
  if (Number(exec?.retryCount ?? 0) > 0) return true;
  return RETRY_TRIGGER_FALLBACKS.has(exec?.triggerType ?? "");
}

/**
 * 重复执行判定（对齐 admin-api 重试语义）：
 * - BullMQ attempts 重试复用同一 execution 行（task.processor 把 FAILED 留在
 *   claimable 列表内）→ 不产生新行，天然不构成重复；
 * - stale sweep / executor-restart 恢复会新建 PENDING 行，其 retryCount =
 *   原行+1 → 由 isRetryDerivedExecution 识别，不计违规；
 * - 其余「非取消终态」行为 primary 行。压测每次触发恰好应产生 1 条 primary
 *   终态行；>1 即重复执行违规。
 */
export function classifyExecutions(executions) {
  const primary = [];
  let retryDerived = 0;
  for (const e of executions ?? []) {
    if (e?.status === CANCELLED_STATUS) continue;
    if (!isTerminalStatus(e?.status)) continue; // pending/running 尚未终态
    if (isRetryDerivedExecution(e)) retryDerived += 1;
    else primary.push(e);
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

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.LOAD_TEST_BASE_URL || "http://localhost:3105",
    username: process.env.LOAD_TEST_USERNAME || "admin",
    password: process.env.LOAD_TEST_PASSWORD || "Admin@123456",
    concurrency: 10,
    count: null,
    durationSec: null,
    maxRpm: 55,
    createRate: 40,
    pollIntervalMs: 1000,
    taskTimeoutSec: 180,
    executor: null,
    glueLanguage: "javascript",
    keepTasks: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`参数 ${arg} 缺少值`);
      }
      return argv[i];
    };
    switch (arg) {
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
        opts.concurrency = Number(next());
        break;
      case "--count":
        opts.count = Number(next());
        break;
      case "--duration":
        opts.durationSec = Number(next());
        break;
      case "--max-rpm":
        opts.maxRpm = Number(next());
        break;
      case "--create-rate":
        opts.createRate = Number(next());
        break;
      case "--poll-interval":
        opts.pollIntervalMs = Number(next());
        break;
      case "--task-timeout":
        opts.taskTimeoutSec = Number(next());
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
        break; // eslint-disable-line no-useless-break
      default:
        throw new Error(`未知参数: ${arg}（--help 查看用法）`);
    }
  }
  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1)
    throw new Error("--concurrency 必须 >= 1");
  if (opts.count === null && opts.durationSec === null) opts.count = 10;
  if (opts.count !== null && (!Number.isFinite(opts.count) || opts.count < 1))
    throw new Error("--count 必须 >= 1");
  if (
    opts.durationSec !== null &&
    (!Number.isFinite(opts.durationSec) || opts.durationSec <= 0)
  )
    throw new Error("--duration 必须 > 0 秒");
  return opts;
}

function printHelp() {
  console.log(`AutoFlow 全栈压测工具（详见 scripts/load-test.README.md）

用法: node scripts/load-test.mjs [options]

选项:
  --base-url URL        admin-api 地址（默认 http://localhost:3105，
                        或 env LOAD_TEST_BASE_URL）
  --username NAME       管理员用户名（env LOAD_TEST_USERNAME，默认 admin）
  --password PASS       管理员密码（env LOAD_TEST_PASSWORD，默认 Admin@123456
                        = compose 缺省 INITIAL_ADMIN_PASSWORD）
  --concurrency N       在途任务并发度（默认 10）
  --count N             共创建+触发的任务数（默认 10）
  --duration SEC        按时长压测（与 --count 二选一，同时给出时先到者停）
  --max-rpm N           工具侧总请求预算/分钟（默认 55，须低于服务端
                        THROTTLE_LIMIT，避免 429）
  --create-rate N       写操作（create/trigger/delete）速率/分钟（默认 40）
  --poll-interval MS    轮询 executions 的基础间隔（默认 1000，实际还受
                        --max-rpm 约束）
  --task-timeout SEC    单任务等待终态的超时（默认 180）
  --executor UUID       任务固定派发到该执行器（executorId pin；缺省由
                        admin 选择最低负载执行器）
  --glue-language LANG  glue 语言: javascript | python | shell（默认 javascript）
  --keep-tasks          结束后保留创建的任务（默认删除）
  -h, --help            显示帮助`);
}

// ---------------------------------------------------------------------------
// 限速 HTTP 客户端
// ---------------------------------------------------------------------------

/** 滑动窗口限速器：每 60s 最多 max 个请求，超出则排队等待。 */
class RateLimiter {
  constructor(maxPerMinute) {
    this.max = maxPerMinute;
    this.timestamps = [];
  }

  async acquire() {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
      if (this.timestamps.length < this.max) {
        this.timestamps.push(now);
        return;
      }
      await sleep(60_000 - (now - this.timestamps[0]) + 1);
    }
  }
}

class ApiClient {
  constructor(baseUrl, { maxRpm, writeRate }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.readLimiter = new RateLimiter(maxRpm);
    this.writeLimiter = new RateLimiter(writeRate);
    this.token = null;
    this.stats = { requests: 0, retries429: 0 };
  }

  async request(method, path, { body, auth = true, write = false } = {}) {
    const max429Retries = 5;
    let attempt = 0;
    for (;;) {
      await (write ? this.writeLimiter : this.readLimiter).acquire();
      this.stats.requests += 1;
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < max429Retries) {
        attempt += 1;
        this.stats.retries429 += 1;
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : nextBackoffDelayMs(attempt) + Math.floor(Math.random() * 250);
        logWarn(`HTTP 429，${delayMs}ms 后第 ${attempt} 次重试: ${method} ${path}`);
        await sleep(delayMs);
        continue;
      }
      return res;
    }
  }

  async json(method, path, opts = {}) {
    const res = await this.request(method, path, opts);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(
        `${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
      err.status = res.status;
      throw err;
    }
    return data;
  }

  login(username, password) {
    return this.json("POST", "/api/auth/login", {
      body: { username, password },
      auth: false,
      write: true,
    });
  }
  createTask(payload) {
    return this.json("POST", "/api/tasks", { body: payload, write: true });
  }
  triggerTask(id) {
    return this.json("POST", `/api/tasks/${id}/trigger`, {
      body: {},
      write: true,
    });
  }
  listExecutions(id) {
    return this.json("GET", `/api/tasks/${id}/executions?page=1&pageSize=50`);
  }
  deleteTask(id) {
    return this.json("DELETE", `/api/tasks/${id}`, { write: true });
  }
}

// ---------------------------------------------------------------------------
// 压测流程
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
    // maxRetry=0 → BullMQ attempts=1，隔离重试语义，重复执行判定保持严格
    maxRetry: 0,
    status: "active",
    ...(opts.executor ? { executorId: opts.executor } : {}),
  };
}

/** 轮询单个 execution 至终态；返回终态行 + 观测到的全部 executions（去重）。 */
async function pollUntilTerminal(client, taskId, execId, opts, triggeredAt) {
  const deadline = Date.now() + opts.taskTimeoutSec * 1000;
  const seen = new Map();
  for (;;) {
    const page = await client.listExecutions(taskId);
    for (const e of page?.items ?? []) seen.set(e.id, e);
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
    await sleep(opts.pollIntervalMs);
  }
}

/** 固定并发度的工作池；duration 模式下到达截止时间即停止派发新任务。 */
async function runPool(opts, workerFn) {
  const deadline =
    opts.durationSec !== null ? Date.now() + opts.durationSec * 1000 : null;
  let next = 0;
  const shouldStop = () =>
    deadline !== null
      ? Date.now() >= deadline
      : next >= /** count 模式 */ opts.count;
  const worker = async () => {
    for (;;) {
      const idx = next;
      if (shouldStop()) return;
      next += 1;
      await workerFn(idx);
    }
  };
  const size =
    opts.durationSec !== null
      ? opts.concurrency
      : Math.max(1, Math.min(opts.concurrency, opts.count));
  await Promise.all(Array.from({ length: size }, worker));
}

function logWarn(msg) {
  console.error(`[load-test] ${msg}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const client = new ApiClient(opts.baseUrl, {
    maxRpm: opts.maxRpm,
    writeRate: opts.createRate,
  });
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const startedAt = Date.now();

  console.log("==== AutoFlow 全栈压测 ====");
  console.log(`目标: ${client.baseUrl}`);
  console.log(
    `并发度=${opts.concurrency} 规模=${opts.durationSec !== null ? `duration=${opts.durationSec}s` : `count=${opts.count}`} ` +
      `maxRpm=${opts.maxRpm} createRate=${opts.createRate}/min glue=${opts.glueLanguage}`,
  );

  // 1) 登录（LOGIN_THROTTLE_LIMIT 限速，失败 3 次即放弃）
  let accessToken;
  try {
    const login = await client.login(opts.username, opts.password);
    accessToken = login?.accessToken;
  } catch (err) {
    console.error(`\n登录失败: ${err.message}`);
    console.error(
      "检查账号密码（compose 缺省 admin/Admin@123456，以 .env 的 INITIAL_ADMIN_PASSWORD 为准）。",
    );
    process.exit(2);
  }
  if (!accessToken) {
    console.error("\n登录响应缺少 accessToken，退出。");
    process.exit(2);
  }
  client.token = accessToken;
  console.log("登录成功，JWT 已获取。\n");

  // 2) 并发创建 + 触发 + 轮询至终态
  const stats = {
    jobs: 0,
    created: 0,
    createFailed: 0,
    triggered: 0,
    triggerFailed: 0,
    success: 0,
    failed: 0,
    killed: 0,
    cancelled: 0,
    pollTimeout: 0,
    duplicateTasks: [],
    retryDerivedRows: 0,
    durationsMs: [],
    taskIds: [],
  };

  await runPool(opts, async (idx) => {
    stats.jobs += 1;
    const payload = buildTaskPayload(opts, idx, runId);
    let task;
    try {
      task = await client.createTask(payload);
      stats.created += 1;
    } catch (err) {
      stats.createFailed += 1;
      logWarn(`任务创建失败 (${payload.name}): ${err.message}`);
      return;
    }
    stats.taskIds.push(task.id);
    let exec;
    try {
      exec = await client.triggerTask(task.id);
      stats.triggered += 1;
    } catch (err) {
      stats.triggerFailed += 1;
      logWarn(`任务触发失败 (${payload.name}): ${err.message}`);
      return;
    }
    const triggeredAt = Date.now();
    const result = await pollUntilTerminal(
      client,
      task.id,
      exec.id,
      opts,
      triggeredAt,
    );
    if (Number.isFinite(result.durationMs)) {
      stats.durationsMs.push(result.durationMs);
    }
    const verdict = classifyExecutions(result.executions);
    stats.retryDerivedRows += verdict.retryDerived;
    if (verdict.duplicateViolation) {
      stats.duplicateTasks.push(task.name);
      logWarn(
        `重复执行违规: ${payload.name} primary=${verdict.primaryTerminal}`,
      );
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
    }
  });

  const elapsedMs = Date.now() - startedAt;

  // 3) 清理（默认删除创建的任务；软删除，executions 留档可审计）
  if (!opts.keepTasks) {
    console.log(`\n清理 ${stats.taskIds.length} 个压测任务...`);
    for (const id of stats.taskIds) {
      try {
        await client.deleteTask(id);
      } catch (err) {
        logWarn(`清理任务失败 (${id}): ${err.message}`);
      }
    }
  } else {
    console.log(`\n--keep-tasks: 保留 ${stats.taskIds.length} 个任务不清理。`);
  }

  printReport(opts, stats, elapsedMs, client);

  const attempted = stats.jobs;
  const successRate = attempted > 0 ? stats.success / attempted : 0;
  const pass =
    attempted > 0 &&
    successRate === 1 &&
    stats.duplicateTasks.length === 0 &&
    stats.pollTimeout === 0;
  process.exit(pass ? 0 : 1);
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function printReport(opts, stats, elapsedMs, client) {
  const p50 = computePercentile(stats.durationsMs, 50);
  const p95 = computePercentile(stats.durationsMs, 95);
  const elapsedMin = elapsedMs / 60_000;
  const throughput = elapsedMin > 0 ? stats.jobs / elapsedMin : 0;
  const successRate =
    stats.jobs > 0 ? ((stats.success / stats.jobs) * 100).toFixed(1) : "0.0";

  console.log(`
==== 压测报告 ====
目标:                ${client.baseUrl}
规模:                ${opts.durationSec !== null ? `duration=${opts.durationSec}s` : `count=${opts.count}`} / 并发度=${opts.concurrency}
总耗时:              ${fmtMs(elapsedMs)}
任务尝试:            ${stats.jobs}
  创建成功/失败:     ${stats.created} / ${stats.createFailed}
  触发成功/失败:     ${stats.triggered} / ${stats.triggerFailed}
终态分布:
  success:           ${stats.success}
  failed/timeout:    ${stats.failed}
  killed:            ${stats.killed}
  cancelled:         ${stats.cancelled}
  轮询超时(未终态):  ${stats.pollTimeout}
成功率:              ${successRate}%
吞吐:                ${throughput.toFixed(1)} 任务/分钟
耗时 p50 / p95:      ${fmtMs(p50)} / ${fmtMs(p95)}
重复执行违规任务:    ${stats.duplicateTasks.length}${stats.duplicateTasks.length ? ` (${stats.duplicateTasks.join(", ")})` : ""}
重试派生行(不计违):  ${stats.retryDerivedRows}
HTTP 请求 / 429:     ${client.stats.requests} / ${client.stats.retries429}
结论:                ${stats.jobs === 0 ? "未完成任何任务" : successRate === "100.0" && stats.duplicateTasks.length === 0 && stats.pollTimeout === 0 ? "PASS" : "FAIL"}
`);
}

// 仅直接执行时运行 main（selftest 以模块方式 import 纯函数）
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[load-test] 运行错误: ${err?.stack || err}`);
    process.exit(2);
  });
}
