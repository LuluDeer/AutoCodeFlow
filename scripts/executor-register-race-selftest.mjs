#!/usr/bin/env node
/**
 * 执行器注册**接管 CAS 并发**真机回归（R11，2026-11-05）。
 *
 * ## 这条用例要证明什么
 *
 * `register` 的「身份解析 → 接管裁决 → 写库」是**跨 await** 的读-判-写（
 * `apps/admin-api/src/modules/executor/executor.service.ts:2443` 起，E-1/E-2 的落点）。
 * 两个进程在同一地址上并发注册时，若裁决与写库不原子，后果是：
 *   · **两行同身份都 active**（行数增长 / 派发到两处）；
 *   · **跨行覆盖**（赢家的 `deviceFingerprint`/`executorStartupId` 被输家改写 ⇒
 *     赢家手里的 per-executor 令牌对不上行 ⇒ 401 死循环）；
 *   · 输家拿到**永久 409**（后续重注册也一直被拒，运维只能删行）。
 *
 * 本脚本在**真 PG + 真 admin-api 进程**上重复 N 轮，每轮并发打两发注册，
 * 逐轮断言「恰好一个赢家 / 行数与行身份与赢家一致 / 赢家可继续重注册」。
 *
 * ## 三条不变量（每轮都查）
 *
 *   I1 **恰好一行**：该地址的 push 行数恒为 1（不许两行同身份都 active）。
 *   I2 **恰好一个赢家**：两发里恰有 1 个 2xx、1 个 409（两发都 201 = 双赢，是覆盖前兆）。
 *   I3 **行身份 = 赢家**：行上的 `deviceFingerprint` / `executorStartupId` /
 *      `status` / `runningTaskCount` 与**赢家**那次上报一致（= 没被输家覆盖）。
 *   I4 **赢家可恢复**：赢家用同一身份**再注册一次必须 2xx**（证明没被自己的
 *      CAS 卡成永久 409）。
 *
 * ## 三个场景（每轮各跑一遍）
 *
 *   A. **接管竞态**：先落一行 OFFLINE 且静默 > 接管窗（默认 5min）的死行，
 *      两个**不同指纹**的进程并发注册同一地址 ⇒ 恰一个接管成功。
 *   B. **首注册竞态**：该地址**无任何行**，两个不同指纹并发注册 ⇒ 唯一索引裁决。
 *   C. **同指纹重注册**：同一指纹并发两发（同机重复注册的幂等面）⇒ 两发都应成功，
 *      行数仍为 1（这条**刻意允许双 2xx**，与 I2 的区别写在这里，避免误读）。
 *
 * ## 用法
 *
 *   node scripts/executor-register-race-selftest.mjs [--rounds=10]
 *   环境变量：ARCH11_SKIP_DOCKER=1 复用本机 PG/Redis（默认用 docker）。
 *
 * 退出码：0 = 全部不变量成立；1 = 有违反（打印违反明细）。
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDatabase } from "./pg-provision.lib.mjs";
import { hermeticEnv } from "./lib/selftest-hermetic.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const API_DIR = path.join(REPO_ROOT, "apps", "admin-api");

const ROUNDS = Number(
  (process.argv.find((a) => a.startsWith("--rounds=")) ?? "--rounds=10").slice("--rounds=".length),
);
const DOCKER_MODE = process.env.ARCH11_SKIP_DOCKER !== "1";
const STAMP = Date.now();
const PG_CONTAINER = `acf-r11-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-r11-redis-${STAMP}`;

const usedPorts = new Set();
const randPort = () => {
  for (;;) {
    const p = 15000 + Math.floor(Math.random() * 10000);
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
};
const PG_PORT = Number(process.env.ARCH11_DB_PORT || randPort());
const REDIS_PORT = Number(process.env.ARCH11_REDIS_PORT || randPort());
const DB_HOST = process.env.ARCH11_DB_HOST || "localhost";
const DB_USER = process.env.ARCH11_DB_USER || "autoflow";
const DB_PASS = process.env.ARCH11_DB_PASS || "test";
const DB_NAME = process.env.ARCH11_DB_NAME || `autoflow_r11_${STAMP}`;
const PORT = Number(process.env.ARCH11_PORT || randPort());
const EXECUTOR_SECRET = "r11-executor-secret";

const ADDRESS = `10.11.11.11:8002`; // 三个场景共用（每轮清理）
const results = [];
const violations = [];
const children = [];
let logDir = "";

const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "✔" : "✘"} ${name}${pass || !detail ? "" : `\n    ${String(detail).slice(0, 700)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 180_000, ...opts });
const hasCommand = (cmd) => run("sh", ["-c", `command -v ${cmd}`]).status === 0;

function baseEnv() {
  return hermeticEnv({
    ...process.env,
    NODE_ENV: "development",
    PORT: String(PORT),
    DB_HOST,
    DB_PORT: String(PG_PORT),
    DB_USERNAME: DB_USER,
    DB_PASSWORD: DB_PASS,
    DB_DATABASE: DB_NAME,
    REDIS_HOST: "localhost",
    REDIS_PORT: String(REDIS_PORT),
    JWT_SECRET: "r11-jwt-secret-32chars-long-here!!",
    JWT_REFRESH_SECRET: "r11-refresh-secret-32chars-longxx",
    EXECUTOR_SECRET,
    EXECUTION_CALLBACK_SECRET: EXECUTOR_SECRET,
    EXECUTOR_ALLOW_PRIVATE_NETWORK: "true",
    INITIAL_ADMIN_USERNAME: "admin",
    INITIAL_ADMIN_PASSWORD: "admin123",
    AI_PROVIDER: "disabled",
    LOGIN_THROTTLE_LIMIT: "10000",
    THROTTLE_LIMIT: "10000",
    // 接管窗：默认 5min。测试里用默认值（不缩短）——要测的就是真实窗口下的裁决。
  });
}

function psql(sql) {
  const r = run("docker", [
    "exec", "-i", PG_CONTAINER,
    "psql", "-U", DB_USER, "-d", DB_NAME, "-tAc", sql,
  ]);
  if (r.status !== 0) throw new Error(`psql 失败: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

async function waitForHttp(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(1000);
  }
  throw new Error(`waitForHttp timeout: ${url} (${last})`);
}

/** 打一发 register（共享令牌；push 模式；带指纹/startupId）。 */
async function register({ fingerprint, startupId, address = ADDRESS, appName = "r11-executor" }) {
  const res = await fetch(`http://localhost:${PORT}/api/executors/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${EXECUTOR_SECRET}`,
    },
    body: JSON.stringify({
      appName,
      address,
      type: "node",
      version: "1.0.0",
      protocolVersion: 9,
      dispatchMode: "push",
      deviceFingerprint: fingerprint,
      startupId,
      maxConcurrentTasks: 4,
    }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

// 64 位小写十六进制（与 normalizeDeviceFingerprint 的采纳形态一致）。
// ⚠️ 必须**由种子派生**：早期版本用 `padEnd+非十六进制替换成 'a'`，导致
// `ret1`/`new1`/`a1` 之类的种子**全部塌成同一个指纹** ⇒ 场景 D 退化成
// 「同指纹并发」（合法双 201），把要测的交叉竞态测没了（已被本轮实测抓到）。
const fp = (seed) => crypto.createHash("sha256").update(String(seed)).digest("hex");

async function main() {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), "acf-r11-"));
  console.log(`=== R11 执行器注册接管 CAS 并发回归（${ROUNDS} 轮 × 3 场景）===`);

  try {
    // ── 依赖：PG + Redis（docker） ─────────────────────────────────
    if (DOCKER_MODE) {
      if (!hasCommand("docker")) throw new Error("docker 不可用（未装或不在 PATH）");
      const stale = run("docker", ["ps", "-a", "--filter", "name=acf-r11-", "--format", "{{.Names}}"]);
      for (const n of (stale.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)) {
        run("docker", ["rm", "-f", n]);
      }
      const pg = run("docker", ["run", "-d", "--name", PG_CONTAINER,
        "-e", `POSTGRES_USER=${DB_USER}`, "-e", `POSTGRES_PASSWORD=${DB_PASS}`,
        "-e", "POSTGRES_DB=autoflow_test", "-p", `${PG_PORT}:5432`, "postgres:16-alpine"]);
      if (pg.status !== 0) throw new Error(`PG 容器启动失败: ${pg.stderr}`);
      const rd = run("docker", ["run", "-d", "--name", REDIS_CONTAINER,
        "-p", `${REDIS_PORT}:6379`, "redis:7-alpine"]);
      if (rd.status !== 0) throw new Error(`Redis 容器启动失败: ${rd.stderr}`);
    }
    await ensureDatabase({ host: DB_HOST, port: PG_PORT, user: DB_USER, password: DB_PASS, dbName: DB_NAME, dropFirst: true });
    ok("依赖服务就绪（PG + Redis）", true);

    // ── 构建 + 迁移 ────────────────────────────────────────────────
    const build = run("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: API_DIR });
    ok("admin-api 构建通过", build.status === 0, build.stderr || build.stdout);
    if (build.status !== 0) return summary();

    const migrate = run("npm", ["run", "migration:run"], { cwd: API_DIR, env: baseEnv() });
    ok("空库迁移链真跑通过", migrate.status === 0, migrate.stderr || migrate.stdout);
    if (migrate.status !== 0) return summary();

    // ── 起 admin-api ──────────────────────────────────────────────
    const out = fs.openSync(path.join(logDir, "admin-api.log"), "a");
    const child = spawn("node", ["dist/main.js"], {
      cwd: API_DIR, env: baseEnv(), stdio: ["ignore", out, out], detached: true,
    });
    child.unref();
    children.push(child);
    await waitForHttp(`http://localhost:${PORT}/api/health/live`);
    ok("admin-api 就绪", true);

    // ── 三个场景 × N 轮 ───────────────────────────────────────────
    const scenarioStats = { A: [], B: [], C: [], D: [] };
    for (let round = 1; round <= ROUNDS; round += 1) {
      // 每轮清理：只删本测试地址的行（绝不整表删）
      psql(`delete from executors where address = '${ADDRESS}';`);

      // 场景 A：接管竞态（预置死行）
      const deadFp = fp(`dead${round}`);
      psql(
        `insert into executors (id,"appName",address,status,"dispatchMode","deviceFingerprint","executorVersion","maxConcurrentTasks","runningTaskCount","lastHeartbeat","createdAt","updatedAt") ` +
        `values (gen_random_uuid(),'dead-install','${ADDRESS}','offline','push','${deadFp}','1.0.0',4,3, now() - interval '10 minutes', now(), now());`,
      );
      const aFp = fp(`a${round}`);
      const bFp = fp(`b${round}`);
      const [aRes, bRes] = await Promise.all([
        register({ fingerprint: aFp, startupId: `a-startup-${round}`, appName: "install-a" }),
        register({ fingerprint: bFp, startupId: `b-startup-${round}`, appName: "install-b" }),
      ]);
      const rowA = inspectRow();
      const invA = checkInvariants(`A#${round}`, [aRes, bRes], [aFp, bFp], [`a-startup-${round}`, `b-startup-${round}`], rowA, { allowDoubleWin: false });
      await assertWinnerRecoverable(`A#${round}`, invA);
      scenarioStats.A.push(invA);

      // 场景 B：首注册竞态（无预置行）
      psql(`delete from executors where address = '${ADDRESS}';`);
      const cFp = fp(`c${round}`);
      const dFp = fp(`d${round}`);
      const [cRes, dRes] = await Promise.all([
        register({ fingerprint: cFp, startupId: `c-startup-${round}`, appName: "install-c" }),
        register({ fingerprint: dFp, startupId: `d-startup-${round}`, appName: "install-d" }),
      ]);
      const rowB = inspectRow();
      const invB = checkInvariants(`B#${round}`, [cRes, dRes], [cFp, dFp], [`c-startup-${round}`, `d-startup-${round}`], rowB, { allowDoubleWin: false });
      await assertWinnerRecoverable(`B#${round}`, invB);
      scenarioStats.B.push(invB);

      // 场景 C：同指纹并发重注册（幂等面，允许双 2xx）
      psql(`delete from executors where address = '${ADDRESS}';`);
      const eFp = fp(`e${round}`);
      const [e1, e2] = await Promise.all([
        register({ fingerprint: eFp, startupId: `e-startup-${round}-1`, appName: "install-e" }),
        register({ fingerprint: eFp, startupId: `e-startup-${round}-2`, appName: "install-e" }),
      ]);
      const rowC = inspectRow();
      const invC = checkInvariants(`C#${round}`, [e1, e2], [eFp, eFp], [`e-startup-${round}-1`, `e-startup-${round}-2`], rowC, { allowDoubleWin: true });
      await assertWinnerRecoverable(`C#${round}`, invC);
      scenarioStats.C.push(invC);

      // 场景 D：**同指纹回归（byFingerprint 命中，无 CAS）vs 不同指纹接管（有 CAS）**
      //  —— 两条写路径对**同一行**：前者裸 id 覆盖写、后者 status=OFFLINE 谓词 CAS。
      //  危险交错：接管 CAS 先提交（行变 ONLINE + FP_NEW），随后回归方的**旧快照**
      //  裸覆盖写把指纹/startupId 改回 FP_OLD ⇒ 接管方持有的令牌对不上行（跨行覆盖）。
      psql(`delete from executors where address = '${ADDRESS}';`);
      const retFp = fp(`ret${round}`); // 「回归的原安装」= 死行的旧指纹
      psql(
        `insert into executors (id,"appName",address,status,"dispatchMode","deviceFingerprint","executorVersion","maxConcurrentTasks","runningTaskCount","lastHeartbeat","createdAt","updatedAt") ` +
        `values (gen_random_uuid(),'dead-install','${ADDRESS}','offline','push','${retFp}','1.0.0',4,2, now() - interval '10 minutes', now(), now());`,
      );
      const newFp = fp(`new${round}`);
      const [retRes, takeRes] = await Promise.all([
        register({ fingerprint: retFp, startupId: `ret-startup-${round}`, appName: "returning-install" }),
        register({ fingerprint: newFp, startupId: `new-startup-${round}`, appName: "taking-over-install" }),
      ]);
      const rowD = inspectRow();
      const invD = checkScenarioD(`D#${round}`, { retRes, takeRes, retFp, newFp, retStartup: `ret-startup-${round}`, newStartup: `new-startup-${round}` }, rowD);
      scenarioStats.D.push(invD);
      await assertWinnerRecoverable(`D#${round}`, invD);
      // 注意：**输家**（不同指纹的接管方）在本轮输掉后继续 409 是 ADR-017 §5 的
      // 预期 fail-closed（它确实是另一份安装、争的是同一个 push 地址），**不是**
      // 「永久 409」缺陷 ⇒ 这里只断言**赢家**可恢复重注册（见上方 invD 的 winnerFp）。

      console.log(
        `  round ${String(round).padStart(2)}/ ${ROUNDS}: A=${invA.pass ? "ok" : "VIOLATION"} ` +
        `B=${invB.pass ? "ok" : "VIOLATION"} C=${invC.pass ? "ok" : "VIOLATION"} D=${invD.pass ? "ok" : "VIOLATION"}` +
        `（A: ${aRes.status}/${bRes.status}  B: ${cRes.status}/${dRes.status}  C: ${e1.status}/${e2.status}  D: ${retRes.status}/${takeRes.status}）`,
      );
    }

    // 汇总
    for (const [name, stats] of Object.entries(scenarioStats)) {
      const bad = stats.filter((s) => !s.pass);
      ok(`场景 ${name}：${ROUNDS} 轮全部满足不变量`, bad.length === 0, bad.map((b) => `${b.label}: ${b.reason}`).join("; "));
    }

    // ── 逐条不变量（跨全部轮次）──────────────────────────────────
    const allViolations = [...violations];
    ok("不变量 I1「恰好一行」全程成立", !allViolations.some((v) => v.rule === "I1"), allViolations.filter((v) => v.rule === "I1").slice(0, 5).map((v) => `${v.label}: ${v.detail}`).join(" | "));
    ok("不变量 I2「恰好一个赢家」全程成立", !allViolations.some((v) => v.rule === "I2"), allViolations.filter((v) => v.rule === "I2").slice(0, 5).map((v) => `${v.label}: ${v.detail}`).join(" | "));
    ok("不变量 I3「行身份 = 赢家」全程成立（无跨行覆盖）", !allViolations.some((v) => v.rule === "I3"), allViolations.filter((v) => v.rule === "I3").slice(0, 5).map((v) => `${v.label}: ${v.detail}`).join(" | "));
    ok("场景 D 交叉竞态「接管赢则行身份属接管方 / 回归赢则未漂移」全程成立", !allViolations.some((v) => v.label.startsWith("D")), allViolations.filter((v) => v.label.startsWith("D")).slice(0, 5).map((v) => `${v.label}: ${v.detail}`).join(" | "));
    ok("不变量 I4「赢家可恢复重注册」全程成立（无永久 409）", !allViolations.some((v) => v.rule === "I4"), allViolations.filter((v) => v.rule === "I4").slice(0, 5).map((v) => `${v.label}: ${v.detail}`).join(" | "));

    return summary();
  } catch (err) {
    ok("用例自身执行", false, err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
    return summary();
  } finally {
    cleanup();
  }
}

/** 读该地址的行（用于 I1/I3）。 */
function inspectRow() {
  const raw = psql(
    `select json_agg(json_build_object(` +
      `'id', id, 'appName', "appName", 'status', status, 'fp', "deviceFingerprint", ` +
      `'startupId', "executorStartupId", 'rtc', "runningTaskCount")) ` +
    `from executors where address = '${ADDRESS}';`,
  );
  if (!raw || raw === "") return [];
  try {
    return JSON.parse(raw) ?? [];
  } catch {
    return [];
  }
}

/**
 * 检查一轮的不变量。赢家 = 2xx 那一发（`allowDoubleWin` 时取第一发）。
 */
function checkInvariants(label, responses, fps, startupIds, rows, { allowDoubleWin }) {
  const fail = (rule, reason) => {
    violations.push({ rule, label, detail: reason });
    return { label, pass: false, reason: `${rule}: ${reason}` };
  };

  // I1：恰好一行
  if (rows.length !== 1) {
    return fail("I1", `地址上有 ${rows.length} 行（期望 1）；行=${JSON.stringify(rows)}`);
  }
  const row = rows[0];

  // I2：恰好一个赢家
  const winners = responses.map((r, i) => ({ r, i })).filter(({ r }) => r.status >= 200 && r.status < 300);
  const losers = responses.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 409);
  const others = responses.filter((r) => !(r.status >= 200 && r.status < 300) && r.status !== 409);
  if (others.length > 0) {
    return fail("I2", `出现 2xx/409 之外的响应：${JSON.stringify(others.map((o) => o.status))}`);
  }
  if (winners.length === 2 && !allowDoubleWin) {
    return fail("I2", `两发都成功（双赢 ⇒ 覆盖前兆）：${JSON.stringify(responses.map((r) => r.status))}`);
  }
  if (winners.length === 0) {
    return fail("I2", `两发都失败（无赢家）：${JSON.stringify(responses.map((r) => r.status))}`);
  }
  if (!allowDoubleWin && winners.length + losers.length !== 2) {
    return fail("I2", `赢家 ${winners.length} / 输家 ${losers.length}（期望 1 + 1）`);
  }

  // I3：行身份 = 赢家的上报（未被输家覆盖）。同指纹场景 C 两发指纹相同，只校验指纹。
  const winnerIdx = winners[0].i;
  const winnerFp = fps[winnerIdx];
  if (row.fp !== winnerFp) {
    return fail("I3", `行的 deviceFingerprint=${String(row.fp)} ≠ 赢家 ${winnerFp}（跨行覆盖）`);
  }
  if (!allowDoubleWin) {
    const winnerStartup = startupIds[winnerIdx];
    if (row.startupId !== winnerStartup) {
      return fail("I3", `行的 executorStartupId=${String(row.startupId)} ≠ 赢家 ${winnerStartup}（跨行覆盖）`);
    }
    if (String(row.status).toLowerCase() !== "online") {
      return fail("I3", `行的 status=${String(row.status)}（赢家接管后应为 online）`);
    }
    if (Number(row.rtc) !== 0) {
      return fail("I3", `行的 runningTaskCount=${String(row.rtc)}（接管应清零幻影计数）`);
    }
  }

  // I4 在调用方（异步）做——这里只把赢家身份带回去。
  return {
    label,
    pass: true,
    winnerFp,
    winnerStartup: allowDoubleWin ? startupIds[0] : startupIds[winnerIdx],
    winnerAppName: allowDoubleWin ? null : winners[0].r.body?.data?.appName ?? null,
  };
}

