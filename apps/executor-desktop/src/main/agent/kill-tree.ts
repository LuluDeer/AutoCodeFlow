import { spawn, execFile, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * P7b（agent-and-deployment）：跨平台进程树终止。
 *
 * ## 为什么必须杀树而不是杀单进程
 * 试跑的候选代码可以再 spawn 子进程（python 起 pip、node 起 worker）。超时
 * 时 `child.kill()` 只终止直接子进程——孙进程存活继续跑，闸门（07 §7.1
 * 「超限终止」）对树形泄漏形同虚设，且残留进程占着工作区文件让下一次
 * 试跑行为不可复现。
 *
 * ## 平台策略
 * - Windows：`taskkill /pid <pid> /T /F`（/T = 树，/F = 强制）——系统调用级
 *   树终止，最可靠。
 * - POSIX：spawn 时置 `detached: true`（让子进程成为**新进程组**组长），
 *   终止时 `process.kill(-pid)` 一次杀全组。父进程必须是 detached spawn
 *   出来的才有效——本模块同时导出 `spawnDetached` 供 trial-run 统一使用，
 *   避免调用方忘掉 detached 导致杀组变杀单。
 *
 * ## P2-4：worker 死亡后的孤儿试跑树
 * `detached: true` 让试跑树在 worker 进程死后**继续存活**——超时定时器随
 * worker 一起消失，孤儿无人再杀。两层缓解（PR_SET_PDEATHSIG 需要原生
 * preexec，node 无干净注入路径，wrapper 脚本会改变解释器 argv 语义，均不采）：
 *  1. **在飞登记**：spawnWithTreeTimeout 把活着的试跑树记入内存注册表，
 *     `killInFlightTreesSync()` 供 worker 的全部主动退出路径（管道断开 /
 *     SIGTERM / SIGINT / uncaughtException）在退出前先杀树。
 *  2. **落盘登记 + 启动清扫**：`recordFile` 把 pgid 落到工作区；worker
 *     重启时 `sweepStaleTrialTrees()` 按 journal 式扫描清扫上次死亡遗留的
 *     孤儿（Linux only：/proc/<pgid>/cmdline 归属校验防 pid 复用误杀；
 *     Windows 无 Job Object 注入路径，登记为未实现）。
 *
 * 所有失败收敛为 boolean（树可能已自行退出——那是成功语义，不是失败）。
 */

/** 试跑在飞登记文件名（落在试跑 workspace 根；打包/列目录按观测产物对待）。 */
export const TRIAL_RECORD_FILENAME = 'trial-in-flight.json';

/** 在飞试跑树注册表：pgid（= detached 组长 pid）→ 解释器名（诊断用）。 */
const inFlightTrees = new Map<number, string>();

/** P2-4 测试/诊断锚点：当前在飞的试跑树数量。 */
export function inFlightTreeCount(): number {
  return inFlightTrees.size;
}

/**
 * P2-4：同步杀掉所有在飞试跑树（worker 退出路径专用——异步等待会与
 * process.exit 竞速）。返回发出终止信号的树数量。POSIX 杀整组；Windows
 * fire-and-forget taskkill（退出路径上不等子进程完成）。
 */
export function killInFlightTreesSync(): number {
  let n = 0;
  for (const [pgid] of inFlightTrees) {
    n += 1;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pgid), '/T', '/F'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref?.();
      } catch { /* 退出路径上尽力而为 */ }
      continue;
    }
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      try { process.kill(pgid, 'SIGKILL'); } catch { /* 已死即成功语义 */ }
    }
  }
  inFlightTrees.clear();
  return n;
}

