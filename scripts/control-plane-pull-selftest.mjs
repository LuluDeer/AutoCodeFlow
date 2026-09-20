/**
 * ARCH-33（ADR-016）真机自检：**控制面 pull 通道**端到端。
 *
 * ## 核心证明
 *
 * ARCH-32 的自检（pull-dispatch-selftest.mjs）证明的是「**任务派发**零入站
 * 依赖」。它盖不住本次要修的故障面：部署/停止/配置热更新这些**中台主动拨入
 * 执行器**的调用在 ADR-015 之后仍是纯 push 硬编码——公网中台 + 内网执行器
 * 拓扑下必然超时。生产实证就是这条：
 *
 *     app_deployments.statusMessage =
 *       "Failed to reach executor after 3 attempts: timeout of 30000ms exceeded"
 *
 * 本自检把执行器地址设为**不可达值**（unreachable-nat-host.invalid:9999——
 * 任何入站拨号必 DNS 失败），然后验证控制面操作**仍然生效**：
 *
 *   ① 执行器以 protocolVersion=2 + dispatchMode=pull 注册（协议门禁的输入）；
 *   ② 部署指令经 pull 通道抵达并被执行器受理——app_deployments 行离开
 *      PENDING/DEPLOYING 且**不带**「Failed to reach executor」错误；
 *   ③ 配置热更新返回 `queued: true`（如实声明异步），且执行器**确实应用**了
 *      ——这是「队列真的被消费」的正向证据，而非只看接口返回值；
 *   ④ 对照：push 路径对该地址**确实**不可达（否则本自检的证明力为零）。
 *
 * 第 ④ 条是关键的自证：如果这个地址其实是可达的，那么 ②③ 的成功就什么都
 * 证明不了。所以先证明「拨号确实失败」，再证明「操作确实成功」。
 *
 * ## 用法
 *
 *   npm run test:control-plane-pull
 *   CP_SKIP_DOCKER=1 npm run test:control-plane-pull    # 复用本机 PG/Redis
 *
 * 退出码：全部通过 0；任一失败 1；环境不满足（无 docker 且无本机 PG/Redis）
 * → 显式 skip 且 0。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'admin-api');
const NODE_DIR = path.join(REPO_ROOT, 'apps', 'executor-node');

const DOCKER_MODE = process.env.CP_SKIP_DOCKER !== '1';
const STAMP = Date.now();
const PG_CONTAINER = `acf-cp-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-cp-redis-${STAMP}`;

const randPort = () => 15000 + Math.floor(Math.random() * 10000);
const PG_PORT = Number(process.env.CP_DB_PORT || randPort());
const REDIS_PORT = Number(process.env.CP_REDIS_PORT || randPort());
const API_PORT = Number(process.env.CP_API_PORT || randPort());
const EXECUTOR_PORT = Number(process.env.CP_EXECUTOR_PORT || randPort());
const DB_HOST = process.env.CP_DB_HOST || 'localhost';
const DB_USER = process.env.CP_DB_USER || 'autoflow';
const DB_PASS = process.env.CP_DB_PASS || 'test';
const DB_NAME = process.env.CP_DB_NAME || `autoflow_cp_${STAMP}`;

/** NAT 模拟：该地址不可解析——任何入站拨号必失败（第 ④ 条会实测这一点）。 */
const UNREACHABLE_ADDRESS = 'unreachable-nat-host.invalid:9999';
const EXECUTOR_SECRET = 'control-plane-pull-secret';
const ADMIN = { username: 'admin', password: 'admin123' };

const EXECUTION_TIMEOUT_MS = 90_000;
/** 配置热更新是异步的（queued → 执行器下一轮拉取时应用），给它足够窗口。 */
const RELOAD_TIMEOUT_MS = 60_000;

const results = [];
const children = [];
const logs = new Map();

