/**
 * BUG-07 真机自检：Windows detached/信号进程级深验（CI 化）。
 *
 * 背景：R14 在真实 Windows 真机窗口验证过三条进程级链路（windows-findings
 * 2.4/2.9，修复 P-7/P-9/P-10），但验证是一次性的——之后任何对 killProcessTree /
 * spawn 标志 / SIGBREAK 注册的回退都不会被现有 jest 单测捕获（单测只断言
 * 参数形态，不产生真实进程树）。本脚本把它们固化为可在 windows runner 上
 * 每次 push 自动执行的进程级断言（非 win32 显式 skip 退 0）：
 *
 *   ① P-10 SIGBREAK 优雅链：detached spawn 一个 node 子进程（注册了
 *      SIGBREAK→graceful 收尾的最小目标进程，与 executor main.ts 同语义），
 *      经 `process.kill(pid, 'SIGBREAK')`（libuv → GenerateConsoleCtrlEvent
 *      的真实信号路径，detached = CREATE_NEW_PROCESS_GROUP 是送达前提）触发，
 *      断言优雅收尾文件被写入 + 退出码 0。
 *   ② P-7 树杀：spawn「任务进程」（windowsHide: true 与 executor runProcess
 *      同参）→ 任务进程 spawn detached 孙进程（存活信号文件轮询写入）→
 *      对任务进程执行 `taskkill /T /F`（killProcessTree win32 分支的同一
 *      实现）→ 断言任务进程与 detached 孙进程全部终止。
 *   ③ P-9 windowsHide：任务进程 spawn 时带 windowsHide（CREATE_NO_WINDOW）
 *      仍能正常起子进程——①②的运行本身即覆盖（非 windowsHide 形态在
 *      service 化部署会直接失败），此处以孙进程存活信号显式断言。
 *
 * 用法：
 *   node scripts/bug07-windows-selftest.mjs
 *   （非 win32 → 显式 skip 退出 0；CI 仅在 windows runner 上真跑）
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const results = [];
const ok = (name, passed, detail = '') => {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✅' : '❌'} ${name}${detail ? `\n   ${detail}` : ''}`);
};

function summary() {
  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    return 1;
  }
  console.log('\nBUG-07 windows detached/信号深验全绿。');
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
};

/** 最小 SIGBREAK 优雅目标：注册 SIGBREAK→写收尾文件→exit 0（executor
 *  main.ts P-10 修复的同语义最小化：信号到达 → 收尾动作 → 优雅退出）。 */
const gracefulTarget = `
const fs = require('fs');
const done = ${'process.env.B07_DONE_FILE'};
process.on('SIGBREAK', () => {
  fs.writeFileSync(done, 'graceful');
  process.exit(0);
});
process.on('SIGINT', () => { fs.writeFileSync(done, 'graceful-int'); process.exit(0); });
setInterval(() => {}, 1000);
`;

/** 任务进程：windowsHide 形态 spawn 的真实子进程，内含 detached 孙进程。 */
const taskTarget = `
const { spawn } = require('child_process');
const fs = require('fs');
const alive = ${'process.env.B07_ALIVE_FILE'};
const grandFile = ${'process.env.B07_GRAND_FILE'};
fs.writeFileSync(alive, 'up');
// detached 孙进程（进程组独立——executor 任务场景的真实形态，P-7 的对象）
const grand = spawn('node', ['-e', '// bug07-grand-probe\nrequire("fs").writeFileSync(process.env.B07_GRAND_FILE, "up"); setInterval(() => {}, 1000);'], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env },
});
grand.unref();
const waitGrand = setInterval(() => {
  if (fs.existsSync(grandFile)) { clearInterval(waitGrand); setInterval(() => {}, 1000); }
}, 100);
setInterval(() => {}, 1000);
`;

