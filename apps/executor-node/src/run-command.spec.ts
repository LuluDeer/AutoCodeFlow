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
