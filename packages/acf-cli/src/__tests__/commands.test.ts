/**
 * Route-level tests for the CLI commands: run the real commander actions
 * against a mocked client and assert method / path / params / body for every
 * new P1 command, plus response parsing (field names, envelope handling).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('ora', () => ({
  default: () => {
    const o: Record<string, unknown> = {
      succeed: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn(),
      text: '',
    };
    o.start = vi.fn(() => o);
    return o;
  },
}));

vi.mock('cli-table3', () => {
  return {
    default: class MockTable {
      rows: unknown[][] = [];
      constructor(public options: unknown) {}
      push(row: unknown[]) {
        this.rows.push(row);
      }
      toString() {
        return `table(${this.rows.length})`;
      }
    },
  };
});

vi.mock('chalk', () => ({
  default: {
    green: (s: unknown) => String(s),
    gray: (s: unknown) => String(s),
    red: (s: unknown) => String(s),
    yellow: (s: unknown) => String(s),
    cyan: (s: unknown) => String(s),
    bold: (s: unknown) => String(s),
  },
}));

vi.mock('../client', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  resetClient: vi.fn(),
  formatApiError: (e: unknown) => String(e),
}));

vi.mock('../config', () => ({
  getApiUrl: () => 'http://localhost:3105',
  getToken: () => '',
  getRefreshToken: () => '',
  setApiUrl: vi.fn(),
  setToken: vi.fn(),
  // BUG-13: login 现在同时落库 refreshToken
  setRefreshToken: vi.fn(),
  clearAuth: vi.fn(),
  showConfig: vi.fn(),
}));

import { get, post, put, patch, del } from '../client';
import { appsCommand } from '../commands/apps';
import { tasksCommand } from '../commands/tasks';
import { executorsCommand } from '../commands/executors';
import { deployCommand } from '../commands/deploy';
import { auditCommand } from '../commands/audit';
import { loginCommand } from '../commands/login';

const mockedGet = vi.mocked(get);
const mockedPost = vi.mocked(post);
const mockedPut = vi.mocked(put);
const mockedPatch = vi.mocked(patch);
const mockedDel = vi.mocked(del);

async function run(cmd: { parseAsync?: unknown }, args: string): Promise<void> {
  // Each command file exports a root Command; wire a fake top-level program
  // so global option hooks do not interfere.
  const { Command } = await import('commander');
  const program = new Command();
  program.addCommand(cmd as never);
  program.exitOverride();
  await program.parseAsync(['node', 'acf', ...args.split(' ').filter(Boolean)], { from: 'node' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

// ---------------------------------------------------------------------------
// app create / update / delete
// ---------------------------------------------------------------------------
describe('acf app create', () => {
  it('POSTs the JSON payload to /applications', async () => {
    mockedPost.mockResolvedValueOnce({ id: 'a1', name: 'demo', version: '1.0.0', status: 'active' });
    await run(appsCommand(), 'app create --json {"name":"demo","version":"1.0.0","runtime":"node"}');
    expect(mockedPost).toHaveBeenCalledWith('/applications', {
      name: 'demo',
      version: '1.0.0',
      runtime: 'node',
    });
  });

  it('does not use PUT', async () => {
    mockedPost.mockResolvedValueOnce({ id: 'a1', name: 'x', status: 'active' });
    await run(appsCommand(), 'app create --json {"name":"x","version":"1","runtime":"node"}');
    expect(mockedPut).not.toHaveBeenCalled();
  });
});

describe('acf app update', () => {
  it('PUTs the patch (without name) to /applications/:id', async () => {
    mockedPut.mockResolvedValueOnce({ id: 'a1', name: 'demo', version: '2.0.0', status: 'active' });
    await run(appsCommand(), 'app update a1 --json {"version":"2.0.0","description":"d"}');
    expect(mockedPut).toHaveBeenCalledWith('/applications/a1', {
      version: '2.0.0',
      description: 'd',
    });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('rejects a payload containing name before hitting the API (UpdateApplicationDto has no name)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      run(appsCommand(), 'app update a1 --json {"name":"new-name","version":"2"}'),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(mockedPut).not.toHaveBeenCalled();
    // The failure message must explain the renaming limitation, not a raw 400.
    const output = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('does not support renaming');
    errSpy.mockRestore();
  });
});

describe('acf app delete', () => {
  it('DELETEs /applications/:id with --yes', async () => {
    mockedDel.mockResolvedValueOnce(undefined);
    await run(appsCommand(), 'app delete a1 --yes');
    expect(mockedDel).toHaveBeenCalledWith('/applications/a1');
  });
});

describe('acf app versions (P3 contract fix)', () => {
  it('GETs /applications/:id/versions and does not crash on the real { commit, deployedAt } field names', async () => {
    // Real backend shape: commit (not gitCommit), deployedAt (not createdAt in legacy fallback)
    mockedGet.mockResolvedValueOnce([
      { id: 'v1', version: '1.0.0', commit: 'abcdef123456', deployedAt: '2026-01-01T00:00:00Z', status: 'success' },
    ]);
    await run(appsCommand(), 'app versions a1');
    expect(mockedGet).toHaveBeenCalledWith('/applications/a1/versions');
  });

  it('accepts legacy fallback rows that only carry createdAt', async () => {
    mockedGet.mockResolvedValueOnce([
      { id: 'v2', version: '0.9.0', commit: null, createdAt: '2025-12-01T00:00:00Z' },
    ]);
    await run(appsCommand(), 'app versions a1');
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });
});

describe('acf app deployments (P2 contract fix)', () => {
  it('reads the { data, total } shape returned by app-deployment.service.findAll', async () => {
    mockedGet.mockResolvedValueOnce({
      data: [{ id: 'd1', applicationId: 'a1', executorId: 'e1', status: 'RUNNING', runMode: 'daemon' }],
      total: 1,
    });
    await run(appsCommand(), 'app deployments');
    expect(mockedGet).toHaveBeenCalledWith('/app-deployments', {
      page: '1',
      pageSize: '20',
    });
  });

  it('passes applicationId when an app filter is given', async () => {
    mockedGet.mockResolvedValueOnce({ data: [], total: 0 });
    await run(appsCommand(), 'app deployments a1');
    expect(mockedGet).toHaveBeenCalledWith('/app-deployments', {
      applicationId: 'a1',
      page: '1',
      pageSize: '20',
    });
  });
});

// ---------------------------------------------------------------------------
// task versions / rollback / compare
// ---------------------------------------------------------------------------
describe('acf task versions', () => {
  it('GETs /tasks/:id/versions', async () => {
    mockedGet.mockResolvedValueOnce([
      { id: 'v1', version: '3', gitCommit: 'abcd', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    await run(tasksCommand(), 'task versions t1');
    expect(mockedGet).toHaveBeenCalledWith('/tasks/t1/versions');
  });
});

describe('acf task rollback', () => {
  it('POSTs to /tasks/:id/versions/:versionId/rollback', async () => {
    mockedPost.mockResolvedValueOnce({ id: 't1', name: 'demo', status: 'active' });
    await run(tasksCommand(), 'task rollback t1 --version v9');
    expect(mockedPost).toHaveBeenCalledWith('/tasks/t1/versions/v9/rollback');
  });
});

describe('acf task compare', () => {
  it('GETs /tasks/:id/versions/:v1/compare/:v2', async () => {
    mockedGet.mockResolvedValueOnce({ cronExpression: { old: '* * * * *', new: '0 0 * * *' } });
    await run(tasksCommand(), 'task compare t1 v1 v2');
    expect(mockedGet).toHaveBeenCalledWith('/tasks/t1/versions/v1/compare/v2');
  });

  it('handles an empty diff (identical versions)', async () => {
    mockedGet.mockResolvedValueOnce({});
    await run(tasksCommand(), 'task compare t1 v1 v1');
    expect(mockedGet).toHaveBeenCalledWith('/tasks/t1/versions/v1/compare/v1');
  });
});

describe('acf task list (P2 contract fix)', () => {
  it('sends the keyword as the `name` query param (ListTasksQueryDto has no keyword)', async () => {
    mockedGet.mockResolvedValueOnce({ list: [], total: 0, page: 1, pageSize: 20 });
    await run(tasksCommand(), 'task list -k foo');
    expect(mockedGet).toHaveBeenCalledWith('/tasks', {
      page: '1',
      pageSize: '20',
      status: undefined,
      name: 'foo',
    });
  });
});

// ---------------------------------------------------------------------------
// task create/update --executor (R7 N20: CLI pinning capability)
// ---------------------------------------------------------------------------
describe('acf task create --executor (N20)', () => {
  it('maps --executor to body.executorId', async () => {
    mockedPost.mockResolvedValueOnce({ id: 't1', name: 'demo', status: 'paused' });
    await run(
      tasksCommand(),
      'task create --json {"name":"demo","triggerType":"api"} --executor 550e8400-e29b-41d4-a716-446655440000',
    );
    expect(mockedPost).toHaveBeenCalledWith('/tasks', {
      name: 'demo',
      triggerType: 'api',
      executorId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('leaves the body untouched when --executor is absent', async () => {
    mockedPost.mockResolvedValueOnce({ id: 't1', name: 'demo', status: 'paused' });
    await run(tasksCommand(), 'task create --json {"name":"demo","triggerType":"api"}');
    const body = mockedPost.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('executorId');
  });
});

describe('acf task update --executor (N20)', () => {
  it('maps --executor to the PATCH body.executorId', async () => {
    mockedPatch.mockResolvedValueOnce({ id: 't1', name: 'demo', status: 'active' });
    await run(
      tasksCommand(),
      'task update t1 --json {"description":"d"} --executor 550e8400-e29b-41d4-a716-446655440000',
    );
    expect(mockedPatch).toHaveBeenCalledWith('/tasks/t1', {
      description: 'd',
      executorId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });
});

// ---------------------------------------------------------------------------
// task executions / trigger --wait (N10)
// ---------------------------------------------------------------------------
describe('acf task executions (N10)', () => {
  it('只发送 PaginationDto 白名单参数（pageSize/page），不再发送后端不识别的 limit', async () => {
    mockedGet.mockResolvedValueOnce({ list: [], total: 0 });
    await run(tasksCommand(), 'task executions t1');
    expect(mockedGet).toHaveBeenCalledWith('/tasks/t1/executions', {
      pageSize: '10',
      page: 1,
    });
    const params = mockedGet.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('limit');
  });
});

describe('acf task trigger --wait (N10)', () => {
  // 轮询用真实定时器：pollExecution 内部 sleep(2000) 真实等待，命中终态即返回。
  // 不引入 vi.useFakeTimers()——fake-timer + 动态 import('commander') 的微任务链
  // 在 CI runner 上会让 advanceTimersByTimeAsync 循环确定性挂死（success 终态
  // 用例曾稳定吃满 120s 超时），真实 2s 轮询反而稳定（单测 2–4s，远低于 30s）。
  it('killed 是终态：轮询立即返回，不再空转到 MAX_WAIT', async () => {
    mockedPost.mockResolvedValueOnce({ id: 'x1', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
    mockedGet.mockResolvedValue({ id: 'x1', status: 'killed', createdAt: '2026-01-01T00:00:00Z' });
    await run(tasksCommand(), 'task trigger t1 --wait');
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledWith('/tasks/executions/x1');
  }, 30_000);

  it('success 终态同样立即返回（回归护栏）', async () => {
    mockedPost.mockResolvedValueOnce({ id: 'x2', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
    mockedGet.mockResolvedValue({ id: 'x2', status: 'success', duration: 123, createdAt: '2026-01-01T00:00:00Z' });
    await run(tasksCommand(), 'task trigger t1 --wait');
    expect(mockedGet).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('running→killed：非终态时继续轮询，命中 killed 后退出', async () => {
    mockedPost.mockResolvedValueOnce({ id: 'x3', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
    mockedGet
      .mockResolvedValueOnce({ id: 'x3', status: 'running', createdAt: '2026-01-01T00:00:00Z' })
      .mockResolvedValueOnce({ id: 'x3', status: 'killed', createdAt: '2026-01-01T00:00:00Z' });
    await run(tasksCommand(), 'task trigger t1 --wait');
    expect(mockedGet).toHaveBeenCalledTimes(2);
  }, 30_000);

  // U11: 失败终态必须透出执行器回调记录的 exitCode / failureReason /
  // errorMessage，不再只依赖 aiAnalysis。
  it('失败终态输出 exitCode/failureReason/errorMessage', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockedPost.mockResolvedValueOnce({ id: 'x4', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      mockedGet.mockResolvedValue({
        id: 'x4', status: 'failed', createdAt: '2026-01-01T00:00:00Z',
        exitCode: 3, failureReason: 'script_error', errorMessage: 'boom',
      });
      await run(tasksCommand(), 'task trigger t1 --wait');
      const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toMatch(/Exit code\s*:\s*3/);
      expect(out).toMatch(/Failure reason\s*:\s*script_error/);
      expect(out).toMatch(/Error\s*:\s*boom/);
    } finally {
      log.mockRestore();
    }
  }, 30_000);

  it('exitCode/failureReason 缺失时不打印对应行（旧数据不显示 undefined）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockedPost.mockResolvedValueOnce({ id: 'x5', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      mockedGet.mockResolvedValue({ id: 'x5', status: 'timeout', createdAt: '2026-01-01T00:00:00Z' });
      await run(tasksCommand(), 'task trigger t1 --wait');
      const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).not.toMatch(/Exit code/);
      expect(out).not.toMatch(/Failure reason/);
    } finally {
      log.mockRestore();
    }
  }, 30_000);

  // CLI-EXIT-01（本轮审计）：--wait 的语义是「等它跑完并给出结果」，但此前
  // pollExecution 命中失败终态（failed/timeout/killed/cancelled）时只调
  // spinner.fail() 打印原因，函数即 return——退出码仍是 0。CI 里
  // `acf task trigger <id> --wait && echo ok` 于是在**任务失败**时照旧打印
  // ok：整个 --wait 通道对自动化完全不可信（而 `acf exec tail` 同场景已有
  // `process.exitCode = status === 'success' ? 0 : 1` 的正确语义——两侧不一致）。
  describe('失败终态必须置非零退出码（CLI-EXIT-01）', () => {
    // 注：这些用例不使用 beforeEach 里的 process.exit 抛错桩的返回值——
    // 修复后走的是 process.exitCode 赋值（不抛），故直接断言 exitCode。
    async function waitFor(status: string, exitOverride = true) {
      const { Command } = await import('commander');
      const program = new Command();
      program.addCommand(tasksCommand() as never);
      if (exitOverride) program.exitOverride();
      try {
        await program.parseAsync(['node', 'acf', 'task', 'trigger', 't1', '--wait'], { from: 'node' });
      } catch {
        /* beforeEach 的 process.exit 桩会抛；此处只关心 exitCode */
      }
      return process.exitCode;
    }

    beforeEach(() => {
      process.exitCode = undefined;
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it.each([
      ['failed', 1],
      ['timeout', 1],
      ['killed', 1],
      ['cancelled', 1],
    ])('%s 终态 → 退出码 %i', async (status, expected) => {
      mockedPost.mockResolvedValueOnce({ id: 'w1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      mockedGet.mockResolvedValue({ id: 'w1', status, createdAt: '2026-01-01T00:00:00Z' });
      expect(await waitFor(status)).toBe(expected);
    }, 30_000);

    it('success 终态仍为 0（回归护栏：不得把成功也判失败）', async () => {
      mockedPost.mockResolvedValueOnce({ id: 'w2', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      mockedGet.mockResolvedValue({ id: 'w2', status: 'success', duration: 50, createdAt: '2026-01-01T00:00:00Z' });
      const code = await waitFor('success');
      expect(code === undefined || code === 0).toBe(true);
    }, 30_000);
  });

  // NETOPT-2①（本轮审计）：轮询窗口耗尽（超时）分支此前只 spinner.fail 就
  // return，退出码仍是 0——执行明明还在跑，CI 里 `acf task trigger <id>
  // --wait && …` 对超过等待上限的真实长任务假绿。修复后超时必须置
  // exitCode=1，且提供 --wait-timeout 让长任务可调（默认 600 保持现行为）。
  describe('等待超时必须置非零退出码（NETOPT-2①）', () => {
    beforeEach(() => {
      process.exitCode = undefined;
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      process.exitCode = undefined;
    });

    function triggerWith(args: string): Promise<void> {
      return (async () => {
        const { Command } = await import('commander');
        const program = new Command();
        program.addCommand(tasksCommand() as never);
        program.exitOverride();
        await program.parseAsync(
          ['node', 'acf', 'task', 'trigger', 't1', '--wait', ...args.split(' ').filter(Boolean)],
          { from: 'node' },
        );
      })();
    }

    it('窗口耗尽 → exitCode=1，且只轮询到窗口关闭为止', async () => {
      mockedPost.mockResolvedValueOnce({ id: 'w3', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      // 始终 running：只能靠超时退出循环
      mockedGet.mockResolvedValue({ id: 'w3', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      await triggerWith('--wait-timeout 1');
      expect(process.exitCode).toBe(1);
      // 1s 窗口：首轮 sleep(2000) 后就超过窗口，最多轮询 1 次
      expect(mockedGet.mock.calls.length).toBeLessThanOrEqual(2);
      expect(mockedGet).toHaveBeenCalledWith('/tasks/executions/w3');
    }, 30_000);

    it('超时提示必须说明执行仍在运行（不能只报 Timed out）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        mockedPost.mockResolvedValueOnce({ id: 'w4', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
        mockedGet.mockResolvedValue({ id: 'w4', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
        await triggerWith('--wait-timeout 1');
        const out = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(out).toContain('still running');
        expect(out).toContain('acf exec tail w4');
      } finally {
        errSpy.mockRestore();
      }
    }, 30_000);

    it('--wait-timeout 缺省为 600（保持既有行为）', () => {
      const cmd = tasksCommand();
      const trigger = cmd.commands.find((c) => c.name() === 'trigger');
      expect(trigger).toBeTruthy();
      const opt = trigger!.options.find((o) => o.long === '--wait-timeout');
      expect(opt?.defaultValue).toBe(600);
    });

    it.each(['0', '-5', 'abc'])('非正值/非法 --wait-timeout（%s）直接报参数错误', async (bad) => {
      const { Command } = await import('commander');
      const program = new Command();
      program.addCommand(tasksCommand() as never);
      // InvalidArgumentError → commander error() 先把错误文案写到 stderr，
      // 再 process.exit(1)（文件级 beforeEach 的桩会让 parseAsync 拒绝）。
      // 因此断言「stderr 有可读的校验错误 + 命令以非零路径终止 + 绝不触发」，
      // 与真实 CLI 的可观察行为一致。
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await expect(
          program.parseAsync(['node', 'acf', 'task', 'trigger', 't1', '--wait', '--wait-timeout', bad], {
            from: 'node',
          }),
        ).rejects.toThrow();
        const out = errSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(out).toContain('wait-timeout');
        expect(out).toContain('positive integer');
      } finally {
        errSpy.mockRestore();
      }
      // 参数校验失败时绝不能真的触发任务
      expect(mockedPost).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// executor get
// ---------------------------------------------------------------------------
describe('acf executor get', () => {
  it('GETs /executors/:id', async () => {
    mockedGet.mockResolvedValueOnce({
      id: 'e1',
      appName: 'executor-node',
      address: '10.0.0.5:3002',
      status: 'online',
      cpuUsage: 12.5,
      runningTaskCount: 2,
    });
    await run(executorsCommand(), 'executor get e1');
    expect(mockedGet).toHaveBeenCalledWith('/executors/e1');
  });

  it('handles entity field names without crashing (appName/address/cpuUsage)', async () => {
    mockedGet.mockResolvedValueOnce({
      id: 'e1',
      appName: 'exec',
      address: 'x:1',
      status: 'offline',
      groupName: null,
      tags: null,
      cpuUsage: null,
      memUsage: null,
      maxConcurrentTasks: null,
    });
    await run(executorsCommand(), 'executor get e1');
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  // U11 (CONSISTENCY-02 parity with admin-web): runningExecutionIds tri-state
  // — null = 旧版执行器未上报, [] = 空闲, 非空 = 运行中列表。
  it.each([
    { value: ['aaaa-bbbb', 'cccc-dddd'], pattern: /Running Executions:\s*2 running: aaaa-bbbb, cccc-dddd/ },
    { value: [], pattern: /Running Executions:\s*idle \(none running\)/ },
    { value: null, pattern: /Running Executions:\s*not reported \(older executor\)/ },
  ])('Running Executions 三态输出（$value）', async ({ value, pattern }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockedGet.mockResolvedValueOnce({
        id: 'e1', appName: 'exec', address: 'x:1', status: 'online',
        runningExecutionIds: value,
      });
      await run(executorsCommand(), 'executor get e1');
      const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toMatch(pattern);
    } finally {
      log.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// deploy upgrade / stop
// ---------------------------------------------------------------------------
describe('acf deploy upgrade', () => {
  it('POSTs to /app-deployments/:id/upgrade', async () => {
    mockedPost.mockResolvedValueOnce({ id: 'd1', status: 'UPGRADING', executorId: 'e1' });
    await run(deployCommand(), 'deploy upgrade d1');
    expect(mockedPost).toHaveBeenCalledWith('/app-deployments/d1/upgrade');
  });
});

describe('acf deploy stop', () => {
  it('POSTs to /app-deployments/:id/stop', async () => {
    mockedPost.mockResolvedValueOnce({ id: 'd1', status: 'STOPPED' });
    await run(deployCommand(), 'deploy stop d1');
    expect(mockedPost).toHaveBeenCalledWith('/app-deployments/d1/stop');
  });
});

// ---------------------------------------------------------------------------
// audit list
// ---------------------------------------------------------------------------
describe('acf audit list', () => {
  it('GETs /audit with AuditQueryDto whitelist params only', async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        {
          id: 7,
          userId: 1,
          username: 'admin',
          action: 'task.trigger',
          resource: 'task',
          resourceId: 't1',
          result: 'success',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    });
    await run(
      auditCommand(),
      'audit list --action task --username admin --start-time 2026-01-01T00:00:00Z --end-time 2026-02-01T00:00:00Z --user-id 1 --resource task',
    );
    expect(mockedGet).toHaveBeenCalledWith('/audit', {
      page: '1',
      pageSize: '20',
      action: 'task',
      resource: 'task',
      userId: '1',
      username: 'admin',
      startTime: '2026-01-01T00:00:00Z',
      endTime: '2026-02-01T00:00:00Z',
    });
  });

  it('omits filters that were not provided (never sends undefined keys)', async () => {
    mockedGet.mockResolvedValueOnce({ data: [], total: 0 });
    await run(auditCommand(), 'audit list');
    expect(mockedGet).toHaveBeenCalledWith('/audit', {
      page: '1',
      pageSize: '20',
      action: undefined,
      resource: undefined,
      userId: undefined,
      username: undefined,
      startTime: undefined,
      endTime: undefined,
    });
  });

  it('parses the { data, total } response shape', async () => {
    mockedGet.mockResolvedValueOnce({
      data: [{ id: 1, action: 'user.login', createdAt: '2026-01-01T00:00:00Z' }],
      total: 42,
    });
    await run(auditCommand(), 'audit list');
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// login (P0 contract regression guard)
// ---------------------------------------------------------------------------
describe('acf login', () => {
  it('reads accessToken/refreshToken (camelCase) from the login response', async () => {
    const { setToken, setRefreshToken } = await import('../config');
    const accessSpy = vi.mocked(setToken);
    const refreshSpy = vi.mocked(setRefreshToken);
    mockedPost.mockResolvedValueOnce({ accessToken: 'jwt-abc', refreshToken: 'r1' });
    await run(loginCommand(), 'login --url http://localhost:9999 --user admin --password secret');
    expect(mockedPost).toHaveBeenCalledWith('/auth/login', {
      username: 'admin',
      password: 'secret',
    });
    expect(accessSpy).toHaveBeenCalledWith('jwt-abc');
    expect(refreshSpy).toHaveBeenCalledWith('r1');
  });

  // PK-27（DEEP_REVIEW 0ef3bbe）：--password 明文会进 ps/shell history，新增
  // ACF_PASSWORD env 通道（不进 argv）+ 使用 --password 时向 stderr 告警。
  it('reads the password from ACF_PASSWORD env when --password is absent', async () => {
    const prev = process.env.ACF_PASSWORD;
    process.env.ACF_PASSWORD = 'env-secret';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedPost.mockResolvedValueOnce({ accessToken: 'jwt-env', refreshToken: 'r2' });
      await run(loginCommand(), 'login --url http://localhost:9999 --user admin');
      expect(mockedPost).toHaveBeenCalledWith('/auth/login', {
        username: 'admin',
        password: 'env-secret',
      });
      // env 通道不该打「明文泄漏」告警
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      if (prev === undefined) delete process.env.ACF_PASSWORD;
      else process.env.ACF_PASSWORD = prev;
    }
  });

  it('prefers --password over ACF_PASSWORD and warns about the leak surface', async () => {
    const prev = process.env.ACF_PASSWORD;
    process.env.ACF_PASSWORD = 'env-secret';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedPost.mockResolvedValueOnce({ accessToken: 'jwt-flag', refreshToken: 'r3' });
      await run(
        loginCommand(),
        'login --url http://localhost:9999 --user admin --password flag-secret',
      );
      expect(mockedPost).toHaveBeenCalledWith('/auth/login', {
        username: 'admin',
        password: 'flag-secret',
      });
      // 必须显式告警（提示改用 ACF_PASSWORD）
      const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(warned).toContain('--password');
      expect(warned).toContain('ACF_PASSWORD');
    } finally {
      stderrSpy.mockRestore();
      if (prev === undefined) delete process.env.ACF_PASSWORD;
      else process.env.ACF_PASSWORD = prev;
    }
  });
});

// ECO-02: --json 输出面（CI 消费）——payload 不经表格直出
describe('acf --json outputs (ECO-02)', () => {
  it('task list --json prints the unwrapped payload as JSON', async () => {
    const payload = { list: [{ id: 't-1', name: 'n1', runtime: 'python', status: 'active', cronExpression: null }], total: 1, page: 1, pageSize: 20 };
    mockedGet.mockResolvedValueOnce(payload);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      await run(tasksCommand(), 'task list --json');
    } finally {
      spy.mockRestore();
    }
    const line = logs.find((l) => l.startsWith('{'));
    expect(line).toBeDefined();
    expect(JSON.parse(line as string)).toEqual(payload);
  });

  it('executor list --json prints a bare array', async () => {
    mockedGet.mockResolvedValueOnce([{ id: 'e-1', appName: 'exec', address: 'h:1', status: 'online' }]);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      await run(executorsCommand(), 'executor list --json');
    } finally {
      spy.mockRestore();
    }
    const line = logs.find((l) => l.startsWith('['));
    expect(JSON.parse(line as string)).toEqual([{ id: 'e-1', appName: 'exec', address: 'h:1', status: 'online' }]);
  });

  it('app list --json prints a bare array', async () => {
    mockedGet.mockResolvedValueOnce({ list: [{ id: 'a-1', name: 'app', status: 'running' }], total: 1 });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      await run(appsCommand(), 'app list --json');
    } finally {
      spy.mockRestore();
    }
    const line = logs.find((l) => l.startsWith('['));
    expect(JSON.parse(line as string)).toEqual([{ id: 'a-1', name: 'app', status: 'running' }]);
  });
});
