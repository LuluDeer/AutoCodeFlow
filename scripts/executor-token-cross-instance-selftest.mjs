#!/usr/bin/env node
/**
 * `issueToken` 的 `(address, startupId)` **跨实例并发幂等**真机回归（R14，2026-11-05）。
 *
 * R12 版只压**单实例**（进程内串行器即可满足）。本脚本起**两个** admin-api 实例共享
 * 同一个 PG/Redis，验证 ADR-030 ②′ 落地后：
 *   · `--mode=on`   ：两实例都开 `EXECUTOR_TOKEN_EPOCH_MODE=on` ⇒ 同身份并发签发
 *                     **两实例必须返回同一枚令牌**（I4，跨实例幂等）。
 *   · `--mode=mixed`：A 开、B 关（灰度混跑）⇒ 允许返回不同令牌（ADR-030 §5.2），
 *                     但**不许出现永久 401**：竞态后必须仍能取到一枚「验得过 DB 哈希」的令牌。
 *
 * 原 R12 头注（单实例语境）保留如下，供对照：
 *
 * ## 缺陷（先查现状再断言）
 *
 * `issueToken`（`apps/admin-api/src/modules/executor/executor.service.ts:6635`）的幂等复用
 * 建立在**进程内缓存**上：`issuedTokenCache.get(identityKey)` → 命中且 `sameProcess` 才复用
 * （`:6697` / `:6705-6719`）→ 否则 `rotateToken(executor.id)`（`:6730`）。
 * 缓存是**同步读**、`rotateToken` 是 **await** ⇒ 并发请求**都能在写入前读到 miss**，
 * 于是各自轮换一次：先返回的那个令牌**刚签发就被下一次轮换覆盖**（调用方拿到死令牌）。
 *
 * ## 三条不变量（每轮都查）
 *
 *   I1 **至多一枚有效令牌**：M 发并发签发的 `token` 去重后 **≤1**（>1 ⇒ 发生了多次轮换）。
 *   I2 **被替换的旧令牌明确吊销**：用 DB 里的 `tokenHash` 逐枚做 `bcrypt.compare` ——
 *      命中的必须**恰好一枚**；其余必须**不命中**（= 已被覆盖，明确吊销）。
 *   I3 **active 令牌数 ≤1**：该行的 `tokenHash` 只有一列，且 I2 的「恰好一枚命中」即其机读形态。
 *
 * ## 用法
 *
 *   node scripts/executor-token-idempotency-selftest.mjs [--rounds=10] [--concurrency=4]
 *   ARCH12_SKIP_DOCKER=1 复用本机 PG/Redis（默认 docker）
 *
 * 退出码：0 = 全部轮次满足不变量；1 = 有违反（打印逐轮明细）。
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { ensureDatabase } from "./pg-provision.lib.mjs";
import { hermeticEnv } from "./lib/selftest-hermetic.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const API_DIR = path.join(REPO_ROOT, "apps", "admin-api");

const ROUNDS = Number((process.argv.find((a) => a.startsWith("--rounds=")) ?? "--rounds=10").slice(9));
const CONCURRENCY = Number((process.argv.find((a) => a.startsWith("--concurrency=")) ?? "--concurrency=4").slice(14));
const DOCKER_MODE = process.env.ARCH12_SKIP_DOCKER !== "1";
const STAMP = Date.now();
const PG_CONTAINER = `acf-r14-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-r14-redis-${STAMP}`;

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
const PG_PORT = Number(process.env.ARCH12_DB_PORT || randPort());
const REDIS_PORT = Number(process.env.ARCH12_REDIS_PORT || randPort());
const DB_HOST = process.env.ARCH12_DB_HOST || "localhost";
const DB_USER = process.env.ARCH12_DB_USER || "autoflow";
const DB_PASS = process.env.ARCH12_DB_PASS || "test";
const DB_NAME = process.env.ARCH14_DB_NAME || `autoflow_r14_${STAMP}`;
const PORT_A = Number(process.env.ARCH14_PORT_A || randPort());
const PORT_B = Number(process.env.ARCH14_PORT_B || randPort());
const MIXED = (process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=on").slice(7) === "mixed";
const EXECUTOR_SECRET = "r14-executor-secret";

const results = [];
const violations = [];
const children = [];
let logDir = "";

const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "✔" : "✘"} ${name}${pass || !detail ? "" : `\n    ${String(detail).slice(0, 800)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 180_000, ...opts });
const hasCommand = (cmd) => run("sh", ["-c", `command -v ${cmd}`]).status === 0;

function baseEnv(port, { epochMode }) {
  return hermeticEnv({
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    DB_HOST,
    DB_PORT: String(PG_PORT),
    DB_USERNAME: DB_USER,
    DB_PASSWORD: DB_PASS,
    DB_DATABASE: DB_NAME,
    REDIS_HOST: "localhost",
    REDIS_PORT: String(REDIS_PORT),
    JWT_SECRET: "r14-jwt-secret-32chars-long-here!!",
    JWT_REFRESH_SECRET: "r14-refresh-secret-32chars-longxx",
    EXECUTOR_SECRET,
    EXECUTION_CALLBACK_SECRET: EXECUTOR_SECRET,
    EXECUTOR_ALLOW_PRIVATE_NETWORK: "true",
    INITIAL_ADMIN_USERNAME: "admin",
    INITIAL_ADMIN_PASSWORD: "admin123",
    AI_PROVIDER: "disabled",
    LOGIN_THROTTLE_LIMIT: "10000",
    THROTTLE_LIMIT: "10000",
    EXECUTOR_TOKEN_EPOCH_MODE: epochMode,
  });
}

function psql(sql) {
  const r = run("docker", ["exec", "-i", PG_CONTAINER, "psql", "-U", DB_USER, "-d", DB_NAME, "-tAc", sql]);
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

const fp = (seed) => crypto.createHash("sha256").update(String(seed)).digest("hex");

async function fetchToken({ address, appName, startupId, fingerprint, port }) {
  const res = await fetch(`http://localhost:${port}/api/executors/token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${EXECUTOR_SECRET}` },
    body: JSON.stringify({ address, appName, startupId, deviceFingerprint: fingerprint }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  const data = body?.data ?? body;
  return { status: res.status, token: data?.token ?? null, tokenHash: data?.tokenHash ?? null };
}

async function main() {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), "acf-r14-"));
  console.log(
    `=== R14 跨实例 token 幂等（${ROUNDS} 轮 × ${CONCURRENCY} 并发；mode=${MIXED ? "mixed(A=on,B=off)" : "on/on"}）===`,
  );

  try {
    if (DOCKER_MODE) {
      if (!hasCommand("docker")) throw new Error("docker 不可用");
      const stale = run("docker", ["ps", "-a", "--filter", "name=acf-r14-", "--format", "{{.Names}}"]);
      for (const n of (stale.stdout || "").split("\n").map((x) => x.trim()).filter(Boolean)) run("docker", ["rm", "-f", n]);
      const pg = run("docker", ["run", "-d", "--name", PG_CONTAINER,
        "-e", `POSTGRES_USER=${DB_USER}`, "-e", `POSTGRES_PASSWORD=${DB_PASS}`,
        "-e", "POSTGRES_DB=autoflow_test", "-p", `${PG_PORT}:5432`, "postgres:16-alpine"]);
      if (pg.status !== 0) throw new Error(`PG 启动失败: ${pg.stderr}`);
      const rd = run("docker", ["run", "-d", "--name", REDIS_CONTAINER, "-p", `${REDIS_PORT}:6379`, "redis:7-alpine"]);
      if (rd.status !== 0) throw new Error(`Redis 启动失败: ${rd.stderr}`);
    }
    await ensureDatabase({ host: DB_HOST, port: PG_PORT, user: DB_USER, password: DB_PASS, dbName: DB_NAME, dropFirst: true });
    ok("依赖服务就绪（PG + Redis，两实例共享）", true);

    const build = run("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: API_DIR });
    ok("admin-api 构建通过", build.status === 0, build.stderr || build.stdout);
    if (build.status !== 0) return summary();

    const migrate = run("npm", ["run", "migration:run"], { cwd: API_DIR, env: baseEnv(PORT_A, { epochMode: "on" }) });
    ok("空库迁移链真跑通过（含 1790000000097 tokenRotationEpoch）", migrate.status === 0, migrate.stderr || migrate.stdout);
    if (migrate.status !== 0) return summary();

    // 两个实例：A 恒 on；B 在 mixed 模式关（灰度混跑）
    const inst = [
      { port: PORT_A, epochMode: "on" },
      { port: PORT_B, epochMode: MIXED ? "off" : "on" },
    ];
    for (const [i, cfg] of inst.entries()) {
      const out = fs.openSync(path.join(logDir, `instance-${cfg.port}.log`), "a");
      const child = spawn("node", ["dist/main.js"], {
        cwd: API_DIR, env: baseEnv(cfg.port, { epochMode: cfg.epochMode }),
        stdio: ["ignore", out, out], detached: true,
      });
      child.unref();
      children.push(child);
      void i;
    }
    await waitForHttp(`http://localhost:${PORT_A}/api/health/live`);
    await waitForHttp(`http://localhost:${PORT_B}/api/health/live`);
    ok(`两实例就绪（A:${PORT_A}=on / B:${PORT_B}=${inst[1].epochMode}）`, true);

    const bcrypt = require(path.join(API_DIR, "node_modules", "bcrypt"));
    const storedHashOf = (address) =>
      psql(`select "tokenHash" from executors where address = '${address}';`);

    const perRound = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      const address = `10.14.${round}.20:8005`;
      const startupId = `r14-startup-${round}`;
      const fingerprint = fp(`r14-${round}`);
      const appName = "r14-token-executor";

      // 交替打到两个实例（同一 identity）
      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          fetchToken({
            address, appName, startupId, fingerprint,
            port: inst[i % inst.length].port,
          }),
        ),
      );
      const bad = responses.filter((r) => r.status !== 200 && r.status !== 201);
      const tokens = [...new Set(responses.map((r) => r.token).filter(Boolean))];
      const hashes = [...new Set(responses.map((r) => r.tokenHash).filter(Boolean))];
      const storedHash = storedHashOf(address);
      const matched = [];
      for (const t of tokens) if (storedHash && (await bcrypt.compare(t, storedHash))) matched.push(t);

      const v = [];
      if (bad.length > 0) v.push(`响应异常 ${JSON.stringify(bad.map((b) => b.status))}`);
      if (matched.length !== 1) v.push(`I2/I3 违反：命中 DB hash 的令牌 ${matched.length} 枚（期望恰好 1）`);
      // I3 的口径按模式区分：mode=on 时「返回的 hash 必须唯一」是幂等的直接含义；
      // **混跑**（A=on / B=off）按 ADR-030 §5.2 **本来就不幂等**（旧实例仍发随机令牌），
      // 所以这里只要求「库里仍只有一枚可用」（matched===1）+ 「不许永久 401」，
      // 不再把「返回 hash 有多枚」当违反 —— 那是设计的已知代价，不是回归。
      if (!MIXED && hashes.length > 1) v.push(`I3 违反：返回 ${hashes.length} 个不同 tokenHash`);
      if (!MIXED && tokens.length > 1) {
        v.push(`I4 违反（跨实例幂等）：两实例返回了 ${tokens.length} 枚不同令牌`);
      }
      if (MIXED) {
        // 混跑：允许不同（ADR-030 §5.2），但**不许永久 401** ——
        // 竞态后再取一次，必须拿到一枚「验得过库里 hash」的令牌。
        const after = await fetchToken({ address, appName, startupId, fingerprint, port: inst[0].port });
        const afterHash = storedHashOf(address);
        const okAfter =
          after.status >= 200 && after.status < 300 && after.token && afterHash
            ? await bcrypt.compare(after.token, afterHash)
            : false;
        if (!okAfter) v.push(`混跑违反「不许永久 401」：竞态后取到的令牌验不过库里 hash（status=${after.status}）`);
      }

      perRound.push({ round, statuses: responses.map((r) => r.status), tokens: tokens.length, hashes: hashes.length, matched: matched.length, v });
      for (const detail of v) violations.push({ round, detail });
      console.log(
        `  round ${String(round).padStart(2)}/${ROUNDS}: 响应=${responses.map((r) => r.status).join("/")} ` +
        `不同令牌=${tokens.length} 不同hash=${hashes.length} 命中hash=${matched.length} ` +
        `${v.length ? "VIOLATION(" + v.join("；") + ")" : "ok"}`,
      );
    }

    ok("I1 至多一枚有效令牌（每轮命中 DB hash 的令牌恰好 1 枚）",
      !violations.some((x) => x.detail.startsWith("I2/I3")),
      violations.filter((x) => x.detail.startsWith("I2/I3")).slice(0, 5).map((x) => `#${x.round}: ${x.detail}`).join(" | "));
    ok("I2 旧令牌明确吊销（bcrypt 逐枚复核，命中恰好一枚）",
      !violations.some((x) => x.detail.startsWith("I2/I3")), "");
    ok(
      MIXED
        ? "I3（混跑口径）库里仍只有一枚可用令牌（matched===1）"
        : "I3 active 令牌数 ≤1（tokenHash 唯一列 + 返回 hash 唯一）",
      !violations.some((x) => x.detail.startsWith("I2/I3") || (x.detail.includes("I3") && !MIXED)),
      violations.filter((x) => x.detail.includes("I3")).slice(0, 5).map((x) => `#${x.round}: ${x.detail}`).join(" | "),
    );
    if (!MIXED) {
      ok("I4 跨实例幂等（两实例返回同一枚令牌）",
        !violations.some((x) => x.detail.startsWith("I4")),
        violations.filter((x) => x.detail.startsWith("I4")).slice(0, 5).map((x) => `#${x.round}: ${x.detail}`).join(" | "));
    } else {
      ok("混跑下限「不许永久 401」（竞态后仍能取到验得过的令牌）",
        !violations.some((x) => x.detail.includes("永久 401")),
        violations.filter((x) => x.detail.includes("永久 401")).slice(0, 5).map((x) => `#${x.round}: ${x.detail}`).join(" | "));
    }
    const avg = perRound.reduce((a, r) => a + r.tokens, 0) / Math.max(1, perRound.length);
    console.log(`\n  统计：${ROUNDS} 轮 · 平均不同令牌数 = ${avg.toFixed(2)}（1.00 = 两实例完全幂等）`);

    return summary();
  } catch (err) {
    ok("用例自身执行", false, err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
    return summary();
  } finally {
    cleanup();
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
  if (DOCKER_MODE && hasCommand("docker")) run("docker", ["rm", "-f", PG_CONTAINER, REDIS_CONTAINER]);
  if (logDir) {
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

process.exit(await main());
