#!/usr/bin/env node
/**
 * R212：`degraded` / `workersKnown` 的**真机**触发探针 —— 补上「只由单测覆盖」的那条路径。
 *
 * ## 为什么需要它（R211 自己登记的缺口）
 *
 * R211 把「可能误报」与「可能漏报」拆成两个位、并用 `workersKnown` 把
 * 「`workers === 0`」与「`workers` 未知」分开。但**触发条件是「`getWorkersCount()` 抛错」**，
 * 而 R211 只在单测里 stub 过它 —— 真机上这条路径是否真的走到，**没人验证过**。
 *
 * ## 它怎么制造「真实读失败」（三条都试过，只有一条可行）
 *
 * | 手段 | 结果 | 结论 |
 * |---|---|---|
 * | `docker pause` 容器 | 请求**无限挂起**（TCP 连接不断、只是不应答） | ❌ 不产生异常，只产生 hang |
 * | `CLIENT KILL` 断开连接 | ioredis **自动重连**并成功 | ❌ 不产生异常 |
 * | **`ACL SETUSER default -client`** 禁用 `CLIENT` 命令 | `getWorkersCount()` 抛 `NOPERM` | ✅ **真实抛错** |
 *
 * ⚠️ 最后一条之所以能命中：`getWorkers()` 的实现是数 Redis **`CLIENT LIST`**（R210 真机坐实），
 * 所以禁用该命令 ⇒ 观测失败 ⇒ 正是我们想验证的路径。
 *
 * ## 断言（每条都只有真机才能证明）
 *
 *  ① 基线：Redis 正常 ⇒ `degraded:false` / `workersKnown:true` / `stalled:false`
 *  ② **禁用 `CLIENT` ⇒ `degraded:true` + `workersKnown:false`**（「不知道」被如实标出）
 *  ③ 同一次读失败下 `stalled:false` —— **不得**因为「读不到 workers」就报停摆（R210 的靶心）
 *  ④ **`paused` 是独立强证据**：队列真的 paused + 有活时，即使 `workers` 读失败，
 *     仍必须 `stalled:true` / `reason:"paused"`（**不能**因为降级把真停摆吞掉）
 *  ⑤ 恢复 `CLIENT` 后 ⇒ `degraded:false` / `workersKnown:true`，且结论与 ④ 一致
 *  ⑥ `queue-idle` 也把 `degraded` 如实标出（同一套读法，不能一个端点亮一个不亮）
 *
 * ## 安全边界（**本探针会改 Redis 的 ACL，所以纪律写死在这里**）
 *
 * · **只对隔离实例**运行：必须显式传 `R212_REDIS_PORT`（默认 16379，**不是** 6379），
 *   且脚本会先**断言它不是 6379**（拒绝在真实实例上跑）；
 * · `ACL` 的改动**在 `finally` 里无条件恢复**（`+client`），且恢复后**回读验证**；
 * · 结束时把 `bull:agent-jobs:*` 里本探针造的 job 删掉并回读确认。
 *
 * 用法：
 *   docker run -d --name acf-r212-redis -p 127.0.0.1:16379:6379 \
 *     redis:8.10.3 redis-server --requirepass r212pass
 *   NESTJS_BASE_URL=http://127.0.0.1:3106 R212_REDIS_PORT=16379 R212_REDIS_PASSWORD=r212pass \
 *     npm run test:r212-degraded-live
 */
import { execFileSync } from "node:child_process";

const BASE = process.env.NESTJS_BASE_URL || "http://127.0.0.1:3106";
const USER = process.env.R209_PROBE_USER || "r207-probe";
const PASS = process.env.R209_PROBE_PASS || "R207probe!temp";
const PORT = process.env.R212_REDIS_PORT || "16379";
const REDIS_PASSWORD = process.env.R212_REDIS_PASSWORD || "r212pass";
/** 容器名（**只**用于 `redis-cli` 的 ACL 操作；也可用 R212_REDIS_CONTAINER 覆盖）。 */
const CONTAINER = process.env.R212_REDIS_CONTAINER || "acf-r212-redis";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在**隔离实例**上执行 redis-cli（读/写 ACL）。 */
function redisCli(...args) {
  return execFileSync(
    "docker",
    ["exec", CONTAINER, "redis-cli", "-a", REDIS_PASSWORD, "--no-auth-warning", ...args],
    { encoding: "utf8" },
  ).trim();
}