/**
 * 场景 D 的不变量：**同指纹回归 vs 不同指纹接管** 的交叉竞态。
 *
 * 两条写路径打同一行：回归方走 `repo.update({id})`（**无 CAS**，R55-A1 论证只覆盖
 * 「覆盖式上报」），接管方走 `repo.update({id, status: OFFLINE}, patch)`。若接管
 * 先提交、回归方的旧快照后落库，行上的身份会被改回旧指纹 ⇒ 接管方令牌对不上行。
 *
 * 判据（只允许两种自洽结局）：
 *   · 接管赢（takeRes 2xx）：行必须是 **接管方的指纹/startupId**，回归方要么 2xx
 *     （随后它成了唯一 owner，行身份应变成回归方 —— 但那时接管方的令牌已失效，
 *     **所以这一态本身也不自洽**：只接受「回归方 409」）；
 *   · 回归赢（retRes 2xx 且 takeRes 409）：行的指纹必须是**回归方**（= 旧指纹，未漂移）。
 */
function checkScenarioD(label, ctx, rows) {
  const { retRes, takeRes, retFp, newFp, retStartup, newStartup } = ctx;
  const fail = (rule, reason) => {
    violations.push({ rule, label, detail: reason });
    return { label, pass: false, reason: `${rule}: ${reason}` };
  };
  if (rows.length !== 1) return fail("I1", `场景 D 地址上有 ${rows.length} 行（期望 1）`);
  const row = rows[0];
  const retWon = retRes.status >= 200 && retRes.status < 300;
  const takeWon = takeRes.status >= 200 && takeRes.status < 300;

  if (!retWon && !takeWon) {
    return fail("I2", `两发都失败：ret=${retRes.status} take=${takeRes.status}`);
  }
  if (retWon && takeWon) {
    // 两发都 2xx：接管方被告知"你拿到了"，但回归方随后覆盖同一行 ⇒ 接管方令牌必失效。
    // 行的身份若已回到旧指纹，就证明接管方的写入被覆盖（跨行覆盖）。
    if (row.fp === retFp && row.startupId === retStartup) {
      return fail(
        "I3",
        `两发都 2xx 且行被回归方覆盖（fp=${String(row.fp).slice(0, 8)}… startup=${String(row.startupId)}）` +
          ` —— 接管方拿到 2xx 却不再拥有该行（令牌失效/跨行覆盖）`,
      );
    }
    return fail("I2", `场景 D 双赢：ret=${retRes.status} take=${takeRes.status}，行 fp=${String(row.fp).slice(0, 8)}…`);
  }
  if (takeWon) {
    if (row.fp !== newFp || row.startupId !== newStartup) {
      return fail(
        "I3",
        `接管方赢了（${takeRes.status}）但行身份是 fp=${String(row.fp).slice(0, 8)}… / startup=${String(row.startupId)}` +
          `（期望接管方 fp=${newFp.slice(0, 8)}… / startup=${newStartup}）—— 被回归方旧快照覆盖`,
      );
    }
    if (retRes.status !== 409) {
      return fail("I2", `接管赢时回归方应 409，实际 ${retRes.status}`);
    }
    return { label, pass: true, winnerFp: newFp, winnerStartup: newStartup };
  }
  // 回归方赢
  if (row.fp !== retFp) {
    return fail("I3", `回归方赢了但行指纹=${String(row.fp).slice(0, 8)}… ≠ ${retFp.slice(0, 8)}…`);
  }
  return { label, pass: true, winnerFp: retFp, winnerStartup: retStartup };
}

/** I4：赢家用**同一身份**再注册一次必须 2xx（否则就是「永久 409」）。 */
async function assertWinnerRecoverable(label, inv) {
  if (!inv.pass) return;
  const replay = await register({
    fingerprint: inv.winnerFp,
    startupId: inv.winnerStartup,
    appName: "r11-executor",
  });
  if (!(replay.status >= 200 && replay.status < 300)) {
    violations.push({
      rule: "I4",
      label,
      detail: `赢家重注册得到 HTTP ${replay.status}（期望 2xx）—— 永久 409`,
    });
  }
}

function summary() {
  const failed = results.filter((r) => r.pass === false);
  console.log("");
  console.log(`══ 汇总：${results.length - failed.length} 通过 / ${failed.length} 失败 ══`);
  if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log(`  ✘ ${f.name}`);
    return 1;
  }
  return 0;
}

function cleanup() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  if (DOCKER_MODE && hasCommand("docker")) {
    run("docker", ["rm", "-f", PG_CONTAINER, REDIS_CONTAINER]);
  }
  if (logDir) {
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const code = await main();
process.exit(code);
