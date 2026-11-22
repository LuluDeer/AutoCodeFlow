#!/usr/bin/env node
/**
 * R215：**resume jobId 的 BullMQ 规则 + 幂等性 + 积压判据可查到它** —— 真机裁定。
 *
 * ## 要证明什么（三条都只在真队列上成立）
 *
 *  ① **BullMQ 拒绝 2 段冒号 id**：`<uuid>:resume` ⇒ `Custom Id cannot contain :`
 *     （所以 R215 改用的是**无冒号**的 `resume-<uuid>`）；
 *  ② **固定 id 的重复 add 是幂等 no-op**：这正是把 `${id}:resume:${Date.now()}` 改掉后
 *     想要的语义（第二次 resume 不该产生第二个 job）；
 *  ③ ★ **积压判据能查到 resume 入队的 job**：这是本轮修的那条**误报路径** ——
 *     改前 `getJob(session.id)` 返回 undefined ⇒ 一条「审批通过、正在正常等消费」的会话
 *     被判成积压 ⇒ 运营按提示「重新入队」⇒ 同一会话跑两遍（双份副作用）。
 *
 * ## 断言
 *
 *  ① `getJob(session.id)` 在**只**有 resume job 时**查不到**（复刻缺陷成立的前提）；
 *  ② 积压服务的三个候选 id（首跑 / `resume-<id>` / `auto-resume-<id>`）能查到它；
 *  ③ 三条路径各建一个 job ⇒ 三条都**不**被判成积压；
 *  ④ 建一条**真正**无 job 的 pending 会话 ⇒ **只有它**被判成积压；
 *  ⑤ `resume-<id>` 重复 add ⇒ 队列长度不变（幂等）；
 *  ⑥ `<id>:resume` 被 BullMQ 拒绝（规则仍成立，防有人改回去）。
 *
 * ## 安全边界
 *
 * 隔离实例（默认 16382，断言不是 6379）；只用 `r215:*` 前缀 key 与 `r215-sess-*` 会话 id；
 * 结束时删净并**回读**。
 *
 * 用法：`npm run test:r215-jobid-live`
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
    /* 缺 .env */
  }
  return process.env[key] ?? fallback;
}

const PORT = process.env.R215_REDIS_PORT || "16382";
const REDIS_PASSWORD = process.env.R215_REDIS_PASSWORD || "r215pass";
const HOST = process.env.R215_REDIS_HOST || "127.0.0.1";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

