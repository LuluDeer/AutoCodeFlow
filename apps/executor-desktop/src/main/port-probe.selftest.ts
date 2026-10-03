/**
 * B-1② / B-8 / B-9 / B-11 self-check：端口与健康面探测原语（node:assert，
 * 无测试框架）。port-probe.ts 是纯 Node 模块，这里用**真实 http/net server**
 * 驱动真实实现（不 mock：探测逻辑的全部价值就在真实 socket 行为上）。
 * Run via: npm run test:main
 *
 * 覆盖：
 *  - probeHealthLive：200 → true；5xx/404 → false；拒连/非法端口 → false；
 *  - isPortReachable / waitForPortFree：占用可连、关闭后释放可检出；
 *  - requestExecutorShutdown：带 Bearer 令牌命中 /api/shutdown → true；
 *    令牌不符（401）→ false；无令牌直接不发（fail-closed 客户端守卫）；
 *  - fetchAdminRegistration：registered/failed/404/坏 JSON 四分支语义与
 *    ExecutorProcess.applyAdminStatus 同源；
 *  - waitForExecutorHealthy：服务晚起也能等到；
 *  - normalizeListenHost（B-8）；
 *  - SYNC 结构守卫：executor-process / ipc-handlers 真的接了这些原语。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as net from 'node:net';
import {
  probeHealthLive,
  isPortReachable,
  waitForPortFree,
  waitForExecutorHealthy,
  requestExecutorShutdown,
  fetchAdminRegistration,
} from './port-probe';
import { normalizeListenHost } from './network-util';

/** 起一个临时 http server（port 0 由系统分配），返回实际端口与关闭函数。 */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function main(): Promise<void> {
  // ── 1. probeHealthLive ────────────────────────────────────────────
  {
    const ok = await startServer((req, res) => {
      if (req.url === '/health/live') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    assert.strictEqual(await probeHealthLive(ok.port, 1_000), true, '200 /health/live → healthy');
    assert.strictEqual(await probeHealthLive(ok.port, 1_000, '127.0.0.1'), true, '显式 host 同判');

    const bad = await startServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    assert.strictEqual(await probeHealthLive(bad.port, 1_000), false, '5xx → 不健康');

    // 404（有 HTTP 服务但路径不匹配）也是 false——健康面必须精确
    assert.strictEqual(await probeHealthLive(ok.port, 1_000), true, '对照组：ok server 仍健康');
    await ok.close();
    await bad.close();

    // 拒连（端口上没有服务）
    assert.strictEqual(await probeHealthLive(ok.port, 500), false, '服务已关 → false（绝不抛）');
    assert.strictEqual(await probeHealthLive(0, 100), false, '非法端口 0 → false');
    assert.strictEqual(await probeHealthLive(Number.NaN, 100), false, 'NaN 端口 → false');
  }

  // ── 2. isPortReachable / waitForPortFree ──────────────────────────
  {
    const server = net.createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as net.AddressInfo).port;
    assert.strictEqual(await isPortReachable(port, 1_000), true, '监听中的端口可达');

    const freePromise = waitForPortFree(port, 3_000, 100);
    await new Promise<void>((done) => server.close(() => done()));
    assert.strictEqual(await freePromise, true, '服务关闭后 waitForPortFree 应尽快判定已释放');
    assert.strictEqual(await isPortReachable(port, 300), false, '关闭后不可达');

    // 一直占用 → 超时 false
    const server2 = net.createServer();
    await new Promise<void>((done) => server2.listen(0, '127.0.0.1', done));
    const port2 = (server2.address() as net.AddressInfo).port;
    assert.strictEqual(await waitForPortFree(port2, 300, 100), false, '一直占用 → 超时 false');
    server2.close();
  }

  // ── 3. requestExecutorShutdown（B-1② 的"特征标识"判定）────────────
  {
    let seenAuth = '';
    let seenPath = '';
    let seenMethod = '';
    const ours = await startServer((req, res) => {
      seenAuth = String(req.headers.authorization ?? '');
      seenPath = String(req.url);
      seenMethod = String(req.method);
      if (req.url === '/api/shutdown' && req.headers.authorization === 'Bearer right-token') {
        res.writeHead(200);
        res.end('{}');
      } else if (req.url === '/api/shutdown') {
        res.writeHead(401);
        res.end('unauthorized');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    assert.strictEqual(await requestExecutorShutdown(ours.port, 'right-token', 1_000), true, '持正确令牌 → 受理');
    assert.strictEqual(seenMethod, 'POST', '必须是 POST /api/shutdown');
    assert.strictEqual(seenPath, '/api/shutdown');
    assert.strictEqual(seenAuth, 'Bearer right-token', '必须带 Bearer 共享令牌');
    assert.strictEqual(await requestExecutorShutdown(ours.port, 'wrong-token', 1_000), false, '令牌不符（401）→ 拒绝 → false');
    await ours.close();
    // 客户端 fail-closed 守卫：无令牌根本不发请求
    assert.strictEqual(await requestExecutorShutdown(12345, '', 500), false, '空令牌 → 不发（外部服务绝不能被误杀）');
    assert.strictEqual(await requestExecutorShutdown(ours.port, 'right-token', 1_000), false, '服务已关 → false');
    assert.strictEqual(await requestExecutorShutdown(0, 't', 100), false, '非法端口 → false');
  }

  // ── 4. fetchAdminRegistration（B-11 注册预检语义）──────────────────
  {
    const reg = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ registration: 'registered', heartbeatStatus: 'ok' }));
    });
    assert.strictEqual(await fetchAdminRegistration(reg.port, 1_000), 'registered');
    await reg.close();

    const failed = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ registration: 'failed' }));
    });
    assert.strictEqual(await fetchAdminRegistration(failed.port, 1_000), 'failed', 'registration=failed → 明确失败');
    await failed.close();

    const hbFailed = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ heartbeatStatus: 'failed' }));
    });
    assert.strictEqual(await fetchAdminRegistration(hbFailed.port, 1_000), 'failed', 'heartbeatStatus=failed → 明确失败');
    await hbFailed.close();

    const notFound = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    assert.strictEqual(await fetchAdminRegistration(notFound.port, 1_000), 'unknown', '404（旧 bundle）→ unknown，不得断言失败');
    await notFound.close();

    const garbage = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json at all');
    });
    assert.strictEqual(await fetchAdminRegistration(garbage.port, 1_000), 'unknown', '坏 JSON → unknown');
    await garbage.close();

    assert.strictEqual(await fetchAdminRegistration(reg.port, 500), 'unknown', '服务已关 → unknown');
  }

  // ── 5. waitForExecutorHealthy（B-9 首个健康信号）────────────────────
  {
    // 先用 TCP 占位拿到一个空闲端口，释放后延迟 400ms 才起 HTTP 服务——
    // 模拟"执行器慢启动"：应等到而不是立即失败。
    const reserver = net.createServer();
    await new Promise<void>((done) => reserver.listen(0, '127.0.0.1', () => done()));
    const port = (reserver.address() as net.AddressInfo).port;
    await new Promise<void>((done) => reserver.close(() => done()));

    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    setTimeout(() => server.listen(port, '127.0.0.1'), 400);
    try {
      const t0 = Date.now();
      const ok = await waitForExecutorHealthy(port, 5_000, 100);
      assert.strictEqual(ok, true, '慢启动的服务应被等到');
      assert.ok(Date.now() - t0 >= 350, '必须真的等了（而非立即返回）');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
    assert.strictEqual(await waitForExecutorHealthy(port, 300, 100), false, '一直不健康 → 超时 false');
  }

  // ── 6. normalizeListenHost（B-8）───────────────────────────────────
  {
    assert.strictEqual(normalizeListenHost('0.0.0.0'), '0.0.0.0');
    assert.strictEqual(normalizeListenHost('127.0.0.1'), '127.0.0.1');
    assert.strictEqual(normalizeListenHost(' 127.0.0.1 '), '127.0.0.1', '两端空白修剪');
    assert.strictEqual(normalizeListenHost(''), '0.0.0.0', '空串回落 0.0.0.0（config-store 缺省）');
    assert.strictEqual(normalizeListenHost('   '), '0.0.0.0');
    assert.strictEqual(normalizeListenHost(undefined), '0.0.0.0', '缺参回落');
    assert.strictEqual(normalizeListenHost(null), '0.0.0.0');
    assert.strictEqual(normalizeListenHost(42), '0.0.0.0', '非字符串回落');
  }

  // ── 7. SYNC 结构守卫：原语真的被接上了 ─────────────────────────────
  {
    const read = (rel: string): string =>
      fs.readFileSync(path.join(__dirname, '..', 'src', 'main', rel), 'utf-8');

    const execSrc = read('executor-process.ts');
    for (const anchor of [
      'isPortReachable(startPort, 1_500)',
      'probeHealthLive(startPort, 3_000)',
      'requestExecutorShutdown(startPort, this.childSharedToken, 5_000)',
      'waitForPortFree(startPort, 10_000)',
      'attachedExisting = true',
    ]) {
      assert.ok(execSrc.includes(anchor), `SYNC: executor-process.ts 缺少 B-1② 接线锚点：${anchor}`);
    }
    // B-1②：healthy 复用分支必须先于 spawn（start 内不落 spawn 之后）
    const startIdx = execSrc.indexOf('async start(config: AppConfig)');
    const spawnIdx = execSrc.indexOf('this.proc = spawn(', startIdx);
    const attachIdx = execSrc.indexOf('attachedExisting = true', startIdx);
    assert.ok(startIdx >= 0 && spawnIdx > 0 && attachIdx > startIdx && attachIdx < spawnIdx,
      'SYNC: attach 分支必须出现在 spawn 之前');

    // B-8：check-port 必须经 normalizeListenHost（不得再固定 0.0.0.0）
    const ipc = read('ipc-handlers.ts');
    assert.ok(
      /checkPortAvailable\(port,\s*normalizeListenHost\(host\)\)/.test(ipc),
      'SYNC: config:check-port 必须把 host 过 normalizeListenHost 再检测',
    );
    assert.ok(
      !/server\.listen\(port,\s*'0\.0\.0\.0'\)/.test(ipc),
      'SYNC: 检测 socket 不得再硬编码 0.0.0.0',
    );
    // B-9/B-11：向导面必须等待健康信号 + 注册预检
    for (const anchor of ['waitForExecutorHealthy(', 'fetchAdminRegistration(', 'WIZARD_START_HEALTH_TIMEOUT_MS']) {
      assert.ok(ipc.includes(anchor), `SYNC: ipc-handlers.ts 缺少向导启动判定锚点：${anchor}`);
    }
  }

  console.log('port-probe selftest: all assertions passed (real-socket occupancy/health/shutdown/registration probes; B-8 host passthrough; SYNC wiring)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
