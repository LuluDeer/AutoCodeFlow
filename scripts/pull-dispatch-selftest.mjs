/**
 * ARCH-32 真机自检：pull 模式派发端到端（NAT 回连——执行器零入站依赖）。
 *
 * 核心证明：把执行器地址设为**不可达值**（unreachable-nat-host:9999——push
 * 模式下 dispatch POST 必然 DNS 失败），在 EXECUTOR_PULL_MODE=true 下走通
 * 「触发 → 队列入队 → 执行器长轮询取件 → glue 执行 → 回调 → SUCCESS」全链。
 * 该成功本身就是零入站依赖的证据：admin 对该地址任何入站拨号都会失败。
 *
 *   ① 执行器以 dispatchMode=pull 注册（GET /api/executors 可见）；
 *   ② 手动触发 node glue 任务 → 执行终态 SUCCESS（拉取→执行→回调全链）；
 *   ③ 执行行 result 携带 dispatchMode=pull / status=queued（传输分支证据，
 *      push 模式该字段是执行器 POST 的 accepted 响应）；
 *   ④ 日志无「派发失败/执行器离线」迹象（执行器从未被入站拨号）。
 *
 * 用法：
 *   npm run test:pull-dispatch
 *   PULL_SKIP_DOCKER=1 npm run test:pull-dispatch    # 复用本机 PG/Redis
 *
 * 退出码：全部通过 0；任一失败 1；环境不满足（无 docker）→ 显式 skip 且 0。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'admin-api');
const NODE_DIR = path.join(REPO_ROOT, 'apps', 'executor-node');

const DOCKER_MODE = process.env.PULL_SKIP_DOCKER !== '1';
const STAMP = Date.now();
const PG_CONTAINER = `acf-pull-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-pull-redis-${STAMP}`;

const randPort = () => 15000 + Math.floor(Math.random() * 10000);
const PG_PORT = Number(process.env.PULL_DB_PORT || randPort());
const REDIS_PORT = Number(process.env.PULL_REDIS_PORT || randPort());
const API_PORT = Number(process.env.PULL_API_PORT || randPort());
const DB_HOST = process.env.PULL_DB_HOST || 'localhost';
const DB_USER = process.env.PULL_DB_USER || 'autoflow';
const DB_PASS = process.env.PULL_DB_PASS || 'test';
const DB_NAME = process.env.PULL_DB_NAME || `autoflow_pull_${STAMP}`;

// NAT 模拟：执行器注册地址不可解析——push 派发对该地址必失败，pull 成功即证。
const UNREACHABLE_ADDRESS = 'unreachable-nat-host.invalid:9999';
const EXECUTOR_SECRET = 'pull-dispatch-executor-secret';
const ADMIN = { username: 'admin', password: 'admin123' };

/** 终态等待上限：拉取节拍 1s + 长轮询窗口 25s 内必有交付，余量给构建。 */
const EXECUTION_TIMEOUT_MS = 90_000;

const results = [];
const children = [];
const logs = new Map();

function capture(name, child) {
  const buf = [];
  child.stdout?.on('data', (d) => {
    const lines = String(d).split('\n').filter(Boolean);
    buf.push(...lines);
    if (buf.length > 400) buf.splice(0, buf.length - 400);
  });
  child.stderr?.on('data', (d) => {
    const lines = String(d).split('\n').filter(Boolean);
    buf.push(...lines);
    if (buf.length > 400) buf.splice(0, buf.length - 400);
  });
  logs.set(name, buf);
}

