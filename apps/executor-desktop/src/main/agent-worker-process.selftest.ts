/**
 * N-06①：agent-worker 主进程侧 handle 守卫——真 spawn、真协议、真自愈。
 *
 * 三层：
 *   A. 假 worker（本用例现场写入 tmpdir 的 .cjs）钉协议往返/统计推送/优雅
 *      退出/意外退出收敛与畸形事件容错；
 *   B. 假 worker 崩溃 → tick 自愈重启（in-place 换脚本文件）；
 *   C. **真 bundle 冒烟**（test:main 链先跑 build:agent-worker）：ELECTRON_
 *      RUN_AS_NODE 形态下 worker 可启动、packageRoot 契约（browsers.json
 *      可读）成立、对不可达中台如实收敛 poll 失败——打包布局契约每一次
 *      test:main 都被真实复验，bundle 布局漂移即红。
 * Run via: npm run test:main
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentWorkerHandle } from './agent-worker-process';

const WATCHDOG_MS = 60_000;
const watchdog = setTimeout(() => {
  console.error('agent-worker-process.selftest: WATCHDOG TIMEOUT — a worker never settled');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

const quietLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 协议脚本模板：STAGE 控制行为分叉（init 后是否崩溃、tick 返回什么）。 */
function fakeWorkerSource(stage: string): string {
  return `
'use strict';
const readline = require('readline');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
send({ t: 'ready', playwrightContract: { browsersJson: false } });
let statsWorking = false;
setInterval(() => {
  if (statsWorking) send({ t: 'stats', stats: { working: false, lastAssignmentId: 'fake', lastOutcome: null, processed: 1, lastEffectiveProfile: null } });
}, 50).unref();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  switch (req.t) {
    case 'init':
      if (${JSON.stringify(stage)} === 'crash-on-init') process.exit(9);
      statsWorking = true;
      send({ t: 'stats', stats: { working: false, lastAssignmentId: null, lastOutcome: null, processed: 0, lastEffectiveProfile: null } });
      return;
    case 'tick':
      // B：'no-tick-result' = 「收到了 tick 却永不回结果」的卡死形态。
      if (${JSON.stringify(stage)} === 'no-tick-result') return;
      send({ t: 'tick-result', worked: true, detail: 'fake-tick' });
      send({ t: 'not-a-known-event', junk: true }); // 畸形事件不得影响后续协议
      return;
    case 'withdraw':
      send({ t: 'withdraw-done' });
      return;
    case 'shutdown':
      setTimeout(() => process.exit(0), 30);
      return;
  }
});
process.stdin.on('close', () => process.exit(0));
`;
}

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-agent-worker-selftest-'));
const FAKE_ENTRY = path.join(WORKDIR, 'fake-worker.cjs');
fs.writeFileSync(FAKE_ENTRY, fakeWorkerSource('ok'));

const CONFIG = {
  agentEnabled: true,
  adminApiUrl: 'http://127.0.0.1:9',
  executorToken: 'selftest-token',
  agent: { preset: 'standard' },
} as const;

function makeHandle(entry: string, onUnexpectedExit?: () => void): AgentWorkerHandle {
  return new AgentWorkerHandle({
    address: 'selftest:1',
    workDir: WORKDIR,
    config: { ...CONFIG },
    entryPath: entry,
    spawnEnv: { ...process.env },
    log: quietLog,
    onUnexpectedExit,
  });
}

async function testFakeWorkerRoundTrip(): Promise<void> {
  const statsSeen: number[] = [];
  const h = new AgentWorkerHandle({
    address: 'selftest:1',
    workDir: WORKDIR,
    config: { ...CONFIG },
    entryPath: FAKE_ENTRY,
    spawnEnv: { ...process.env },
    log: quietLog,
    onStats: (s) => statsSeen.push(s.processed),
  });
  const ready = await h.start();
  assert.strictEqual(ready.t, 'ready');

  const tick = await h.tick();
  assert.deepStrictEqual(tick, { worked: true, detail: 'fake-tick' });

  // 畸形事件不毒化协议流：第二发 tick 照常往返
  const tick2 = await h.tick();
  assert.strictEqual(tick2.worked, true);

  assert.ok(statsSeen.length >= 1, 'stats 消息必须到达 onStats 回调');

  await h.withdraw();

  const exitPromise = h.shutdownWhenIdle();
  await exitPromise;
  assert.strictEqual(h.alive, false);
}

async function testCrashAndSelfHeal(): Promise<void> {
  fs.writeFileSync(FAKE_ENTRY, fakeWorkerSource('crash-on-init'));
  const unexpected: number[] = [];
  const h = makeHandle(FAKE_ENTRY, () => unexpected.push(1));
  await h.start();
  // worker 在 init 即退出(9)：tick 的在飞请求必须被 exit 收敛，不得悬挂
  const first = await h.tick();
  assert.strictEqual(first.worked, false);
  assert.ok(
    (first.detail ?? '').includes('worker exited during tick') ||
      (first.detail ?? '').includes('respawn failed'),
    `crash 必须如实收敛，实际 detail=${first.detail}`,
  );
  assert.strictEqual(h.alive, false);
  assert.ok(unexpected.length >= 1, '意外退出必须触发 onUnexpectedExit');

  // 原地换回健康脚本：下一次 tick 自愈重启并恢复正常往返
  fs.writeFileSync(FAKE_ENTRY, fakeWorkerSource('ok'));
  const healed = await h.tick();
  assert.strictEqual(healed.worked, true, `自愈重启后 tick 必须恢复，实际 detail=${healed.detail}`);
  h.kill();
}

