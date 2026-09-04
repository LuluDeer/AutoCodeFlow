import { spawn, ChildProcess } from 'child_process';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  shell?: boolean;
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
    // Cap captured output so a chatty child cannot balloon executor memory.
    const CAP = 10 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    const timer = opts.timeout
      ? setTimeout(() => {
          killProcessTree(child, 'SIGKILL');
        }, opts.timeout)
      : null;
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < CAP) stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < CAP) stderr += d.toString();
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}