async function http(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // 读失败时端点会走 Redis 超时 ⇒ 给足时间，但不要无限等（pause 那种 hang 就是教训）
    signal: AbortSignal.timeout(30_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json };
}

async function main() {
  // ── 0. 安全闸：绝不在真实实例上跑 ─────────────────────────────────────
  // 真实实例是 6379（compose / 1Panel 的默认端口）；本探针会改 ACL，误跑会把生产 Redis 打停。
  check(
    "①a 安全闸：目标 Redis 端口**不是** 6379（本探针会改 ACL，禁止打真实实例）",
    PORT !== "6379",
    `R212_REDIS_PORT=${PORT}`,
  );
  if (PORT === "6379") {
    console.error("拒绝在 6379 上运行 —— 请用隔离实例（默认 16379）。");
    process.exit(2);
  }

  let aclChanged = false;
  try {
    const health = await http("GET", "/api/health", null);
    check("①b 前置：admin-api 可达", health.status === 200, `status=${health.status}`);
    if (health.status !== 200) throw new Error(`admin-api 不可达（${BASE}）`);

    const login = await http("POST", "/api/auth/login", null, { username: USER, password: PASS });
    const token = login.json?.data?.accessToken ?? null;
    check("①c 探针账号登录成功", !!token, `status=${login.status}`);
    if (!token) throw new Error("登录失败 —— 检查 R209_PROBE_USER / R209_PROBE_PASS");

    // ── 1. 基线：一切正常 ────────────────────────────────────────────────
    const base = await http("GET", "/api/agent/sessions/queue-stall", token);
    const b = base.json?.data;
    check(
      "② 基线（Redis 正常）⇒ `degraded:false` / `workersKnown:true` / `stalled:false`",
      b?.degraded === false && b?.workersKnown === true && b?.stalled === false,
      `degraded=${b?.degraded} workersKnown=${b?.workersKnown} stalled=${b?.stalled}`,
    );

    // ── 2. ★ 制造真实读失败：禁用 CLIENT 命令 ────────────────────────────
    // 这是三条候选手段里**唯一**真正让 `getWorkersCount()` 抛错的那条（见文件头注）。
    redisCli("ACL", "SETUSER", "default", "-client");
    aclChanged = true;
    await sleep(800);

    const deg = await http("GET", "/api/agent/sessions/queue-stall", token);
    const d = deg.json?.data;
    check(
      "③ ★ 禁用 `CLIENT` ⇒ `degraded:true` + `workersKnown:false`（「不知道」被如实标出）",
      d?.degraded === true && d?.workersKnown === false,
      `degraded=${d?.degraded} workersKnown=${d?.workersKnown}`,
    );
    check(
      "④ ★ 同一次读失败下 `stalled:false` —— **不得**因「读不到 workers」就报停摆（R210 靶心）",
      d?.stalled === false,
      `stalled=${d?.stalled} reason=${d?.reason}`,
    );

    const idleDeg = await http("GET", "/api/agent/sessions/queue-idle", token);
    check(
      "⑤ `queue-idle` 也把 `degraded` 标出（同一套读法不能一个端点亮、一个不亮）",
      idleDeg.json?.data?.degraded === true,
      `degraded=${idleDeg.json?.data?.degraded}`,
    );

    // ── 3. ★ paused 是独立强证据：降级不得吞掉真停摆 ──────────────────────
    // 造「队列被暂停 + 有活排队」：paused 状态下新 job 进 `wait` 列表且不会被消费。
    execFileSync("node", ["--input-type=module", "-e", `
      import { createRequire } from "node:module";
      const req = createRequire("${process.cwd()}/apps/admin-api/package.json");
      const { Queue } = req("bullmq");
      const IORedis = req("ioredis");
      const cfg = { host: "127.0.0.1", port: ${Number(PORT)}, password: "${REDIS_PASSWORD}", maxRetriesPerRequest: null };
      const q = new Queue("agent-jobs", { connection: new IORedis(cfg), prefix: "bull" });
      await q.pause();
      await new Promise(r => setTimeout(r, 300));
      await q.add("run", { sessionId: "r212-paused" }, { jobId: "r212-paused-1" });
      await q.close();
      process.exit(0);
    `], { stdio: "pipe" });
    await sleep(800);

    // ⚠️ 反证实测到的一处**构造抖动**：`q.add` 之后 `wait` 列表偶发还没落库（第一次跑
    //    `pendingJobs=0`）⇒ 断言会红在「构造没到位」而不是「产品错了」（R407 的同款陷阱）。
    //    ⇒ 轮询等到 `pendingJobs>0` 再断言（上限 5s，超时就让断言自己红并打印实得值）。
    let p = null;
    const dl = Date.now() + 5_000;
    while (Date.now() < dl) {
      const probe = await http("GET", "/api/agent/sessions/queue-stall", token);
      p = probe.json?.data ?? null;
      if ((p?.pendingJobs ?? 0) > 0) break;
      await sleep(200);
    }
    const pausedDeg = { json: { data: p } };
    check(
      "⑥ ★ paused + 有活 + `workers` 读失败 ⇒ 仍 `stalled:true` / `reason:\"paused\"`（降级**不得**吞掉真停摆）",
      p?.stalled === true && p?.reason === "paused" && p?.workersKnown === false,
      `stalled=${p?.stalled} reason=${p?.reason} pendingJobs=${p?.pendingJobs} workersKnown=${p?.workersKnown}`,
    );

    // ── 4. 恢复 ACL ⇒ 位回落，结论不变 ───────────────────────────────────
    redisCli("ACL", "SETUSER", "default", "+client");
    aclChanged = false;
    await sleep(800);
    const restored = await http("GET", "/api/agent/sessions/queue-stall", token);
    const r = restored.json?.data;
    check(
      "⑦ 恢复 `CLIENT` ⇒ `degraded:false` / `workersKnown:true`，且停摆结论与 ⑥ 一致",
      r?.degraded === false && r?.workersKnown === true && r?.stalled === true && r?.reason === "paused",
      `degraded=${r?.degraded} workersKnown=${r?.workersKnown} stalled=${r?.stalled} reason=${r?.reason}`,
    );
  } finally {
    // ⚠️ **无条件恢复 ACL**（一个被禁掉 CLIENT 的实例会让所有队列观测永久降级）
    if (aclChanged) {
      try {
        redisCli("ACL", "SETUSER", "default", "+client");
      } catch (err) {
        console.error(`⚠️ ACL 恢复失败，请人工执行 ACL SETUSER default +client：${err?.message ?? err}`);
      }
    }
    // 清掉本探针造的 job + 恢复队列
    try {
      execFileSync("node", ["--input-type=module", "-e", `
        import { createRequire } from "node:module";
        const req = createRequire("${process.cwd()}/apps/admin-api/package.json");
        const { Queue } = req("bullmq");
        const IORedis = req("ioredis");
        const cfg = { host: "127.0.0.1", port: ${Number(PORT)}, password: "${REDIS_PASSWORD}", maxRetriesPerRequest: null };
        const q = new Queue("agent-jobs", { connection: new IORedis(cfg), prefix: "bull" });
        await q.resume().catch(() => {});
        for (const state of ["waiting","active","delayed","completed","failed","paused"]) {
          const jobs = await q.getJobs([state], 0, 200).catch(() => []);
          for (const j of jobs) if (j && String(j.id).startsWith("r212-")) { try { await j.remove(); } catch {} }
        }
        await q.close();
        process.exit(0);
      `], { stdio: "pipe" });
    } catch (err) {
      console.error(`⚠️ 清理 job 失败：${err?.message ?? err}`);
    }
    // 回读验证（不是「我恢复了」，是「读出来是恢复的」）
    let aclOk = null;
    let clientOk = null;
    try {
      // ⚠️ 判据是 `ACL LIST` 里 default 行**没有** `-client` —— 实测：
      //    禁用时该行末尾出现 `-client`，`ACL GETUSER` 的输出里**看不到**命令位
      //    （只有 flags/passwords），所以必须读 ACL LIST。
      const acl = redisCli("ACL", "LIST");
      aclOk = acl.length > 0;
      const defaultLine = acl.split("\n").find((l) => l.startsWith("user default")) ?? "";
      clientOk = defaultLine.includes("+client") && !defaultLine.includes("-client");
    } catch {
      /* 保留 null ⇒ 下面的断言会红 */
    }
    check("⑧ 恢复确认：`CLIENT` 命令可用（不是「我改了」，是**读出来**可用）", clientOk === true, `clientEnabled=${clientOk} aclReadable=${aclOk}`);
  }

  const failed = results.filter((x) => !x.ok);
  console.log(
    `\n${failed.length === 0 ? "✔" : "✘"} R212 degraded 真机探针：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join(" / ")}）` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("探针异常终止：", err?.message ?? err);
  process.exit(2);
});