async function main() {
  check(
    "①a 安全闸：目标 Redis 端口**不是** 6379（禁止打真实实例）",
    PORT !== "6379",
    `R215_REDIS_PORT=${PORT}`,
  );
  if (PORT === "6379") {
    console.error("拒绝在 6379 上运行 —— 请用隔离实例（默认 16382）。");
    process.exit(2);
  }

  const conn = new IORedis({
    host: HOST,
    port: Number(PORT),
    password: REDIS_PASSWORD,
    maxRetriesPerRequest: null,
  });
  const queue = new Queue("agent-jobs", {
    connection: new IORedis({
      host: HOST,
      port: Number(PORT),
      password: REDIS_PASSWORD,
      maxRetriesPerRequest: null,
    }),
    prefix: "bull",
  });

  // 生产纯函数/类（判定仍走它们，探针只负责**取真观测**）
  const { manualResumeJobId, autoResumeJobId } = await import(
    "../apps/admin-api/dist/modules/agent/runtime/agent-job-options.js"
  );

  const SID_RESUME = "r215-sess-resume";
  const SID_AUTO = "r215-sess-auto";
  const SID_FIRST = "r215-sess-first";
  const SID_TRUE_BACKLOG = "r215-sess-real";
  const createdIds = [];

  try {
    await conn.ping();

    // ── ① BullMQ 的 jobId 规则（2 段冒号被拒）────────────────────────────
    let rejected = false;
    let rejMsg = "";
    try {
      await queue.add("run", { sessionId: SID_RESUME }, { jobId: `${SID_RESUME}:resume` });
    } catch (err) {
      rejected = true;
      rejMsg = err?.message ?? String(err);
    }
    check(
      "① ★ `<id>:resume`（2 段冒号）被 BullMQ **拒绝** —— 所以 R215 用无冒号的 `resume-<id>`",
      rejected && /cannot contain/i.test(rejMsg),
      `rejected=${rejected} msg=${rejMsg.slice(0, 60)}`,
    );

    // ── ② 三条入队路径各建一个 job ───────────────────────────────────────
    await queue.add("run", { sessionId: SID_FIRST }, { jobId: SID_FIRST });
    await queue.add("run", { sessionId: SID_RESUME }, { jobId: manualResumeJobId(SID_RESUME) });
    await queue.add("run", { sessionId: SID_AUTO }, { jobId: autoResumeJobId(SID_AUTO) });
    createdIds.push(SID_FIRST, manualResumeJobId(SID_RESUME), autoResumeJobId(SID_AUTO));

    // ── ③ ★ 复刻缺陷成立的前提：`getJob(session.id)` 对 resume 会话查不到 ──
    const bySessionId = await queue.getJob(SID_RESUME);
    check(
      "② ★ 缺陷前提成立：`getJob(session.id)` 对**只经 resume 入队**的会话返回 undefined",
      bySessionId === undefined,
      `getJob(${SID_RESUME}) = ${bySessionId === undefined ? "undefined" : bySessionId.id}`,
    );

    // ── ④ 积压服务用「三个候选」能查到（本轮修的正是这个）───────────────
    const found = [];
    for (const [label, sid, candidates] of [
      ["首跑", SID_FIRST, [SID_FIRST]],
      ["人工恢复", SID_RESUME, [SID_RESUME, manualResumeJobId(SID_RESUME)]],
      ["自动续跑", SID_AUTO, [SID_AUTO, autoResumeJobId(SID_AUTO)]],
    ]) {
      let hit = null;
      for (const cid of candidates) {
        const j = await queue.getJob(cid);
        if (j) {
          hit = cid;
          break;
        }
      }
      found.push({ label, sid, hit });
    }
    check(
      "③ ★ 三条入队路径都能被「有限枚举」查到（⇒ 它们**不会**被判成积压）",
      found.every((f) => f.hit !== null),
      found.map((f) => `${f.label}→${f.hit ?? "MISS"}`).join(" | "),
    );

    // ── ⑤ 真正无 job 的 pending 会话 ⇒ 才该判积压 ───────────────────────
    let realBacklogHit = null;
    for (const cid of [
      SID_TRUE_BACKLOG,
      manualResumeJobId(SID_TRUE_BACKLOG),
      autoResumeJobId(SID_TRUE_BACKLOG),
    ]) {
      const j = await queue.getJob(cid);
      if (j) {
        realBacklogHit = cid;
        break;
      }
    }
    check(
      "④ 真正无 job 的会话 ⇒ 三个候选全 miss（**只有它会**被判成积压）",
      realBacklogHit === null,
      `hit=${realBacklogHit ?? "none（正确）"}`,
    );

    // ── ⑥ 固定 id 重复 add ⇒ 幂等 no-op（去重语义已变，必须钉住）──────────
    const before = await queue.getWaitingCount();
    await queue.add("run", { sessionId: SID_RESUME }, { jobId: manualResumeJobId(SID_RESUME) });
    const after = await queue.getWaitingCount();
    check(
      "⑤ ★ `resume-<id>` 重复 add ⇒ **队列长度不变**（幂等 no-op —— 第二次 resume 不产生第二个 job）",
      before === after,
      `before=${before} after=${after}`,
    );
  } finally {
    // 清掉本探针造的 job（只删自己列的 id，不做全表 obliterate）
    for (const id of createdIds) {
      try {
        const j = await queue.getJob(id);
        if (j) await j.remove();
      } catch {
        /* 尽力而为 */
      }
    }
    let left = "?";
    try {
      const keys = await conn.keys("bull:agent-jobs:r215-sess-*");
      if (keys.length) await conn.del(...keys);
      left = String((await conn.keys("bull:agent-jobs:r215-*")).length);
    } catch {
      /* 保留 '?' ⇒ 断言会红 */
    }
    check("⑥ 清理生效：`r215-*` 残留 = 0（**回读**确认）", left === "0", `残留=${left}`);
    // ⚠️ ioredis 的 `disconnect()` 返回 undefined（R214 踩过）⇒ 用 try/catch 而不是 promise 链。
    try {
      await queue.close();
    } catch {
      /* 已关 */
    }
    try {
      conn.disconnect();
    } catch {
      /* 已断 */
    }
  }

  const failed = results.filter((x) => !x.ok);
  console.log(
    `\n${failed.length === 0 ? "✔" : "✘"} R215 jobId 真机探针：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join(" / ")}）` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("探针异常终止：", err?.message ?? err);
  process.exit(2);
});
