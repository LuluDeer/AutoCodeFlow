/**
 * QA-05 第四档真机验收：**回调入口 10k 条/分钟**（真实 execution fixture）。
 *
 * 为什么不能直接拿 load-test 的 callback 场景充数：那个场景按调用方提供的**单个**
 * execution id 发批次，重复请求全部落幂等分支（工具与文档都明确「不等于 10k 个
 * 真实完成回调」）。本脚本自己造**真实 RUNNING 执行池**再打回调：
 *
 *   ① 起 PG16 + Redis7 + admin-api（空库迁移链真跑）+ **探针执行器**
 *      （接受派发但不回报结果 + 周期心跳）→ 执行稳定停在 RUNNING；
 *   ② 建 N 个任务并全部触发 → N 个真实 RUNNING execution（探针收到 N 次派发）；
 *   ③ 按 100 条/请求的批量打回调（id 在池内轮转）：**每个 execution 的首条是
 *      真实终态 winner**（条件 UPDATE 命中 + 落终态 + 事件），其余落幂等分支；
 *   ④ 统计**条目级**吞吐与结果分布（winner/idempotent/失败），断言 ≥10k 条/分钟。
 *
 * 口径如实：本档压的是「回调入口 + 终态 winner 条件更新 + 幂等分支」的混合负载，
 * 不是 10k 个互不相同的真实完成（那需要 10k 个在途执行，编排成本另计）；
 * winner 数 = execution 池大小，会在报告里分开列出。
 *
 * 用法：
 *   node scripts/qa05-callback-tier-selftest.mjs
 *   QA05_EXECUTIONS=1000 QA05_ITEMS=10000 QA05_CONCURRENCY=10 node scripts/...
 *   QA05_SKIP_DOCKER=1 ...（复用本机 PG/Redis）
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'admin-api');

const DOCKER_MODE = process.env.QA05_SKIP_DOCKER !== '1';
const STAMP = Date.now();
const PG_CONTAINER = `acf-qa05cb-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-qa05cb-redis-${STAMP}`;

const randPort = () => 15000 + Math.floor(Math.random() * 10000);
const PG_PORT = Number(process.env.QA05_DB_PORT || randPort());
const REDIS_PORT = Number(process.env.QA05_REDIS_PORT || randPort());
const API_PORT = Number(process.env.QA05_API_PORT || randPort());
const DB_HOST = process.env.QA05_DB_HOST || 'localhost';
const DB_USER = process.env.QA05_DB_USER || 'autoflow';
const DB_PASS = process.env.QA05_DB_PASS || 'test';
const DB_NAME = process.env.QA05_DB_NAME || `autoflow_qa05cb_${STAMP}`;
const EXECUTOR_SECRET = process.env.QA05_EXECUTOR_SECRET || 'qa05-callback-secret';

/** execution 池大小（= 真实 winner 回调数）。 */
const EXECUTIONS = Number(process.env.QA05_EXECUTIONS || 1000);
/** 回调条目总数（10k 档默认值）。 */
const ITEMS = Number(process.env.QA05_ITEMS || 10000);
/** 批量大小（admin-api 上限 100）。 */
const BATCH = Number(process.env.QA05_BATCH || 100);
/** 批量请求并发。 */
const CONCURRENCY = Number(process.env.QA05_CONCURRENCY || 10);
/** 条目吞吐目标（条/分钟）。 */
const TARGET_ITEMS_PER_MIN = Number(process.env.QA05_TARGET_PER_MIN || 10000);

const ADMIN = { username: 'admin', password: 'admin123' };

const results = [];
const children = [];
let tmpDir = '';

function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✔' : '✘'} ${name}${pass || !detail ? '' : `\n    ${String(detail).slice(0, 800)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...opts });
const hasCommand = (cmd) => run('sh', ['-c', `command -v ${cmd}`]).status === 0;

async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000);
  }
  throw new Error(`waitForHttp timeout: ${url} (${last})`);
}

