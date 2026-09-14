/**
 * ARCH-31 矩阵清单收尾项：真机双实例 outbox webhook **重复投递边界**验证。
 *
 * 此前矩阵 5 条清单已全部通过，唯一残留边界是「webhook 实际投递次数」——
 * 需要一个真实接收端才能观测。本套件在 loopback 上起真实 HTTP 接收器
 * （EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK=true 解锁内网订阅 URL），起两个
 * 真实 admin-api 共享同一 PG + Redis（迁移链真跑），制造 N 个派发失败终态
 * 执行（无执行器在线 → BUG-21 修复后派发阶段失败也发 execution.failed
 * 领域事件），断言：
 *
 *   ① 每个订阅收到的投递次数 == 事件数（正常路径恰一次：双实例 SKIP LOCKED
 *      claim 零重叠 + markFastPathDelivered 快速路径收口不双发）；
 *   ② 投递不丢（at-least-once 下界：收到的 == 期望的，签名头齐备）；
 *   ③ 经 ≥2 个补投扫描周期（OUTBOX_SCAN_INTERVAL_MS=5s）后计数不再增长
 *      ——这正是「快速路径收口前每个成功事件会被补投再投一遍」的历史回归锚；
 *   ④ DB 层：event_outbox 全部行 dispatchedAt 已回写（无残留未结行）。
 *
 * 口径（如实）：单机双进程 + loopback 接收端；多主机网络拓扑仍留验。
 *
 * 用法：
 *   npm run test:arch31-outbox-dup
 *   ARCH31_SKIP_DOCKER=1 …（复用本机 PG/Redis，同 multi-instance 套件约定）
 *
 * 退出码：全部通过 0；任一失败 1；环境不满足（无 docker）→ 显式 skip 且 0。
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureDatabase } from './pg-provision.lib.mjs';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'admin-api');

const DOCKER_MODE = process.env.ARCH31_SKIP_DOCKER !== '1';
const STAMP = Date.now();
const PG_CONTAINER = `acf-arch31dup-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-arch31dup-redis-${STAMP}`;

const randPort = () => 15000 + Math.floor(Math.random() * 10000);
const PG_PORT = Number(process.env.ARCH31_DB_PORT || randPort());
const REDIS_PORT = Number(process.env.ARCH31_REDIS_PORT || randPort());
const DB_HOST = process.env.ARCH31_DB_HOST || 'localhost';
const DB_USER = process.env.ARCH31_DB_USER || 'autoflow';
const DB_PASS = process.env.ARCH31_DB_PASS || 'test';
const DB_NAME = process.env.ARCH31_DB_NAME || `autoflow_arch31dup_${STAMP}`;
const REDIS_PASS = process.env.ARCH31_REDIS_PASS || '';

const PORT_A = Number(process.env.ARCH31_PORT_A || randPort());
const PORT_B = Number(process.env.ARCH31_PORT_B || randPort());
/** loopback 接收器端口（两个订阅分别走 IP 字面量与 localhost DNS 两条校验路径）。 */
const RECV_PORT = randPort();
/** 制造的失败执行数（每个执行 = 1 个 execution.failed 事件）。 */
const N_EVENTS = 5;
/** 稳定观测窗：≥2 个补投扫描周期（5s）+ 余量。 */
const STABILIZE_MS = 12_000;

const ADMIN = { username: 'admin', password: 'admin123' };
const SUB_SECRET = 'arch31-dup-secret-0123456789abcdef';

const results = [];
const children = [];
let logDir = '';
let recvServer = null;
const deliveries = []; // { path, event, signature, ts }

function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✔' : '✘'} ${name}${pass || !detail ? '' : `\n    ${String(detail).slice(0, 600)}`}`);
}
function skip(name, reason) {
  results.push({ name, pass: null });
  console.log(`- ${name}（跳过：${reason}）`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts });
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
    ...(REDIS_PASS ? { REDIS_PASSWORD: REDIS_PASS } : {}),
    JWT_SECRET: 'arch31-jwt-secret-32chars-long-here',
    JWT_REFRESH_SECRET: 'arch31-refresh-secret-32chars-longxx',
    EXECUTOR_SECRET: 'arch31-executor-secret',
    EXECUTION_CALLBACK_SECRET: 'arch31-executor-secret',
    EXECUTOR_ALLOW_PRIVATE_NETWORK: 'true',
    INITIAL_ADMIN_USERNAME: ADMIN.username,
    INITIAL_ADMIN_PASSWORD: ADMIN.password,
    AI_PROVIDER: 'disabled',
    LOGIN_THROTTLE_LIMIT: '10000',
    THROTTLE_LIMIT: '10000',
    // 本套件核心开关：解锁 loopback 订阅 URL（云元数据段仍由闸内代码恒拒）
    EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK: 'true',
    AI_ALLOW_PRIVATE_NETWORK: 'false',
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
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON 保持 null */
  }
  return { status: res.status, body: json?.data ?? json, raw: json };
}

