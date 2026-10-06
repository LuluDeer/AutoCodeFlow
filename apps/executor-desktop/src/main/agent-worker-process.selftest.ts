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

(async () => {
  await testFakeWorkerRoundTrip();
  await testCrashAndSelfHeal();
  await testRealBundleSmoke();
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  console.log('agent-worker-process.selftest: all assertions passed');
  process.exit(0);
})().catch((err) => {
  console.error('agent-worker-process.selftest FAILED:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