/**
 * B：tick 看门狗——worker 收到 tick 却永不回 tick-result。
 *
 * 现实形态：stdin 半死 / worker 主循环被浏览器子进程堵死。旧实现里 tickPending
 * 永不落定 ⇒ single-flight 永久成立 ⇒ index.ts 跳过后续所有 tick（托管永久空转），
 * 身份状态机看到 tickInFlight 恒真而永久 defer（旧 token / 旧 workDir 继续收单）。
 *
 * 断言三件事：① tick 必须**落定**为超时形态（不 reject、不悬挂）；
 * ② 同一轮触发 kill（日志 + alive 归 false）；③ 下一次 tick 自愈重启。
 * 用 tickTimeoutMs=150 注入缩短超时（生产值 2h15m，见 TICK_WATCHDOG_MS），
 * 另用 5s 的 Promise.race 兜住"根本没落定"的坏形态，避免用例挂死。
 * 反证：删掉 tick() 里的 armTickWatchdog() 调用 → 本例在 5s 上限处转红。
 */
async function testTickWatchdog(): Promise<void> {
  const entry = path.join(WORKDIR, 'stalled-worker.cjs');
  fs.writeFileSync(entry, fakeWorkerSource('no-tick-result'));
  const errors: string[] = [];
  const h = new AgentWorkerHandle({
    address: 'selftest:1',
    workDir: WORKDIR,
    config: { ...CONFIG, executorToken: 'sk-secret-token-abcdef' },
    entryPath: entry,
    spawnEnv: { ...process.env },
    log: { ...quietLog, error: (m) => errors.push(m) },
    tickTimeoutMs: 150,
  });
  await h.start();
  assert.strictEqual(h.alive, true, '假 worker 必须起来');

  const settled = await Promise.race([
    h.tick(),
    new Promise<{ worked: boolean; detail?: string }>((_, reject) =>
      setTimeout(() => reject(new Error('tick 在看门狗到点后仍未落定')), 5_000)),
  ]);
  assert.strictEqual(settled.worked, false, '超时 tick 必须如实回 worked:false');
  assert.ok(
    (settled.detail ?? '').includes('tick timeout'),
    `超时形态的 detail 必须写明 tick timeout，实际 detail=${settled.detail}`,
  );
  // 同轮 kill 的判据：日志（同步写入）+ alive 最终归 false（exit 事件异步到达）
  assert.ok(
    errors.some((m) => m.includes('tick watchdog fired')),
    '看门狗到点必须记一条 error 日志（同轮触发 kill 的证据）',
  );
  assert.ok(
    !errors.some((m) => m.includes('sk-secret-token')),
    '看门狗日志只记超时与毫秒数，不得把载荷（token）写进日志',
  );
  const deadBy = Date.now() + 2_000;
  while (h.alive && Date.now() < deadBy) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(h.alive, false, '看门狗到点必须 kill worker（否则后续 tick 继续被 single-flight 挡掉）');

  // 自愈：换回健康脚本后下一次 tick 走 !alive 分支 respawn 并恢复往返
  fs.writeFileSync(entry, fakeWorkerSource('ok'));
  const healed = await h.tick();
  assert.strictEqual(healed.worked, true, `看门狗 kill 后 tick 必须自愈重启，实际 detail=${healed.detail}`);
  h.kill();
}

async function testRealBundleSmoke(): Promise<void> {
  const entry = path.join(__dirname, '..', 'resources', 'agent-worker', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(
      'real bundle missing: resources/agent-worker/dist/index.js — ' +
        'test:main 链先跑 build:agent-worker；missing 即红，绝不静默跳过',
    );
  }
  const h = new AgentWorkerHandle({
    address: 'selftest:1',
    workDir: WORKDIR,
    config: { ...CONFIG },
    entryPath: entry,
    spawnEnv: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    log: quietLog,
  });
  const ready = await h.start();
  // packageRoot 契约（bundle 在 <X>/dist/、两个 JSON 在 <X>/）——打包布局的
  // 每次真实复验点：漂移即红。
  assert.strictEqual(
    ready.playwrightContract.browsersJson, true,
    'worker bundle 必须能在运行时读到 packageRoot/browsers.json（bundle 布局契约）',
  );
  // 对不可达中台（127.0.0.1:9）：host 的失败收敛面如实落到 tick-result，
  // 绝不悬挂、绝不伪装成功。
  const tick = await Promise.race([
    h.tick(),
    new Promise<{ worked: boolean; detail?: string }>((_, reject) =>
      setTimeout(() => reject(new Error('real-bundle tick hung — worker/host convergence broken')), 30_000)),
  ]);
  assert.strictEqual(tick.worked, false);
  assert.ok(
    (tick.detail ?? '').includes('poll failed') || (tick.detail ?? '').includes('capability failed'),
    `不可达中台必须收敛为如实失败，实际 detail=${tick.detail}`,
  );
  h.kill();
}