function startReceiver() {
  return new Promise((resolve, reject) => {
    recvServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        deliveries.push({
          path: req.url,
          event: req.headers['x-autocodeflow-event'] || '',
          signature: req.headers['x-hub-signature-256'] || '',
          ts: Date.now(),
          execId: (() => {
            try {
              return JSON.parse(raw)?.data?.executionId ?? null;
            } catch {
              return null;
            }
          })(),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    recvServer.once('error', reject);
    recvServer.listen(RECV_PORT, '127.0.0.1', () => resolve());
  });
}

/** 等待接收器累计收到 per-sub 期望条数；超时返回当前计数。 */
async function waitDeliveries(perSubExpected, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const one = deliveries.filter((d) => d.path === '/hooks/one').length;
    const two = deliveries.filter((d) => d.path === '/hooks/two').length;
    if (one >= perSubExpected && two >= perSubExpected) return { one, two };
    await sleep(500);
  }
  return {
    one: deliveries.filter((d) => d.path === '/hooks/one').length,
    two: deliveries.filter((d) => d.path === '/hooks/two').length,
  };
}

function psql(sql) {
  return run('docker', ['exec', PG_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-tAc', sql]);
}

function summary() {
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;
  console.log(`\n══ 汇总：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ══`);
  process.exit(failed > 0 ? 1 : 0);
}

function cleanup() {
  if (recvServer) {
    try {
      recvServer.close();
    } catch {
      /* ignore */
    }
  }
  for (const c of children) {
    try {
      try {
        process.kill(-c.pid, 'SIGTERM');
      } catch {
        try {
          c.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  run('sleep', ['3']);
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      try {
        c.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  if (DOCKER_MODE) run('docker', ['rm', '-f', PG_CONTAINER, REDIS_CONTAINER]);
  if (logDir && !process.env.ARCH31_KEEP_LOGS) {
    try {
      rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

async function main() {
  console.log('══ ARCH-31 双实例 outbox 重复投递边界验证 ══');

  if (DOCKER_MODE && !hasCommand('docker')) {
    skip('双实例重复投递边界', 'docker 不可用（ARCH31_SKIP_DOCKER=1 + 本机 PG/Redis 可跳过）');
    summary();
    return;
  }

  logDir = mkdtempSync(path.join(tmpdir(), 'acf-arch31dup-'));
  console.log(`日志目录：${logDir}`);

  // ── [1] 依赖服务（自愈：清残留容器）────────────────────────────────
  if (DOCKER_MODE) {
    const stale = run('docker', ['ps', '-a', '--filter', 'name=acf-arch31dup', '--format', '{{.Names}}']);
    for (const name of (stale.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
      run('docker', ['rm', '-f', name]);
    }
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
    dropFirst: true,
  });
  console.log(`依赖服务就绪（PG :${PG_PORT} / Redis :${REDIS_PORT}，库 ${DB_NAME}）`);

  // ── [2] 构建 + 迁移链（空库真跑；tsc 直出与 nest build 等价，见 multi-instance 套件注记）
  const build = run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: API_DIR });
  ok('admin-api 构建通过（dist/main.js）', build.status === 0, build.stderr || build.stdout);
  if (build.status !== 0) return summary();

  const migrate = run('npm', ['run', 'migration:run'], { cwd: API_DIR, env: baseEnv(PORT_A) });
  ok('空库迁移链真跑通过', migrate.status === 0, migrate.stderr || migrate.stdout);
  if (migrate.status !== 0) return summary();

  // ── [3] loopback 接收器 + 双实例 ────────────────────────────────────
  await startReceiver();
  ok(`loopback 接收器就绪（:${RECV_PORT}，两个订阅 URL 分别走 IP 字面量与 DNS 路径）`, true);

  for (const port of [PORT_A, PORT_B]) {
    const out = openSync(path.join(logDir, `instance-${port}.log`), 'a');
    const child = spawn('node', ['dist/main.js'], {
      cwd: API_DIR,
      env: baseEnv(port),
      stdio: ['ignore', out, out],
      detached: true,
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
        tail += `\n--- instance-${port}.log ---\n${readFileSync(path.join(logDir, `instance-${port}.log`), 'utf8').slice(-1500)}`;
      } catch {
        /* ignore */
      }
    }
    ok('双实例启动就绪', false, `${e instanceof Error ? e.message : String(e)}${tail}`);
    return summary();
  }
  ok('双实例启动就绪（共享同一 PG + Redis，均开私网豁免开关）', true);

  const tokenA = await login(PORT_A);
  const tokenB = await login(PORT_B);
  ok('双实例均可登录', !!tokenA && !!tokenB);

  // ── [4] 创建两个订阅（127.0.0.1 字面量 / localhost DNS 两校验路径）──
  const mk = async (name, url) => {
    const r = await api(PORT_A, tokenA, 'POST', '/api/event-subscriptions', {
      url,
      eventTypes: ['execution.failed'],
      secret: SUB_SECRET,
    });
    ok(`订阅 ${name}（${url}）创建成功（私网豁免开关下 loopback URL 通过 SSRF 闸）`,
      r.status === 201, `status=${r.status} body=${JSON.stringify(r.raw)?.slice(0, 200)}`);
    return r;
  };
  const subOne = await mk('one', `http://127.0.0.1:${RECV_PORT}/hooks/one`);
  const subTwo = await mk('two', `http://localhost:${RECV_PORT}/hooks/two`);
  if (subOne.status !== 201 || subTwo.status !== 201) return summary();

  // 反向锚点：未开开关的形态已由单测固化（默认姿态拒 loopback），此处不重复。

  // ── [5] 制造 N 个派发失败终态执行（无执行器在线 → BUG-21 修复后发 execution.failed）
  const task = await api(PORT_A, tokenA, 'POST', '/api/tasks', {
    name: `arch31-dup-${STAMP}`,
    triggerType: 'manual',
    runtime: 'node',
    entrypoint: 'main.js',
    maxRetry: 0,
  });
  const taskId = task.body?.id;
  ok('测试任务创建成功（maxRetry=0，无执行器 → 派发失败即终态）', task.status === 201 && !!taskId,
    `status=${task.status} body=${JSON.stringify(task.raw)?.slice(0, 200)}`);
  if (!taskId) return summary();

  for (let i = 0; i < N_EVENTS; i += 1) {
    const t = await api(PORT_A, tokenA, 'POST', `/api/tasks/${taskId}/trigger`, {});
    if (t.status !== 201 && t.status !== 200) {
      ok(`触发执行 #${i + 1}`, false, `status=${t.status} body=${JSON.stringify(t.raw)?.slice(0, 200)}`);
      return summary();
    }
  }
  ok(`触发 ${N_EVENTS} 个执行（A 实例发起）`, true);

  const waited = await waitDeliveries(N_EVENTS);
  ok(`① at-least-once 下界：两订阅各收到 ${N_EVENTS} 条（IP 字面量订阅 ${waited.one} / DNS 订阅 ${waited.two}）`,
    waited.one === N_EVENTS && waited.two === N_EVENTS,
    `收到 one=${waited.one} two=${waited.two}，期望各 ${N_EVENTS}`);

  ok('② 签名头齐备（X-Hub-Signature-256，sha256= 前缀）',
    deliveries.length > 0 && deliveries.every((d) => /^sha256=[0-9a-f]{64}$/.test(d.signature)),
    `样本=${JSON.stringify(deliveries[0])?.slice(0, 200)}`);

  // ── [6] 稳定窗：≥2 个补投扫描周期后计数不增长（快速路径收口不双发的回归锚）
  const beforeStable = { ...waited };
  await sleep(STABILIZE_MS);
  const afterStable = {
    one: deliveries.filter((d) => d.path === '/hooks/one').length,
    two: deliveries.filter((d) => d.path === '/hooks/two').length,
  };
  ok(`③ 稳定窗（${STABILIZE_MS / 1000}s ≥ 2 个补投周期）后零重复投递（恰一次语义）`,
    afterStable.one === beforeStable.one && afterStable.two === beforeStable.two,
    `稳定前 one=${beforeStable.one}/two=${beforeStable.two}，稳定后 one=${afterStable.one}/two=${afterStable.two}`);

  // ── [7] DB 层：outbox 全部结清 + 重复投递定位诊断 ─────────────────────
  const unsettled = psql('SELECT count(*) FROM event_outbox WHERE "dispatchedAt" IS NULL;');
  const totalRows = psql('SELECT count(*) FROM event_outbox;');
  ok('④ DB 层：event_outbox 全部行 dispatchedAt 已回写（双实例 claim 零残留）',
    Number(unsettled.stdout?.trim()) === 0,
    `总行=${totalRows.stdout?.trim()} 未结=${unsettled.stdout?.trim()} stderr=${unsettled.stderr?.slice(0, 120)}`);

  // 诊断：区分「补投重复投递」（行数=事件数、attempts≥2）vs「事件被 emit 两次」
  // （行数=2×事件数、attempts=1）——按 attempts 聚合打印。
  console.log('  [诊断] outbox rows total =', (totalRows.stdout || '').trim(),
    '| attempts 分布:', (psql('SELECT attempts || \'x:\' || count(*) FROM event_outbox GROUP BY attempts ORDER BY attempts;').stdout || '').trim().replace(/\n/g, ' '));
  console.log('  [诊断] 投递时间线（按执行分组）:');
  const byExec = new Map();
  for (const d of deliveries) {
    if (!byExec.has(d.execId)) byExec.set(d.execId, []);
    byExec.get(d.execId).push(d);
  }
  const t0 = deliveries[0]?.ts ?? 0;
  for (const [execId, ds] of byExec) {
    console.log(`    exec=${String(execId).slice(0, 8)}: ${ds.map((d) => `${d.path.slice(6)}@+${((d.ts - t0) / 1000).toFixed(1)}s`).join('  ')}`);
  }

  summary();
}

main().catch((e) => {
  console.error(`✘ 验证脚本异常：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