function baseEnv(port) {
  return {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DB_HOST,
    DB_PORT: String(PG_PORT),
    DB_USERNAME: DB_USER,
    DB_PASSWORD: DB_PASS,
    DB_DATABASE: DB_NAME,
    REDIS_HOST: 'localhost',
    REDIS_PORT: String(REDIS_PORT),
    JWT_SECRET: 'qa05-cb-jwt-secret-32chars-longxxx',
    JWT_REFRESH_SECRET: 'qa05-cb-refresh-secret-32chars-xxx',
    EXECUTOR_SECRET,
    EXECUTION_CALLBACK_SECRET: EXECUTOR_SECRET,
    EXECUTOR_ALLOW_PRIVATE_NETWORK: 'true',
    INITIAL_ADMIN_USERNAME: ADMIN.username,
    INITIAL_ADMIN_PASSWORD: ADMIN.password,
    AI_PROVIDER: 'disabled',
    LOGIN_THROTTLE_LIMIT: '10000',
    THROTTLE_LIMIT: '10000',
    // 触发是 OPS 档（默认 30/min/IP）——本档要一次性触发上千任务
    THROTTLE_OPS_LIMIT: '100000',
    // 回调档默认 60/min/IP；本档要打满 10k 条/分钟（100 条/请求 ⇒ ≥100 请求）
    THROTTLE_CALLBACK_LIMIT: '100000',
  };
}

async function login() {
  const res = await fetch(`http://localhost:${API_PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`login failed → HTTP ${res.status}`);
  const body = await res.json();
  const data = body?.data ?? body;
  return data?.accessToken || data?.access_token;
}

async function api(token, method, urlPath, body) {
  const res = await fetch(`http://localhost:${API_PORT}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 空体 */
  }
  return { status: res.status, body: json?.data ?? json };
}

