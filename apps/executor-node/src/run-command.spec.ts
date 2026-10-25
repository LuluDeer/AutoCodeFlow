import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { runCommand } from './run-command';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const mockSpawn = spawn as unknown as jest.Mock;

function fakeProc(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: jest.Mock;
} {
  const p = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: jest.Mock;
  };
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.pid = 4242;
  p.kill = jest.fn();
  return p;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// NETOPT-E P3（回归注记）：run-command 的 abort 语义此前零单测——execute.spec
// 的树杀用例是手动 close 驱动，从没验证 onAbort 真的调用 killProcessTree。
// 这里直接钉死：signal abort → 立即树杀（POSIX 负 pid / win32 taskkill + kill），
// close 后 resolve 非零 status；未 abort 的普通退出不受影响。
describe('runCommand abort semantics (NETOPT-E P3)', () => {
  it('kills the process tree immediately when the signal fires', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const ac = new AbortController();
    const promise = runCommand('git', ['clone'], { signal: ac.signal });
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      ac.abort();
      if (process.platform !== 'win32') {
        expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      } else {
        expect(mockSpawn).toHaveBeenCalledWith(
          'taskkill',
          ['/T', '/F', '/PID', '4242'],
          { stdio: 'ignore' },
        );
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      }
    } finally {
      killSpy.mockRestore();
    }

    proc.emit('close', null);
    await expect(promise).resolves.toEqual({ status: null, stdout: '', stderr: '' });
  });

  it('kills immediately when the signal is already aborted before spawn', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const ac = new AbortController();
    ac.abort();
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const promise = runCommand('git', ['clone'], { signal: ac.signal });
      if (process.platform !== 'win32') {
        expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      } else {
        expect(mockSpawn).toHaveBeenCalledWith(
          'taskkill',
          ['/T', '/F', '/PID', '4242'],
          { stdio: 'ignore' },
        );
      }
      proc.emit('close', null);
      await expect(promise).resolves.toEqual({ status: null, stdout: '', stderr: '' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('resolves with the exit code when the child exits normally (no signal)', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand('git', ['fetch'], {});
    proc.emit('close', 0);
    await expect(promise).resolves.toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('resolves null status when the child exits without a code (killed)', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand('git', ['fetch'], {});
    proc.emit('close', null);
    await expect(promise).resolves.toEqual({ status: null, stdout: '', stderr: '' });
  });

  it('surfaces spawn errors via the error handler (W-24 stdio guard preserved)', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand('uv', ['--version'], {});
    proc.emit('error', new Error('spawn uv ENOENT'));
    proc.emit('close', null);
    await expect(promise).resolves.toEqual({
      status: null,
      stdout: '',
      stderr: 'spawn uv ENOENT',
    });
  });
});

// NETOPT-9-8（残差收口）：execute.ts runProcess 已用 StringDecoder 解流，
// runCommand 的 per-chunk d.toString() 是最后一处——多字节 UTF-8 序列被
// chunk 边界劈开时逐 chunk 变 U+FFFD（deploy/interpreters/runtime-detection
// 的输出都在这条路径上）。
describe('runCommand chunk decoding (NETOPT-9-8)', () => {
  it('keeps multi-byte UTF-8 sequences split across chunks intact', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand('node', ['--version'], {});
    const zh = Buffer.from('中', 'utf8'); // E4 B8 AD — 劈在序列中间
    proc.stdout.emit('data', zh.subarray(0, 2));
    proc.stdout.emit('data', zh.subarray(2));
    proc.emit('close', 0);
    await expect(promise).resolves.toEqual({ status: 0, stdout: '中', stderr: '' });
  });

  it('flushes a trailing partial sequence via decoder.end on close', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand('node', ['--version'], {});
    proc.stdout.emit('data', Buffer.from([0xe4, 0xb8])); // 悬空的半个序列
    proc.emit('close', 0);
    await expect(promise).resolves.toEqual({ status: 0, stdout: '\uFFFD', stderr: '' });
  });

  it('decodes stderr the same way', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand('node', ['--version'], {});
    const warn = Buffer.from('警告', 'utf8');
    proc.stderr.emit('data', warn.subarray(0, 3));
    proc.stderr.emit('data', warn.subarray(3));
    proc.emit('close', 1);
    await expect(promise).resolves.toEqual({ status: 1, stdout: '', stderr: '警告' });
  });
});

// R74-A1（安全面四轴审计·轴 4 执行隔离）：子进程输出上限。
// prepare 阶段的 git/npm/pip 输出会整段进内存——一个刷屏的子进程（死循环
// console.log / npm 依赖树爆炸）能把执行器 OOM 掉，而 OOM 会连带打死同进程里
// **所有**并发任务。run-command.ts 的 CAP 就是这条防线，此前零单测：删掉 CAP
// 判断用例也全绿。这里直接灌 12MB，钉住"内存不随输出线性增长"。
describe('runCommand output cap (R74-A1 轴 4)', () => {
  const CAP = 10 * 1024 * 1024;

  it('caps captured stdout/stderr instead of accumulating unbounded output', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = runCommand('npm', ['install'], {});
    const chunk = Buffer.from('x'.repeat(1024 * 1024));
    // 12 × 1MB，远超 CAP；末块允许越过上限一块（实现是"追加前判长度"）
    for (let i = 0; i < 12; i++) proc.stdout.emit('data', chunk);
    for (let i = 0; i < 12; i++) proc.stderr.emit('data', chunk);
    proc.emit('close', 0);

    const result = await promise;
    expect(result.status).toBe(0);
    // 上限生效（含单块余量），且没有把 12MB 全吃进内存
    expect(result.stdout.length).toBeLessThanOrEqual(CAP + chunk.length);
    expect(result.stderr.length).toBeLessThanOrEqual(CAP + chunk.length);
    expect(result.stdout.length).toBeLessThan(12 * 1024 * 1024);
    expect(result.stderr.length).toBeLessThan(12 * 1024 * 1024);
    // 上限之内的输出必须完整保留（不能为了省内存把正常日志也丢了）
    expect(result.stdout.length).toBeGreaterThanOrEqual(CAP);
  });
});


