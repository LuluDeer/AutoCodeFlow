#!/usr/bin/env node
/**
 * R209：「队列空转」观测的**真 HTTP 端点**探针（真 NestJS 进程 + 真 PG + 真 Redis）。
 *
 * ## 为什么还需要它（R208 已经做了真 Redis 探针）
 *
 * R208 的 `r207-queue-idle-live-probe.mjs` 验证到的是**接线层的读法**
 * （`getWaiting(0,1)` + `job.timestamp` + `attemptsStarted`）并调用**生产纯函数**判定 ——
 * 但它**没有**经过 NestJS：controller 的响应整形、服务注入、错误码映射、
 * 全局响应信封、JWT/Roles 守卫，**一条都没被覆盖**。
 * 而这些恰恰是「接线」的另一半：纯函数对、端点错，运营看到的仍然是错的。
 *
 * ## 它断言什么（每条都对应一个**只有真 HTTP** 才能证明的事实）
 *
 *  ① 未认证 ⇒ **401**（不是 200 + 空数据）；
 *  ② ADMIN 登录后 ⇒ **200**，且响应体在 `data` 信封里（不是裸对象）；
 *  ③ 字段**齐全**：`idleStuck / oldestAgeMs / thresholdMs / waitingCount / retried /
 *     suppressedBy / degraded / basis`，且 `basis.formula` 带推导依据（R403）；
 *  ④ 空队列 ⇒ `idleStuck:false`、`oldestAgeMs:0`、`degraded:false`（**正例控制组**）；
 *  ⑤ **paused + 老 job** ⇒ `suppressedBy:"queue-stall"` 且 `idleStuck:false`
 *     —— 让位逻辑在**真端点**上成立；同一个快照下 `queue-stall` 报 `stalled:true`（两端口径一致）；
 *  ⑥ 恢复后 ⇒ 回到 `suppressedBy:null`（清理生效的**行为**证据，不只是 key 计数）。
 *
 * ## 安全边界（**这个脚本会碰真实队列**，所以纪律写死在这里）
 *
 * · 只增删 jobId 以 `r207-probe` 为前缀的 job；**不改**任何会话/执行行；
 * · 结束时 **`resume()` 队列**（即使中途抛错，`finally` 里也 resume）——
 *   一个被留在 paused 状态的队列会让真实调度全线停摆，这是本脚本**唯一**能造成
 *   生产影响的方式，故必须无条件复原；
 * · 清理后**回读**端点确认 `suppressedBy` 归零（不是「我 resume 了」，是「端点说正常了」）；
 * · 需要 `NESTJS_BASE_URL`（默认 `http://127.0.0.1:3105`）与探针账号
 *   `R209_PROBE_USER` / `R209_PROBE_PASS`（默认 `r207-probe` / `R207probe!temp`）。
 *
 * 前置：admin-api 已构建并**在跑**（`node dist/main.js`），PG/Redis 可达。
 * 用法：`npm run test:r209-queue-idle-http`
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const require_ = createRequire(join(ROOT, "apps/admin-api", "package.json"));

const { Queue } = require_("bullmq");
const IORedis = require_("ioredis");

function envFromRepo(key, fallback) {
  try {
    const raw = readFileSync(join(ROOT, ".env"), "utf8");
    const m = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m && m[1] !== "") return m[1].replace(/\r$/, "");
  } catch {
    /* 缺 .env ⇒ 用环境变量/默认值 */
  }
  return process.env[key] ?? fallback;
}

const BASE = process.env.NESTJS_BASE_URL || "http://127.0.0.1:3105";
const USER = process.env.R209_PROBE_USER || "r207-probe";
const PASS = process.env.R209_PROBE_PASS || "R207probe!temp";

const REDIS = {
  host: envFromRepo("REDIS_HOST", "127.0.0.1"),
  port: Number(envFromRepo("REDIS_PORT", "6379")),
  password: envFromRepo("REDIS_PASSWORD", ""),
  db: Number(envFromRepo("REDIS_DB", "0")),
  maxRetriesPerRequest: null,
};

