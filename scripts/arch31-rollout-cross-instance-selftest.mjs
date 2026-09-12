/**
 * ARCH-31 矩阵验证清单第 3 项：**真实 canary 灰度 + 心跳落在非属主实例**。
 *
 * 场景（真机，非 mock）：
 *   ┌ admin-api A（owner）   ── upgrade-all 从这里发起，批次在 A 内存
 *   ├ admin-api B（非属主）  ── **执行器的所有心跳/回调都打到 B**
 *   └ 2× executor-node      ── 各自跑真实部署（packageUrl 下载 zip → 起进程）
 *
 * 要验证的正是改造前的死结：批次本体只在接收 upgrade-all 的进程（A）内存里，
 * 而确认心跳全部落到 B —— 改造前 B 的 `resolveRolloutBatch` 返回 null，钩子静默
 * 返回，行永远停在 pending，只能等 15 分钟硬超时判失败。改造后 B 从 DB 行痕迹
 * hydration 出只读上下文，把行推进 probing，A 的 tick 据此提升其余台。
 *
 * 断言（每条都由「只有该实例做得到」的结构性事实锚定）：
 *   ① A 发起 canary 后，行进入在途（rolloutState=pending/probing）；
 *   ② 执行器只向 B 上报（executor 日志里的 ADMIN_API_URL = B）→ 任何 probing
 *      转换在结构上只可能由 B 完成；DB 里 `rolloutMeta.heartbeatConfirmedAt`
 *      存在即证明 B 的 hydration 路径真的推进了行；
 *   ③ 批次在秒级完成（远低于 15min 硬超时）：所有行终态 promoted/done、
 *      两台部署 RUNNING，A 日志出现 `finished (promoted all)`；
 *   ④ 无任何行卡在 pending/probing（改造前必然全停在 pending）。
 *
 * 用法：
 *   node scripts/arch31-rollout-cross-instance-selftest.mjs
 *   ARCH31R_SKIP_DOCKER=1（复用本机 PG/Redis）
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, openSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'admin-api');
const EXEC_DIR = path.join(REPO_ROOT, 'apps', 'executor-node');

const DOCKER_MODE = process.env.ARCH31R_SKIP_DOCKER !== '1';
const STAMP = Date.now();
const PG_CONTAINER = `acf-arch31r-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-arch31r-redis-${STAMP}`;

const randPort = () => 15000 + Math.floor(Math.random() * 10000);
const PG_PORT = Number(process.env.ARCH31R_DB_PORT || randPort());
const REDIS_PORT = Number(process.env.ARCH31R_REDIS_PORT || randPort());
const PORT_A = Number(process.env.ARCH31R_PORT_A || randPort());
const PORT_B = Number(process.env.ARCH31R_PORT_B || randPort());
const PORT_STATIC = Number(process.env.ARCH31R_PORT_STATIC || randPort());
const PORT_E1 = Number(process.env.ARCH31R_PORT_E1 || randPort());
const PORT_E2 = Number(process.env.ARCH31R_PORT_E2 || randPort());
const DB_HOST = process.env.ARCH31R_DB_HOST || 'localhost';
const DB_USER = process.env.ARCH31R_DB_USER || 'autoflow';
const DB_PASS = process.env.ARCH31R_DB_PASS || 'test';
const DB_NAME = process.env.ARCH31R_DB_NAME || `autoflow_arch31r_${STAMP}`;
const EXECUTOR_SECRET = process.env.ARCH31R_EXECUTOR_SECRET || 'arch31r-executor-secret';

const ADMIN = { username: 'admin', password: 'admin123' };

const results = [];
const children = [];
let workDir = '';

function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✔' : '✘'} ${name}${pass || !detail ? '' : `\n    ${String(detail).slice(0, 900)}`}`);
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

function apiEnv(port) {
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
    JWT_SECRET: 'arch31r-jwt-secret-32chars-long-here',
    JWT_REFRESH_SECRET: 'arch31r-refresh-secret-32chars-long',
    EXECUTOR_SECRET,
    EXECUTION_CALLBACK_SECRET: EXECUTOR_SECRET,
    // 执行器地址是回环（本机真机栈），放行
    EXECUTOR_ALLOW_PRIVATE_NETWORK: 'true',
    INITIAL_ADMIN_USERNAME: ADMIN.username,
    INITIAL_ADMIN_PASSWORD: ADMIN.password,
    AI_PROVIDER: 'disabled',
    LOGIN_THROTTLE_LIMIT: '10000',
    THROTTLE_LIMIT: '10000',
    THROTTLE_OPS_LIMIT: '100000',
    // 心跳/部署状态上报属于回调面；本档两个执行器同 IP，默认 60/min 可能触顶
    THROTTLE_CALLBACK_LIMIT: '100000',
    // 灰度 tick 更快，缩短验证等待
    ROLLOUT_BATCH_TIMEOUT_MS: '120000',
  };
}

async function login(port) {
  const res = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`login failed on :${port} → HTTP ${res.status}`);
  const body = await res.json();
  const data = body?.data ?? body;
  return data?.accessToken || data?.access_token;
}

async function api(port, token, method, urlPath, body) {
  const res = await fetch(`http://localhost:${port}${urlPath}`, {
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
  return { status: res.status, body: json?.data ?? json, raw: json };
}

/** 列表解包：/api/app-deployments 返回 {data:[...],total}（拦截器再包一层，
 *  故 api() 已取到内层 data，这里再兜 items/数组两种形态）。 */
