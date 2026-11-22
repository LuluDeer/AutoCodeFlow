#!/usr/bin/env node
/**
 * R217：**自动补入队的真机端到端** —— 真 chron + 真 Redis + 真 PG。
 *
 * ## 为什么还需要它（R216 已经做了真 PG 的 CAS 探针）
 *
 * R216 证明了「10 并发 CAS 只有 1 个赢家」（真 PG）和「入队逻辑正确」（单测），
 * 但**没有**跑过一整轮「积压 → 自动补 → 下轮不再判积压」：
 *
 * | 层 | R216 覆盖 | R217 补上 |
 * |---|---|---|
 * | CAS 单赢家（真并发） | ✅ 真 PG | — |
 * | `queue.add` 的形态与幂等 | ✅ 单测 | ✅ **真 Redis** |
 * | **cron 真的注册并触发** | ❌ | ✅ |
 * | **真积压 → 真补 → 端点回读为「不积压」的闭环** | ❌ | ✅ |
 * | **`count=1` 的会话不会被再补**（幂等保证） | ❌（单测 mock） | ✅ |
 *
 * ## 断言
 *
 *  ① 前置：admin-api 可达；
 *  ② 造一条真积压（`pending` + 队列无 job）⇒ `/backlogged` **能识别它**（判据前提）；
 *  ③ **等 cron 触发** ⇒ 日志出现 `candidates≥1 attempted=1 enqueued=1`；
 *  ④ **真 Redis 里出现 `jobId = session.id` 的 job**（形态正确 —— R215 的教训）；
 *  ⑤ 数据库 `backlogReenqueueCount` = **1**（CAS 生效）；
 *  ⑥ **闭环**：`/backlogged` 不再报它（job 被消费 ⇒ 会话离开 `pending`）；
 *  ⑦ ★ **幂等**：再造一条 `pending` 且 `count` **已是 1** 的会话 ⇒ 等下一轮 cron ⇒
 *     **不产生 job**、计数**仍为 1**（`attempted` 为 0 时服务**故意不打日志**，所以这里
 *     只能靠「Redis 无 job + 计数不变」来判，不能靠日志）。
 *
 * ## 安全边界
 *
 * · 只碰 `triggerSource = 'r217-probe'` 的会话（精确匹配）；
 * · 隔离 Redis（默认 16383，脚本断言不是 6379）；
 * · 结束时删净并**回读**。
 *
 * ## ⚠️ 运行时间
 *
 * cron 表达式是 `0 5,15,25,35,45,55 * * * *`（每 10 分钟）⇒ **本探针会真的等**，
 * 最坏 ~11 分钟。这是刻意的：**只有真 cron 才能证明 cron 没接错**（R416 的教训 ——
 * 用「手动调 runOnce()」代替 cron 会跳过「注册/触发」这一层）。
 *
 * 用法：`npm run test:r217-auto-requeue-e2e`
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.R217_BASE_URL || "http://127.0.0.1:3108";
const USER = process.env.R217_PROBE_USER || "r217-user";
const PASS = process.env.R217_PROBE_PASS || "R217probe!temp";
const REDIS_PORT = process.env.R217_REDIS_PORT || "16383";
const REDIS_PASSWORD = process.env.R217_REDIS_PASSWORD || "r217pass";
const REDIS_CONTAINER = process.env.R217_REDIS_CONTAINER || "acf-r217-redis";
const API_LOG = process.env.R217_API_LOG || "/tmp/api-r217.log";
const PG_CONTAINER = process.env.R217_PG_CONTAINER || "1Panel-postgresql-cFrN";
const PG_USER = process.env.R217_PG_USER || "autoflow";
const PG_DB = process.env.R217_PG_DB || "autoflow";
const PROBE_TAG = "r217-probe";
/** cron 每 10 分钟一轮 ⇒ 等一轮 + 余量（给登录/扫描留时间）。 */
/** 一轮 cron 的最长等待（10 分钟周期 + 1 分钟余量）。 */
const WAIT_ONE_CYCLE_MS = 11 * 60_000;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function psql(sql) {
  const raw = execFileSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-tAc", sql],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();
  // 过滤命令状态行（`INSERT 0 1` 等）—— R216 踩过：它会污染 `RETURNING` 的值。
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(INSERT|UPDATE|DELETE) \d+( \d+)?$/.test(l))
    .join("\n");
}

