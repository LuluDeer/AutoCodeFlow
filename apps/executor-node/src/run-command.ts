import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  shell?: boolean;
  /** Abort signal: when fired the child's whole process tree is killed
   *  immediately (the close handler then resolves with a non-zero status).
   *  Used by the execution kill endpoint to break a prepare-phase
   *  git/npm out of the 60–300s waits without a per-process hard kill. */
  signal?: AbortSignal;
}

export interface RunCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Kill a child process and — on POSIX — its entire process group.
 *  Children are spawned detached (group leaders), so the negative pid takes
 *  down the whole tree instead of orphaning grandchildren. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (_) {
      /* process group may already be gone — fall through to the direct kill */
    }
    try { child.kill(signal); } catch (_) { /* already dead */ }
  } else {
    // W-02/parity with executor-python: Node's child.kill on Windows only
    // terminates the direct child (grandchildren linger). taskkill /T /F walks
    // the pid tree so a killed task cannot orphan its own spawns.
    // /F is forced (no graceful path exists for console trees on Windows).
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } catch (_) {
      /* taskkill unavailable — fall back to direct kill only */
    }
    try { child.kill(signal); } catch (_) { /* already dead */ }
  }
}

/** Promise-wrapped spawn: git/npm/pip must never use spawnSync on the request
 *  path — a synchronous 120–300s wait stalls heartbeats, /health and every API.
 *  The child is detached on POSIX so timeouts can kill its whole group.
 *
 *  P2-6（node 半边，本轮审计）：POSIX 下把 prepare 阶段子进程包一层
 *  `/bin/sh -c 'ulimit …; cmd=$1; shift; exec "$cmd" "$@"'`——与任务进程的
 *  applyTaskRlimits（process-rlimits.ts）同款包装、同源配置（TASK_NOFILE_
 *  LIMIT / TASK_CPU_LIMIT_SECONDS / TASK_FSIZE_LIMIT_MB）。动因：prepare 阶段
 *  的 git/npm/uv 是执行器派生的子进程，此前完全在资源限制之外——恶意包的
 *  install 脚本（npm lifecycle / wheel build）可在无 NOFILE/CPU/FSIZE 约束下
 *  跑任意代码（fd 耗尽拖垮执行器、写满盘）。ulimit 失败（容器硬限制低于设定
 *  值）静默放行——`;` 分隔保证 exec 始终执行，与任务侧 best-effort 语义一致。
 *  win32 无 ulimit 原语，原样返回（applyTaskRlimits 的既有平台守卫同款）。
 *  注意 detached + killProcessTree 的组杀语义不受影响：exec 不换 pid，sh 即
 *  进程组组长。 */
import { buildPrepareRlimitStatements } from './process-rlimits';

function wrapWithRlimits(
  cmd: string,
  args: string[],
): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return { cmd, args };
  }
  const statements = buildPrepareRlimitStatements();
  if (statements.length === 0) {
    return { cmd, args };
  }
  // R12-fix（process-rlimits.ts 同款注记）：`exec "$0" "$@"` 是错的（$0 会吃掉
  // 第一个参数）；POSIX 兼容写法：取命令到变量 → shift → `exec "$cmd" "$@"`。
  const script = `${statements.join('; ')}; cmd=$1; shift; exec "$cmd" "$@"`;
  return { cmd: '/bin/sh', args: ['-c', script, 'task', cmd, ...args] };
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    // P2-6: rlimit 包装只施加于**长任务型**子进程（git/npm/uv/pip——全部经
    // opts.timeout 或 opts.signal 驱动收尾）；纯探测类（which/env 探测无
    // timeout）保持原样，避免给高频探测加 /bin/sh 一跳。判定用「带 timeout
    // 或带 signal」两个既有信号，与调用面自然对齐（deploy/execute 的全部
    // runCommand 调用至少带其一）。
    const isLongRunning = opts.timeout !== undefined || opts.signal !== undefined;
    const argvSpec = isLongRunning ? wrapWithRlimits(cmd, args) : { cmd, args };
    const child = spawn(argvSpec.cmd, argvSpec.args, {
      ...opts,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // W-24: guard the stdio sockets' 'error' event (see execute.ts runProcess).
    // Without these, a failed spawn (ENOENT) emits an unhandled socket error
    // that becomes an uncaughtException and kills the whole executor process.
    child.stdout?.on('error', () => { /* surfaced via child 'error' handler */ });
    child.stderr?.on('error', () => { /* surfaced via child 'error' handler */ });
    // Cap captured output so a chatty child cannot balloon executor memory.
    const CAP = 10 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    // P3-14: 每流最多追加一条截断标记。
    let stdoutTruncated = false;
    let stderrTruncated = false;
    // NETOPT-9-8 (same as execute.ts runProcess): decode with StringDecoder so
    // a multi-byte UTF-8 sequence split across chunk boundaries is not turned
    // into U+FFFD per chunk. runCommand's callers (deploy / interpreters /
    // runtime-detection) feed this text to logs, manifests and probes.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const timer = opts.timeout
      ? setTimeout(() => {
          killProcessTree(child, 'SIGKILL');
        }, opts.timeout)
      : null;
    // Abort support (execution kill during prepare): killing the tree makes
    // the child exit, the close handler below resolves — callers treat the
    // non-zero status as the failure signal and re-check the abort flag.
    const onAbort = () => {
      killProcessTree(child, 'SIGKILL');
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const clearWatchers = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < CAP) {
        stdout += stdoutDecoder.write(d);
      } else if (!stdoutTruncated) {
        // P3-14（本轮审计）：达上限后静默丢弃改为**一次性截断标记**——与
        // 任务输出 BoundedLogBuffer 的 marker 语义对齐（admin 的
        // LOG_TRUNCATION_MARKER 按 /\[\s*(?:logs\s+)?truncated\b/i 识别），
        // 运维/用户看到 marker 才知道诊断信息被截，而不是把「缺尾巴」误读
        // 为完整输出。marker 追加后不再重复（每流一条）。
        stdoutTruncated = true;
        stdout += stdoutDecoder.write(
          Buffer.from('\n... [logs truncated, prepare-phase output exceeded 10MB capture cap] ...\n'),
        );
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < CAP) {
        stderr += stderrDecoder.write(d);
      } else if (!stderrTruncated) {
        stderrTruncated = true;
        stderr += stderrDecoder.write(
          Buffer.from('\n... [logs truncated, prepare-phase output exceeded 10MB capture cap] ...\n'),
        );
      }
    });
    child.on('error', (err) => {
      clearWatchers();
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ status: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearWatchers();
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ status: code, stdout, stderr });
    });
  });
}
