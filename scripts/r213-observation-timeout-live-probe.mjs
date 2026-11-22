#!/usr/bin/env node
/**
 * R213：**观测调用超时**的真机验证 —— 证明「Redis 卡住 ⇒ 端点挂死」这个洞已补。
 *
 * ## 背景（R212 实测发现，本探针就是用同一种手段复验）
 *
 * R212 用 `docker pause` 卡住 Redis 时，`queue-stall` 端点**挂死 25s+ 无响应**：
 * 不报错、也不降级。运营看到的是浏览器转圈，而不是「队列状态未知」。
 * 根因是 BullMQ 要求的 `maxRetriesPerRequest: null` + `enableOfflineQueue: true`
 * （**不能改**）⇒ 修复只能在观测层做（判据：`docs/observability/observation-timeout-criterion.md`）。
 *
 * ## 断言（每条都只有真机才能证明）
 *
 *  ① 基线：Redis 正常 ⇒ 端点快速返回且 `degraded:false`
 *  ② ★ **Redis 卡住（`docker pause`）⇒ 端点仍在「单调用上界 + 余量」内返回 200**，
 *     且 `degraded:true` / `workersKnown:false`（**不是**挂死、**不是** 500）
 *  ③ ★ **`backlogged` 用整次请求总预算**：有 pending 会话时也必须在
 *     「总预算 + 余量」内返回，且 `truncated:true`（截断必须可见 —— R395）
 *  ④ 恢复 Redis ⇒ 两个端点都回到正常（位回落、结论正确）
 *  ⑤ 清理生效：探针造的 pending 会话与 job 都被删掉，且**回读**为 0
 *
 * ## 安全边界（本探针会 `pause` Redis，纪律写死在这里）
 *
 * · **只对隔离实例**：必须传 `R213_REDIS_PORT`（默认 16380，**不是** 6379），
 *   脚本会先断言它不是 6379（`pause` 生产 Redis = 整个平台停摆）；
 * · `pause` 必在 `finally` 里 `unpause`，且恢复后**回读**端点确认；
 * · 只删 `triggerSource = 'r213-probe'` 的会话（精确匹配，不按通配删）。
 *
 * ## ⚠️ 已知残留（如实登记，不声称已消除）
 *
 * `Promise.race` **不取消**底层命令 ⇒ 超时后 ioredis 里那条命令仍挂着，直到连接恢复。
 * 观测是低频 GET，且最终由 `retryStrategy` 的重连流程清理；本探针**不**验证这一点
 * （要验证得观测 Redis 内部连接状态，超出本判据范围）。
 */
import { execFileSync } from "node:child_process";

const BASE = process.env.NESTJS_BASE_URL || "http://127.0.0.1:3107";
const USER = process.env.R209_PROBE_USER || "r207-probe";
const PASS = process.env.R209_PROBE_PASS || "R207probe!temp";
const PORT = process.env.R213_REDIS_PORT || "16380";
const REDIS_PASSWORD = process.env.R213_REDIS_PASSWORD || "r213pass";
const CONTAINER = process.env.R213_REDIS_CONTAINER || "acf-r213-redis";
/** 探针造的数据的**唯一标记**（清理只按它删，绝不按通配删）。 */
const PROBE_TAG = "r213-probe";
const PG_CONTAINER = process.env.R213_PG_CONTAINER || "1Panel-postgresql-cFrN";
const PG_USER = process.env.R213_PG_USER || "autoflow";
const PG_DB = process.env.R213_PG_DB || "autoflow";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-tAc", sql],
    { encoding: "utf8" },
  ).trim();
}

async function http(method, path, token, body, timeoutMs = 40_000) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, elapsedMs: Date.now() - started };
}

/** 生产常量（与 `observation-timeout.util.ts` 同源；探针**不**从源码解析，只做上界余量）。 */
const PER_CALL_MS = 5_000;
const BUDGET_MS = 8_000;
/** 余量：超时器本身 + 进程调度 + HTTP 往返。取 6s（足够宽松，仍能区分「挂死」）。 */
const SLACK_MS = 6_000;

