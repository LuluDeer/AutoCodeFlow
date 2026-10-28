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
import {
  inFlightTreeCount,
  killInFlightTreesSync,
  killTree,
  spawnDetached,
  spawnWithTreeTimeout,
  sweepStaleTrialTrees,
  TRIAL_RECORD_FILENAME,
} from './kill-tree';
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
    // P2-4：在飞登记文件在试跑正常收敛后必须被清掉（不留垃圾、不进候选包）
    check('试跑结束后登记文件已删除', !fs.existsSync(path.join(ws, TRIAL_RECORD_FILENAME)), TRIAL_RECORD_FILENAME);
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

  console.log('-- 5. P2-4：在飞登记 + 退出路径整组补杀 --');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orphan-'));
    const recordFile = path.join(ws, TRIAL_RECORD_FILENAME);
    // 候选树：spawn 孙进程 + 落盘 pid；30s 超时 —— 走「worker 死亡」的同款形态
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
    const pending = spawnWithTreeTimeout(
      process.execPath,
      [path.join(ws, 'spawner.js')],
      { cwd: ws, env: buildTrialEnv('node'), recordFile: recordFile },
      30_000,
    );
    // 等树真正起来（pids.txt 出现 = 父子都已 spawn）
    for (let i = 0; i < 50 && !fs.existsSync(path.join(ws, 'pids.txt')); i++) await sleep(100);
    const pids = JSON.parse(fs.readFileSync(path.join(ws, 'pids.txt'), 'utf8')) as { self: number; grand: number };
    check('在飞登记计数 = 1', inFlightTreeCount() === 1, `count=${inFlightTreeCount()}`);
    check('登记文件已落盘（worker 死亡后清扫的输入）', fs.existsSync(recordFile));
    const killed = killInFlightTreesSync();
    check('killInFlightTreesSync 报告击杀 1 棵树', killed === 1, `killed=${killed}`);
    check('击杀后登记清空', inFlightTreeCount() === 0);
    await sleep(500);
    check('worker「死亡」后孤儿树被补杀（父进程）', !alive(pids.self), `self=${pids.self} stillAlive=${alive(pids.self)}`);
    check('孤儿树被补杀（孙进程——树杀非单杀）', !alive(pids.grand), `grand=${pids.grand} stillAlive=${alive(pids.grand)}`);
    const res = await pending;
    check('被补杀的 spawn 以收敛语义结算（不悬挂）', res.exitCode !== undefined, JSON.stringify(res));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('-- 6. P2-4：启动清扫（Linux only——/proc 归属校验）--');
  if (process.platform === 'linux') {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agent-sweep-'));
    const asgDir = path.join(root, 'asg-1');
    fs.mkdirSync(asgDir, { recursive: true });

    // 6a：真实孤儿——detached node 死循环 + 记录文件 → 清扫击杀
    const orphan = spawnDetached(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { cwd: root, env: { ...process.env } });
    await sleep(200); // 等 detached 组建立
    const orphanPgid = orphan.pid ?? 0;
    const recordPath = path.join(asgDir, TRIAL_RECORD_FILENAME);
    fs.writeFileSync(recordPath, JSON.stringify({ pgid: orphanPgid, interpreter: path.basename(process.execPath), recordedAt: new Date().toISOString() }), 'utf8');
    const killed = sweepStaleTrialTrees(root, (line) => console.log(`    [sweep] ${line}`));
    await sleep(300);
    check('启动清扫击杀孤儿试跑树', killed === 1 && !alive(orphanPgid), `killed=${killed} alive=${alive(orphanPgid)}`);
    check('清扫后登记文件已删', !fs.existsSync(recordPath));

    // 6b：pid 复用防护——记录指向存活进程（本进程）但解释器不符 → 绝不误杀
    const fakeRecord = path.join(asgDir, TRIAL_RECORD_FILENAME);
    fs.writeFileSync(fakeRecord, JSON.stringify({ pgid: process.pid, interpreter: 'definitely-not-a-real-interpreter', recordedAt: new Date().toISOString() }), 'utf8');
    const killed2 = sweepStaleTrialTrees(root);
    check('解释器归属不符 → 跳过击杀（防 pid 复用误杀）', killed2 === 0, `killed=${killed2}`);
    check('本进程仍存活', alive(process.pid));
    check('可疑记录被清除（不反复判定）', !fs.existsSync(fakeRecord));

    // 6c：已死树的陈旧记录 → 静默清理
    fs.writeFileSync(recordPath, JSON.stringify({ pgid: 99999999, interpreter: 'node' }), 'utf8');
    const killed3 = sweepStaleTrialTrees(root);
    check('陈旧记录（树已死）→ 0 击杀且记录清理', killed3 === 0 && !fs.existsSync(recordPath));

    // 6d：组长已退、组内成员存活（PROC-3）——孤儿组必须被清扫，不能按
    // 「/proc/<pgid> ENOENT」误判成树已死而漏杀。
    // 形态：组长 detached（= 进程组组长），fork 普通（非 detached）组员
    // 后退出——组员留在组里，组长 /proc 条目消失。
    const leaver = spawnDetached(
      process.execPath,
      [
        '-e',
        "const { spawn } = require('child_process');" +
        "spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' }).unref();" +
        'setTimeout(() => process.exit(0), 100);',
      ],
      { cwd: root, env: { ...process.env } },
    );
    await sleep(600); // 等组长退出、组员稳定运行
    check('组长已退（前置条件）', !alive(leaver.pid ?? 0));
    fs.writeFileSync(recordPath, JSON.stringify({ pgid: leaver.pid, interpreter: path.basename(process.execPath), recordedAt: new Date().toISOString() }), 'utf8');
    const killed4 = sweepStaleTrialTrees(root, (line) => console.log(`    [sweep] ${line}`));
    await sleep(300);
    check('组长已退但组员存活 → 孤儿组被清扫（不误判树已死）', killed4 === 1, `killed=${killed4}`);
    check('清扫后登记文件已删', !fs.existsSync(recordPath));

    fs.rmSync(root, { recursive: true, force: true });
  } else {
    console.log('  (跳过：非 Linux 平台无 /proc 归属校验——sweep 登记为 best-effort Linux only)');
  }

  console.log('-- 6b2. 超时必落定：setsid 逃逸者持有管道时（POSIX only）--');
  if (process.platform !== 'win32') {
    // 候选代码 Popen(start_new_session=True) 脱离进程组：组杀杀不到它，
    // 它继承的 stdout/stderr 写端让 pipe 永不 EOF → close 永不触发。
    // 宽限强制销毁必须让 spawnWithTreeTimeout 在「timeout + 5s 宽限」内落定。
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-escape-'));
    fs.writeFileSync(
      path.join(ws, 'escape.js'),
      [
        "const { spawn } = require('child_process');",
        // setsid 孙进程：脱离进程组 + 继承 stdio 管道
        "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
        'g.unref();',
        "console.log('parent exiting');",
      ].join('\n'),
      'utf8',
    );
    const t0 = Date.now();
    const res = await spawnWithTreeTimeout(
      process.execPath,
      [path.join(ws, 'escape.js')],
      { cwd: ws, env: buildTrialEnv('node') },
      1500,
    );
    const elapsed = Date.now() - t0;
    check(
      '超时 + 逃逸者持有管道 → 必然落定（timeout+5s 宽限内）',
      res.timedOut === true && elapsed < 8_000,
      `elapsed=${elapsed}ms res=${JSON.stringify(res)}`,
    );
    check('落定时 errorMessage 指明管道被强销毁', (res.errorMessage ?? '').includes('grace'), res.errorMessage ?? '');
    fs.rmSync(ws, { recursive: true, force: true });
  } else {
    console.log('  (跳过：Windows 无 setsid 形态——树杀走 taskkill /T)');
  }

  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== kill-tree selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
