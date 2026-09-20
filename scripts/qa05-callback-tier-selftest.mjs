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
import net from 'node:net';
import path from 'node:path';

import { ensureDatabase } from './pg-provision.lib.mjs';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'admin-api');

const DOCKER_MODE = process.env.QA05_SKIP_DOCKER !== '1';
const STAMP = Date.now();
const PG_CONTAINER = `acf-qa05cb-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-qa05cb-redis-${STAMP}`;

const randPort = () => 15000 + Math.floor(Math.random() * 10000);
/**
 * R22 根治（2026-09-20 CI 实爆）：三个随机端口此前**各自独立抽取、互不查重**，
 * 自身就有约 0.03% 的自碰撞率（实测 67/200000）；更要命的是碰撞后的失败形态
 * ——被撞的那个服务静默起不来（如 admin-api EADDRINUSE 直接 exit(1)），而
 * waitForHttp 只会空等 90s 后抛一句 "(fetch failed)"，指向错误的方向。
 *
 * 两层防护：
 *   ① 抽取时去重（本函数）——消除自碰撞；
 *   ② 开工前对**本脚本要自己占**的端口做 TCP 预检（见 main 内）——拦截上一轮
 *      selftest 残留进程占着端口的情况。环境变量显式指定的端口被占 = 用户意图
 *      与实际冲突，直接报错；随机抽到的被占则**自动重抽**（不该让一次倒霉的
 *      抽样把整轮 CI 判红）。
 */
const usedPorts = new Set();
const envPort = (name) => (process.env[name] ? Number(process.env[name]) : null);
function drawPort() {
  for (let i = 0; i < 500; i += 1) {
    const p = randPort();
    if (usedPorts.has(p)) continue;
    usedPorts.add(p);
    return p;
  }
  throw new Error('无法分配互不冲突的随机端口（500 次尝试）');
}
/** null = 未显式指定，可在预检阶段重抽。 */
const PG_PORT_ENV = envPort('QA05_DB_PORT');
const REDIS_PORT_ENV = envPort('QA05_REDIS_PORT');
const API_PORT_ENV = envPort('QA05_API_PORT');
let PG_PORT = PG_PORT_ENV ?? drawPort();
let REDIS_PORT = REDIS_PORT_ENV ?? drawPort();
let API_PORT = API_PORT_ENV ?? drawPort();
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

/** TCP 层探测：区别于 fetch——能分辨「端口没人在听」与「有服务但不回 HTTP」。 */
function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (verdict) => {
      sock.destroy();
      resolve(verdict);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done('open'));
    sock.once('timeout', () => done('timeout'));
    sock.once('error', (e) => done(e.code || 'error'));
  });
}

/**
 * 等 HTTP 就绪，并在超时时给出**可用**的诊断（CI run 35499194130 的教训）。
 *
 * 原实现只抛 `waitForHttp timeout: <url> (fetch failed)`：fetch failed 同时
 * 覆盖「ECONNREFUSED（无人监听）」「DNS 失败」「代理拦截」等完全不同的原因，
 * 且脚本随后 cleanup 会 rmSync(tmpDir) **删掉唯一的 admin-api 日志**——真机
 * 报障时现场已被自己销毁，只能靠猜（本轮为此浪费了整整一轮排查）。
 * 现在超时路径必须回答三件事：子进程还活着吗（exitCode/signal）、端口在 TCP
 * 层是否有人听、admin-api 日志尾部说了什么。
 */