/** 真实队列名（与 `agent.processor.ts` 的 `AGENT_QUEUE_NAME` 同字面）。 */
const QUEUE_NAME = "agent-jobs";
const PREFIX = "bull";
/** 探针 job 的 id 前缀：清理只按它删，**绝不**碰别人的 job。 */
const PROBE = "r207-probe";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应（如 401 也可能是空体） */
  }
  return { status: res.status, json };
}

async function login() {
  const r = await http("POST", "/api/auth/login", null, { username: USER, password: PASS });
  return { status: r.status, token: r.json?.data?.accessToken ?? null };
}

/** 清理：只删 `r207-probe*` 的 job，并**回读**确认。 */
async function cleanProbeJobs(queue) {
  let removed = 0;
  for (const state of ["waiting", "active", "delayed", "completed", "failed", "paused"]) {
    let jobs = [];
    try {
      jobs = await queue.getJobs([state], 0, 200);
    } catch {
      continue;
    }
    for (const j of jobs) {
      if (j && String(j.id).startsWith(PROBE)) {
        try {
          await j.remove();
          removed += 1;
        } catch {
          /* 已终结的 job 可能删不掉：不影响判定 */
        }
      }
    }
  }
  return removed;
}

async function main() {
  const connection = new IORedis(REDIS);
  const queue = new Queue(QUEUE_NAME, { connection: new IORedis(REDIS), prefix: PREFIX });
  let pausedByUs = false;

  try {
    // ── 0. 前置：端点可达 ────────────────────────────────────────────────
    const health = await http("GET", "/api/health", null);
    check("① 前置：admin-api 可达（/api/health 200）", health.status === 200, `status=${health.status}`);
    if (health.status !== 200) {
      throw new Error(`admin-api 不可达（${BASE}/api/health ⇒ ${health.status}）—— 先起服务再跑本探针`);
    }

    // ── 1. 未认证 ⇒ 401（不是 200 + 空数据）──────────────────────────────
    const anon = await http("GET", "/api/agent/sessions/queue-idle", null);
    check(
      "② 未认证 ⇒ **401**（「没权限」与「队列正常」必须可区分）",
      anon.status === 401,
      `status=${anon.status}`,
    );

    // ── 2. 登录（探针账号）──────────────────────────────────────────────
    const auth = await login();
    check("③ 探针账号登录成功（拿得到 accessToken）", auth.status < 300 && !!auth.token, `status=${auth.status}`);
    if (!auth.token) throw new Error("登录失败 —— 检查 R209_PROBE_USER / R209_PROBE_PASS 或账号是否存在");
    const token = auth.token;

    // ── 3. 空队列 ⇒ 正例控制组 ──────────────────────────────────────────
    await cleanProbeJobs(queue);
    if (await queue.isPaused()) {
      await queue.resume();
      await sleep(300);
    }
    const idle0 = await http("GET", "/api/agent/sessions/queue-idle", token);
    const d0 = idle0.json?.data;
    check(
      "④ 空队列 ⇒ `idleStuck:false` / `oldestAgeMs:0` / `degraded:false`（正例控制组）",
      idle0.status === 200 && d0?.idleStuck === false && d0?.oldestAgeMs === 0 && d0?.degraded === false,
      `status=${idle0.status} idleStuck=${d0?.idleStuck} age=${d0?.oldestAgeMs} degraded=${d0?.degraded}`,
    );
    check(
      "⑤ 响应在 `data` 信封里（不是裸对象）—— 全局响应拦截器没有被绕过",
      !!idle0.json && typeof idle0.json === "object" && "data" in idle0.json && "code" in idle0.json,
      `顶层键=${idle0.json ? Object.keys(idle0.json).join(",") : "?"}`,
    );

    // ── 4. 字段齐全 + basis.formula 带推导依据（R403）────────────────────
    const required = [
      "idleStuck",
      "oldestAgeMs",
      "thresholdMs",
      "waitingCount",
      "retried",
      "suppressedBy",
      "degraded",
      "basis",
    ];
    const missing = required.filter((k) => !(k in (d0 ?? {})));
    check("⑥ 契约字段齐全（缺一个就说明响应整形丢字段）", missing.length === 0, missing.length ? `缺 ${missing.join(",")}` : "8/8");
    check(
      "⑦ `basis.formula` 带推导依据（只给阈值不给依据 ⇒ 下次调参就变魔法数）",
      typeof d0?.basis?.formula === "string" && d0.basis.formula.includes("wallClockMs"),
      `formula=${d0?.basis?.formula}`,
    );
    check(
      "⑧ 线上阈值 = 3,630,000（wallClockMs × concurrency + tick）",
      d0?.thresholdMs === 3_630_000 && d0?.basis?.thresholdMs === 3_630_000,
      `thresholdMs=${d0?.thresholdMs}`,
    );

    // ── 5. ★ paused + 老 job ⇒ 让位（真端点上的 R399 语义）───────────────
    await queue.pause();
    pausedByUs = true;
    await queue.add(
      "run",
      { sessionId: `${PROBE}-old`, reason: PROBE },
      { jobId: `${PROBE}-old`, timestamp: Date.now() - 7_200_000 },
    );
    await sleep(500);

    const idle1 = await http("GET", "/api/agent/sessions/queue-idle", token);
    const d1 = idle1.json?.data;
    const stall1 = await http("GET", "/api/agent/sessions/queue-stall", token);
    const s1 = stall1.json?.data;

    check(
      "⑨ paused + 老 job ⇒ `suppressedBy:\"queue-stall\"` 且**不**报空转（让位在真端点上成立）",
      d1?.suppressedBy === "queue-stall" && d1?.idleStuck === false,
      `suppressedBy=${d1?.suppressedBy} idleStuck=${d1?.idleStuck} age=${d1?.oldestAgeMs}`,
    );
    check(
      "⑩ 同一快照下 `queue-stall` 报 `stalled:true` / `reason:paused`（两端口径一致）",
      s1?.stalled === true && s1?.reason === "paused",
      `stalled=${s1?.stalled} reason=${s1?.reason} pendingJobs=${s1?.pendingJobs}`,
    );
    check(
      "⑪ 让位**不是**「读不到」：`degraded:false`（两者都会让徽标不显示，但语义相反）",
      d1?.degraded === false,
      `degraded=${d1?.degraded}`,
    );

    // ── 6. 复原 ⇒ 端点回到正常（清理的**行为**证据）───────────────────────
    await cleanProbeJobs(queue);
    await queue.resume();
    pausedByUs = false;
    await sleep(600);
    const idle2 = await http("GET", "/api/agent/sessions/queue-idle", token);
    const d2 = idle2.json?.data;
    check(
      "⑫ 复原后 ⇒ `suppressedBy:null` / `degraded:false`（不是「我 resume 了」，是**端点说**正常了）",
      d2?.suppressedBy === null && d2?.degraded === false,
      `suppressedBy=${d2?.suppressedBy} degraded=${d2?.degraded} paused=${await queue.isPaused()}`,
    );
  } finally {
    // ⚠️ **无条件复原**：paused 队列会让真实调度全线停摆 —— 这是本脚本唯一能造成
    //    生产影响的方式，所以即使中途抛错也必须 resume。
    try {
      await cleanProbeJobs(queue);
      if (pausedByUs || (await queue.isPaused())) await queue.resume();
    } catch (err) {
      console.error(`⚠️ 复原失败，请人工确认队列未被暂停：${err?.message ?? err}`);
    }
    const paused = await queue.isPaused().catch(() => null);
    const waiting = await queue.getWaitingCount().catch(() => null);
    check(
      "⑬ 复原确认：队列**未**处于 paused 且探针 job 已清空",
      paused === false && waiting === 0,
      `paused=${paused} waiting=${waiting}`,
    );
    await queue.close();
    await connection.quit();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "✔" : "✘"} R209 真 HTTP 探针：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join(" / ")}）` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("探针异常终止：", err?.message ?? err);
  process.exit(2);
});
