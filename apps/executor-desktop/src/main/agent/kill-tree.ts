import { spawn, execFile, type ChildProcess } from 'child_process';

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
 * 所有失败收敛为 boolean（树可能已自行退出——那是成功语义，不是失败）。
 */

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
 */
export function spawnWithTreeTimeout(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
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
    let timedOut = false;
    let killed = false;
    let settled = false;
    let errorMessage: string | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      // killed 语义 = 「终止信号已发出」（同步置位）。异步等待 killTree 完成
      // 会与 close 事件竞速：taskkill /F 后进程以 exit code 1 触发 close，
      // 若先走 finish 会拿到 killed=false / exitCode=1 的失真快照。
      killed = true;
      void killTree(child.pid ?? 0);
    }, timeoutMs);

    child.stdout?.on('data', (b: Buffer) => onChunk?.(b, false));
    child.stderr?.on('data', (b: Buffer) => onChunk?.(b, true));

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
