import { spawn, ChildProcess } from 'child_process';

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
 *  The child is detached on POSIX so timeouts can kill its whole group. */
export function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
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
      if (stdout.length < CAP) stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < CAP) stderr += d.toString();
    });
    child.on('error', (err) => {
      clearWatchers();
      resolve({ status: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearWatchers();
      resolve({ status: code, stdout, stderr });
    });
  });
}
