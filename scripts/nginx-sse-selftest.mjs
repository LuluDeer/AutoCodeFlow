/**
 * BUG-17 真机验证：真实 nginx 反代下的 SSE 长流语义（部署前的代理层门禁）。
 *
 * 为什么必须真机跑：SSE 能不能活下来完全取决于**代理层**（缓冲、读取超时、
 * 连接复用），单测只能覆盖应用侧写帧逻辑。本脚本用 `infra/nginx/default.conf`
 * **原件**（仅把上游地址与监听端口替换为本机值）起一个真实 nginx 容器，
 * 端到端验证：
 *
 *   ① 通用 /api/ 前缀位置：`GET /api/health` 正常透传（配置语法与上游可达）；
 *   ② 专用 SSE 位置（`/api/tasks/:id/executions/:execId/logs/stream`）经 nginx
 *      仍是流式：响应头 text/event-stream、无 Content-Length（chunked），且
 *      **首帧不迟滞**（缓冲会攒够 buffer 才下发 = 长流场景的"日志不实时"）；
 *   ③ 长流存活：专用位置日志流持续读帧 NGINX_SOAK_SECONDS（默认 180s，支持
 *      86400=24h），断言连接不断、`": ping"` 保活帧间隔 ≤ 45s。注意通用位置
 *      的 proxy_read_timeout 是 60s、专用位置才是 1h——soak 超过 60s 且不断连，
 *      本身就是"专用位置生效"的证据。
 *   ④ 业务事件穿透：走真实生产路径（executor 回调 → 终态 winner → 领域事件 →
 *      SSE 帧 → nginx → 客户端），断言 `execution.failed` 到达订阅方，且日志流
 *      在终态后正常收尾（[DONE] 语义不被代理吞掉）。
 *   ⑤ 并发长流：logs/stream + executions/stream + metrics/stream 三条并存互不干扰；
 *   ⑥ 长流期间普通请求不被拖慢（代理/事件循环未被长连接拖死）；
 *   ⑦ 长流不导致 admin-api 内存持续增长（RSS 涨幅阈值）。
 *
 * 为让"长流"有真实载体，脚本会起一个**探针执行器**（接受派发但永不回报结果）
 * 并周期心跳，使执行稳定停在 RUNNING：否则任务会因"无可用执行器"秒级失败，
 * 专用位置的长流无从验证（首轮实测：日志流 5s 即收尾）。
 *
 * 用法：
 *   node scripts/nginx-sse-selftest.mjs                              # 默认 180s soak
 *   NGINX_SOAK_SECONDS=86400 node scripts/nginx-sse-selftest.mjs      # 24h 长流（发布门禁）
 *   NGINX_SKIP_DOCKER=1 ...（复用本机 PG/Redis；nginx 仍由 docker 起）
 *
 * 退出码：全通过 0；任一失败 1；环境不满足（无 docker）→ 显式 skip 且 0。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'admin-api');
const NGINX_CONF_SRC = path.join(REPO_ROOT, 'infra', 'nginx', 'default.conf');

const DOCKER_MODE = process.env.NGINX_SKIP_DOCKER !== '1';
const STAMP = Date.now();
const PG_CONTAINER = `acf-nginx-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-nginx-redis-${STAMP}`;
const NGINX_CONTAINER = `acf-nginx-proxy-${STAMP}`;

const randPort = () => 15000 + Math.floor(Math.random() * 10000);
const PG_PORT = Number(process.env.NGINX_DB_PORT || randPort());
const REDIS_PORT = Number(process.env.NGINX_REDIS_PORT || randPort());
const API_PORT = Number(process.env.NGINX_API_PORT || randPort());
const PROXY_PORT = Number(process.env.NGINX_PROXY_PORT || randPort());
const DB_HOST = process.env.NGINX_DB_HOST || 'localhost';
const DB_USER = process.env.NGINX_DB_USER || 'autoflow';
const DB_PASS = process.env.NGINX_DB_PASS || 'test';
const DB_NAME = process.env.NGINX_DB_NAME || `autoflow_nginx_${STAMP}`;
const EXECUTOR_SECRET = process.env.NGINX_EXECUTOR_SECRET || 'nginx-sse-executor-secret';

/** soak 时长：默认 180s（> 通用位置 60s 读取超时，足以证明专用位置生效）。 */
const SOAK_SECONDS = Number(process.env.NGINX_SOAK_SECONDS || 180);
/** 保活帧间隔上限：应用侧 15s ping，留 3× 余量判"代理未吞帧"。 */
const MAX_PING_GAP_MS = 45_000;
/** 首帧迟滞上限：缓冲开启时通常要等到 buffer 满/超时才下发。 */
const FIRST_FRAME_BUDGET_MS = 25_000;
/** 长流期间 admin-api RSS 涨幅上限（MB）。 */
const RSS_GROWTH_LIMIT_MB = 200;
/** 反代并发长流档：并发连接数（0 = 跳过该档）。 */
const PROXY_SSE_CONNS = Number(process.env.NGINX_SSE_CONNS || 500);
/** 并发长流的保持时长（秒）。必须 > executions/stream 的 idle ping 间隔（默认
 *  30s，EXECUTIONS_STREAM_IDLE_PING_MS）——事件流是事件驱动、无初始快照，短于
 *  该间隔时那一半连接必然零帧（实测 20s 档正是 250/500 有帧）。 */
