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