function redisKeys(pattern) {
  const raw = execFileSync(
    "docker",
    ["exec", REDIS_CONTAINER, "redis-cli", "-a", REDIS_PASSWORD, "--no-auth-warning", "KEYS", pattern],
    { encoding: "utf8", timeout: 15_000 },
  ).trim();
  return raw ? raw.split("\n").filter(Boolean) : [];
}

async function http(method, path, token, body, timeoutMs = 30_000) {
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
  return { status: res.status, json };
}

/** 读日志（不存在 ⇒ 空串）。 */
function readApiLog() {
  try {
    return readFileSync(API_LOG, "utf8");
  } catch {
    return "";
  }
}

/**
 * 等到日志里出现满足条件的行，或超时。
 *
 * ⚠️ **必须带 `sinceMs`**：本探针的 ③ 首次实现只匹配「含 attempted=1 的行」，
 * 而目标 Redis 复用时会命中**上一轮**留下的旧日志行 ⇒ 断言假绿、
 * 后续 ④⑤⑥ 全红（实测踩过，正是 R407「探针红了先问红的是产品还是探针」）。
 * ⇒ 只认 `sinceMs` **之后**写入的行。
 */
async function waitForLog(predicate, timeoutMs, sinceMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of readApiLog().split("\n")) {
      if (!line.includes("Backlog auto re-enqueue")) continue;
      // 结构化日志里的 `timestamp` 是毫秒；用它过滤掉本轮之前的历史行。
      const m = line.match(/"timestamp":(\d+)/);
      const ts = m ? Number(m[1]) : 0;
      if (ts < sinceMs) continue;
      if (predicate(line)) return line;
    }
    await sleep(5_000);
  }
  return null;
}