const PROXY_SSE_HOLD_S = Number(process.env.NGINX_SSE_HOLD || 35);

const ADMIN = { username: 'admin', password: 'admin123' };

const results = [];
const children = [];
const execIdRef = { value: null };
let tmpDir = '';

function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✔' : '✘'} ${name}${pass || !detail ? '' : `\n    ${String(detail).slice(0, 700)}`}`);
}
function skip(name, reason) {
  results.push({ name, pass: null });
  console.log(`- ${name}（跳过：${reason}）`);
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
    JWT_SECRET: 'nginx-sse-jwt-secret-32chars-longx',
    JWT_REFRESH_SECRET: 'nginx-sse-refresh-secret-32chars-l',
    EXECUTOR_SECRET,
    EXECUTION_CALLBACK_SECRET: EXECUTOR_SECRET,
    EXECUTOR_ALLOW_PRIVATE_NETWORK: 'true',
    INITIAL_ADMIN_USERNAME: ADMIN.username,
    INITIAL_ADMIN_PASSWORD: ADMIN.password,
    AI_PROVIDER: 'disabled',
    LOGIN_THROTTLE_LIMIT: '10000',
    THROTTLE_LIMIT: '10000',
    // 反代并发长流档：全局流槽位（metrics/stream 与 executions/stream 共享）
    // 必须抬到并发数之上，否则测到的是应用槽位 503 而不是代理层行为。
    METRICS_STREAM_MAX_GLOBAL: String(Math.max(64, Number(process.env.NGINX_SSE_CONNS || 500) + 64)),
  };
}

async function login(port) {
  const res = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`login failed → HTTP ${res.status}`);
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
    /* 空体/流式 */
  }
  return { status: res.status, body: json?.data ?? json };
}

/**
 * 打开一条 SSE 流并持续读帧。返回 { frames, firstFrameAt, maxGapMs, ended,
 * error, stop() }；`ready` 在建连（拿到响应头）后 resolve。
 */
function openSse(url, token) {
  const state = {
    frames: 0,
    firstFrameAt: 0,
    maxGapMs: 0,
    startedAt: Date.now(),
    ended: false,
    error: '',
    controller: new AbortController(),
    stop() {
      try {
        this.controller.abort();
      } catch {
        /* ignore */
      }
    },
  };
  state.ready = (async () => {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: state.controller.signal,
    });
    state.status = res.status;
    state.headers = res.headers;
    if (!res.body) {
      state.error = 'no response body';
      return res;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lastAt = Date.now();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          // 注释保活帧 ": ping" 与数据帧同计（两者都证明"字节真的流出来了"）
          const count = (text.match(/\n\n/g) || []).length || 1;
          for (let i = 0; i < count; i += 1) {
            state.frames += 1;
            const now = Date.now();
            if (!state.firstFrameAt) state.firstFrameAt = now;
            state.maxGapMs = Math.max(state.maxGapMs, now - lastAt);
            lastAt = now;
          }
        }
      } catch (e) {
        if (!state.controller.signal.aborted) {
          state.error = e instanceof Error ? e.message : String(e);
        }
      } finally {
        state.ended = true;
      }
    })();
    return res;
  })();
  return state;
}