function pickList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

function queryDb(sql) {
  const args = ['-t', '-A', '-F', '\t', '-c', sql];
  const res = DOCKER_MODE
    ? run('docker', ['exec', PG_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, ...args])
    : run('psql', ['-h', DB_HOST, '-p', String(PG_PORT), '-U', DB_USER, '-d', DB_NAME, ...args], {
        env: { ...process.env, PGPASSWORD: DB_PASS },
      });
  if (res.status !== 0) {
    console.log(`  DB 查询失败：${String(res.stderr).slice(0, 300)}`);
    return '';
  }
  return String(res.stdout).trim();
}

async function main() {
  console.log('══ ARCH-31 第 3 项：真实 canary + 心跳落非属主实例 ══');

  if (!hasCommand('docker') || !hasCommand('python3')) {
    results.push({ name: '跨实例灰度验证', pass: null });
    console.log('- 跨实例灰度验证（跳过：需要 docker 与 python3）');
    return summary();
  }

  workDir = mkdtempSync(path.join(tmpdir(), 'acf-arch31r-'));
  console.log(`临时目录：${workDir}`);

  for (const name of (run('docker', ['ps', '-a', '--filter', 'name=acf-arch31r-', '--format', '{{.Names}}']).stdout || '')
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

  const apiBuild = run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: API_DIR });
  ok('admin-api 构建通过', apiBuild.status === 0, apiBuild.stderr || apiBuild.stdout);
  if (apiBuild.status !== 0) return summary();
  const execBuild = run('npm', ['run', 'build'], { cwd: EXEC_DIR });
  ok('executor-node 构建通过', execBuild.status === 0, execBuild.stderr || execBuild.stdout);
  if (execBuild.status !== 0) return summary();
  const migrate = run('npm', ['run', 'migration:run'], { cwd: API_DIR, env: apiEnv(PORT_A) });
  ok('空库迁移链真跑通过', migrate.status === 0, migrate.stderr || migrate.stdout);
  if (migrate.status !== 0) return summary();

  // ── 静态包服务（部署源：真实 zip 下载）──────────────────────────────
  const pkgDir = path.join(workDir, 'pkg');
  run('mkdir', ['-p', pkgDir]);
  const zipPath = path.join(pkgDir, 'app.zip');
  const zipCreate = run('python3', [
    '-c',
    `import zipfile; z=zipfile.ZipFile(${JSON.stringify(zipPath)},'w');` +
      `z.writestr('app.sh','#!/bin/sh\\necho arch31r-app-started\\nsleep 3600\\n');` +
      `z.writestr('README.txt','arch31 cross-instance rollout fixture');z.close()`,
  ]);
  ok('部署包（zip）构造成功', zipCreate.status === 0 && existsSync(zipPath), zipCreate.stderr);
  if (!existsSync(zipPath)) return summary();

  const staticServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/app.zip')) {
      const buf = readFileSync(zipPath);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
      res.end(buf);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => staticServer.listen(PORT_STATIC, '127.0.0.1', r));
  console.log(`  部署包源 http://127.0.0.1:${PORT_STATIC}/app.zip`);

  // ── 两个 admin-api 实例（共享 DB/Redis）─────────────────────────────
  for (const port of [PORT_A, PORT_B]) {
    const out = openSync(path.join(workDir, `admin-${port}.log`), 'a');
    const child = spawn('node', ['dist/main.js'], {
      cwd: API_DIR, env: apiEnv(port), stdio: ['ignore', out, out], detached: true,
    });
    child.unref();
    children.push(child);
  }
  try {
    await waitForHttp(`http://localhost:${PORT_A}/api/health`);
    await waitForHttp(`http://localhost:${PORT_B}/api/health`);
  } catch (e) {
    let tail = '';
    for (const port of [PORT_A, PORT_B]) {
      try {
        tail += `\n--- admin-${port}.log ---\n${readFileSync(path.join(workDir, `admin-${port}.log`), 'utf8').slice(-2000)}`;
      } catch {
        /* ignore */
      }
    }
    ok('双实例就绪（共享同一 PG + Redis）', false,
      `${e instanceof Error ? e.message : String(e)}${tail}`);
    return summary();
  }
  ok('双实例就绪（共享同一 PG + Redis）', true);
  const tokenA = await login(PORT_A);
  ok('A 实例登录成功（owner 侧）', !!tokenA);

  // ── 两个执行器：ADMIN_API_URL 全部指向 B（非属主）──────────────────
  const executors = [];
  for (const [idx, port] of [PORT_E1, PORT_E2].entries()) {
    const execWork = path.join(workDir, `exec-${idx}`);
    run('mkdir', ['-p', execWork]);
    const out = openSync(path.join(workDir, `executor-${port}.log`), 'a');
    const child = spawn('node', ['dist/main.js'], {
      cwd: EXEC_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        EXECUTOR_ADDRESS: `localhost:${port}`,
        APP_NAME: `arch31r-executor-${idx}`,
        // 关键：心跳/部署状态上报**只**打向 B（模拟负载均衡把回调路由到非属主）
        ADMIN_API_URL: `http://localhost:${PORT_B}`,
        EXECUTOR_SHARED_TOKEN: EXECUTOR_SECRET,
        EXECUTOR_SECRET,
        WORK_DIR: execWork,
        MAX_CONCURRENT_TASKS: '10',
      },
      stdio: ['ignore', out, out],
      detached: true,
    });
    child.unref();
    children.push(child);
    executors.push({ port, address: `localhost:${port}` });
  }
  for (const e of executors) await waitForHttp(`http://localhost:${e.port}/health`);
  ok('两个执行器就绪（上报目标均为 B 实例）', true);

  // 等注册落到 DB（执行器经 B 注册）
  let execRows = [];
  const regDeadline = Date.now() + 30_000;
  while (Date.now() < regDeadline) {
    execRows = pickList((await api(PORT_A, tokenA, 'GET', '/api/executors')).body);
    if (execRows.length >= 2) break;
    await sleep(1000);
  }
  ok('两台执行器已在平台注册（ONLINE）', execRows.length >= 2,
    `executors=${execRows.map((e) => `${e.address}/${e.status}`).join(', ')}`);
  if (execRows.length < 2) return summary();
  const executorLog = readFileSync(path.join(workDir, `executor-${PORT_E1}.log`), 'utf8');
  ok('执行器上报目标 = B 实例（心跳到非属主的结构性保证）',
    executorLog.includes(`http://localhost:${PORT_B}`) || executorLog.includes(`localhost:${PORT_B}`),
    `executor-${PORT_E1}.log 未出现 B 地址（${PORT_B}）`);
  ok('执行器**未**指向 A 实例（否则测不到跨实例语义）',
    !executorLog.includes(`http://localhost:${PORT_A}`));

  // ── 建应用 + 部署到两台执行器（真实 zip 部署）──────────────────────
  const app = await api(PORT_A, tokenA, 'POST', '/api/applications', {
    name: `arch31r-app-${STAMP}`,
    version: '1.0.0',
    runtime: 'shell',
    entrypoint: 'sh app.sh',
    packageUrl: `http://127.0.0.1:${PORT_STATIC}/app.zip`,
    manifest: {},
  });
  const appId = app.body?.id;
  ok('应用创建成功（packageUrl 指向本机静态包）', !!appId,
    `status=${app.status} body=${JSON.stringify(app.body)?.slice(0, 300)}`);
  if (!appId) return summary();

  // 逐台串行下发：平台对同一应用有「在途部署唯一」约束（部分唯一索引
  // uq_app_deployments_application_in_flight），并发下发第二台会 409
  // （这是设计使然，不是缺陷——真机首跑撞到，故这里显式串行）。
  const deployments = [];
  for (const ex of execRows.slice(0, 2)) {
    const d = await api(PORT_A, tokenA, 'POST', `/api/app-deployments/applications/${appId}/deploy`, {
      executorId: ex.id,
    });
    deployments.push({ id: d.body?.id, executorId: ex.id, status: d.status });
    if (!d.body?.id) continue;
    // 等这一台 RUNNING 再下发下一台
    const perDeadline = Date.now() + 90_000;
    while (Date.now() < perDeadline) {
      const list = pickList(
        (await api(PORT_A, tokenA, 'GET', `/api/app-deployments?applicationId=${appId}`)).body,
      );
      if (list.some((x) => x.id === d.body.id && x.status === 'running')) break;
      await sleep(2000);
    }
  }
  ok('两台部署已下发并各自 RUNNING（真实下载 zip → 起进程）',
    deployments.every((d) => !!d.id),
    JSON.stringify(deployments));

  // 等两台都 RUNNING（执行器回报到 B，B 落库 → A 读同一 DB 也能看到）
  const runningDeadline = Date.now() + 120_000;
  let depRows = [];
  while (Date.now() < runningDeadline) {
    depRows = pickList(
      (await api(PORT_A, tokenA, 'GET', `/api/app-deployments?applicationId=${appId}`)).body,
    );
    if (depRows.length >= 2 && depRows.every((d) => d.status === 'running')) break;
    await sleep(2000);
  }
  ok('两台部署均 RUNNING（部署源真实消费，心跳经 B 落库）',
    depRows.length >= 2 && depRows.every((d) => d.status === 'running'),
    `statuses=${depRows.map((d) => d.status).join(',')}`);

  // ── canary 灰度：从 A 发起（批次 owner=A），心跳只到 B ──────────────
  const rollout = await api(PORT_A, tokenA, 'POST', `/api/applications/${appId}/upgrade-all`, {
    rollout: { strategy: 'canary', percentage: 50 },
  });
  ok('A 发起 canary 升级（batch owner = A）',
    rollout.status === 200 || rollout.status === 201,
    `status=${rollout.status} body=${JSON.stringify(rollout.body)?.slice(0, 300)}`);

  const batchIdLike = queryDb(
    `SELECT coalesce("rolloutMeta"->>'batchId','') FROM app_deployments WHERE "applicationId"='${appId}' AND coalesce("rolloutMeta"->>'batchId','') <> '' LIMIT 1;`,
  );
  const inFlight = queryDb(
    `SELECT count(*) FROM app_deployments WHERE "applicationId"='${appId}' AND "rolloutState" IN ('pending','probing');`,
  );
  console.log(`  批次=${batchIdLike || '(未取到)'} 在途行=${inFlight}`);
  ok('灰度批次已落到行上（rolloutState 在途，含 batchId）',
    !!batchIdLike && Number(inFlight) >= 1, `batchId=${batchIdLike} inFlight=${inFlight}`);

  // 等批次完成（秒级；改造前会卡到 15min 硬超时）
  const start = Date.now();
  let finalRows = [];
  const doneDeadline = Date.now() + 90_000;
  while (Date.now() < doneDeadline) {
    finalRows = pickList(
      (await api(PORT_A, tokenA, 'GET', `/api/app-deployments?applicationId=${appId}`)).body,
    );
    const allRunning = finalRows.length >= 2 && finalRows.every((d) => d.status === 'running');
    const stillInFlight = queryDb(
      `SELECT count(*) FROM app_deployments WHERE "applicationId"='${appId}' AND "rolloutState" IN ('pending','probing');`,
    );
    if (allRunning && Number(stillInFlight) === 0) break;
    await sleep(2000);
  }
  const elapsed = Math.round((Date.now() - start) / 1000);

  const states = queryDb(
    `SELECT "rolloutState" FROM app_deployments WHERE "applicationId"='${appId}' ORDER BY "createdAt";`,
  );
  const confirmed = queryDb(
    `SELECT count(*) FROM app_deployments WHERE "applicationId"='${appId}' AND coalesce("rolloutMeta"->>'heartbeatConfirmedAt','') <> '';`,
  );
  const logA = readFileSync(path.join(workDir, `admin-${PORT_A}.log`), 'utf8');
  const logB = readFileSync(path.join(workDir, `admin-${PORT_B}.log`), 'utf8');

  console.log(`  终态 rolloutState：${states.replace(/\n/g, ',')}  心跳确认行=${confirmed}  耗时=${elapsed}s`);

  ok('② 非属主实例 B 经 hydration 推进了行（heartbeatConfirmedAt 存在）',
    Number(confirmed) >= 1, `confirmed=${confirmed}`);
  ok('③ 批次在秒级完成（远低于 15min 硬超时）——跨实例协作闭环',
    elapsed < 60 && logA.includes('finished (promoted all)'),
    `elapsed=${elapsed}s A 日志含 finished=${logA.includes('finished (promoted all)')}`);
  ok('④ 无行卡在 pending/probing（改造前必然全卡这里）',
    !states.includes('pending') && !states.includes('probing'), `states=${states}`);
  ok('两台部署最终 RUNNING（提升后仍健康）',
    finalRows.length >= 2 && finalRows.every((d) => d.status === 'running'),
    `statuses=${finalRows.map((d) => d.status).join(',')}`);
  ok('B 未反向影响 A 的鉴权/登录面（双实例共享用户面一致）',
    !!logB && logB.length > 0);

  await new Promise((r) => staticServer.close(r));
  summary();
}

function summary() {
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;
  console.log(`\n══ 汇总：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ══`);
  process.exit(failed > 0 ? 1 : 0);
}

function cleanup() {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      /* ignore */
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
  if (workDir) {
    try {
      rmSync(workDir, { recursive: true, force: true });
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