/**
 * P2-4（best-effort，Linux only）：清扫上次 worker 死亡遗留的孤儿试跑树。
 * 扫描 `<workspacesRoot>/<assignmentId>/trial-in-flight.json`，对每条记录：
 *  - pgid 非法 → 删记录跳过；
 *  - /proc/<pgid>/cmdline 不存在 → 树已死 → 删记录；
 *  - cmdline 不含登记的解释器名 → 疑似 pid 复用（绝不能误杀无辜组）→ 删记录跳过；
 *  - 归属确认 → kill(-pgid, SIGKILL) → 删记录。
 * 返回实际击杀的树数量。调用时机：worker 启动（此时本进程不可能有在飞试跑，
 * 记录只可能来自上一次死亡的 worker）。
 */
export function sweepStaleTrialTrees(workspacesRoot: string, log?: (line: string) => void): number {
  if (process.platform !== 'linux') return 0;
  let killed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspacesRoot, { withFileTypes: true });
  } catch {
    return 0; // 无工作区根 = 无残留
  }
  for (const dir of entries) {
    if (!dir.isDirectory()) continue;
    const recordPath = path.join(workspacesRoot, dir.name, TRIAL_RECORD_FILENAME);
    let raw: string;
    try {
      raw = fs.readFileSync(recordPath, 'utf8');
    } catch {
      continue; // 无登记文件
    }
    try { fs.unlinkSync(recordPath); } catch { /* 删不掉也不影响后续判定 */ }
    let pgid: number | null = null;
    let interpreter = '';
    try {
      const rec = JSON.parse(raw) as { pgid?: unknown; interpreter?: unknown };
      if (typeof rec.pgid === 'number' && Number.isInteger(rec.pgid) && rec.pgid > 1) pgid = rec.pgid;
      if (typeof rec.interpreter === 'string') interpreter = rec.interpreter;
    } catch { /* 烂记录：删了即可 */ }
    if (pgid === null) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${pgid}/cmdline`, 'utf8');
    } catch {
      continue; // 进程组已死——记录已删，无事可做
    }
    if (interpreter && !cmdline.includes(interpreter)) {
      log?.(`sweep: pgid ${pgid} cmdline 不含登记的解释器 ${interpreter}——疑似 pid 复用，跳过击杀`);
      continue;
    }
    try {
      process.kill(-pgid, 'SIGKILL');
      killed += 1;
      log?.(`sweep: killed orphan trial tree pgid=${pgid} (${interpreter || 'unknown interpreter'})`);
    } catch {
      try { process.kill(pgid, 'SIGKILL'); killed += 1; } catch { /* 已死 */ }
    }
  }
  return killed;
}

/** 以「可被整组击杀」的方式 spawn（POSIX detached 进程组；Windows 无差异）。 */
export function spawnDetached(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX：子进程成为新会话/进程组组长，`process.kill(-pid)` 才能覆盖
    // 孙进程。Windows 上该选项无副作用（树杀走 taskkill）。
    detached: process.platform !== 'win32',
  });
}

/** 终止一棵进程树。返回是否发出了终止信号（树已不存在 = true）。 */
export function killTree(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (process.platform === 'win32') {
    return execFilePromise('taskkill', ['/pid', String(pid), '/T', '/F']);
  }
  return killProcessGroup(pid);
}

function execFilePromise(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err) => {
      // err 常见形态：「进程不存在」——树已经死了，语义上就是成功
      resolve(true);
      void err;
    });
  });
}

function killProcessGroup(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      // 负号 = 杀整个进程组（要求子进程以 detached 启动）
      process.kill(-pid, 'SIGKILL');
      resolve(true);
    } catch {
      // 组不存在（已退出）或权限不足——尽力补一刀单进程
      try {
        process.kill(pid, 'SIGKILL');
        resolve(true);
      } catch {
        resolve(true); // 已死即成功语义
      }
    }
  });
}

/**
 * spawn + 超时整组终止的打包：trial-run 用。
 * 返回 exit 信息；`timedOut` 时保证整组（含孙进程）已被终止。
 * `errorMessage` = spawn 后 error 事件的原因（如解释器不存在）。
 *
 * P2-4：opts.recordFile 给出时，spawn 成功即把 { pgid, interpreter } 落盘、
 * 结束（正常/超时/错误）时删除——worker 死亡后残留的记录文件是启动清扫
 * （sweepStaleTrialTrees）的输入；同时 pgid 进入内存注册表（killInFlightTreesSync）。
 */
export function spawnWithTreeTimeout(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; recordFile?: string },
  timeoutMs: number,
  onChunk?: (buf: Buffer, isErr: boolean) => void,
): Promise<{ exitCode: number | null; timedOut: boolean; killed: boolean; errorMessage: string | null }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnDetached(command, args, opts);
    } catch (err) {
      resolve({ exitCode: null, timedOut: false, killed: false, errorMessage: err instanceof Error ? err.message : String(err) });
      return;
    }
    // P2-4：在飞登记（pgid = detached 组长 pid）。登记必须先于任何 finish 路径。
    const interpreter = path.basename(command);
    if (child.pid && child.pid > 0) {
      inFlightTrees.set(child.pid, interpreter);
      if (opts.recordFile) {
        try {
          fs.writeFileSync(opts.recordFile, JSON.stringify({
            pgid: child.pid,
            interpreter,
            pid: child.pid,
            recordedAt: new Date().toISOString(),
          }), 'utf8');
        } catch { /* 落盘失败只损失清扫能力，在飞杀树不受影响 */ }
      }
    }
    const unregister = (): void => {
      if (child.pid) inFlightTrees.delete(child.pid);
      if (opts.recordFile) {
        try { fs.rmSync(opts.recordFile, { force: true }); } catch { /* 尽力而为 */ }
      }
    };
    let timedOut = false;
    let killed = false;
    let settled = false;
    let errorMessage: string | null = null;

    /**
     * 超时强杀后的宽限定时器：进程组击杀杀不到 setsid/守护化逃逸者——
     * 候选代码 `subprocess.Popen(..., start_new_session=True)` 会脱离进程组，
     * SIGKILL 杀不到它，而它继承了 stdout/stderr 写端，pipe 永不 EOF →
     * 'close' 永不触发 → 本 Promise 永不落定，runTrialInSandbox 的 await
     * 永久挂起（整条 agent 循环卡死）。宽限到期强制销毁管道并落定：
     * 「timedOut 必然收敛」的承诺优先于「等到自然退出」。
     */
    let graceTimer: NodeJS.Timeout | null = null;
    const KILL_GRACE_MS = 5_000;

    const timer = setTimeout(() => {
      timedOut = true;
      // killed 语义 = 「终止信号已发出」（同步置位）。异步等待 killTree 完成
      // 会与 close 事件竞速：taskkill /F 后进程以 exit code 1 触发 close，
      // 若先走 finish 会拿到 killed=false / exitCode=1 的失真快照。
      killed = true;
      void killTree(child.pid ?? 0);
      graceTimer = setTimeout(() => {
        graceTimer = null;
        errorMessage = 'kill grace expired: child stdout/stderr destroyed (escaped process may hold the pipe)';
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch { /* 尽力而为 */ }
        // destroy 不保证触发 child 'close'（stdio 引用计数是实现细节）——
        // 显式落定，finish 的 settled 幂等让两条路径天然安全。
        finish(null);
      }, KILL_GRACE_MS);
      graceTimer.unref?.();
    }, timeoutMs);

    child.stdout?.on('data', (b: Buffer) => onChunk?.(b, false));
    child.stderr?.on('data', (b: Buffer) => onChunk?.(b, true));

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      unregister();
      // 超时强杀下进程可能以任意退出码触发 close（Windows taskkill /F → 1）
      // ——退出码已无意义，归 null（调用方以 timedOut 判定，不是 exitCode）
      resolve({ exitCode: timedOut ? null : exitCode, timedOut, killed, errorMessage });
    };

    child.on('error', (err) => {
      // 解释器不存在等 spawn 后错误——消息透传给调用方，不给 exitCode
      errorMessage = err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