async function testDeadPipeLogRedaction(): Promise<void> {
  // P3-1：死管道日志只记消息类型不记载荷——config 消息携带 executorToken，
  // 旧实现 `line.slice(0, 80)` 会把 token 前缀写进 electron-log。
  // （公开调用方都先判 alive，死分支是防御性的——经类型化缝隙直击 writeLine，
  //  锚定「一旦命中，载荷绝不入日志」的红线。）
  const warns: string[] = [];
  const h = new AgentWorkerHandle({
    address: 'selftest:1',
    workDir: WORKDIR,
    config: { ...CONFIG, executorToken: 'sk-secret-token-abcdef' },
    entryPath: FAKE_ENTRY,
    spawnEnv: { ...process.env },
    log: { info: () => undefined, warn: (m) => warns.push(m), error: () => undefined },
  });
  assert.strictEqual(h.alive, false, '从未 start 的 handle 必须是 dead 态');
  const writeLine = (h as unknown as { writeLine: (line: string) => void }).writeLine.bind(h);
  writeLine(JSON.stringify({ t: 'config', config: { ...CONFIG, executorToken: 'sk-secret-token-abcdef' } }));
  assert.strictEqual(warns.length, 1, `死管道写入必须记一条 warn，实际 ${warns.length}`);
  assert.ok(warns[0].includes('t=config'), `日志必须含消息类型 t=config，实际：${warns[0]}`);
  assert.ok(!warns[0].includes('sk-secret-token'), `载荷（token）绝不能进日志：${warns[0]}`);
  assert.ok(!warns[0].includes('adminApiUrl'), `载荷（配置体）不能进日志：${warns[0]}`);
  // 非协议行（烂行）→ 如实记 unparseable，也不回显内容
  writeLine('not-json-at-all');
  assert.ok(warns[1].includes('t=unparseable') && !warns[1].includes('not-json-at-all'), `烂行形态：${warns[1]}`);
}

/**
 * PIPE-EPIPE（2026-10-27 审计轮 #7）：管道断开不得升级为 uncaughtException。
 *
 * 现实形态：worker 退出（自愈重启 / SIGKILL 兜底）与 30s tick 的 write 之间
 * 没有同步，写一个已断开的管道会 emit 'error'；无监听者时 Node 视为
 * uncaughtException → crash-guard 退出整个桌面端（用户视角："RPA 客户端自己关了"）。
 *
 * 为什么要临时接管 uncaughtException：该失败**不是**能被 try/catch 捕获的同步
 * 抛出，而是 EventEmitter 的 'error' 事件在下一 tick 无人接收才升级——只有
 * "先抢下 uncaughtException，再看它有没有被触发"才能把失败变成断言。
 * 反证（实测）：注释掉 start() 里的 child.stdin?.on('error') → captured 非 null，本例转红。
 */
async function testStdinErrorIsContained(): Promise<void> {
  const h = new AgentWorkerHandle({
    address: '127.0.0.1:9999',
    workDir: WORKDIR,
    config: { ...CONFIG, executorToken: 'sk-secret-token-abcdef' },
    entryPath: FAKE_ENTRY,
    spawnEnv: { ...process.env },
    log: quietLog,
  });
  await h.start();
  assert.strictEqual(h.alive, true, '假 worker 必须起来');

  const child = (h as unknown as { child: import('node:child_process').ChildProcess })
    .child;
  assert.ok(child?.stdin, 'worker stdin 必须存在');

  let captured: unknown = null;
  const onUncaught = (err: unknown) => {
    captured = err;
  };
  process.on('uncaughtException', onUncaught);
  try {
    // 真实故障形态：管道已断开，而 handle 仍然认为活着。
    child.stdin.destroy(new Error('EPIPE (simulated)'));
    const writeLine = (h as unknown as { writeLine: (line: string) => void })
      .writeLine.bind(h);
    writeLine(JSON.stringify({ t: 'tick' }));
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    process.removeListener('uncaughtException', onUncaught);
  }
  assert.strictEqual(
    captured,
    null,
    '管道 error 必须被 start() 的 stdin 监听吞掉，不得升级为 uncaughtException（否则 crash-guard 会退出整个桌面端）',
  );
  h.kill();
}

(async () => {
  await testFakeWorkerRoundTrip();
  await testCrashAndSelfHeal();
  await testDeadPipeLogRedaction();
  await testStdinErrorIsContained();
  await testTickWatchdog();
  await testRealBundleSmoke();
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  console.log('agent-worker-process.selftest: all assertions passed');
  process.exit(0);
})().catch((err) => {
  console.error('agent-worker-process.selftest FAILED:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