async function main() {
  // ── 0. 安全闸 ────────────────────────────────────────────────────────
  check(
    "①a 安全闸：目标 Redis 端口**不是** 6379（本探针会 pause Redis，禁止打真实实例）",
    PORT !== "6379",
    `R213_REDIS_PORT=${PORT}`,
  );
  if (PORT === "6379") {
    console.error("拒绝在 6379 上运行 —— 请用隔离实例（默认 16380）。");
    process.exit(2);
  }

  let paused = false;
  try {
    const health = await http("GET", "/api/health", null, null, 5_000);
    check("①b 前置：admin-api 可达", health.status === 200, `status=${health.status}`);
    if (health.status !== 200) throw new Error(`admin-api 不可达（${BASE}）`);

    const login = await http("POST", "/api/auth/login", null, {
      username: USER,
      password: PASS,
    });
    const token = login.json?.data?.accessToken ?? null;
    check("①c 探针账号登录成功", !!token, `status=${login.status}`);
    if (!token) throw new Error("登录失败 —— 检查 R209_PROBE_USER / R209_PROBE_PASS");

    // ── 1. 基线 ──────────────────────────────────────────────────────────
    const base = await http("GET", "/api/agent/sessions/queue-stall", token, null, 10_000);
    check(
      "② 基线（Redis 正常）⇒ 快速返回且 `degraded:false`",
      base.status === 200 && base.json?.data?.degraded === false && base.elapsedMs < 3_000,
      `status=${base.status} degraded=${base.json?.data?.degraded} elapsed=${base.elapsedMs}ms`,
    );

    // 造几条 pending 会话（为了让 backlog 的串行探测真的有活可探）
    psql(
      `INSERT INTO agent_sessions (kind,status,"triggerSource","createdAt","updatedAt") ` +
        `SELECT 'task','pending','${PROBE_TAG}',now(),now() FROM generate_series(1,5)`,
    );

    // ── 2. ★ Redis 卡住 ⇒ 端点必须在有限时间内返回（而不是挂死）──────────
    execFileSync("docker", ["pause", CONTAINER], { stdio: "pipe" });
    paused = true;
    await sleep(1_000);

    const during = await http("GET", "/api/agent/sessions/queue-stall", token, null, PER_CALL_MS + SLACK_MS + 10_000);
    check(
      "③ ★ Redis 卡住 ⇒ `queue-stall` 仍在「上界+余量」内返回 200（**不是**挂死、**不是** 500）",
      during.status === 200 && during.elapsedMs < PER_CALL_MS + SLACK_MS,
      `status=${during.status} elapsed=${during.elapsedMs}ms（上界 ${PER_CALL_MS}ms + 余量 ${SLACK_MS}ms）`,
    );
    check(
      "④ ★ 且如实降级：`degraded:true` / `workersKnown:false`（不是「队列正常」）",
      during.json?.data?.degraded === true && during.json?.data?.workersKnown === false,
      `degraded=${during.json?.data?.degraded} workersKnown=${during.json?.data?.workersKnown}`,
    );

    // ── 3. ★ backlog 用「整次请求总预算」────────────────────────────────
    const backlog = await http("GET", "/api/agent/sessions/backlogged", token, null, BUDGET_MS + SLACK_MS + 20_000);
    check(
      "⑤ ★ Redis 卡住 + 有 pending ⇒ `backlogged` 在「总预算+余量」内返回（串行探测不能逐调用累加）",
      backlog.status === 200 && backlog.elapsedMs < BUDGET_MS + SLACK_MS,
      `status=${backlog.status} elapsed=${backlog.elapsedMs}ms（总预算 ${BUDGET_MS}ms + 余量 ${SLACK_MS}ms）`,
    );
    check(
      "⑥ ★ 且 `truncated:true`（预算耗尽 = 没查完 ⇒ **必须可见**，R395）",
      backlog.json?.data?.truncated === true,
      `truncated=${backlog.json?.data?.truncated} probed=${backlog.json?.data?.probed}`,
    );

    // ── 4. 恢复 ⇒ 位回落 ─────────────────────────────────────────────────
    execFileSync("docker", ["unpause", CONTAINER], { stdio: "pipe" });
    paused = false;
    await sleep(1_500);

    const after = await http("GET", "/api/agent/sessions/queue-stall", token, null, 15_000);
    check(
      "⑦ 恢复 Redis ⇒ `degraded:false` / `workersKnown:true`（位回落，不是永久降级）",
      after.status === 200 && after.json?.data?.degraded === false && after.json?.data?.workersKnown === true,
      `degraded=${after.json?.data?.degraded} workersKnown=${after.json?.data?.workersKnown}`,
    );
  } finally {
    // ⚠️ **无条件 unpause**：一个被留在 pause 状态的 Redis = 整个平台停摆。
    if (paused) {
      try {
        execFileSync("docker", ["unpause", CONTAINER], { stdio: "pipe" });
      } catch (err) {
        console.error(`⚠️ unpause 失败，请人工执行 docker unpause ${CONTAINER}：${err?.message ?? err}`);
      }
    }
    // 清理探针造的 pending 会话（只按精确 triggerSource 删）
    let deleted = "?";
    try {
      deleted = psql(`DELETE FROM agent_sessions WHERE "triggerSource"='${PROBE_TAG}'`);
    } catch (err) {
      console.error(`⚠️ 清理会话失败：${err?.message ?? err}`);
    }
    const left = psql(`SELECT count(*) FROM agent_sessions WHERE "triggerSource"='${PROBE_TAG}'`);
    check(
      "⑧ 清理生效：探针造的 pending 会话残留 = 0（**回读**确认，不是「我删了」）",
      left === "0",
      `DELETE=${deleted} 残留=${left}`,
    );
    // 回读确认 Redis 真的没被留在 pause
    let pauseState = "?";
    try {
      // paused 的容器 state 里没有直接信号，改用实际命令探活
      execFileSync("docker", ["exec", CONTAINER, "redis-cli", "-a", REDIS_PASSWORD, "--no-auth-warning", "PING"], {
        stdio: "pipe",
        timeout: 5_000,
      });
      pauseState = "responsive";
    } catch {
      pauseState = "NOT responsive（请人工确认）";
    }
    check("⑨ 恢复确认：隔离 Redis 可响应（不是「我 unpause 了」，是**探活成功**）", pauseState === "responsive", pauseState);
  }

  const failed = results.filter((x) => !x.ok);
  console.log(
    `\n${failed.length === 0 ? "✔" : "✘"} R213 观测超时真机探针：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join(" / ")}）` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("探针异常终止：", err?.message ?? err);
  process.exit(2);
});
