#!/usr/bin/env node
/**
 * R18-B（2026-11-05）：**协议层**全栈并发 —— 真 HTTP 心跳 × 真调度占坑。
 *
 * ## 与 R16 的区别（这是本轮立项的原因）
 *
 * R16 压的是 **SQL 层**写冲突（两条 psql 连接跑生产语句）；R17 是静态守卫。
 * **协议层（鉴权 / DTO 校验 / 心跳服务链路）从未被并发压过** —— 本脚本补这一层：
 * 心跳走**真 HTTP**（共享令牌鉴权 → DTO 校验 → service → R16 的在途下限 → 落库），
 * 占坑走**调度器自己的原子 SQL**（`executor-dispatch-slot.collaborator.ts:105-118` 的形状），
 * 两者在同一轮里并发。
 *
 * ## 三条不变量（复用 R16 口径）
 *
 *   I1 心跳不得把**已占坑**数改小（最终计数 >= 在途占坑）——违反 ⇒ 超卖。
 *   I2 心跳不得把**已释放**的坑永久占住（终态化后计数必须能回落 0）。
 *   I3 容量判断不得因覆盖而放行超过 `maxConcurrentTasks`（本轮成功占坑数 <= max）。
 *
 * ## 必须证明"交错真的发生"（R16 教训㊴：不许假绿）
 *
 * 每轮记录 `hb_ms`（心跳 HTTP 往返）与 `claim_at_ms`（占坑发生在心跳发出后的第几毫秒），
 * 只有 `claim_at_ms < hb_ms` 才算**交错**。轮末汇总"交错轮次 / 总轮次"，
 * 若为 0 ⇒ 直接判红（说明并发没压上，结论无效）。
 *
 * ## 用法 / 退出码
 *
 *   node scripts/executor-protocol-layer-race-selftest.mjs [--rounds=10] [--max=2]
 *   退出码：0 = 全部不变量成立且交错被证明发生；1 = 违反或未证明交错。
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import { hermeticEnv } from "./lib/selftest-hermetic.mjs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const API_DIR = path.join(REPO_ROOT, "apps", "admin-api");
const ROUNDS = Number((process.argv.find((a) => a.startsWith("--rounds=")) ?? "--rounds=10").slice(9));
const MAX = Number((process.argv.find((a) => a.startsWith("--max=")) ?? "--max=2").slice(6));
const STAMP = Date.now();
const PG = `acf-r18-pg-${STAMP}`;
const REDIS = `acf-r18-redis-${STAMP}`;
const used = new Set();
const randPort = () => {
  for (;;) {
    const p = 15600 + Math.floor(Math.random() * 8000);
    if (!used.has(p)) { used.add(p); return p; }
  }
};
const PG_PORT = randPort();
const REDIS_PORT = randPort();
const PORT = randPort();
const EXECUTOR_SECRET = "r18-executor-secret";
const STUB_PORT = randPort();
const ADDRESS = `127.0.0.1:${STUB_PORT}`;
const children = [];
const violations = [];

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 300_000, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) =>
  run("docker", ["exec", "-i", PG, "psql", "-U", "autoflow", "-d", "autoflow_test", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-c", q]);

function env() {
  // 自检 hermeticity（R04）：起 admin-api 必须经 hermeticEnv，否则仓库根 .env 会注入夹具未显式
  // 给出的键（实测 133 个），把判据绑到开发机的环境上。
  return hermeticEnv({
    ...process.env,
    NODE_ENV: "development",
    PORT: String(PORT),
    DB_HOST: "127.0.0.1", DB_PORT: String(PG_PORT), DB_USERNAME: "autoflow", DB_PASSWORD: "test", DB_DATABASE: "autoflow_test",
    REDIS_HOST: "127.0.0.1", REDIS_PORT: String(REDIS_PORT),
    JWT_SECRET: "r18-jwt-secret-long-enough-0123456789abcdef", JWT_REFRESH_SECRET: "r18-refresh-secret-long-enough-0123456789",
    EXECUTOR_SECRET, EXECUTION_CALLBACK_SECRET: EXECUTOR_SECRET,
    INITIAL_ADMIN_USERNAME: "admin", INITIAL_ADMIN_PASSWORD: "admin123",
    AI_PROVIDER: "disabled", LOGIN_THROTTLE_LIMIT: "100000", THROTTLE_LIMIT: "100000",
  });
}

async function waitFor(url, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(1000);
  }
  throw new Error(`waitFor timeout: ${url}`);
}

async function http(pathname, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${EXECUTOR_SECRET}` },
    body: JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

const fingerprint = crypto.createHash("sha256").update("r18-stub").digest("hex");

async function main() {
  console.log(`=== R18-B 协议层并发：真 HTTP 心跳 × 真调度占坑（${ROUNDS} 轮 · max=${MAX}）===`);
  const stale = run("docker", ["ps", "-a", "--filter", "name=acf-r18-", "--format", "{{.Names}}"]);
  for (const n of (stale.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)) run("docker", ["rm", "-f", n]);
  const pg = run("docker", ["run", "-d", "--name", PG, "-e", "POSTGRES_USER=autoflow", "-e", "POSTGRES_PASSWORD=test",
    "-e", "POSTGRES_DB=autoflow_test", "-p", `${PG_PORT}:5432`, "postgres:16-alpine"]);
  if (pg.status !== 0) throw new Error(`PG 启动失败: ${pg.stderr}`);
  const rd = run("docker", ["run", "-d", "--name", REDIS, "-p", `${REDIS_PORT}:6379`, "redis:7-alpine"]);
  if (rd.status !== 0) throw new Error(`Redis 启动失败: ${rd.stderr}`);

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "acf-r19-"));
  let stubServerForCleanup = null;
  try {
    for (let i = 0; i < 60; i += 1) { if (sql("select 1").status === 0) break; await sleep(1000); }

    const build = run("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: API_DIR });
    if (build.status !== 0) throw new Error(`构建失败: ${(build.stderr || build.stdout).slice(0, 800)}`);
    const mig = run("npm", ["run", "migration:run"], { cwd: API_DIR, env: env() });
    if (mig.status !== 0) throw new Error(`迁移失败: ${(mig.stderr || mig.stdout).slice(0, 800)}`);
    console.log("✔ PG/Redis 就绪 + admin-api 构建 + 迁移链通过");

    const out = fs.openSync(path.join(logDir, "admin-api.log"), "a");
    const child = spawn("node", ["dist/main.js"], { cwd: API_DIR, env: env(), stdio: ["ignore", out, out], detached: true });
    child.unref();
    children.push(child);
    try {
      await waitFor(`http://127.0.0.1:${PORT}/api/health/live`, 120_000);
    } catch (e) {
      // 起不来时把实例日志打出来（否则只有 "timeout" 一句，无法定位）
      const logPath = path.join(logDir, "admin-api.log");
      const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-4000) : "(无日志)";
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- admin-api.log 末尾 ---\n${tail}`);
    }
    console.log("✔ admin-api 就绪（真实例，走完整鉴权 + DTO 校验）");

    /** admin 登录拿 JWT（任务/触发端点要管理员会话；执行器端点仍走共享令牌）。 */
  async function adminLogin() {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    const json = await res.json().catch(() => ({}));
    const data = json?.data ?? json;
    const token = data?.accessToken ?? data?.access_token ?? data?.token;
    if (res.status >= 300 || !token) {
      throw new Error(`admin 登录失败：${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    }
    return token;
  }

  /** admin 会话下的 JSON 请求。 */
  async function adminApi(pathname, body, method = "POST", token) {
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json?.data ?? json };
  }

  /** 起一个最小执行器 stub（push 模式：中台会真的 POST /execute 过来）。
   *  目的不是跑任务，而是让**真实派发链路**把执行行留在 RUNNING（不立刻终态），
   *  这样 R16 的在途下限才有事实源、I1/I2 才有意义。 */
  async function startExecutorStub() {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += String(c); });
      req.on("end", () => {
        // 只回 200 收下，不发回调 ⇒ 执行行停在 RUNNING（正是我们要的在途态）
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      });
    });
    await new Promise((r) => server.listen(STUB_PORT, "127.0.0.1", r));
    return server;
  }

// 协议层第一步：真注册（建行）
    const stubServer = await startExecutorStub();
    stubServerForCleanup = stubServer;
    const jwt = await adminLogin();
    console.log("✔ admin 登录成功（JWT）");

    const reg = await http("/api/executors/register", {
      appName: "r19-stub", address: ADDRESS, type: "node", version: "1.0.0",
      protocolVersion: 9, dispatchMode: "push", deviceFingerprint: fingerprint,
      startupId: "r19-life", maxConcurrentTasks: MAX,
    });
    if (reg.status >= 300) throw new Error(`注册失败: ${reg.status} ${JSON.stringify(reg.body).slice(0, 300)}`);
    console.log(`✔ 注册成功（${reg.status}）—— 建立执行器行（push 模式，地址指向本地 stub）`);

    // 协议层第二步：**真 API 建任务**（复用 scripts/demo-failure-seed.mjs 的同一套最小任务定义形状）
    const taskDef = {
      name: `r19-protocol-race-${STAMP}`,
      description: "[r19] 协议层并发压测用任务（由生产 API 创建）",
      runtime: "node",
      triggerType: "manual",
      timeout: 600,
      maxRetry: 0,
      glueSource: "console.log('r19 protocol race');\n",
      glueLanguage: "javascript",
    };
    const created = await adminApi("/api/tasks", taskDef, "POST", jwt);
    if (created.status >= 300 || !created.body?.id) {
      throw new Error(`建任务失败（${created.status}）：${JSON.stringify(created.body).slice(0, 400)}`);
    }
    const taskId = created.body.id;
    console.log(`✔ 任务已由生产 API 创建（${created.status}，taskId=${taskId}）`);

    let interleaved = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      // 每轮复位：计数归零、清掉上一轮执行行
      sql(`delete from task_executions where "executorId" in (select id from executors where address='${ADDRESS}');`);
      sql(`update executors set "runningTaskCount" = 0, "reservedSlots" = 0 where address='${ADDRESS}';`);
      const execId = sql(`select id from executors where address='${ADDRESS}';`).stdout.trim();

      // 心跳侧：**真 HTTP**，上报一个陈旧快照 runningTaskCount=0（执行器以为自己空闲）
      const t0 = Date.now();
      const hbProm = http("/api/executors/heartbeat", {
        address: ADDRESS, runningTaskCount: 0, reservedSlots: 0,
        runningExecutionIds: [], startupId: "r18-life", deviceFingerprint: fingerprint,
      });

      // 派发侧：**真触发**（生产 dispatch 链路自己跑 claimExecutorSlotForExecution + 插执行行）
      await sleep(5);
      let claimAtMs = Date.now() - t0;
      // 每轮一个新任务：触发门禁（`acquireTriggerGateLockOrThrow`）不允许同一任务反复并发触发
      const createdR = await adminApi("/api/tasks", { ...taskDef, name: `${taskDef.name}-r${round}` }, "POST", jwt);
      const roundTaskId = createdR.body?.id;
      if (!roundTaskId) throw new Error(`第 ${round} 轮建任务失败：${createdR.status}`);
      const trig = await adminApi(`/api/tasks/${roundTaskId}/trigger`, {}, "POST", jwt);
      // 等生产把执行行**指派到本执行器**（非终态 + executorId=本行）；最多 40s
      let inFlightRows = 0;
      let assigned = 0;
      for (let i = 0; i < 80; i += 1) {
        const row = sql(
          `select count(*) filter (where "executorId" is null), ` +
          `count(*) filter (where "executorId"='${execId}') ` +
          `from task_executions where "taskId"='${roundTaskId}' and status in ('pending','running','waiting');`,
        ).stdout.trim();
        const [unassigned, mine] = row.split("|").map((x) => Number(x || "0"));
        assigned = unassigned + mine;
        inFlightRows = mine;
        if (mine > 0) break;
        await sleep(500);
      }
      // 诊断（一次性）：生产触发后到底有没有插执行行？按 taskId 与全局各看一眼
      const byTask = sql(`select count(*) from task_executions where "taskId"='${roundTaskId}';`).stdout.trim();
      const anyRows = sql(`select count(*) from task_executions;`).stdout.trim();
      const taskRow = sql(`select status from tasks where id='${taskId}';`).stdout.trim();
      const execRow = sql(`select status, "maxConcurrentTasks" from executors where address='${ADDRESS}';`).stdout.trim().replace(/\n/g, "/");
      console.log(`    [诊断] 执行行(按task)=${byTask} 执行行(全表)=${anyRows} task.status=${taskRow} 已建行=${assigned} executor=${execRow} trigger.body=${JSON.stringify(trig.body).slice(0, 200)}`);
      const hb = await hbProm;
      const hbMs = Date.now() - t0;
      if (claimAtMs < hbMs) interleaved += 1;

      const finalCount = Number(sql(`select "runningTaskCount" from executors where address='${ADDRESS}';`).stdout.trim() || "0");
      const inFlight = inFlightRows;

      // I2 探针：终态化 + 释放后必须能回落 0
      sql(`update task_executions set status='success' where "executorId"='${execId}';`);
      for (let k = 0; k < finalCount; k += 1) {
        sql(`update task_executions set status='success' where "executorId"='${execId}';`);
        sql(`update executors set "runningTaskCount" = GREATEST("runningTaskCount" - 1, 0) where id='${execId}';`);
      }
      const afterRelease = Number(sql(`select "runningTaskCount" from executors where address='${ADDRESS}';`).stdout.trim() || "0");

      const v = [];
      // ⚠️ 不许假绿（R16 教训）：若占坑一条都没建成，说明**用例没建模生产**（生产的
      // `claimExecutorSlotForExecution(candidate, execution)` 要求执行行**已存在**），
      // 此时"最终计数=在途=0"是空断言 ⇒ 必须判红并报卡点，而不是记 ok。
      if (inFlight === 0) {
        v.push("用例未能建立任何占坑（生产未插执行行）⇒ 未建模生产，本轮结论无效（卡点见 receipt）");
      }
      if (hb.status >= 300) v.push(`心跳协议面拒绝：HTTP ${hb.status} ${JSON.stringify(hb.body).slice(0, 160)}`);
      if (finalCount < inFlight) v.push(`I1 违反：最终计数 ${finalCount} < 在途 ${inFlight}（超卖）`);
      if (finalCount > MAX) v.push(`I3 违反：占坑计数 ${finalCount} > max ${MAX}`);
      if (afterRelease !== 0) v.push(`I2 违反：释放后计数 ${afterRelease} != 0（饥饿）`);
      if (v.length) violations.push({ round, detail: v.join("；") });
      console.log(
        `  round ${String(round).padStart(2)}/${ROUNDS}: hb=${hb.status} hb_ms=${hbMs} claim_at_ms=${claimAtMs} 交错=${claimAtMs < hbMs ? "是" : "否"} ` +
        `在途=${inFlight} trigger=${trig.status} 最终=${finalCount} 释放后=${afterRelease} ${v.length ? "VIOLATION(" + v.join("；") + ")" : "ok"}`,
      );
    }

    const i1 = violations.filter((x) => x.detail.includes("I1"));
    const i2 = violations.filter((x) => x.detail.includes("I2"));
    const i3 = violations.filter((x) => x.detail.includes("I3"));
    const proto = violations.filter((x) => x.detail.includes("心跳协议面"));
    console.log("");
    console.log(`══ 汇总：${ROUNDS} 轮 · I1 ${i1.length} · I2 ${i2.length} · I3 ${i3.length} · 协议面 ${proto.length} · 交错 ${interleaved}/${ROUNDS} ══`);
    if (violations.length) console.log(`   样例：${violations[0].detail}`);
    // 硬要求：必须证明交错发生，否则"全绿"没有意义（R16 教训㊴）
    if (interleaved === 0) {
      console.log("✘ 未能证明并发交错（claim_at_ms 全部 >= hb_ms）⇒ 结论无效，判红");
      return 1;
    }
    return violations.length > 0 ? 1 : 0;
  } finally {
    try { stubServerForCleanup?.close(); } catch { /* ignore */ }
    for (const c of children) {
      try { process.kill(-c.pid, "SIGKILL"); } catch { try { c.kill("SIGKILL"); } catch { /* ignore */ } }
    }
    run("docker", ["rm", "-f", PG, REDIS]);
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`✘ 用例自身失败：${err instanceof Error ? err.message : String(err)}`);
  run("docker", ["rm", "-f", `acf-r18-pg-${STAMP}`, `acf-r18-redis-${STAMP}`]);
  process.exit(1);
}
