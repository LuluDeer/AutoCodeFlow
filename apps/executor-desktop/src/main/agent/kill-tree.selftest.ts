/**
 * P7b self-check：进程树终止。
 * Run via: npm run test:main
 *
 * 反证锚点：
 *   · 超时必须杀**整棵树**——候选代码 spawn 的孙进程若存活，闸门对树形
 *     泄漏形同虚设（P7a 残差：Windows kill() 只杀单进程）；
 *   · 树已自行退出 → killTree 仍是成功语义（不因 ESRCH 报错）；
 *   · 正常退出路径不受影响。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { killTree, spawnWithTreeTimeout } from './kill-tree';
import { runTrialInSandbox, buildTrialEnv } from './trial-run';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('\n=== kill-tree selftest ===\n');

  console.log('-- 1. 语义 --');
  {
    const ok = await killTree(99999999);
    check('不存在的 pid → true（已死即成功语义，不因 ESRCH 失败）', ok === true);
    const bad = await killTree(0);
    check('非法 pid → false', bad === false);
  }

  console.log('-- 2. 超时整组终止（单层）--');
  {
    const res = await spawnWithTreeTimeout(
      process.execPath,
      ['-e', 'const t = Date.now(); while (Date.now() - t < 30000) {}'],
      { cwd: os.tmpdir(), env: { ...process.env } },
      800,
    );
    check('失控进程被超时终止', res.timedOut === true && res.killed === true && res.exitCode === null);
  }

  console.log('-- 3. 超时整组终止（树：候选代码 spawn 孙进程）--');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tree-'));
    // 候选代码：spawn 一个孙进程（死循环），把自己的 pid 与孙 pid 落盘
    fs.writeFileSync(
      path.join(ws, 'spawner.js'),
      [
        "const { spawn } = require('child_process');",
        "const fs = require('fs');",
        "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);",
        "fs.writeFileSync('pids.txt', JSON.stringify({ self: process.pid, grand: g.pid }));",
        'setInterval(()=>{}, 1000);',
      ].join('\n'),
      'utf8',
    );
    const r = await runTrialInSandbox({
      workspaceRoot: ws,
      interpreter: 'node',
      entryPath: 'spawner.js',
      timeoutMs: 1500,
      codeExecution: 'sandbox',
    });
    check('候选树被超时终止', r.timedOut === true, `ok=${r.ok} stderr=${r.stderr.slice(0, 100)}`);
    const pids = JSON.parse(fs.readFileSync(path.join(ws, 'pids.txt'), 'utf8')) as { self: number; grand: number };
    await sleep(500); // 给终止信号传播留时间
    check('孙进程也死了（树杀而非单杀——P7a 残差修复）', !alive(pids.grand), `grand=${pids.grand} stillAlive=${alive(pids.grand)}`);
    check('直接子进程死了', !alive(pids.self));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('-- 4. 正常路径不受影响 --');
  {
    const res = await spawnWithTreeTimeout(
      process.execPath,
      ['-e', 'console.log("fine")'],
      { cwd: os.tmpdir(), env: buildTrialEnv('node') },
      5000,
    );
    check('正常退出：timedOut=false', res.timedOut === false && res.exitCode === 0 && res.errorMessage === null);

    const missing = await spawnWithTreeTimeout(
      process.platform === 'win32' ? 'definitely-not-a-real-cmd-xyz' : 'definitely-not-a-real-cmd-xyz',
      [],
      { cwd: os.tmpdir(), env: { ...process.env } },
      3000,
    );
    check('解释器不存在 → errorMessage 透传、exitCode null', missing.exitCode === null && missing.errorMessage !== null && missing.timedOut === false);
  }

  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== kill-tree selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
