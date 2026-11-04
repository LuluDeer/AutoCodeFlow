#!/usr/bin/env node
/**
 * `issueToken` 的 `(address, startupId)` **并发幂等**真机回归（R12，2026-11-05）。
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
const PG_CONTAINER = `acf-r12-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-r12-redis-${STAMP}`;

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
const DB_NAME = process.env.ARCH12_DB_NAME || `autoflow_r12_${STAMP}`;
const PORT = Number(process.env.ARCH12_PORT || randPort());
const EXECUTOR_SECRET = "r12-executor-secret";

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
    JWT_SECRET: "r12-jwt-secret-32chars-long-here!!",
    JWT_REFRESH_SECRET: "r12-refresh-secret-32chars-longxx",
    EXECUTOR_SECRET,
    EXECUTION_CALLBACK_SECRET: EXECUTOR_SECRET,
    EXECUTOR_ALLOW_PRIVATE_NETWORK: "true",
    INITIAL_ADMIN_USERNAME: "admin",
    INITIAL_ADMIN_PASSWORD: "admin123",
    AI_PROVIDER: "disabled",
    LOGIN_THROTTLE_LIMIT: "10000",
    THROTTLE_LIMIT: "10000",
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

async function fetchToken({ address, appName, startupId, fingerprint }) {
  const res = await fetch(`http://localhost:${PORT}/api/executors/token`, {
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
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), "acf-r12-"));
  console.log(`=== R12 issueToken 并发幂等回归（${ROUNDS} 轮 × ${CONCURRENCY} 并发）===`);

  try {
    if (DOCKER_MODE) {
      if (!hasCommand("docker")) throw new Error("docker 不可用");
      const stale = run("docker", ["ps", "-a", "--filter", "name=acf-r12-", "--format", "{{.Names}}"]);
      for (const n of (stale.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)) {
        run("docker", ["rm", "-f", n]);
      }
      const pg = run("docker", ["run", "-d", "--name", PG_CONTAINER,
        "-e", `POSTGRES_USER=${DB_USER}`, "-e", `POSTGRES_PASSWORD=${DB_PASS}`,
        "-e", "POSTGRES_DB=autoflow_test", "-p", `${PG_PORT}:5432`, "postgres:16-alpine"]);
      if (pg.status !== 0) throw new Error(`PG 启动失败: ${pg.stderr}`);
      const rd = run("docker", ["run", "-d", "--name", REDIS_CONTAINER, "-p", `${REDIS_PORT}:6379`, "redis:7-alpine"]);
      if (rd.status !== 0) throw new Error(`Redis 启动失败: ${rd.stderr}`);
    }
    await ensureDatabase({ host: DB_HOST, port: PG_PORT, user: DB_USER, password: DB_PASS, dbName: DB_NAME, dropFirst: true });
    ok("依赖服务就绪（PG + Redis）", true);

    const build = run("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: API_DIR });
    ok("admin-api 构建通过", build.status === 0, build.stderr || build.stdout);
    if (build.status !== 0) return summary();

    const migrate = run("npm", ["run", "migration:run"], { cwd: API_DIR, env: baseEnv() });
    ok("空库迁移链真跑通过", migrate.status === 0, migrate.stderr || migrate.stdout);
    if (migrate.status !== 0) return summary();

    const out = fs.openSync(path.join(logDir, "admin-api.log"), "a");
    const child = spawn("node", ["dist/main.js"], { cwd: API_DIR, env: baseEnv(), stdio: ["ignore", out, out], detached: true });
    child.unref();
    children.push(child);
    await waitForHttp(`http://localhost:${PORT}/api/health/live`);
    ok("admin-api 就绪", true);

    const bcrypt = require(path.join(API_DIR, "node_modules", "bcrypt"));
    const perRound = [];

    for (let round = 1; round <= ROUNDS; round += 1) {
      const address = `10.12.${round}.10:8003`;
      const startupId = `r12-startup-${round}`;
      const fingerprint = fp(`r12-${round}`);
      const appName = "r12-token-executor";

      // M 发并发签发（同一 address + startupId + 指纹）
      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => fetchToken({ address, appName, startupId, fingerprint })),
      );
      const bad = responses.filter((r) => r.status !== 200 && r.status !== 201);
      const tokens = [...new Set(responses.map((r) => r.token).filter(Boolean))];
      const hashes = [...new Set(responses.map((r) => r.tokenHash).filter(Boolean))];

      // 读 DB 当前 tokenHash（唯一事实源）
      const storedHash = psql(`select "tokenHash" from executors where address = '${address}';`);
      // I2：用 bcrypt 逐枚复核 —— 命中的必须恰好一枚
      const matched = [];
      for (const t of tokens) {
        if (storedHash && (await bcrypt.compare(t, storedHash))) matched.push(t);
      }

      const roundViolations = [];
      if (bad.length > 0) roundViolations.push(`响应异常：${JSON.stringify(bad.map((b) => b.status))}`);
      if (tokens.length > 1) roundViolations.push(`I1 违反：${tokens.length} 枚不同令牌（发生了 ${tokens.length} 次轮换）`);
      if (matched.length !== 1) roundViolations.push(`I2 违反：命中 DB hash 的令牌 ${matched.length} 枚（期望恰好 1）`);
      if (hashes.length > 1) roundViolations.push(`I3 违反：tokenHash 出现 ${hashes.length} 个不同值`);

      perRound.push({ round, tokens: tokens.length, hashes: hashes.length, matched: matched.length, violations: roundViolations });
      for (const v of roundViolations) violations.push({ round, detail: v });
      console.log(
        `  round ${String(round).padStart(2)}/${ROUNDS}: 响应=${responses.map((r) => r.status).join("/")} ` +
        `不同令牌=${tokens.length} 不同hash=${hashes.length} 命中hash=${matched.length} ` +
        `${roundViolations.length ? "VIOLATION(" + roundViolations.join("；") + ")" : "ok"}`,
      );
    }

    // 汇总：逐条不变量
    ok(
      "I1 至多一枚有效令牌（每轮不同令牌数 ≤1）",
      !violations.some((v) => v.detail.startsWith("I1")),
      violations.filter((v) => v.detail.startsWith("I1")).slice(0, 5).map((v) => `#${v.round}: ${v.detail}`).join(" | "),
    );
    ok(
      "I2 被替换的旧令牌明确吊销（bcrypt 命中 DB hash 的恰好一枚）",
      !violations.some((v) => v.detail.startsWith("I2")),
      violations.filter((v) => v.detail.startsWith("I2")).slice(0, 5).map((v) => `#${v.round}: ${v.detail}`).join(" | "),
    );
    ok(
      "I3 任一时刻 active 令牌数 ≤1（tokenHash 唯一列 + 命中唯一）",
      !violations.some((v) => v.detail.startsWith("I3")),
      violations.filter((v) => v.detail.startsWith("I3")).slice(0, 5).map((v) => `#${v.round}: ${v.detail}`).join(" | "),
    );
    const avgTokens = perRound.reduce((a, r) => a + r.tokens, 0) / Math.max(1, perRound.length);
    console.log(`\n  统计：${ROUNDS} 轮 · 平均不同令牌数 = ${avgTokens.toFixed(2)}（1.00 = 完全幂等）`);

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