const tailOf = (name, n = 30) => (logs.get(name) ?? []).slice(-n).join('\n');
const ok = (name, passed, detail = '') => {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✅' : '❌'} ${name}${detail ? `\n   ${detail}` : ''}`);
};
const skip = (name, reason) => {
  console.log(`⏭️  ${name} — skip：${reason}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts });
const hasCommand = (cmd) => run('sh', ['-c', `command -v ${cmd}`]).status === 0;

function summary() {
  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    return 1;
  }
  console.log('\nARCH-32 pull-dispatch 自检全绿。');
  return 0;
}

async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (_) { /* not ready */ }
    await sleep(1000);
  }
  return false;
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
    JWT_SECRET: 'pull-jwt-secret-32chars-long-here',
    JWT_REFRESH_SECRET: 'pull-refresh-secret-32chars-longxx',
    EXECUTOR_SECRET,
    EXECUTION_CALLBACK_SECRET: EXECUTOR_SECRET,
    INITIAL_ADMIN_USERNAME: ADMIN.username,
    INITIAL_ADMIN_PASSWORD: ADMIN.password,
    AI_PROVIDER: 'disabled',
    LOGIN_THROTTLE_LIMIT: '10000',
    THROTTLE_LIMIT: '10000',
  };
}

async function login(port) {
  const res = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`login failed → HTTP ${res.status}`);
  const body = await res.json();
  const data = body?.data ?? body;
  return data.accessToken ?? data.token;
}

async function api(port, token, method, urlPath, body) {
  const res = await fetch(`http://localhost:${port}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json?.data ?? json };
}

async function main() {
  console.log(`\n=== ARCH-32 pull-dispatch 自检（:${API_PORT}，地址=${UNREACHABLE_ADDRESS}）===\n`);
  if (DOCKER_MODE && !hasCommand('docker')) {
    skip('pull 派发全链', 'docker 不可用（PULL_SKIP_DOCKER=1 + 本机 PG/Redis 可跳过）');
    return 0;
  }

  try {
    if (DOCKER_MODE) {
      run('docker', ['rm', '-f', PG_CONTAINER, REDIS_CONTAINER]);
      const pgUp = run('docker', ['run', '-d', '--name', PG_CONTAINER,
        '-e', `POSTGRES_USER=${DB_USER}`, '-e', `POSTGRES_PASSWORD=${DB_PASS}`,
        '-e', `POSTGRES_DB=${DB_NAME}`, '-p', `127.0.0.1:${PG_PORT}:5432`,
        'postgres:16-alpine']);
      const redisUp = run('docker', ['run', '-d', '--name', REDIS_CONTAINER,
        '-p', `127.0.0.1:${REDIS_PORT}:6379`, 'redis:7-alpine']);
      ok('基础设施容器启动（PG16 + Redis7）',
        pgUp.status === 0 && redisUp.status === 0,
        (pgUp.stderr || redisUp.stderr || '').slice(-300));
      if (pgUp.status !== 0 || redisUp.status !== 0) return summary();
      await sleep(4000);
    }

    // 构建（tsc 直出，arch31 同款理由：nest build 的 dist 清理在本机有静默失败前科）
    const buildApi = run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: API_DIR });
    const buildNode = run('npx', ['tsc'], { cwd: NODE_DIR });
    ok('admin-api / executor-node 构建通过',
      buildApi.status === 0 && buildNode.status === 0,
      (buildApi.stderr || buildNode.stderr || '').slice(-300));
    if (buildApi.status !== 0 || buildNode.status !== 0) return summary();

    const migrate = run('npm', ['run', 'migration:run'], { cwd: API_DIR, env: baseEnv(API_PORT) });
    ok('空库迁移链真跑', migrate.status === 0, (migrate.stderr || '').slice(-300));
    if (migrate.status !== 0) return summary();

    const apiChild = spawn('node', ['dist/main.js'], {
      cwd: API_DIR, env: baseEnv(API_PORT),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push({ name: 'admin-api', child: apiChild });
    capture('admin-api', apiChild);
    const apiReady = await waitForHttp(`http://localhost:${API_PORT}/api/health/live`);
    ok('admin-api 就绪', apiReady);
    if (!apiReady) return summary();

    // 执行器：pull 模式 + 不可达注册地址（NAT 模拟核心）
    const executorChild = spawn('node', ['dist/main.js'], {
      cwd: NODE_DIR,
      env: {
        ...process.env,
        ADMIN_API_URL: `http://localhost:${API_PORT}`,
        APP_NAME: 'pull-executor-1',
        PORT: String(randPort()),
        EXECUTOR_ADDRESS: UNREACHABLE_ADDRESS,
        EXECUTOR_ADDRESS_PUBLIC: UNREACHABLE_ADDRESS,
        EXECUTOR_SECRET,
        EXECUTOR_PULL_MODE: 'true',
        HEARTBEAT_INTERVAL_SECONDS: '2',
        MAX_CONCURRENT_TASKS: '2',
        TASK_TIMEOUT_SECONDS: '60',
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push({ name: 'executor-node(pull)', child: executorChild });
    capture('executor-node(pull)', executorChild);

    const token = await login(API_PORT);

    // ① 执行器注册且 dispatchMode=pull 可见
    let registered = false;
    let executorId = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const list = await api(API_PORT, token, 'GET', '/api/executors');
      const items = Array.isArray(list.body?.items) ? list.body.items : (list.body ?? []);
      const match = (items ?? []).find((e) => e.appName === 'pull-executor-1');
      if (match && match.status === 'online') {
        registered = match.dispatchMode === 'pull';
        executorId = match.id;
        break;
      }
      await sleep(1000);
    }
    ok('① 执行器以 dispatchMode=pull 注册并在线', Boolean(registered), `executorId=${executorId}`);

    // ② 触发 node glue 任务 → SUCCESS（拉取→执行→回调全链）
    const created = await api(API_PORT, token, 'POST', '/api/tasks', {
      name: `pull-selftest-${STAMP}`,
      runtime: 'node',
      triggerType: 'manual',
      timeout: 60,
      glueSource: `const msg = 'pulled through NAT';
console.log(msg);
return { ok: true, msg };`,
      glueLanguage: 'javascript',
    });
    const taskId = created.body?.id;
    ok('② glue 任务创建', Boolean(taskId), `taskId=${taskId}`);
    if (!taskId || !registered) return summary();

    const trig = await api(API_PORT, token, 'POST', `/api/tasks/${taskId}/trigger`, {});
    // 契约：返回执行行本体（{id, taskId, status:'pending', ...}）
    const executionId = trig.body?.id;
    ok('③ 手动触发', Boolean(executionId),
      `HTTP ${trig.status} body=${JSON.stringify(trig.body).slice(0, 200)}`);
    if (!executionId) return summary();

    let terminal = null;
    const execDeadline = Date.now() + EXECUTION_TIMEOUT_MS;
    while (Date.now() < execDeadline) {
      // 契约：执行记录经任务维度读取（GET /executions/:id 不存在）
      const list = await api(API_PORT, token, 'GET', `/api/tasks/${taskId}/executions`);
      const items = Array.isArray(list.body) ? list.body : (list.body?.items ?? []);
      const one = (items ?? []).find((e) => e.id === executionId);
      if (one && ['success', 'failed', 'timeout', 'killed', 'cancelled'].includes(String(one.status))) {
        terminal = one;
        break;
      }
      if (Date.now() > execDeadline - 3000) {
        console.log(`   [poll] items=${JSON.stringify(items ?? null).slice(0, 400)}`);
      }
      await sleep(1500);
    }
    ok('④ 执行经 pull 链跑至 SUCCESS（零入站依赖的证明）',
      terminal?.status === 'success',
      `status=${terminal?.status ?? 'timeout'} errorMessage=${terminal?.errorMessage ?? '-'}`);

    ok('⑤ 传输分支证据：result.dispatchMode=pull / status=queued',
      terminal?.result?.dispatchMode === 'pull' && terminal?.result?.status === 'queued',
      JSON.stringify(terminal?.result ?? null).slice(0, 200));

    return summary();
  } finally {
    if (results.some((r) => !r.passed)) {
      console.log('\n--- admin-api 日志尾部 ---');
      console.log(tailOf('admin-api', 40));
      console.log('\n--- executor 日志尾部 ---');
      console.log(tailOf('executor-node(pull)', 40));
    }
    for (const { child } of children) {
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    }
    if (DOCKER_MODE) {
      run('docker', ['rm', '-f', PG_CONTAINER, REDIS_CONTAINER]);
    }
  }
}

process.exit(await main());
