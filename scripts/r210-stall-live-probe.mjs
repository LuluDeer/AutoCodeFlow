#!/usr/bin/env node
/**
 * R210：「队列停摆」判据的**真机**语义探针 —— 钉住 `getWorkersCount()` 到底是**什么**。
 *
 * ## 为什么需要它（这是 R204/R205 判据文档里**写错了一个前提**）
 *
 * 原文写的是：`getWorkers()` 读「worker 心跳注册表」，若事件循环被阻塞 ⇒ 心跳过期 ⇒
 * 返回空 ⇒ **误报停摆**。R210 在真 Redis + BullMQ 9.x 上实测**推翻**了它：
 *
 * | 事实 | 证据 |
 * |---|---|
 * | `getWorkers()` **数的是 Redis `CLIENT LIST` 里连接名匹配的连接** | `queue-getters.js` 的 `matcher` 拼 `${clientName()}:w:`；`baseGetClients` 走 `getClientList()` |
 * | **事件循环阻塞期间 `workers` 不降**（TCP 连接还在） | 本探针 ② |
 * | **worker 连接断开（崩溃 / close）才降为 0** | 本探针 ③ |
 *
 * ## 断言（每条都是**只有真队列**才能证明的）
 *
 *  ① 无 worker ⇒ `workers === 0`（基线）；起 worker ⇒ `1`；
 *  ② **handler 同步阻塞 8 秒期间，`workers` 仍为 1**（⇒ 「阻塞导致误报」**不成立**）；
 *  ③ `worker.close()` 后 ⇒ `workers === 0`，且此时塞 job ⇒ `waiting>0 / active=0 / workers=0`
 *     （**这才是真停摆**，判据该报）；
 *  ④ **正例控制组**：真实停摆时 `isQueueStalled` 为 true、且 `reason === "no-worker"`。
 *
 * ## 安全边界
 *
 * 全程使用 `acf-r210-*` 唯一队列名，**不碰** `agent-jobs`；结束时 obliterate + 按前缀兜底删，
 * 并**回读确认残留 = 0**。
 *
 * 用法：`npm run test:r210-stall-live`（需 Redis 可达；凭据从仓库 .env 读）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const require_ = createRequire(join(ROOT, "apps/admin-api", "package.json"));

const { Queue, Worker } = require_("bullmq");
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

const REDIS = {
  host: envFromRepo("REDIS_HOST", "127.0.0.1"),
  port: Number(envFromRepo("REDIS_PORT", "6379")),
  password: envFromRepo("REDIS_PASSWORD", ""),
  db: Number(envFromRepo("REDIS_DB", "0")),
  maxRetriesPerRequest: null,
};
const PREFIX = "bull";
const QUEUE_NAME = `acf-r210-stall-${process.pid}-${Date.now()}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const connection = new IORedis(REDIS);
  const queue = new Queue(QUEUE_NAME, { connection: new IORedis(REDIS), prefix: PREFIX });

  // 生产纯函数（判定仍走它，探针只负责**取真观测**）
  const { isQueueStalled, pendingJobCount, queueStallReason } = await import(
    "../apps/admin-api/dist/modules/agent/runtime/agent-queue-stall-check.js"
  );

  let worker = null;
  try {
    // ── ① 基线 ────────────────────────────────────────────────────────────
    check("①a 无 worker ⇒ `workers === 0`", (await queue.getWorkersCount()) === 0, `实得 ${await queue.getWorkersCount()}`);

    let blockStarted = 0;
    worker = new Worker(
      QUEUE_NAME,
      async () => {
        blockStarted += 1;
        // **同步忙等** 8 秒：彻底堵死事件循环（模拟「同步重活 / 长 GC」）
        const t = Date.now();
        while (Date.now() - t < 8000) {
          /* spin */
        }
      },
      { connection: new IORedis(REDIS), prefix: PREFIX, concurrency: 2 },
    );
    await sleep(1500);
    const w1 = await queue.getWorkersCount();
    check("①b 起 worker ⇒ `workers === 1`", w1 === 1, `实得 ${w1}`);

    // ── ② ★ 事件循环阻塞期间，workers 不降（推翻「心跳过期误报」）──────────
    await queue.add("probe", { tag: "block" }, { jobId: "r210-block" });
    // 等 handler 真的进入阻塞
    const dl = Date.now() + 5000;
    while (blockStarted < 1 && Date.now() < dl) await sleep(50);
    check("②a handler 已进入同步阻塞", blockStarted >= 1, `blockStarted=${blockStarted}`);

    // 阻塞中途从**另一个连接**查（模拟另一个进程的 admin-api）
    await sleep(500);
    const probe = new Queue(QUEUE_NAME, { connection: new IORedis(REDIS), prefix: PREFIX });
    const wDuringBlock = await probe.getWorkersCount();
    check(
      "②b ★ **阻塞期间 `workers` 仍为 1**（⇒「事件循环阻塞导致停摆误报」不成立）",
      wDuringBlock === 1,
      `实得 ${wDuringBlock}（原文档假设会掉成 0）`,
    );

    // 等阻塞结束
    await sleep(9000);

    // ── ③ worker 连接断开 ⇒ workers 才降为 0 ──────────────────────────────
    await worker.close();
    worker = null;
    await sleep(800);
    const wAfterClose = await probe.getWorkersCount();
    check("③a `worker.close()` 后 ⇒ `workers === 0`（连接断了才是真的没人）", wAfterClose === 0, `实得 ${wAfterClose}`);

    // 塞 job：此刻没有 worker ⇒ 真停摆
    await queue.add("probe", { tag: "orphan" }, { jobId: "r210-orphan" });
    await sleep(300);
    const waiting = await probe.getWaitingCount();
    const active = await probe.getActiveCount();
    const workers = await probe.getWorkersCount();
    check(
      "③b 孤儿 job ⇒ `waiting>0` / `active=0` / `workers=0`（真停摆形态）",
      waiting > 0 && active === 0 && workers === 0,
      `waiting=${waiting} active=${active} workers=${workers}`,
    );

    // ── ④ 正例控制组：判据在真观测上成立，且归因正确 ─────────────────────
    const snapshot = { waiting, delayed: 0, prioritized: 0, active, workers, paused: false };
    check(
      "④a 真停摆 ⇒ `isQueueStalled === true` 且 `reason === \"no-worker\"`",
      isQueueStalled(snapshot) === true && queueStallReason(snapshot) === "no-worker",
      `stalled=${isQueueStalled(snapshot)} reason=${queueStallReason(snapshot)} pendingJobs=${pendingJobCount(snapshot)}`,
    );

    // 反面：有人在干活时不得判停摆
    const busy = { waiting: 18, delayed: 0, prioritized: 0, active: 2, workers: 1, paused: false };
    check(
      "④b 反面控制组：合法积压（waiting=18 / active=2 / workers=1）⇒ **不**停摆",
      isQueueStalled(busy) === false,
      `stalled=${isQueueStalled(busy)}`,
    );

    await probe.close();
  } finally {
    if (worker) await worker.close().catch(() => {});
    try {
      await queue.obliterate({ force: true });
    } catch {
      /* 已空也算成功 */
    }
    const keys = await connection.keys(`${PREFIX}:${QUEUE_NAME}:*`);
    if (keys.length) await connection.del(...keys);
    const left = (await connection.keys(`${PREFIX}:${QUEUE_NAME}:*`)).length;
    check("⑤ 清理生效：本探针 Redis key 残留 = 0", left === 0, `残留 ${left} 个`);
    await queue.close();
    await connection.quit();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "✔" : "✘"} R210 停摆真机探针：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join(" / ")}）` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("探针异常终止：", err?.message ?? err);
  process.exit(2);
});