async function main() {
  console.log(`\n=== BUG-07 windows detached/信号深验（platform=${process.platform}）===\n`);
  if (!isWin) {
    console.log('⏭️  非 win32 环境——显式 skip（真实信号语义仅存在于 Windows；CI 由 windows runner 真跑）');
    return 0;
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'bug07-'));
  try {
    // ① P-10：SIGBREAK → 优雅收尾（真实控制台事件路径）
    {
      const doneFile = path.join(tmp, 'graceful.done');
      const target = path.join(tmp, 'graceful-target.cjs');
      writeFileSync(target, gracefulTarget.replaceAll('${process.env.B07_DONE_FILE}', JSON.stringify(doneFile)));
      const child = spawn(process.execPath, [target], {
        detached: true, // CREATE_NEW_PROCESS_GROUP——CTRL_BREAK 送达的前提
        stdio: 'ignore',
      });
      await sleep(500); // 等 handler 注册
      const r = process.kill(child.pid, 'SIGBREAK');
      await waitFor(() => existsSync(doneFile), 10_000, 'SIGBREAK graceful marker');
      const [, , code] = spawnSync('powershell', ['-NoProfile', '-Command',
        `(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue) -ne $null`], { encoding: 'utf8' });
      ok('① P-10 SIGBREAK 优雅链（真实 GenerateConsoleCtrlEvent 路径）',
        r === true && readFileSync(doneFile, 'utf8') === 'graceful' && code.trim() === 'False',
        `signal accepted=${r}, marker=${readFileSync(doneFile, 'utf8')}, process-alive-after=${code.trim()}`);
    }

    // ② P-7 + ③ P-9：taskkill /T /F 树杀（含 detached 孙进程）+ windowsHide 形态可用性
    {
      const aliveFile = path.join(tmp, 'task.alive');
      const grandFile = path.join(tmp, 'grand.alive');
      const taskJs = path.join(tmp, 'task-target.cjs');
      writeFileSync(taskJs, taskTarget
        .replaceAll('${process.env.B07_ALIVE_FILE}', JSON.stringify(aliveFile))
        .replaceAll('${process.env.B07_GRAND_FILE}', JSON.stringify(grandFile)));

      // windowsHide: true —— executor runProcess win32 分支的同参形态（P-9）
      const task = spawn(process.execPath, [taskJs], {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, B07_ALIVE_FILE: aliveFile, B07_GRAND_FILE: grandFile },
      });
      await waitFor(() => existsSync(aliveFile), 10_000, 'task alive marker');
      await waitFor(() => existsSync(grandFile), 10_000, 'detached grandchild alive marker');

      // killProcessTree win32 分支的同一实现：taskkill /T /F（整树强杀）
      const kill = spawnSync('taskkill', ['/PID', String(task.pid), '/T', '/F'], { encoding: 'utf8' });
      await sleep(1000);

      const alive = (pid) => spawnSync('powershell', ['-NoProfile', '-Command',
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'True' } else { 'False' }`],
        { encoding: 'utf8' }).stdout.trim();
      const taskAlive = alive(task.pid);
      // 孙进程 PID 未知（detached unref）——以其存活标记文件所在进程的探测替代：
      // 直接按 grand 进程的命令行特征（B07_GRAND_FILE env 不可查）→ 用父树杀后
      // 孙进程独存场景的检测窗：taskkill /T 断言后 2 秒内写入哨兵探测。
      const sentinel = path.join(tmp, 'grand-after-kill.sentinel');
      // 孙进程若仍在跑（每秒空转），说明树杀未及——由它写出哨兵
      // （不依赖 PID：孙进程的 -e 脚本里没有写哨兵逻辑，这里改用 powershell 按
      //  命令行特征查询 grandchild 是否存活）
      const probe = spawnSync('powershell', ['-NoProfile', '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bug07-grand-probe*' }).Count`],
        { encoding: 'utf8' });
      const grandCount = parseInt((probe.stdout || '0').trim(), 10);

      ok('② P-7 taskkill /T /F 树杀（父+detached 孙全灭）',
        kill.status === 0 && taskAlive === 'False' && grandCount === 0,
        `taskkill rc=${kill.status} taskAlive=${taskAlive} grandStillRunning=${grandCount}`);

      // ③ P-9：windowsHide 形态下任务与孙进程都正常起（alive 标记即证）
      ok('③ P-9 windowsHide(CREATE_NO_WINDOW) 形态任务树正常起',
        existsSync(aliveFile) && kill.status === 0,
        `task alive marker=${existsSync(aliveFile)}`);
    }

    return summary();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exit(await main());