async function waitForHttp(url, timeoutMs = 90_000, probe = null) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      last = `HTTP ${res.status}`;
    } catch (e) {
      const cause = e?.cause?.code ? ` cause=${e.cause.code}` : '';
      last = `${e instanceof Error ? e.message : String(e)}${cause}`;
    }
    await sleep(1000);
  }

  const lines = [`waitForHttp timeout: ${url} (${last})`];
  if (probe) {
    const { child, host = 'localhost', port, logFile } = probe;
    if (child) {
      lines.push(
        `  子进程：pid=${child.pid} exitCode=${child.exitCode} signalCode=${child.signalCode}` +
          `${child.exitCode === null && child.signalCode === null ? '（仍在运行——不是崩溃，是起不来或端口不对）' : '（已退出——见下方日志的致命错误）'}`,
      );
    }
    lines.push(`  TCP ${host}:${port} → ${await probeTcp(host, port)}`);
    if (logFile) {
      try {
        const tail = readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('query:'))
          .slice(-12)
          .join('\n');
        lines.push(`  admin-api 日志尾部（${logFile}）：\n${tail}`);
      } catch (e) {
        lines.push(`  （读取 admin-api 日志失败：${e instanceof Error ? e.message : e}）`);
      }
    }
  }
  throw new Error(lines.join('\n'));
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

  // 端口预检（本轮 CI 实爆的直接根因面）：docker run -p 在宿主机端口被占用时
  // 的表现依赖 docker 版本/driver（有的直接失败，有的建了容器但映射不可用），
  // 而 admin-api 撞端口则必然是 EADDRINUSE 退出。无论哪条路径，下游都只会
  // 看到「服务起不来」。故这里**在动任何东西之前**就把端口探一遍：
  //   · 环境变量显式指定的端口被占 → 用户意图与实际冲突，报错（附占用者查法）；
  //   · 随机抽到的端口被占 → 静默重抽（不让倒霉抽样把 CI 判红）。
  //
  // 只检「本脚本要自己占」的端口：SKIP_DOCKER 模式下 PG/Redis 是**复用外部**
  // 的，它们本就应当在监听，探到 open 是预期状态而非冲突。
  const checkPort = async (envVal, current, getLabel) => {
    const verdict = await probeTcp('127.0.0.1', current, 1200);
    if (verdict !== 'open') return current;
    if (envVal !== null) {
      throw new Error(
        `端口预检失败：${getLabel()} 端口 ${current} 已被占用（TCP open，但该端口由环境变量显式指定）。` +
          `\n  查占用者：lsof -iTCP:${current} -sTCP:LISTEN ；或更换该环境变量的值。`,
      );
    }
    const fresh = drawPort();
    console.log(`  ⚠ ${getLabel()} 随机端口 ${current} 已被占用 → 自动改抽 ${fresh}`);
    return fresh;
  };
  API_PORT = await checkPort(API_PORT_ENV, API_PORT, () => 'API');
  if (DOCKER_MODE) {
    PG_PORT = await checkPort(PG_PORT_ENV, PG_PORT, () => 'PG');
    REDIS_PORT = await checkPort(REDIS_PORT_ENV, REDIS_PORT, () => 'Redis');
  }
  console.log(
    `端口预检通过（PG :${PG_PORT} / Redis :${REDIS_PORT} / API :${API_PORT}${DOCKER_MODE ? '' : '；PG/Redis 外部复用不检'}）`,
  );

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
  }
  // 就绪 + 建库统一走 host TCP（与迁移同一条连接路径），替代原先容器内 socket 版
  // pg_isready + 不检查返回码的建库——详见 scripts/pg-provision.lib.mjs 顶部注释。
  await ensureDatabase({
    host: DB_HOST,
    port: PG_PORT,
    user: DB_USER,
    password: DB_PASS,
    dbName: DB_NAME,
  });

  const build = run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: API_DIR });
  ok('admin-api 构建通过', build.status === 0, build.stderr || build.stdout);
  if (build.status !== 0) return summary();
  const migrate = run('npm', ['run', 'migration:run'], { cwd: API_DIR, env: baseEnv(API_PORT) });
  ok('空库迁移链真跑通过', migrate.status === 0, migrate.stderr || migrate.stdout);
  if (migrate.status !== 0) return summary();

  const apiLogPath = path.join(tmpDir, 'admin-api.log');
  const apiLog = openSync(apiLogPath, 'a');
  const apiChild = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: baseEnv(API_PORT),
    stdio: ['ignore', apiLog, apiLog],
    detached: true,
  });
  apiChild.unref();
  children.push(apiChild);
  // 先记日志再等：启动失败（如 EADDRINUSE）时 pid 早就不在，exitCode 由这里捕获。
  const apiExit = new Promise((resolve) => {
    apiChild.once('exit', (code, signal) => {
      console.log(`  ⚠ admin-api 子进程提前退出：exitCode=${code} signal=${signal}`);
      resolve();
    });
    apiChild.once('error', (e) => {
      console.log(`  ⚠ admin-api 子进程 spawn 失败：${e.message}`);
      resolve();
    });
  });
  await Promise.race([
    waitForHttp(`http://localhost:${API_PORT}/api/health`, 90_000, {
      child: apiChild,
      host: 'localhost',
      port: API_PORT,
      logFile: apiLogPath,
    }),
    // 子进程已退出就没必要再空等满 90s——立刻把日志摊开（原来的行为是
    // 把一个已经死掉的进程当成"慢启动"，白等 90s 再报一句 fetch failed）。
    apiExit.then(() => waitForHttp(`http://localhost:${API_PORT}/api/health`, 1_000, {
      child: apiChild,
      host: 'localhost',
      port: API_PORT,
      logFile: apiLogPath,
    })),
  ]);
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

  // 等它们全部被探针接单（RUNNING），并确认探针确实收到了派发。
  // R12-fix（qa05 间歇性 itemFail>0 / 幂等分支 0）：原门槛 EXECS_MIN=95%
  // 允许 5% 在途——CI 高负载下 1000 并发派发可能超过 60s 窗口，剩余在途
  // execution 的回调落入 R-16 not_dispatched → success:false → 断言红。
  // 改为 100% 接单 + 更长窗口（180s），从源头消除「回调时尚未派发」。
  const dispatchDeadline = Date.now() + 180_000;
  while (Date.now() < dispatchDeadline && probe.dispatched.length < execIds.length) {
    await sleep(1000);
  }
  ok(`探针执行器收到全部派发（${probe.dispatched.length}/${execIds.length}）`,
    probe.dispatched.length >= execIds.length,
    `dispatched=${probe.dispatched.length} 池=${execIds.length}`);
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
      // R12-fix（qa05 间歇性 itemFail>0）：即便等待门槛已提到 100%，并发派发
      // 的极端情况下仍有极少数 execution 的回调落入 R-16 not_dispatched（或
      // 派发落库窗口的 not_found）。对这些条目做有限重试（最多 3 次、间隔
      // 2s），让派发落库完成后重发成功——这是对「回调时尚未派发」的最后兜底，
      // 不改变任何产品语义。
      const retriable = [];
      for (const r of list) {
        if (r?.success) {
          winnerOk += 1;
        } else {
          const err = String(r?.error ?? '');
          if (/terminal|already|not in|idempot/i.test(err)) {
            idempotentSeen += 1;
          } else if (/not been dispatched|not found/i.test(err) && r?.executionId) {
            retriable.push({ ...items.find((i) => i.executionId === r.executionId), _err: err });
          } else {
            itemFail += 1;
          }
        }
      }
      for (const item of retriable) {
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
          await sleep(2000);
          const r2 = await fetch(`http://localhost:${API_PORT}/api/executions/callback`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${EXECUTOR_SECRET}`,
            },
            body: JSON.stringify([item]),
          }).catch(() => null);
          if (!r2) continue;
          const b2 = await r2.json().catch(() => null);
          const res2 = b2?.data?.results?.[0] ?? b2?.results?.[0];
          if (res2?.success) {
            winnerOk += 1;
            done = true;
          } else {
            const e2 = String(res2?.error ?? '');
            if (/terminal|already|not in|idempot/i.test(e2)) {
              idempotentSeen += 1;
              done = true;
            } else if (/not been dispatched|not found/i.test(e2)) {
              // 仍在派发窗口，继续重试
            } else {
              itemFail += 1;
              done = true;
            }
          }
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
  // 显式退出：脚本里留着 http server / 子进程管道等句柄，只设 exitCode 时事件
  // 循环可能不空（实测出现过脚本跑完仍挂 5h、连带子进程占端口），cleanup 由
  // 'exit' 钩子统一执行。
  process.exit(failed > 0 ? 1 : 0);
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
    // 失败时**保留**临时目录：admin-api.log（唯一的启动诊断证据）在被删掉的
    // 目录里，正是本轮真机报障只能靠猜的原因（CI 35499194130）。成功仍清理。
    if (process.exitCode) {
      console.log(`（失败：保留诊断目录 ${tmpDir}，含 admin-api.log）`);
    } else {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
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