/** 并发受控 map（默认 50 路）。 */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 探针执行器：接受派发但永不回报（把执行钉在 RUNNING）。 */
async function startProbeExecutor() {
  const port = randPort();
  const address = `127.0.0.1:${port}`;
  const dispatched = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      dispatched.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted' }));
    });
  });
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));

  const reg = await fetch(`http://localhost:${API_PORT}/api/executors/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${EXECUTOR_SECRET}` },
    body: JSON.stringify({
      address,
      appName: 'qa05-callback-probe',
      groupName: 'default',
      tags: ['shell', 'probe'],
      description: 'QA-05 callback tier probe (accepts dispatch, never reports)',
      maxConcurrentTasks: Math.max(EXECUTIONS + 50, 200),
    }),
  });
  const regBody = await reg.json().catch(() => null);
  if (!reg.ok) {
    console.log(`  register 失败：status=${reg.status} body=${JSON.stringify(regBody)?.slice(0, 300)}`);
    await new Promise((r) => server.close(r));
    return null;
  }
  const data = regBody?.data ?? regBody;
  const execToken = data?.token || data?.executorToken || EXECUTOR_SECRET;
  console.log(`  探针执行器 ${address} 已注册（cap=${EXECUTIONS}）`);

  const heartbeat = (runningIds) =>
    fetch(`http://localhost:${API_PORT}/api/executors/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${execToken}` },
      body: JSON.stringify({
        address,
        cpuUsage: 5,
        memUsage: 5,
        runningTaskCount: runningIds.length,
        runningExecutionIds: runningIds.slice(0, 500),
        maxConcurrentTasks: Math.max(EXECUTIONS + 50, 200),
      }),
    }).catch(() => null);

  await heartbeat([]);
  return {
    address,
    dispatched,
    heartbeat,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function main() {
  console.log('══ QA-05 第四档：回调入口 10k 条/分钟（真实 execution 池）══');
  console.log(`池=${EXECUTIONS} 条目=${ITEMS} 批量=${BATCH} 并发=${CONCURRENCY}`);

  if (!hasCommand('docker')) {
    results.push({ name: '回调档验证', pass: null });
    console.log('- 回调档验证（跳过：docker 不可用）');
    return summary();
  }
  tmpDir = mkdtempSync(path.join(tmpdir(), 'acf-qa05cb-'));
  console.log(`临时目录：${tmpDir}`);

  for (const name of (run('docker', ['ps', '-a', '--filter', 'name=acf-qa05cb-', '--format', '{{.Names}}']).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean)) {
    run('docker', ['rm', '-f', name]);
  }
  if (DOCKER_MODE) {
    const pg = run('docker', [
      'run', '-d', '--name', PG_CONTAINER,
      '-e', `POSTGRES_USER=${DB_USER}`, '-e', `POSTGRES_PASSWORD=${DB_PASS}`,
      '-e', 'POSTGRES_DB=autoflow_test', '-p', `${PG_PORT}:5432`, 'postgres:16-alpine',
    ]);
    if (pg.status !== 0) throw new Error(`PG 容器启动失败: ${pg.stderr}`);
    const rd = run('docker', ['run', '-d', '--name', REDIS_CONTAINER, '-p', `${REDIS_PORT}:6379`, 'redis:7-alpine']);
    if (rd.status !== 0) throw new Error(`Redis 容器启动失败: ${rd.stderr}`);
    for (let i = 0; i < 40; i += 1) {
      if (run('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', DB_USER]).status === 0) break;
      await sleep(1000);
    }
    run('docker', ['exec', PG_CONTAINER, 'psql', '-U', DB_USER, '-d', 'postgres', '-c', `CREATE DATABASE "${DB_NAME}";`]);
  } else {
    const create = run('psql', ['-h', DB_HOST, '-p', String(PG_PORT), '-U', DB_USER, '-d', 'postgres', '-c', `CREATE DATABASE "${DB_NAME}";`], {
      env: { ...process.env, PGPASSWORD: DB_PASS },
    });
    if (create.status !== 0) throw new Error(`建库失败: ${create.stderr}`);
  }

  const build = run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: API_DIR });
  ok('admin-api 构建通过', build.status === 0, build.stderr || build.stdout);
  if (build.status !== 0) return summary();
  const migrate = run('npm', ['run', 'migration:run'], { cwd: API_DIR, env: baseEnv(API_PORT) });
  ok('空库迁移链真跑通过', migrate.status === 0, migrate.stderr || migrate.stdout);
  if (migrate.status !== 0) return summary();

  const apiLog = openSync(path.join(tmpDir, 'admin-api.log'), 'a');
  const apiChild = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: baseEnv(API_PORT),
    stdio: ['ignore', apiLog, apiLog],
    detached: true,
  });
  apiChild.unref();
  children.push(apiChild);
  await waitForHttp(`http://localhost:${API_PORT}/api/health`);
  ok('admin-api 就绪（空库迁移链真跑）', true);

  const token = await login();
  const probe = await startProbeExecutor();
  if (!probe) {
    results.push({ name: '回调档验证', pass: null });
    return summary();
  }

  // ── ① 造 N 个真实 RUNNING 执行 ──────────────────────────────────────
  const t0 = Date.now();
  const created = await mapLimit(Array.from({ length: EXECUTIONS }, (_, i) => i), 50, async (i) => {
    const t = await api(token, 'POST', '/api/tasks', {
      name: `qa05-cb-${STAMP}-${i}`,
      triggerType: 'manual',
      runtime: 'shell',
      entrypoint: 'echo cb',
    });
    return t.body?.id ?? null;
  });
  const taskIds = created.filter(Boolean);
  const executions = await mapLimit(taskIds, 50, async (taskId) => {
    const r = await api(token, 'POST', `/api/tasks/${taskId}/trigger`, {});
    return r.body?.executionId ?? r.body?.id ?? null;
  });
  const execIds = executions.filter(Boolean);
  ok(`造出 ${EXECUTIONS} 个真实执行（任务 ${taskIds.length} / execution ${execIds.length}）`,
    execIds.length === EXECUTIONS, `taskIds=${taskIds.length} execIds=${execIds.length}`);

  // 等它们全部被探针接单（RUNNING），并确认探针确实收到了派发
  const dispatchDeadline = Date.now() + 60_000;
  while (Date.now() < dispatchDeadline && probe.dispatched.length < EXECS_MIN(execIds.length)) {
    await sleep(1000);
  }
  ok(`探针执行器收到派发（${probe.dispatched.length} 次）`,
    probe.dispatched.length >= EXECS_MIN(execIds.length),
    `dispatched=${probe.dispatched.length}`);
  console.log(`  造池耗时 ${Math.round((Date.now() - t0) / 1000)}s`);

  // ── ② 按批量打回调（id 池内轮转），统计条目级吞吐 ───────────────────
  const batches = [];
  for (let sent = 0; sent < ITEMS; sent += BATCH) {
    const items = [];
    for (let k = 0; k < BATCH && sent + k < ITEMS; k += 1) {
      const execId = execIds[(sent + k) % execIds.length];
      items.push({
        executionId: execId,
        status: 'failed',
        error: 'qa05 callback tier probe',
        executorAddress: probe.address,
      });
    }
    batches.push(items);
  }

  let httpOk = 0;
  let httpFail = 0;
  let winnerOk = 0;
  let idempotentSeen = 0;
  let itemFail = 0;
  const cbStart = Date.now();
  await mapLimit(batches, CONCURRENCY, async (items) => {
    try {
      const res = await fetch(`http://localhost:${API_PORT}/api/executions/callback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${EXECUTOR_SECRET}`,
        },
        body: JSON.stringify(items),
      });
      if (!res.ok) {
        httpFail += 1;
        return;
      }
      httpOk += 1;
      const body = await res.json().catch(() => null);
      const list = body?.data?.results ?? body?.results ?? [];
      for (const r of list) {
        // 注意：admin-api 对**重复回调同样返回 success:true**（affected=0 幂等
        // 分支），所以 success 计数不能区分 winner/幂等——winner 数由 DB 侧
        // 终态执行数核对（见下），这里只统计「非 2xx/无结果」的真实失败。
        if (r?.success) winnerOk += 1;
        else {
          itemFail += 1;
          const err = String(r?.error ?? '');
          if (/terminal|already|not in|idempot/i.test(err)) idempotentSeen += 1;
        }
      }
    } catch {
      httpFail += 1;
    }
  });
  const elapsedMs = Date.now() - cbStart;
  const itemsPerMin = Math.round((ITEMS / elapsedMs) * 60_000);

  console.log('\n==== 回调档报告 ====');
  console.log(`池大小:            ${execIds.length} executions`);
  console.log(`条目总数:          ${ITEMS}`);
  console.log(`批量请求:          ${batches.length} 次 × ${BATCH} 条（并发 ${CONCURRENCY}）`);
  console.log(`总耗时:            ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(`条目吞吐:          ${itemsPerMin} 条/分钟（目标 ${TARGET_ITEMS_PER_MIN}）`);
  console.log(`HTTP 成功/失败:    ${httpOk} / ${httpFail}`);
  console.log(`条目 success:      ${winnerOk}`);
  console.log(`条目 幂等分支:     ${idempotentSeen}`);
  console.log(`条目 其他失败:     ${itemFail}`);

  ok(`回调条目吞吐 ≥ ${TARGET_ITEMS_PER_MIN}/分钟`, itemsPerMin >= TARGET_ITEMS_PER_MIN, `${itemsPerMin} 条/分钟`);
  ok('批量入口 HTTP 全成功（无 5xx/限流）', httpFail === 0, `ok=${httpOk} fail=${httpFail}`);
  ok('条目结果无失败（重复回调按幂等回 success:true）', itemFail === 0,
    `success=${winnerOk} idempotent=${idempotentSeen} itemFail=${itemFail}`);

  // ── ③ DB 侧核对 winner：真实推进终态的执行数 == 池大小，且没有重复执行行 ──
  const dbCounts = queryDb(
    `SELECT
       (SELECT count(*) FROM task_executions WHERE status = 'failed') AS failed_execs,
       (SELECT count(*) FROM task_executions) AS total_execs,
       (SELECT count(*) FROM tasks WHERE name LIKE 'qa05-cb-%') AS tasks;`,
  );
  const failedExecs = Number(dbCounts?.failed_execs ?? -1);
  const totalExecs = Number(dbCounts?.total_execs ?? -1);
  console.log(`DB 核对: failed executions=${failedExecs} / total executions=${totalExecs}`);

  ok(`真实终态 winner 数 = execution 池大小（${execIds.length}）——首条回调真的推进了终态`,
    failedExecs === execIds.length, `failed=${failedExecs} 池=${execIds.length}`);
  ok('重复回调未派生重复执行行（一个任务恰一条 execution）',
    totalExecs === execIds.length, `total=${totalExecs} 期望=${execIds.length}`);

  await probe.close();
  summary();
}

function EXECS_MIN(n) {
  // 探针派发数下限：绝大多数被接单即可（并发派发可能有极少数在途）
  return Math.max(1, Math.floor(n * 0.95));
}

/** 直接核对 PG（docker exec 或本机 psql）：DB 侧事实是终态 winner 的唯一硬证据。 */
function queryDb(sql) {
  const args = ['-t', '-A', '-F', ',', '-c', sql];
  const res = DOCKER_MODE
    ? run('docker', ['exec', PG_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, ...args])
    : run('psql', ['-h', DB_HOST, '-p', String(PG_PORT), '-U', DB_USER, '-d', DB_NAME, ...args], {
        env: { ...process.env, PGPASSWORD: DB_PASS },
      });
  if (res.status !== 0) {
    console.log(`  DB 查询失败: ${res.stderr?.slice(0, 200)}`);
    return null;
  }
  const [failed_execs, total_execs, tasks] = String(res.stdout).trim().split(/[,\n]/);
  return { failed_execs, total_execs, tasks };
}

function summary() {
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;
  console.log(`\n══ 汇总：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ══`);
  process.exitCode = failed > 0 ? 1 : 0;
}

function cleanup() {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      try {
        c.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
  run('sleep', ['3']);
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  run('docker', ['rm', '-f', PG_CONTAINER, REDIS_CONTAINER]);
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

main().catch((e) => {
  console.error(`✘ 验证脚本异常：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
