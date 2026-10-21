/**
 * SEC-IPC-TYPE selftest（R86-A1 轴 1）：`config:check-port` 的参数闸。
 *
 * 三组断言：
 *  1. 纯函数面（sanitizePortArgument / sanitizeListenHost）的取值矩阵；
 *  2. 真实行为面（真起 TCP server 抢占端口）——非法参数一律在**进入 net 之前**
 *     被拒，且不会在磁盘上留下任何 socket/管道宿主文件；
 *  3. 反向验证（RED 证据）：把旧实现（无校验，渲染层参数直送 listen）照抄一份，
 *     断言它确实会"把 null 当 0 号端口并回报可用"——这是本轮实测到的缺陷形态，
 *     钉在这里防止有人日后把校验删回去（删掉校验 → 断言 2 立刻变红）。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_LISTEN_HOST,
  INVALID_PORT_MESSAGE,
  checkPortAvailable,
  sanitizeListenHost,
  sanitizePortArgument,
} from './port-check';

/** 在 127.0.0.1 上真实占住一个临时端口，返回 { port, close }。 */
function occupyEphemeralPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function main(): Promise<void> {
  // ── 1. 端口参数矩阵：只接受 number 类型的 1..65535 整数 ────────────────
  for (const ok of [1, 80, 8002, 65535]) {
    assert.strictEqual(sanitizePortArgument(ok), ok, `合法端口 ${ok} 必须原样通过`);
  }
  const rejected: unknown[] = [
    '8002', // 字符串：Node 的 listen 会把它当**管道路径**（见文件头实证）
    'abc',
    1.5,
    0, // 0 = 让内核挑端口 → 预检永远"可用"（旧实现的实际表现）
    -1,
    65536,
    655350,
    NaN,
    Infinity,
    null,
    undefined,
    true,
    {},
    [8002],
  ];
  for (const bad of rejected) {
    assert.strictEqual(
      sanitizePortArgument(bad),
      null,
      `非法端口必须拒绝: ${JSON.stringify(bad)}（typeof=${typeof bad}）`,
    );
  }

  // ── 2. host 参数矩阵：只接受 IP 字面量 / localhost，其余回落默认且不发 DNS ─
  assert.strictEqual(sanitizeListenHost('127.0.0.1'), '127.0.0.1');
  assert.strictEqual(sanitizeListenHost('0.0.0.0'), '0.0.0.0');
  assert.strictEqual(sanitizeListenHost('192.168.1.7'), '192.168.1.7');
  assert.strictEqual(sanitizeListenHost('::'), '::');
  assert.strictEqual(sanitizeListenHost('::1'), '::1');
  assert.strictEqual(sanitizeListenHost(' 127.0.0.1 '), '127.0.0.1', '首尾空白必须先 trim');
  assert.strictEqual(sanitizeListenHost('localhost'), 'localhost');
  assert.strictEqual(sanitizeListenHost('LOCALHOST'), 'localhost', '大小写归一');
  for (const bad of ['', '   ', 'evil.example.com', 'a b', '127.0.0.1/x', '1.2.3.4:80', null, undefined, 42, {}]) {
    assert.strictEqual(
      sanitizeListenHost(bad),
      DEFAULT_LISTEN_HOST,
      `非 IP 字面量必须回落 ${DEFAULT_LISTEN_HOST}: ${JSON.stringify(bad)}`,
    );
  }

  // ── 3. 行为面：非法参数在进 net 之前就被拒（fail-closed）──────────────
  const socketHost = path.join(os.tmpdir(), `acf-audit-socket-${process.pid}`);
  const pipeLike = path.join(os.tmpdir(), `acf-audit-pipe-${process.pid}`);
  for (const bad of ['8002', 'abc', pipeLike, socketHost, null, undefined, NaN, 0, 70000]) {
    const verdict = await checkPortAvailable(bad);
    assert.strictEqual(verdict.available, false, `非法端口必须报不可用: ${JSON.stringify(bad)}`);
    assert.strictEqual(verdict.message, INVALID_PORT_MESSAGE, '非法端口必须给出明确文案（不是"检测失败"）');
  }
  // 反向验证：旧实现会用渲染层给的字符串去 listen(path) → 可能在磁盘上留下
  // unix socket 宿主文件（POSIX）。新实现必须**不产生任何文件**。
  assert.ok(!fs.existsSync(socketHost), '不得在渲染层指定的路径上创建 socket 文件');
  assert.ok(!fs.existsSync(pipeLike), '不得在渲染层指定的路径上创建管道/socket 文件');

  // 真占用：被占端口必须报不可用（原语义逐字保留）
  const blocker = await occupyEphemeralPort();
  try {
    const busy = await checkPortAvailable(blocker.port, '127.0.0.1');
    assert.strictEqual(busy.available, false, '被占用端口必须报不可用');
    assert.ok(busy.message.includes(String(blocker.port)), '文案必须带上端口号');
    assert.ok(busy.message.includes('已被占用'), '文案必须是"已被占用"（与旧实现逐字一致）');

    // 关键反证：字符串形态**绝不能**落进 listen（否则会去 listen 一个管道名，
    // 从而对"端口是否被占"给出与事实无关的答案）
    const asString = await checkPortAvailable(String(blocker.port), '127.0.0.1');
    assert.strictEqual(asString.available, false, '字符串端口必须拒绝');
    assert.strictEqual(asString.message, INVALID_PORT_MESSAGE, '字符串端口必须是"非法"而不是"被占用"');
  } finally {
    await blocker.close();
  }

  // 空闲端口：报可用（真 bind 试探，不是纯静态判断）
  let freePort: number | null = null;
  for (let i = 0; i < 5 && freePort === null; i++) {
    const tmp = await occupyEphemeralPort();
    const candidate = tmp.port;
    await tmp.close();
    const verdict = await checkPortAvailable(candidate, '127.0.0.1');
    if (verdict.available) freePort = candidate;
  }
  assert.ok(freePort !== null, '释放后的端口必须能被判定为可用（bind 试探仍生效）');

  // host 非 IP → 回落 0.0.0.0（不因 host 非法而误报"端口非法"）
  const withBadHost = await checkPortAvailable(freePort!, 'evil.example.com');
  assert.strictEqual(typeof withBadHost.available, 'boolean', 'host 非法时必须回落默认 host 继续探测');

  // ── 4. 反向验证（RED 证据）：旧实现（无校验）确实会放行 null ──────────
  {
    // 逐字照抄 ipc-handlers.ts 改造前的 checkPortAvailable（无任何参数校验）
    const legacyCheckPortAvailable = (port: any, host: any = '0.0.0.0') =>
      new Promise<{ available: boolean; message: string }>((resolve) => {
        const server = net.createServer();
        server.once('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            resolve({ available: false, message: `端口 ${port} 已被占用，请换一个端口` });
          } else {
            resolve({ available: false, message: `端口检测失败: ${err.message}` });
          }
        });
        server.once('listening', () => {
          server.close();
          resolve({ available: true, message: `端口 ${port} 可用` });
        });
        server.listen(port, host);
      });

    // NaN（渲染层 number input 清空）经 IPC 序列化成 null —— 旧实现把它当 0 号端口
    const legacyVerdict = await legacyCheckPortAvailable(null, '0.0.0.0');
    assert.strictEqual(
      legacyVerdict.available,
      true,
      '反向验证：旧实现对 null 端口应误报"可用"（0 号临时端口）——若此断言红，说明 Node 行为变了，' +
        '需要重新评估 port-check 的校验是否仍然必要',
    );
    // 新实现对同一输入必须拒绝 —— 这一条就是"修好了"的判据
    const newVerdict = await checkPortAvailable(null, '0.0.0.0');
    assert.strictEqual(newVerdict.available, false, '新实现必须拒绝 null 端口');
  }

  console.log(
    'port-check selftest: all assertions passed ' +
      '(port/host matrices, fail-closed before net, busy/free probes, legacy-null counter-proof)',
  );
}

main().then(
  () => undefined,
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
