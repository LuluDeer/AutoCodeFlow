/**
 * 4-2（audit-r4）：内存看门狗单测——采样器注入 + 假定时器。
 * Linux 进程树采样与 Windows tasklist 解析走真实实现但 mock 底层 IO
 * （fs.readFileSync / child_process.execFile），不真正读 /proc 或 spawn tasklist。
 *
 * 注意：Node 22 的 CJS 命名空间对象是冻结的，jest.spyOn 报
 * "Cannot redefine property"，所以改用模块级 jest.mock 替换 readFileSync /
 * execFile（其余 fs/child_process 能力透传 requireActual）。
 */
import * as fs from 'fs';
import * as childProcess from 'child_process';

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, readFileSync: jest.fn() };
});
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execFile: jest.fn() };
});

import {
  startMemoryWatchdog,
  linuxProcTreeSampler,
  winTasklistSampler,
  MemorySampler,
} from './memory-watchdog';

const mockReadFileSync = fs.readFileSync as unknown as jest.Mock;
const mockExecFile = childProcess.execFile as unknown as jest.Mock;

describe('startMemoryWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('RSS 超过上限时触发 onExceed；stop 后不再采样', async () => {
    const sampler: MemorySampler = {
      sampleRssBytes: jest.fn().mockResolvedValue(3 * 1024 * 1024),
    };
    const onExceed = jest.fn();
    const stop = startMemoryWatchdog({
      pid: 42,
      limitMb: 2,
      sampler,
      intervalMs: 1000,
      onExceed,
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(onExceed).toHaveBeenCalledTimes(1);
    stop();
    await jest.advanceTimersByTimeAsync(3000);
    expect(onExceed).toHaveBeenCalledTimes(1);
  });

  it('未超限不触发', async () => {
    const sampler: MemorySampler = {
      sampleRssBytes: jest.fn().mockResolvedValue(1024),
    };
    const onExceed = jest.fn();
    startMemoryWatchdog({ pid: 7, limitMb: 2, sampler, intervalMs: 1000, onExceed });
    await jest.advanceTimersByTimeAsync(3000);
    expect(onExceed).not.toHaveBeenCalled();
  });

  it('采样异常静默跳过（进程已退出/竞态）', async () => {
    const sampler: MemorySampler = {
      sampleRssBytes: jest.fn().mockRejectedValue(new Error('gone')),
    };
    const onExceed = jest.fn();
    startMemoryWatchdog({ pid: 9, limitMb: 2, sampler, intervalMs: 1000, onExceed });
    await jest.advanceTimersByTimeAsync(3000);
    expect(onExceed).not.toHaveBeenCalled();
  });
});

describe('linuxProcTreeSampler (4-2)', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  it('汇总进程树 VmRSS（父 + 子 + 孙）', async () => {
    const table: Record<string, string> = {
      '/proc/100/status': 'Name:\ttask\nVmRSS:\t 1024 kB\n',
      '/proc/100/task/100/children': '200 201\n',
      '/proc/200/status': 'Name:\tchild\nVmRSS:\t 512 kB\n',
      '/proc/200/task/200/children': '300\n',
      '/proc/201/status': 'Name:\tchild2\nVmRSS:\t 256 kB\n',
      '/proc/201/task/201/children': '\n',
      '/proc/300/status': 'Name:\tgrand\nVmRSS:\t 128 kB\n',
      '/proc/300/task/300/children': '\n',
    };
    mockReadFileSync.mockImplementation((p: unknown) => {
      const procPath = String(p);
      if (procPath in table) return table[procPath];
      const err = new Error(`ENOENT: ${procPath}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const rss = await linuxProcTreeSampler.sampleRssBytes(100);
    expect(rss).toBe((1024 + 512 + 256 + 128) * 1024);
  });

  it('进程已退出返回 0（不抛）', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(await linuxProcTreeSampler.sampleRssBytes(404)).toBe(0);
  });
});

describe('winTasklistSampler (4-2)', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('解析 tasklist CSV 的 Mem Usage 字段（含千分位分隔符）', async () => {
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, '"node.exe","1234","Console","1","1,234,567 K"\r\n');
        return {} as never;
      },
    );
    const rss = await winTasklistSampler.sampleRssBytes(1234);
    expect(rss).toBe(1234567 * 1024);
  });

  it('进程不存在（tasklist 报错）返回 0', async () => {
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(new Error('INFO: No tasks are running'), '');
        return {} as never;
      },
    );
    expect(await winTasklistSampler.sampleRssBytes(9999)).toBe(0);
  });
});