function capture(name, child) {
  const buf = [];
  const push = (d) => {
    const lines = String(d).split('\n').filter(Boolean);
    buf.push(...lines);
    if (buf.length > 500) buf.splice(0, buf.length - 500);
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  logs.set(name, buf);
}

const tailOf = (name, n = 40) => (logs.get(name) ?? []).slice(-n).join('\n');
const logHas = (name, needle) =>
  (logs.get(name) ?? []).some((l) => l.includes(needle));

const ok = (name, passed, detail = '') => {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✅' : '❌'} ${name}${detail ? `\n   ${detail}` : ''}`);
};
const skip = (name, reason) => {
  console.log(`⏭️  ${name} — skip：${reason}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows 上 npm/npx/docker 是 .cmd 垫片，直接 spawnSync 会失败——而
 * Node 20+ 出于 CVE-2024-27980 的加固，对 .cmd 连 `shell:false` + 显式
 * `.cmd` 后缀也报 EINVAL（实测）。唯一可行组合是 `shell: true`。
 *
 * 既有 pull-dispatch-selftest.mjs 没处理这一点，因此它只能在 Linux/CI 上
 * 跑。本自检要在开发机本地也产出真机证据，故显式分支；`shell:true` 的
 * DEP0190 警告只在 Windows 分支出现，且本脚本的参数全是脚本内硬编码常量
 * （不含外部输入），无注入面。
 */
const IS_WIN = process.platform === 'win32';
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 180_000,
    ...(IS_WIN ? { shell: true } : {}),
    ...opts,
  });
const hasCommand = (cmd) => run('sh', ['-c', `command -v ${cmd}`]).status === 0;

function summary() {
  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    return 1;
  }
  console.log('\nARCH-33 控制面 pull 通道自检全绿。');
  return 0;
}

async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not ready */
    }
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
    JWT_SECRET: 'cp-pull-jwt-secret-32chars-long-here',
    JWT_REFRESH_SECRET: 'cp-pull-refresh-secret-32chars-xx',
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
  console.log(
    `\n=== ARCH-33 控制面 pull 自检（api=:${API_PORT}，执行器地址=${UNREACHABLE_ADDRESS}）===\n`,
  );
  if (DOCKER_MODE && !hasCommand('docker')) {
    skip(
      '控制面 pull 全链',
      'docker 不可用（CP_SKIP_DOCKER=1 + 本机 PG/Redis 可跳过）',
    );
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

    const buildApi = run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: API_DIR });
    const buildNode = run('npx', ['tsc'], { cwd: NODE_DIR });
    ok('admin-api / executor-node 构建通过',
      buildApi.status === 0 && buildNode.status === 0,
      (buildApi.stderr || buildNode.stderr || '').slice(-300));
    if (buildApi.status !== 0 || buildNode.status !== 0) return summary();

    const migrate = run('npm', ['run', 'migration:run'], {
      cwd: API_DIR, env: baseEnv(API_PORT),
    });
    ok('空库迁移链真跑', migrate.status === 0, (migrate.stderr || '').slice(-300));
    if (migrate.status !== 0) return summary();

    const apiChild = spawn('node', ['dist/main.js'], {
      cwd: API_DIR, env: baseEnv(API_PORT), stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push({ name: 'admin-api', child: apiChild });
    capture('admin-api', apiChild);
    const apiReady = await waitForHttp(`http://localhost:${API_PORT}/api/health/live`);
    ok('admin-api 就绪', apiReady);
    if (!apiReady) return summary();

    const executorChild = spawn('node', ['dist/main.js'], {
      cwd: NODE_DIR,
      env: {
        ...process.env,
        ADMIN_API_URL: `http://localhost:${API_PORT}`,
        APP_NAME: 'cp-pull-executor',
        PORT: String(EXECUTOR_PORT),
        EXECUTOR_ADDRESS: UNREACHABLE_ADDRESS,
        EXECUTOR_ADDRESS_PUBLIC: UNREACHABLE_ADDRESS,
        EXECUTOR_SECRET,
        // config.ts 的优先级是 EXECUTOR_SHARED_TOKEN > EXECUTOR_SECRET。
        // 开发机上 apps/executor-node/.env（dotenvx 自动加载）若含
        // EXECUTOR_SHARED_TOKEN，会**压过**本脚本注入的 EXECUTOR_SECRET，
        // 导致执行器拿旧令牌 → 全链 401。两个都设，保证自检在任何开发机上
        // 都用自己的 secret（既有 pull-dispatch 自检没处理这点，故它对本机
        // .env 敏感）。
        EXECUTOR_SHARED_TOKEN: EXECUTOR_SECRET,
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

    // ── ① 注册：dispatchMode=pull + protocolVersion=2（协议门禁的输入） ──
    let executor = null;
    const regDeadline = Date.now() + 30_000;
    while (Date.now() < regDeadline) {
      const list = await api(API_PORT, token, 'GET', '/api/executors');
      const items = Array.isArray(list.body?.items)
        ? list.body.items
        : (list.body ?? []);
      const match = (items ?? []).find((e) => e.appName === 'cp-pull-executor');
      if (match && match.status === 'online') {
        executor = match;
        break;
      }
      await sleep(1000);
    }
    ok('① 执行器注册：dispatchMode=pull', executor?.dispatchMode === 'pull',
      `executorId=${executor?.id} dispatchMode=${executor?.dispatchMode}`);
    // 协议门禁的输入必须真的是 2——否则中台根本不会下发 commands，
    // 后续断言会「因为没发命令而通过」，是假绿。
    ok('①b 执行器上报 protocolVersion=2（控制面门禁的输入）',
      Number(executor?.protocolVersion) >= 2,
      `protocolVersion=${executor?.protocolVersion}`);
    if (!executor) return summary();

    // ── ④（先做对照）该地址确实不可达——否则后面的成功什么都证明不了 ──
    // 从 admin-api 侧发一次真实入站请求，必须失败。这是本自检证明力的前提。
    let inboundReachable = false;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(`http://${UNREACHABLE_ADDRESS}/api/health/live`, {
        signal: ctl.signal,
      });
      clearTimeout(t);
      inboundReachable = r.ok;
    } catch {
      inboundReachable = false;
    }
    ok('④ 对照：该地址入站**确实不可达**（本自检证明力的前提）',
      inboundReachable === false,
      inboundReachable
        ? '⚠️ 地址居然可达——后续「经 pull 成功」的断言证明力为零'
        : 'DNS/连接失败，符合 NAT 模拟预期');

    // ── ② 配置热更新经 pull 通道抵达并**确实生效** ──
    const beforeReload = await api(API_PORT, token, 'GET', '/api/executors');
    const beforeItems = Array.isArray(beforeReload.body?.items)
      ? beforeReload.body.items
      : (beforeReload.body ?? []);
    const beforeOne = beforeItems.find((e) => e.id === executor.id);

    const reload = await api(
      API_PORT, token, 'POST', `/api/executors/${executor.id}/reload-config`,
      { maxConcurrentTasks: 5 },
    );
    // 接口必须如实返回 queued（异步语义），不得谎报「已应用」。
    ok('② 配置热更新接口返回 queued=true（如实声明异步）',
      reload.body?.queued === true && Boolean(reload.body?.commandId),
      `HTTP ${reload.status} body=${JSON.stringify(reload.body).slice(0, 200)}`);

    // 正向证据：执行器**确实**应用了——日志里出现本地 /config/reload 的应用记录。
    // 只看接口返回值是不够的（那只能证明入队成功）。
    let applied = false;
    const applyDeadline = Date.now() + RELOAD_TIMEOUT_MS;
    while (Date.now() < applyDeadline) {
      if (
        logHas('executor-node(pull)', '[command] Executing config-reload') &&
        logHas('executor-node(pull)', 'accepted by local route')
      ) {
        applied = true;
        break;
      }
      await sleep(1000);
    }
    ok('②b 执行器**确实消费了队列**并应用配置（非只看接口返回值）',
      applied,
      applied
        ? '日志出现命令执行 + 本地路由受理'
        : `未在 ${RELOAD_TIMEOUT_MS / 1000}s 内观察到命令消费`);

    ok('②c 无「不可达/超时」失败痕迹（入站拨号从未发生）',
      !logHas('admin-api', 'Failed to reach executor') &&
      !logHas('admin-api', 'ECONNREFUSED') &&
      !logHas('admin-api', 'ENOTFOUND'),
      'admin-api 日志无入站拨号失败');

    // ── ③ 结果上报：执行器回报了 command-result ──
    let reported = false;
    const reportDeadline = Date.now() + 30_000;
    while (Date.now() < reportDeadline) {
      if (logHas('admin-api', 'command-result')) {
        reported = true;
        break;
      }
      await sleep(1000);
    }
    ok('③ 执行器回报 /executors/command-result（可观测性闭环）',
      reported, reported ? '' : '未观察到结果上报日志');

    // ── ⑤ 部署指令经 pull 通道抵达（本次故障的原始现场） ──
    const app = await api(API_PORT, token, 'POST', '/api/applications', {
      name: `cp-pull-app-${STAMP}`,
      version: '1.0.0',
      gitRepo: 'https://example.invalid/repo.git',
      gitBranch: 'main',
      runtime: 'node',
      entrypoint: 'node index.js',
    });
    const appId = app.body?.id;
    ok('⑤ 应用创建（部署前置）', Boolean(appId),
      `HTTP ${app.status} body=${JSON.stringify(app.body).slice(0, 200)}`);

    if (appId) {
      // 契约：CreateDeploymentDto 只收 executorId / runMode / env / startCommand
      // ——gitBranch 从应用行读取，不在本 DTO 里（白名单会 400）。
      const dep = await api(
        API_PORT, token, 'POST', `/api/app-deployments/applications/${appId}/deploy`,
        { executorId: executor.id },
      );
      const deploymentId = dep.body?.id ?? dep.body?.deploymentId;
      ok('⑤b 部署请求被受理（不再同步等入站拨号）', Boolean(deploymentId),
        `HTTP ${dep.status} body=${JSON.stringify(dep.body).slice(0, 300)}`);

      if (deploymentId) {
        // 关键断言：部署指令**必须**经 pull 通道抵达执行器并被执行器受理。
        //
        // 判据不是「statusMessage 里出现 queued」——那句是入队瞬间的过渡文案，
        // 会被执行器的真实进度覆盖（实测：几百毫秒后就变成 git clone 的输出）。
        // 真正有证明力的是**执行器侧**的证据：日志出现 deploy 命令被消费 +
        // 本地路由受理。这只有「命令真的穿过 pull 通道送达」才可能发生。
        let deployConsumed = false;
        const depDeadline = Date.now() + 60_000;
        let lastStatus = null;
        while (Date.now() < depDeadline) {
          const one = await api(API_PORT, token, 'GET', `/api/app-deployments/${deploymentId}`);
          lastStatus = one.body;
          if (
            logHas('executor-node(pull)', '[command] Executing deploy') &&
            logHas('executor-node(pull)', 'accepted by local route')
          ) {
            deployConsumed = true;
            break;
          }
          await sleep(1000);
        }
        ok('⑤c 部署指令经 pull 通道抵达执行器并被受理（执行器侧日志为证）',
          deployConsumed,
          deployConsumed
            ? '日志出现 deploy 命令执行 + 本地路由受理'
            : `statusMessage=${String(lastStatus?.statusMessage ?? '-').slice(0, 200)}`);

        // 原始故障现场的反例：绝不能出现 "Failed to reach executor"。
        // 注：部署本身会因 gitRepo 是 example.invalid 而失败——那是**预期的**
        // （本自检不拉真代码），失败原因必须是「git clone 失败」这类执行器侧
        // 的业务失败，而**不是**「连不上执行器」的传输失败。
        const msg = String(lastStatus?.statusMessage ?? '');
        ok('⑤d 失败原因是执行器侧业务失败，而非原始故障 "Failed to reach executor"',
          !msg.includes('Failed to reach executor') &&
          !msg.includes('timeout of 30000ms exceeded'),
          `status=${lastStatus?.status ?? '-'} statusMessage=${msg.slice(0, 200)}`);
      }
    }

    return summary();
  } finally {
    if (results.some((r) => !r.passed)) {
      console.log('\n--- admin-api 日志尾部 ---');
      console.log(tailOf('admin-api', 50));
      console.log('\n--- executor 日志尾部 ---');
      console.log(tailOf('executor-node(pull)', 50));
    }
    for (const { child } of children) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    if (DOCKER_MODE) {
      run('docker', ['rm', '-f', PG_CONTAINER, REDIS_CONTAINER]);
    }
  }
}

process.exit(await main());