async function main() {
  check(
    "①a 安全闸：目标 Redis 端口**不是** 6379（本探针会造会话等真 cron，禁止打真实实例）",
    REDIS_PORT !== "6379",
    `R217_REDIS_PORT=${REDIS_PORT}`,
  );
  if (REDIS_PORT === "6379") {
    console.error("拒绝在 6379 上运行 —— 请用隔离实例（默认 16383）。");
    process.exit(2);
  }

  const sidA = `${Date.now()}`;
  writeFileSync("/tmp/r217-sid-marker.txt", sidA); // 便于中断后人工排查

  try {
    const health = await http("GET", "/api/health", null, null, 5_000);
    check("①b 前置：admin-api 可达", health.status === 200, `status=${health.status}`);
    if (health.status !== 200) throw new Error(`admin-api 不可达（${BASE}）`);

    const login = await http("POST", "/api/auth/login", null, { username: USER, password: PASS });
    const token = login.json?.data?.accessToken ?? null;
    check("①c 探针账号登录", !!token, `status=${login.status}`);
    if (!token) throw new Error("登录失败 —— 检查 R217_PROBE_USER / R217_PROBE_PASS");

    // ── ② 造真积压 + 判据能识别 ─────────────────────────────────────────
    const idA = psql(
      `INSERT INTO agent_sessions (kind,status,"triggerSource","createdAt","updatedAt","backlogReenqueueCount") ` +
        `VALUES ('task','pending','${PROBE_TAG}',now(),now(),0) RETURNING id`,
    );
    const before = await http("GET", "/api/agent/sessions/backlogged", token);
    check(
      "② 真积压（`pending` + 队列无 job）⇒ `/backlogged` **能识别它**",
      before.json?.data?.sessionIds?.includes(idA) === true,
      `count=${before.json?.data?.count} 含本会话=${before.json?.data?.sessionIds?.includes(idA)}`,
    );

    // ── ③ 等真 cron（不手动触发 —— 那会跳过「注册/触发」这一层）──────────
    console.log(`  … 等 cron（每 10 分钟一轮，最坏约 11 分钟）`);
    // ⚠️ `sinceMs` 取**本会话插入之后**（含 1s 余量）—— 只认本轮产生的日志。
    // ⚠️ 断言条件：`candidates>0` 的**本轮**自动补日志（逐会话行 / 汇总行任一）。
    //    首版写成 `attempted=1 && includes(idA)` —— 两条件分属**两行**日志
    //    （逐会话行只含 id、汇总行只含 attempted=1），永远不可能同时满足 ⇒ 实测踩过。
    const sinceMs = Date.now() - 1_000;
    const logLine = await waitForLog(
      (l) => /attempted=[1-9]/.test(l) || l.includes("首次自动补"),
      WAIT_ONE_CYCLE_MS,
      sinceMs,
    );
    check(
      "③ ★ 真 cron 触发并自动补（日志出现 `attempted=1` / `首次自动补`）",
      logLine !== null,
      logLine ? logLine.slice(0, 140) : `等待 ${WAIT_ONE_CYCLE_MS / 60_000} 分钟内未出现`,
    );

    // ── ④ 真 Redis 里出现 `jobId = session.id` 的 job ────────────────────
    // 注意：job 可能已被 worker 消费（那会离开 waiting）⇒ 用**作业哈希 key** 判存在性，
    // 它由 `jobId` 直接派生，与状态无关。
    const jobKeys = redisKeys(`bull:agent-jobs:${idA}`);
    check(
      "④ ★ 真 Redis 里存在 `jobId = session.id` 的 job（形态正确 —— R215 的教训）",
      jobKeys.length > 0,
      jobKeys.length ? jobKeys.join(",") : "未找到 job 哈希",
    );

    // ── ⑤ 计数 = 1 ───────────────────────────────────────────────────────
    const countA = psql(
      `SELECT "backlogReenqueueCount" FROM agent_sessions WHERE id='${idA}'`,
    );
    check("⑤ 数据库 `backlogReenqueueCount` = 1（CAS 生效）", countA === "1", `count=${countA}`);

    // ── ⑥ 闭环：不再被判积压 ─────────────────────────────────────────────
    const after = await http("GET", "/api/agent/sessions/backlogged", token);
    const stillListed = after.json?.data?.sessionIds?.includes(idA) === true;
    check(
      "⑥ ★ 闭环：`/backlogged` **不再报它**（job 已入队/被消费 ⇒ 会话离开 `pending`）",
      !stillListed,
      `仍被列为积压=${stillListed} status=${psql(`SELECT status FROM agent_sessions WHERE id='${idA}'`)}`,
    );

    // ── ⑦ ★ 幂等：count 已是 1 ⇒ 下一轮**不会**再补 ──────────────────────
    // 造一条 `pending` 且 `count=1` 的会话（模拟「补过但仍然积压」的形态）。
    const idB = psql(
      `INSERT INTO agent_sessions (kind,status,"triggerSource","createdAt","updatedAt","backlogReenqueueCount") ` +
        `VALUES ('task','pending','${PROBE_TAG}',now(),now(),1) RETURNING id`,
    );
    console.log(`  … 再等一轮 cron 验证幂等（最坏约 11 分钟）`);
    // ⚠️ `attempted=0` 时服务**故意不打日志** ⇒ 不能靠日志判，只能等一轮后查事实。
    await sleep(WAIT_ONE_CYCLE_MS);

    const jobKeysB = redisKeys(`bull:agent-jobs:${idB}`);
    const countB = psql(
      `SELECT "backlogReenqueueCount" FROM agent_sessions WHERE id='${idB}'`,
    );
    check(
      "⑦ ★ 幂等：`count` 已=1 的会话 ⇒ **不产生 job**（`attempted=0` 时服务故意不打日志，故查事实）",
      jobKeysB.length === 0,
      jobKeysB.length ? `意外出现 job：${jobKeysB.join(",")}` : "无 job（正确）",
    );
    check("⑧ 且其计数**仍为 1**（没有被再 +1）", countB === "1", `count=${countB}`);
  } finally {
    let deleted = "?";
    try {
      deleted = psql(`DELETE FROM agent_sessions WHERE "triggerSource"='${PROBE_TAG}'`);
    } catch (err) {
      console.error(`⚠️ 清理失败：${err?.message ?? err}`);
    }
    const left = psql(
      `SELECT count(*) FROM agent_sessions WHERE "triggerSource"='${PROBE_TAG}'`,
    );
    check(
      "⑨ 清理生效：探针会话残留 = 0（**回读**确认）",
      left === "0",
      `DELETE=${deleted} 残留=${left}`,
    );
  }

  const failed = results.filter((x) => !x.ok);
  console.log(
    `\n${failed.length === 0 ? "✔" : "✘"} R217 自动补端到端探针：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join(" / ")}）` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("探针异常终止：", err?.message ?? err);
  process.exit(2);
});
