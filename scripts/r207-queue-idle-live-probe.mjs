#!/usr/bin/env node
/**
 * R207 真机探针：「队列空转」接线在**真 Redis + 真 BullMQ 队列**上的行为。
 *
 * 为什么要有它：R207 的接线证据全部来自单测（stub 出来的 queue 对象）。
 * 单测能证明「给定观测快照时的判定」，**不能**证明下面三件只在真 Redis 上才成立的事：
 *
 *  ① `queue.getWaiting(0, 1)` 的第一个**真的**是最老的那个 job
 *     （依赖 `asc=true` + 底层 ZSET 的 score = `job.timestamp`）；
 *  ② `job.attemptsStarted` / `job.timestamp` 从 Redis 反序列化后**仍然可读**
 *     （判据 `retried` 与「年龄」都靠它）；
 *  ③ 「停摆让位」与「空转」在**真队列状态**下的优先顺序正确
 *     （`workers=0` ⇒ 让位；worker 在册但不再消费 ⇒ 空转）。
 *
 * ⚠️ **不碰生产队列**：所有 key 都在 `acf-r207-probe-*` 前缀下，结束时删干净并**验证删除生效**
 *   （「清理了」是声明，「查计数=0」才是证据）。
 *
 * 用法（Redis 需可达；凭据从仓库 .env 读，不写死在脚本里）：
 *   node scripts/r207-queue-idle-live-probe.mjs
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

/** 从仓库 `.env` 读一个键（不引入 dotenv 依赖：本脚本要能在裸环境跑）。 */
function envFromRepo(key, fallback) {
  try {
    const raw = readFileSync(join(ROOT, ".env"), "utf8");
    const m = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m && m[1] !== "") return m[1].replace(/\r$/, "");
  } catch {
    /* .env 缺失 ⇒ 用环境变量/默认值 */
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

/** 探针队列名带唯一后缀：避免与任何真实队列撞名（也不污染 `agent-jobs`）。 */
const QUEUE_NAME = `acf-r207-probe-${process.pid}-${Date.now()}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup(queue, connection, prefix) {
  // ① 删队列自身的 key（obliterate 会清空本队列下所有 job 与状态）。
  try {
    await queue.obliterate({ force: true });
  } catch (err) {
    console.log(`  （obliterate 跳过：${err?.message ?? err}）`);
  }
  // ② 按前缀兜底扫一遍：本队列的 key 全在 `${prefix}:${name}:*` 下。
  const keys = await connection.keys(`${prefix}:${QUEUE_NAME}:*`);
  if (keys.length) await connection.del(...keys);
  // ③ **验证清理生效**（不是「我删了」，是「查出来是 0」）。
  const left = await connection.keys(`${prefix}:${QUEUE_NAME}:*`);
  return left.length;
}

async function main() {
  const connection = new IORedis(REDIS);
  const prefix = "bull";
  const queue = new Queue(QUEUE_NAME, { connection: new IORedis(REDIS), prefix });

  // 接线层的**真实实现**（不是 stub）：直接 import 编译产物不方便，
  // 故本探针复刻接线层读的三个观测量，并用**同一个**纯函数做判定。
  // ⚠️ 复刻的是「读法」（getWaiting(0,1) / job.timestamp / attemptsStarted），
  //   这正是只在真 Redis 上才能验证的那部分；判定逻辑仍走生产纯函数。
  const { deriveIdleThresholdMs, evaluateQueueIdle } = await import(
    "../apps/admin-api/dist/modules/agent/runtime/agent-queue-idle-check.js"
  );
  const { isQueueStalled } = await import(
    "../apps/admin-api/dist/modules/agent/runtime/agent-queue-stall-check.js"
  );

  const TICK = 30_000;
  const WALL = 1_800_000;
  const CONC = 2;
  const THRESHOLD = deriveIdleThresholdMs(WALL, CONC, TICK);
  check(
    "① 阈值推导：wallClockMs × concurrency + tick = 3,630,000（60.5min）",
    THRESHOLD === 3_630_000,
    `实得 ${THRESHOLD}`,
  );

  try {
    // ── 场景 A：三个 job，入队时间**故意乱序**（老的在先、新的在后）─────────
    // 用显式 `timestamp` 制造确定性的年龄。⚠️ 这些 job 都走同一条 add 路径 ⇒
    // 插入序与 timestamp 序一致（这正是生产路径的形态）。
    const now = Date.now();
    await queue.add("probe", { tag: "oldest" }, { jobId: "r207-a-oldest", timestamp: now - 4_000_000 });
    await queue.add("probe", { tag: "middle" }, { jobId: "r207-a-middle", timestamp: now - 1_000_000 });
    await queue.add("probe", { tag: "newest" }, { jobId: "r207-a-newest", timestamp: now - 10_000 });

    const waitingCount = await queue.getWaitingCount();
    check("② `getWaitingCount()` 读到 3 个 waiting job", waitingCount === 3, `实得 ${waitingCount}`);

    // ⚠️ 被验证的那一行：`getWaiting(0, 1)`（end 是闭区间 ⇒ 取到 2 个）。
    const probe = await queue.getWaiting(0, 1);
    const oldest = probe[0];
    check(
      "③ `getWaiting(0, 1)` 的第一个是**最早入队**的那个（wait 是 LIST，表头=最早入队）",
      oldest?.id === "r207-a-oldest",
      `实得 id=${oldest?.id}（共取回 ${probe.length} 个：${probe.map((j) => j.id).join(", ")}）`,
    );
    check(
      "④ `job.timestamp` 从 Redis 反序列化后 = 我们显式传入的入队时间",
      Number(oldest?.timestamp) === now - 4_000_000,
      `实得 ${oldest?.timestamp}，期望 ${now - 4_000_000}`,
    );
    check(
      "⑤ `job.attemptsStarted` 可读（首轮未开始时为 0）",
      Number(oldest?.attemptsStarted) === 0,
      `实得 ${oldest?.attemptsStarted}`,
    );

    // ── 场景 A 判定：worker 在册（本进程没起 worker，但注册表为空）─────────
    // 说明：此刻**没有** worker ⇒ 应当触发「停摆让位」，而不是「空转」。
    const workers0 = await queue.getWorkersCount();
    const active0 = await queue.getActiveCount();
    const paused0 = await queue.isPaused();
    const verdictA = evaluateQueueIdle({
      waitingCount,
      oldest: { id: oldest.id, timestamp: Number(oldest.timestamp), attemptsStarted: Number(oldest.attemptsStarted) },
      thresholdMs: THRESHOLD,
    });
    const stalledA = isQueueStalled(
      { waiting: waitingCount, delayed: 0, prioritized: 0, active: active0, workers: workers0, paused: paused0 },
      { requireIdleWorker: true },
    );
    check(
      "⑥ 真队列：无 worker ⇒ 停摆判据成立（本条应**让位**，不报空转）",
      stalledA === true && workers0 === 0,
      `stalled=${stalledA} workers=${workers0} active=${active0} paused=${paused0}`,
    );
    check(
      "⑦ 判据本体**确实**会判空转（年龄 4,000,000 > 阈值 3,630,000）⇒ 让位是必要的",
      verdictA.idleStuck === true && verdictA.oldestAgeMs > THRESHOLD,
      `idleStuck=${verdictA.idleStuck} age=${verdictA.oldestAgeMs}`,
    );

    // ── 场景 B：起一个**真 worker**，但它被慢 handler 占满槽 ⇒ 空转 ──────────
    // ⚠️ 用**独立队列**，且**顺序刻意设计**：`wait` 是 LIST（插入序），
    //    `getWaiting(0,1)[0]` = **最早入队**的那个。若在已有残留 job 的队列上
    //    追加一个「很老」的 job，它会排在表头（最新入队）⇒ 取到的仍是残留那个，
    //    断言就会测到别的东西（第一版就是这么错的，实得 age=10s）。
    //    ⇒ 先占满 2 个槽，再让「很老」的 job 成为 wait 里**唯一/最早**的项。
    const qBname = `${QUEUE_NAME}-b`;
    const qB = new Queue(qBname, { connection: new IORedis(REDIS), prefix });
    let releaseB;
    const holdB = new Promise((r) => {
      releaseB = r;
    });
    let startedB = 0;
    const workerB = new Worker(
      qBname,
      async () => {
        startedB += 1;
        await holdB;
      },
      { connection: new IORedis(REDIS), prefix, concurrency: CONC },
    );
    try {
      // ① 先用两个 job 占满两个并发槽（它们会被取走 ⇒ 不在 wait 里）。
      await qB.add("probe", { tag: "filler-1" }, { jobId: "b-fill-1" });
      await qB.add("probe", { tag: "filler-2" }, { jobId: "b-fill-2" });
      const dl = Date.now() + 20_000;
      while (startedB < 2 && Date.now() < dl) await sleep(100);
      check("⑧ 真 worker 占满 2 个并发槽（handler 卡住）", startedB >= 2, `started=${startedB}`);

      // ② 现在入队里**只剩一个** item：「很老」的那个 ⇒ 它一定是表头也是唯一项。
      //    （worker 已无空闲槽 ⇒ 它取不到，停在 waiting。）
      await qB.add("probe", { tag: "stuck" }, { jobId: "b-stuck", timestamp: Date.now() - 5_000_000 });
      await sleep(400);

      const workersB = await qB.getWorkersCount();
      const activeB = await qB.getActiveCount();
      const waitingB = await qB.getWaitingCount();
      const probeB = await qB.getWaiting(0, 1);
      const oldestB = probeB[0];
      const verdictB = evaluateQueueIdle({
        waitingCount: waitingB,
        oldest: oldestB
          ? {
              id: oldestB.id,
              timestamp: Number(oldestB.timestamp),
              attemptsStarted: Number(oldestB.attemptsStarted),
            }
          : null,
        thresholdMs: THRESHOLD,
      });
      const stalledB = isQueueStalled(
        { waiting: waitingB, delayed: 0, prioritized: 0, active: activeB, workers: workersB, paused: false },
        { requireIdleWorker: true },
      );

      check(
        "⑨ 真队列：worker 在册 + 有 job 在排（`workers>0`）⇒ 停摆判据**不**成立",
        stalledB === false && workersB > 0,
        `stalled=${stalledB} workers=${workersB} active=${activeB} waiting=${waitingB}`,
      );
      check(
        "⑩ 真队列：最老 waiting job 年龄超阈值 ⇒ **空转**成立（本条该报的那一格）",
        verdictB.idleStuck === true,
        `idleStuck=${verdictB.idleStuck} age=${verdictB.oldestAgeMs} threshold=${THRESHOLD} head=${oldestB?.id}`,
      );
      check(
        "⑪ 两个判据在真队列上**互斥**（不是「都红」也不是「都不报」）",
        stalledB === false && verdictB.idleStuck === true,
        `stalled=${stalledB} idleStuck=${verdictB.idleStuck}`,
      );

      // ── 场景 C：放行 handler ⇒ 队列恢复消费 ⇒ 空转消失 ──────────────────
      releaseB();
      await sleep(1500);
      const waitingC = await qB.getWaitingCount();
      const probeC = await qB.getWaiting(0, 1);
      const verdictC = evaluateQueueIdle({
        waitingCount: waitingC,
        oldest: probeC[0]
          ? {
              id: probeC[0].id,
              timestamp: Number(probeC[0].timestamp),
              attemptsStarted: Number(probeC[0].attemptsStarted),
            }
          : null,
        thresholdMs: THRESHOLD,
      });
      check(
        "⑫ 放行后队列恢复消费 ⇒ waiting 清空、**不再**判空转（正向控制组）",
        waitingC === 0 && verdictC.idleStuck === false,
        `waiting=${waitingC} idleStuck=${verdictC.idleStuck}`,
      );
    } finally {
      releaseB();
      await workerB.close().catch(() => {});
      await qB.obliterate({ force: true });
      const leftB0 = await connection.keys(`${prefix}:${qBname}:*`);
      if (leftB0.length) await connection.del(...leftB0);
      check("⑫b 场景 B 清理生效：残留 = 0", (await connection.keys(`${prefix}:${qBname}:*`)).length === 0);
      await qB.close();
    }


    // ── 场景 D：真实边界 —— delayed promote 会让「表头」与「timestamp 最小」错位 ──
    // 这是 R207 真机实测发现的**判据前提修正**：`wait` 是 LIST（插入序），
    // `timestamp` 不是排序键 ⇒ promote 后的 job 插在表头、但 timestamp 是「当初算 delay 的时刻」。
    // ⇒ 断言：错位确实存在，且**方向是年龄算小（只漏报、不误报）**。
    const q2name = `${QUEUE_NAME}-d`;
    const q2 = new Queue(q2name, { connection: new IORedis(REDIS), prefix });
    try {
      // ① 先把 5 个**普通** job 入队（它们按顺序占住表尾一侧）
      for (let i = 0; i < 5; i++) await q2.add("probe", { i }, { jobId: `d-n${i}` });
      await sleep(150);
      // ② 再入一个 delayed job，它的 `timestamp` **故意设成 2 小时前**（模拟「很早就排好、
      //    但被延迟投递」的真实形态）。promote 时它被 `LPUSH` 到**表头** ⇒ 顺序与 timestamp 错位。
      //    ⚠️ 必须让 promote 真的发生：用 `q2.promoteJobs()`（把到期的 delayed 搬到 wait）。
      await q2.add("probe", { tag: "delayed-old" }, { jobId: "d-old", timestamp: Date.now() - 7_200_000, delay: 100 });
      await sleep(400);
      await q2.promoteJobs().catch(() => {});
      await sleep(200);
      const allD = await q2.getWaiting(0, -1);
      const headD = (await q2.getWaiting(0, 1))[0];
      const trueOldest = allD.reduce((a, b) => (Number(a.timestamp) <= Number(b.timestamp) ? a : b));
      const ageHead = Date.now() - Number(headD?.timestamp);
      const ageTrue = Date.now() - Number(trueOldest?.timestamp);
      // ⚠️ 这条断言必须**能失败**：先要求错位**真实发生**（表头 ≠ timestamp 最小），
      //    否则「两者一致」时下面那条 ageHead <= ageTrue 会恒真 ⇒ 假绿。
      check(
        "⑭ 边界：`getWaiting(0,1)[0]` 与「timestamp 最小」**确实**不同（LIST 插入序 ≠ timestamp 序）",
        allD.length >= 2 && headD?.id !== trueOldest?.id,
        `表头=${headD?.id}(ts=${headD ? headD.timestamp - Date.now() : "?"}) 真·timestamp 最小=${trueOldest?.id}(ts=${trueOldest ? trueOldest.timestamp - Date.now() : "?"})`,
      );
      check(
        "⑮ 边界方向：错位只会把年龄**算小**（⇒ 漏报，不会误报）",
        ageHead <= ageTrue,
        `按表头 age=${ageHead}，按 timestamp 最小 age=${ageTrue}`,
      );
    } finally {
      await q2.obliterate({ force: true });
      const leftD0 = await connection.keys(`${prefix}:${q2name}:*`);
      if (leftD0.length) await connection.del(...leftD0);
      check("⑯ 场景 D 清理生效：残留 = 0", (await connection.keys(`${prefix}:${q2name}:*`)).length === 0);
      await q2.close();
    }
  } finally {
    // 清理并**验证**清理生效（不是「我删了」）。
    let left = await cleanup(queue, connection, prefix);
    // worker 的 key 也要清（它注册在 `<prefix>:<queue>:*` 下，obliterate 会带走大部分）。
    if (left) {
      const keys = await connection.keys(`${prefix}:${QUEUE_NAME}:*`);
      if (keys.length) await connection.del(...keys);
      left = (await connection.keys(`${prefix}:${QUEUE_NAME}:*`)).length;
    }
    check("⑬ 清理生效：本探针的 Redis key 残留 = 0", left === 0, `残留 ${left} 个`);
    await queue.close();
    await connection.quit();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "✔" : "✘"} R207 真机探针：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join(" / ")}）` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("探针异常终止：", err);
  process.exit(2);
});
