/**
 * 运行能力探测（runtime-detection）回归测试。
 *
 * 覆盖的每一条都对应一个**真实爆过的缺陷**或关键契约：
 *   1. Windows 上 `which` 不存在导致 python 能力永远探测不到（desktop-v1.5.x
 *      实爆：客户端只上报 `shell,node`，而任务 runtime 缺省是 python，
 *      结果是"注册成功但任务永远派不过来"）；
 *   2. 自带 uv 必须算作 Python 能力（客户端"通用执行器"的核心能力正是靠
 *      uv 按 runtimeVersion 获取解释器）；
 *   3. `type` 必须与 capabilities **同源**——不能出现"后台显示通用、却因
 *      capabilities 缺 python 而派不到任务"的错配；
 *   4. 探测失败必须降级而**绝不抛**（能力少报只影响派发，抛异常会让整台
 *      执行器注册不上，严重得多）。
 */
import {
  detectRuntimes,
  reportedExecutorType,
  probePythonExecutable,
  hasSystemPython,
  type ReportedRuntime,
} from './runtime-detection';
import { runCommand } from './run-command';

jest.mock('./run-command');

const mockRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('detectRuntimes: python 判定（双通道）', () => {
  it('shell 与 node 恒定存在，且顺序稳定', () => {
    const r = detectRuntimes({ hasUv: false, isPythonExecutable: () => false });
    expect(r).toEqual(['shell', 'node']);
  });

  it('系统 python 可用 → 追加 python', () => {
    const r = detectRuntimes({
      hasUv: false,
      isPythonExecutable: (c) => c === 'python3',
    });
    expect(r).toContain('python');
  });

  it('只有 python（无 python3，Windows 常见）也算可用', () => {
    const r = detectRuntimes({
      hasUv: false,
      isPythonExecutable: (c) => c === 'python',
    });
    expect(r).toContain('python');
  });

  // 核心回归：自带 uv 即可获取解释器 → 具备 Python 能力。
  it('无系统 python 但有自带 uv → 仍然具备 python 能力', () => {
    const r = detectRuntimes({ hasUv: true, isPythonExecutable: () => false });
    expect(r).toContain('python');
  });

  it('既无系统 python 也无 uv → 不含 python', () => {
    const r = detectRuntimes({ hasUv: false, isPythonExecutable: () => false });
    expect(r).not.toContain('python');
  });

  it('判定函数抛异常时视为不可用（绝不冒泡）', () => {
    expect(() =>
      detectRuntimes({
        hasUv: false,
        isPythonExecutable: () => {
          throw new Error('EACCES');
        },
      }),
    ).not.toThrow();
    const r = detectRuntimes({
      hasUv: false,
      isPythonExecutable: () => {
        throw new Error('EACCES');
      },
    });
    expect(r).toEqual(['shell', 'node']);
  });
});

describe('reportedExecutorType: 与 capabilities 同源', () => {
  it('具备 python → universal（桌面客户端形态）', () => {
    expect(reportedExecutorType(['shell', 'node', 'python'])).toBe('universal');
  });

  it('不具备 python → node（如实降级，不虚报通用）', () => {
    expect(reportedExecutorType(['shell', 'node'])).toBe('node');
  });

  it('永不返回 python 档（本客户端始终带 node/shell 执行面）', () => {
    const all: ReportedRuntime[][] = [
      ['shell', 'node'],
      ['shell', 'node', 'python'],
      ['python'],
    ];
    for (const r of all) {
      expect(reportedExecutorType(r)).not.toBe('python');
    }
  });

  // 关键契约：type 与 capabilities 由同一份 runtimes 推导，不允许错配。
  it('type 与 capabilities 始终一致（无"显示通用却派不到 python"错配）', () => {
    for (const hasUv of [true, false]) {
      for (const hasPy of [true, false]) {
        const runtimes = detectRuntimes({
          hasUv,
          isPythonExecutable: () => hasPy,
        });
        const type = reportedExecutorType(runtimes);
        const claimsPython = runtimes.includes('python');
        expect(type === 'universal').toBe(claimsPython);
      }
    }
  });
});

describe('probePythonExecutable: 实跑探测而非 which', () => {
  it('退出码 0 → 可用', async () => {
    mockRunCommand.mockResolvedValue({ status: 0, stdout: 'Python 3.12.0', stderr: '' });
    await expect(probePythonExecutable('python3')).resolves.toBe(true);
  });

  // 核心回归：原实现用 which，Windows 上 spawnSync 返回 ENOENT（status=null），
  // 只判 status===0 会把它当"不可用"；实跑探测对不存在命令同样返回 false，
  // 但对**存在**的命令能正确识别——两者的差别在 hasSystemPython 的短路行为。
  it('命令不存在（ENOENT → status null）→ 不可用，且不抛', async () => {
    mockRunCommand.mockResolvedValue({ status: null, stdout: '', stderr: 'spawn python3 ENOENT' });
    await expect(probePythonExecutable('python3')).resolves.toBe(false);
  });

  it('非 0 退出码 → 不可用', async () => {
    mockRunCommand.mockResolvedValue({ status: 1, stdout: '', stderr: 'boom' });
    await expect(probePythonExecutable('python')).resolves.toBe(false);
  });

  it('绝不调用 which（回归：Windows 无 which）', async () => {
    mockRunCommand.mockResolvedValue({ status: 0, stdout: '', stderr: '' });
    await probePythonExecutable('python3');
    for (const call of mockRunCommand.mock.calls) {
      expect(call[0]).not.toBe('which');
    }
  });
});

describe('hasSystemPython: 候选优先级与短路', () => {
  it('python3 命中即不再试 python', async () => {
    mockRunCommand.mockResolvedValue({ status: 0, stdout: '', stderr: '' });
    await expect(hasSystemPython()).resolves.toBe(true);
    expect(mockRunCommand).toHaveBeenCalledTimes(1);
    expect(mockRunCommand.mock.calls[0][0]).toBe('python3');
  });

  it('python3 失败则回落 python', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ status: null, stdout: '', stderr: 'ENOENT' })
      .mockResolvedValueOnce({ status: 0, stdout: '', stderr: '' });
    await expect(hasSystemPython()).resolves.toBe(true);
    expect(mockRunCommand).toHaveBeenCalledTimes(2);
    expect(mockRunCommand.mock.calls[1][0]).toBe('python');
  });

  it('两者都失败 → false', async () => {
    mockRunCommand.mockResolvedValue({ status: null, stdout: '', stderr: 'ENOENT' });
    await expect(hasSystemPython()).resolves.toBe(false);
  });
});