// ---------------------------------------------------------------------------
// 本轮审计修复回归锁（P2-6 prepare 子进程 ulimit 包装 / P3-14 输出截断标记）
// ---------------------------------------------------------------------------

describe('runCommand prepare-phase rlimit wrapping (P2-6)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      fn();
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  }

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('POSIX: wraps long-running children (timeout/signal callers) in an sh ulimit script', async () => {
    jest.resetModules();
    const childProcessModule = await import('child_process');
    const { runCommand: run } = await import('./run-command');
    const spawnMock = childProcessModule.spawn as unknown as jest.Mock;
    let captured: [string, string[]] | null = null;
    withPlatform('linux', () => {
      const proc = fakeProc();
      spawnMock.mockReturnValue(proc);
      const promise = run('git', ['clone', '--bare', 'https://example.com/r.git'], { timeout: 120_000 });
      proc.emit('close', 0);
      void promise.then(() => {
        captured = spawnMock.mock.calls[0] as unknown as [string, string[]];
      });
      // spawn 在 promise executor 里同步发生——platform 恢复前已捕获 argv。
      captured = spawnMock.mock.calls[0] as unknown as [string, string[]];
    });

    const [cmd, args] = captured as unknown as [string, string[]];
    expect(cmd).toBe('/bin/sh');
    expect(args[0]).toBe('-c');
    const script = String(args[1]);
    // NOFILE 语句形态与 process-rlimits 一致（默认 NOFILE=1024）。CPU 档
    // 仅在显式配置 TASK_CPU_LIMIT_SECONDS>0 时施加（prepare 无逐任务
    // timeoutSec 语境，不做 timeout+60s 回落——见 buildPrepareRlimitStatements
    // 注释）；本 spec 未配置 → 只断言 NOFILE。
    expect(script).toMatch(/ulimit -n 1024/);
    expect(script).not.toMatch(/ulimit -t /);
    // 命令与参数经位置参数透传，零字符串拼接注入面。
    expect(script).toContain('cmd=$1; shift; exec "$cmd" "$@"');
    expect(args.slice(3)).toEqual(['git', 'clone', '--bare', 'https://example.com/r.git']);
  });

  it('POSIX: pure probes (no timeout, no signal) skip the wrapper', async () => {
    jest.resetModules();
    const childProcessModule = await import('child_process');
    const { runCommand: run } = await import('./run-command');
    const spawnMock = childProcessModule.spawn as unknown as jest.Mock;
    let captured: [string, string[]] | null = null;
    withPlatform('linux', () => {
      const proc = fakeProc();
      spawnMock.mockReturnValue(proc);
      const promise = run('uv', ['--version'], {});
      proc.emit('close', 0);
      void promise.then(() => {
        captured = spawnMock.mock.calls[0] as unknown as [string, string[]];
      });
      captured = spawnMock.mock.calls[0] as unknown as [string, string[]];
    });

    const [cmd, args] = captured as unknown as [string, string[]];
    expect(cmd).toBe('uv');
    expect(args).toEqual(['--version']);
  });

  it('win32: returns the argv unwrapped (no ulimit primitive)', async () => {
    jest.resetModules();
    const childProcessModule = await import('child_process');
    const { runCommand: run } = await import('./run-command');
    const spawnMock = childProcessModule.spawn as unknown as jest.Mock;
    let captured: [string, string[]] | null = null;
    withPlatform('win32', () => {
      const proc = fakeProc();
      spawnMock.mockReturnValue(proc);
      const promise = run('git', ['clone', 'x'], { timeout: 60_000 });
      proc.emit('close', 0);
      void promise.then(() => {
        captured = spawnMock.mock.calls[0] as unknown as [string, string[]];
      });
      // spawn 在 promise executor 里同步发生——platform 恢复前已捕获 argv。
      captured = spawnMock.mock.calls[0] as unknown as [string, string[]];
    });

    expect(captured![0]).toBe('git');
    expect(captured![1]).toEqual(['clone', 'x']);
  });
});

describe('runCommand output truncation marker (P3-14)', () => {
  it('appends a one-shot truncation marker to each stream after the cap is hit', async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = runCommand('npm', ['install'], {});
    const chunk = Buffer.from('x'.repeat(1024 * 1024));
    // 11 × 1MB 越过 10MB CAP → 标记在越限后追加一次；再灌一块标记不重复。
    for (let i = 0; i < 11; i++) proc.stdout.emit('data', chunk);
    proc.stdout.emit('data', chunk);
    for (let i = 0; i < 11; i++) proc.stderr.emit('data', chunk);
    proc.stderr.emit('data', chunk);
    proc.emit('close', 0);

    const result = await promise;
    const stdoutMarkers = (result.stdout.match(/\[logs truncated/g) || []).length;
    const stderrMarkers = (result.stderr.match(/\[logs truncated/g) || []).length;
    expect(stdoutMarkers).toBe(1);
    expect(stderrMarkers).toBe(1);
    // marker 文案可被 admin LOG_TRUNCATION_MARKER（/\[\s*(?:logs\s+)?truncated\b/i）识别。
    expect(result.stdout).toMatch(/\[logs truncated, prepare-phase output exceeded 10MB capture cap\]/);
  });
});