/** 探针执行器：接受派发但不回报结果（维持执行 RUNNING 以承载长流验证）。 */
async function startProbeExecutor() {
  const port = randPort();
  const address = `127.0.0.1:${port}`;
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body.slice(0, 200) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', message: 'probe accepted' }));
    });
  });
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));

  const reg = await fetch(`http://localhost:${API_PORT}/api/executors/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${EXECUTOR_SECRET}` },
    body: JSON.stringify({
      address,
      appName: 'nginx-sse-probe',
      groupName: 'default',
      tags: ['shell', 'probe'],
      description: 'nginx SSE soak probe (never reports back)',
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
  console.log(`  探针执行器 ${address} 已注册（id=${data?.id ?? 'n/a'}）`);

  const heartbeat = (execId) =>
    fetch(`http://localhost:${API_PORT}/api/executors/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${execToken}` },
      body: JSON.stringify({
        address,
        cpuUsage: 5,
        memUsage: 5,
        runningTaskCount: execId ? 1 : 0,
        runningExecutionIds: execId ? [execId] : [],
        maxConcurrentTasks: 4,
      }),
    });
  // 注册后立即打一次心跳（钉住 online，避免调度器判定离线）
  await heartbeat(null).catch(() => {});

  return {
    address,
    requests,
    heartbeat,
    close: () => new Promise((r) => server.close(r)),
  };
}

function rssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function main() {
  console.log('══ BUG-17 真机验证：nginx 反代下 SSE 长流 ══');
  console.log(`soak = ${SOAK_SECONDS}s`);

  if (!hasCommand('docker')) {
    skip('nginx SSE 长流验证', 'docker 不可用（本脚本需 docker 起 nginx）');
    return summary();
  }

  tmpDir = mkdtempSync(path.join(tmpdir(), 'acf-nginx-'));
  console.log(`临时目录：${tmpDir}`);

  // ── [1] 依赖服务 ────────────────────────────────────────────────────
  for (const name of (run('docker', ['ps', '-a', '--filter', 'name=acf-nginx-', '--format', '{{.Names}}']).stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)) {
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
    run('docker', ['exec', PG_CONTAINER, 'psql', '-U', DB_USER, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS "${DB_NAME}";`]);
    run('docker', ['exec', PG_CONTAINER, 'psql', '-U', DB_USER, '-d', 'postgres', '-c', `CREATE DATABASE "${DB_NAME}";`]);
  } else {
    const create = run('psql', ['-h', DB_HOST, '-p', String(PG_PORT), '-U', DB_USER, '-d', 'postgres', '-c', `CREATE DATABASE "${DB_NAME}";`], {
      env: { ...process.env, PGPASSWORD: DB_PASS },
    });
    if (create.status !== 0) throw new Error(`建库失败: ${create.stderr}`);
  }

  // ── [2] 构建 + 迁移 + 起 admin-api ──────────────────────────────────
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

  // ── [3] 真实 nginx（infra/nginx/default.conf 原件，仅替换两处环境值） ──
  // 说明：只替换「上游地址」（compose 服务名 → 本机回环）与「监听端口」
  // （80 → 随机高端口，避开宿主已有 80 监听）。location/缓冲/超时/limit 等
  // 被验证的语义全部保持原件。
  // 网络用 --network host：bridge 下 docker0 → 宿主回环的转发在部分环境
  // 受防火墙/NAT 限制（实测 504），host 模式让"经 nginx 反代"这一被测语义
  // 不受容器网络干扰。
  const conf = readFileSync(NGINX_CONF_SRC, 'utf8')
    .replace(/http:\/\/admin-api:3105/g, `http://127.0.0.1:${API_PORT}`)
    .replace(/listen 80;/, `listen ${PROXY_PORT};`);
  const confPath = path.join(tmpDir, 'default.conf');
  writeFileSync(confPath, conf);
  ok(
    'nginx 配置取自 infra/nginx/default.conf 原件（仅替换上游地址与监听端口）',
    conf.includes(`127.0.0.1:${API_PORT}`) && conf.includes(`listen ${PROXY_PORT};`),
  );

  const nginx = run('docker', [
    'run', '-d', '--name', NGINX_CONTAINER,
    '--network', 'host',
    '-v', `${confPath}:/etc/nginx/conf.d/default.conf:ro`,
    'nginx:alpine',
  ]);
  if (nginx.status !== 0) {
    ok('nginx 容器启动', false, nginx.stderr);
    return summary();
  }

  try {
    await waitForHttp(`http://localhost:${API_PORT}/api/health`);
    await waitForHttp(`http://localhost:${PROXY_PORT}/api/health`);
  } catch (e) {
    ok('admin-api 与 nginx 就绪', false, e instanceof Error ? e.message : String(e));
    return summary();
  }
  ok('① nginx 反代透传 /api/health（配置语法与上游可达）', true);

  const token = await login(API_PORT);

  // ── [4] 探针执行器：注册 + 心跳（让执行真正进入 RUNNING，长流才有载体）──
  const probe = await startProbeExecutor();
  if (!probe) {
    skip('nginx SSE 长流验证', '探针执行器注册失败（无法构造长命执行）');
    return summary();
  }
  const probeTimer = setInterval(() => {
    probe.heartbeat(execIdRef.value).catch(() => {});
  }, 10_000);
  probeTimer.unref?.();

  const taskRes = await api(API_PORT, token, 'POST', '/api/tasks', {
    name: `nginx-sse-${STAMP}`,
    triggerType: 'manual',
    runtime: 'shell',
    entrypoint: 'echo hello',
  });
  const taskId = taskRes.body?.id;
  if (!taskId) {
    ok('创建演示任务', false, `status=${taskRes.status} body=${JSON.stringify(taskRes.body)?.slice(0, 200)}`);
    return summary();
  }
  const trig = await api(API_PORT, token, 'POST', `/api/tasks/${taskId}/trigger`, {});
  // 触发返回的是 execution 实体（主键 id），历史形态也曾暴露 executionId —— 两者都认。
  const execId = trig.body?.executionId ?? trig.body?.id;
  execIdRef.value = execId;
  ok('创建任务并触发（拿到 executionId 供日志流使用）', !!execId, `trigger status=${trig.status} body=${JSON.stringify(trig.body)?.slice(0, 300)}`);
  if (!execId) return summary();

  // 探针确实收到了平台派发（链路闭环，否则下面的"长流"只是空跑）
  const dispatchDeadline = Date.now() + 30_000;
  while (Date.now() < dispatchDeadline && probe.requests.length === 0) await sleep(500);
  ok('探针执行器收到平台派发（POST /api/execute）', probe.requests.length > 0,
    `received=${JSON.stringify(probe.requests.slice(0, 1))?.slice(0, 300)}`);

  // ── [5] ② 专用 SSE 位置：流式语义 ───────────────────────────────────
  const logsUrl = `http://localhost:${PROXY_PORT}/api/tasks/${taskId}/executions/${execId}/logs/stream`;
  const logsStream = openSse(logsUrl, token);
  await logsStream.ready;
  const h = logsStream.headers;
  // 注：X-Accel-Buffering 是 nginx 的**指令**（被消费而非转发），客户端看不到
  // 该响应头——所以这里断言流式契约（content-type + chunked + 首帧节奏），
  // 缓冲是否真的关闭由下面「首帧不迟滞/保活按节奏」的行为断言兜底。
  ok('② 经 nginx 仍是流式响应（text/event-stream，X-Accel-Buffering 被 nginx 消费不转发）',
    logsStream.status === 200 &&
      (h?.get('content-type') || '').includes('text/event-stream'),
    `status=${logsStream.status} content-type=${h?.get('content-type')} x-accel-buffering=${h?.get('x-accel-buffering')}（null=nginx 已消费）`);
  ok('② 无 Content-Length（chunked 流，未被代理整体缓冲）',
    !h?.get('content-length'),
    `content-length=${h?.get('content-length')}`);

  // ── [6] ⑤ 并发长流（终态流 + 指标流，均走通用 /api/ 位置）────────────
  const termUrl = `http://localhost:${PROXY_PORT}/api/executions/stream`;
  const termStream = openSse(termUrl, token);
  await termStream.ready;
  ok('⑤ 并发第二条 SSE 长流建连成功（executions/stream）',
    termStream.status === 200 &&
      (termStream.headers?.get('content-type') || '').includes('text/event-stream'),
    `status=${termStream.status} content-type=${termStream.headers?.get('content-type')}`);

  const metricsStream = openSse(`http://localhost:${PROXY_PORT}/api/metrics/stream`, token);
  await metricsStream.ready;
  ok('⑤ 并发第三条 SSE 长流建连成功（metrics/stream，通用位置）',
    metricsStream.status === 200 &&
      (metricsStream.headers?.get('content-type') || '').includes('text/event-stream'),
    `status=${metricsStream.status} content-type=${metricsStream.headers?.get('content-type')}`);

  // ── [7] ③ 专用位置长流 soak + ⑥ 普通请求 + ⑦ 内存 ─────────────────
  const rssBefore = rssKb(apiChild.pid);
  const soakStart = Date.now();
  let healthMaxMs = 0;
  let healthProbes = 0;
  while (Date.now() - soakStart < SOAK_SECONDS * 1000) {
    await sleep(5000);
    const t0 = Date.now();
    try {
      const res = await fetch(`http://localhost:${PROXY_PORT}/api/health`);
      if (!res.ok) healthMaxMs = Number.POSITIVE_INFINITY;
    } catch {
      healthMaxMs = Number.POSITIVE_INFINITY;
    }
    healthMaxMs = Math.max(healthMaxMs, Date.now() - t0);
    healthProbes += 1;
    if (logsStream.ended || logsStream.error) break;
  }
  const elapsedS = Math.round((Date.now() - soakStart) / 1000);
  const rssAfter = rssKb(apiChild.pid);

  ok(`③ 专用位置日志流长流存活 ${elapsedS}s 不断连（执行持续 RUNNING；该位置 proxy_read_timeout 1h）`,
    !logsStream.ended && !logsStream.error && elapsedS >= Math.min(SOAK_SECONDS, 60),
    `ended=${logsStream.ended} error=${logsStream.error} frames=${logsStream.frames}`);
  ok('③ 保活帧按节奏到达（代理未吞帧 / 未被缓冲成一次性批量下发）',
    logsStream.frames >= Math.max(1, Math.floor(elapsedS / 20)) &&
      logsStream.maxGapMs <= MAX_PING_GAP_MS,
    `frames=${logsStream.frames} maxGapMs=${logsStream.maxGapMs} 期望≥${Math.max(1, Math.floor(elapsedS / 20))}`);
  ok('② 首帧不迟滞（缓冲会攒够 buffer 才下发 → 实时日志体验受损）',
    logsStream.firstFrameAt > 0 && logsStream.firstFrameAt - logsStream.startedAt < FIRST_FRAME_BUDGET_MS,
    `firstFrame Δ=${logsStream.firstFrameAt - logsStream.startedAt}ms（预算 ${FIRST_FRAME_BUDGET_MS}ms）`);

  if (SOAK_SECONDS < 20) {
    // 短档（smoke）：首帧断言在执行刚起跑时无意义，显式降级为跳过而非误判失败
    results[results.length - 1] = { name: '② 首帧不迟滞', pass: null };
    console.log('- ② 首帧不迟滞（跳过：soak < 20s，短档下执行可能尚未产生首帧）');
  }
  ok('⑤ 并发长流全程共存（三条 SSE 互不干扰）',
    !termStream.error && !metricsStream.error && termStream.status === 200 && metricsStream.status === 200,
    `term(ended=${termStream.ended} err=${termStream.error}) metrics(ended=${metricsStream.ended} err=${metricsStream.error})`);
  ok('⑥ 长流期间普通请求仍通畅（代理与事件循环未被长连接拖死）',
    healthProbes > 0 && Number.isFinite(healthMaxMs) && healthMaxMs < 5000,
    `probes=${healthProbes} maxLatency=${healthMaxMs}ms`);
  const growthMb = Math.round(((rssAfter - rssBefore) / 1024) * 10) / 10;
  ok('⑦ 长流期间 admin-api RSS 涨幅在阈值内（无长连接泄漏）',
    growthMb <= RSS_GROWTH_LIMIT_MB,
    `RSS ${Math.round(rssBefore / 1024)}MB → ${Math.round(rssAfter / 1024)}MB（Δ${growthMb}MB，阈值 ${RSS_GROWTH_LIMIT_MB}MB）`);

  // ── [8] ④ 事件穿透：回调上报 failed → 终态事件经 nginx 到达订阅方 ────
  // 走真实生产路径：executor 回调 → 唯一 winner 落终态 → 领域事件 →
  // executions/stream 帧 → nginx → 客户端。同时日志流应收到终态收尾。
  const cb = await fetch(`http://localhost:${API_PORT}/api/executions/callback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${EXECUTOR_SECRET}`,
    },
    body: JSON.stringify([
      {
        executionId: execId,
        status: 'failed',
        error: 'probe executor reports failure (nginx-sse-selftest)',
        executorAddress: probe.address,
      },
    ]),
  });
  const cbBody = await cb.json().catch(() => null);
  const cbDeadline = Date.now() + 25_000;
  while (Date.now() < cbDeadline && termStream.frames === 0) await sleep(500);
  ok('④ execution.failed 事件穿透 nginx 到达订阅方（代理未吞事件）',
    termStream.frames > 0,
    `callback status=${cb.status} body=${JSON.stringify(cbBody)?.slice(0, 200)} frames=${termStream.frames}`);

  const logDoneDeadline = Date.now() + 25_000;
  while (Date.now() < logDoneDeadline && !logsStream.ended) await sleep(500);
  ok('④ 执行终态后日志流正常收尾（[DONE] 语义经 nginx 送达，未悬挂）',
    logsStream.ended, `ended=${logsStream.ended} frames=${logsStream.frames}`);

  clearInterval(probeTimer);
  logsStream.stop();
  termStream.stop();
  metricsStream.stop();
  await probe.close();
  await sleep(1000);

  const after = await fetch(`http://localhost:${PROXY_PORT}/api/health`);
  ok('断流后服务正常（连接与槽位回收干净）', after.ok, `status=${after.status}`);

  // ── [9] ⑧ 反代并发长流档（QA-05 缺口：经 nginx 的 500 连接形态）────────
  // 生产拓扑里 nginx 在应用前面，应用侧扛得住不等于代理层扛得住：nginx 的
  // worker_connections、upstream keepalive、limit_conn 都可能先到顶。这里按
  // 并发建流 → 保持 → 断言建连率/存活率/保活帧/槽位回收，并打印水位。
  if (PROXY_SSE_CONNS > 0) {
    const rssBefore = Math.round(rssKb(apiChild.pid) / 1024);
    const streams = [];
    const urlFor = (i) =>
      i % 2 === 0
        ? `http://localhost:${PROXY_PORT}/api/executions/stream`
        : `http://localhost:${PROXY_PORT}/api/metrics/stream`;
    const openStart = Date.now();
    for (let i = 0; i < PROXY_SSE_CONNS; i += 1) {
      streams.push(openSse(urlFor(i), token));
    }
    await Promise.allSettled(streams.map((s) => s.ready));
    const openMs = Date.now() - openStart;

    const statusCount = new Map();
    for (const s of streams) {
      statusCount.set(s.status ?? 0, (statusCount.get(s.status ?? 0) ?? 0) + 1);
    }
    const established = streams.filter(
      (s) => s.status === 200 && (s.headers?.get?.('content-type') || '').includes('text/event-stream'),
    ).length;

    await sleep(PROXY_SSE_HOLD_S * 1000);
    const alive = streams.filter((s) => !s.ended && !s.error).length;
    const withFrames = streams.filter((s) => s.frames > 0).length;
    const rssAfter = Math.round(rssKb(apiChild.pid) / 1024);

    console.log(
      `  反代并发长流：${PROXY_SSE_CONNS} 条 / 建连 ${openMs}ms / 状态分布 ${JSON.stringify(
        Object.fromEntries(statusCount),
      )} / 存活 ${alive} / 有帧 ${withFrames} / RSS ${rssBefore}→${rssAfter} MB`,
    );
    ok(`⑧ 经 nginx 建立 ${PROXY_SSE_CONNS} 条 SSE 长流（建连率 ≥99%）`,
      established >= Math.floor(PROXY_SSE_CONNS * 0.99),
      `established=${established}/${PROXY_SSE_CONNS} status=${JSON.stringify(Object.fromEntries(statusCount))}`);
    ok(`⑧ 保持 ${PROXY_SSE_HOLD_S}s 后存活率 ≥99%（代理未提前掐断）`,
      alive >= Math.floor(PROXY_SSE_CONNS * 0.99), `alive=${alive}/${PROXY_SSE_CONNS}`);
    ok('⑧ 长流全程有保活/数据帧到达（字节真的在流，不是死连接）',
      withFrames >= Math.floor(PROXY_SSE_CONNS * 0.9), `withFrames=${withFrames}/${PROXY_SSE_CONNS}`);
    ok('⑧ 500 并发长流下 admin-api RSS 增幅在阈值内（无连接级泄漏）',
      rssAfter - rssBefore <= RSS_GROWTH_LIMIT_MB, `ΔRSS=${rssAfter - rssBefore} MB（上限 ${RSS_GROWTH_LIMIT_MB}）`);

    for (const s of streams) s.stop();
    await sleep(3000);
    // 槽位回收：关掉整批后应能重新建连（不残留占满全局槽位）
    const recheck = openSse(`http://localhost:${PROXY_PORT}/api/metrics/stream`, token);
    await Promise.race([recheck.ready, sleep(10_000)]);
    ok('⑧ 批量断流后槽位回收干净（可立即重新建流）',
      recheck.status === 200, `status=${recheck.status}`);
    recheck.stop();
    await sleep(500);
  }

  summary();
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
  run('docker', ['rm', '-f', NGINX_CONTAINER, PG_CONTAINER, REDIS_CONTAINER]);
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
