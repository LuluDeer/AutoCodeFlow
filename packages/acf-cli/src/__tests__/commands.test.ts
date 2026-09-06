/**
 * Route-level tests for the CLI commands: run the real commander actions
 * against a mocked client and assert method / path / params / body for every
 * new P1 command, plus response parsing (field names, envelope handling).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  // run() 内部有动态 import('commander')，其微任务链需在 fake timers 下逐步
  // 让出真实事件循环才能结算，随后轮询的 setTimeout 才会挂上。故用小步推进
  // 直到 pending 落定，避免“一次性大步推进错过定时器注册”的竞态。
  async function drain(pending: Promise<unknown>, maxMs = 20_000): Promise<void> {
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let t = 0; t < maxMs && !settled; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    await pending;
  }

  it('killed 是终态：轮询立即返回，不再空转到 MAX_WAIT', async () => {
    vi.useFakeTimers();
    try {
      mockedPost.mockResolvedValueOnce({ id: 'x1', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      mockedGet.mockResolvedValue({ id: 'x1', status: 'killed', createdAt: '2026-01-01T00:00:00Z' });
      await drain(run(tasksCommand(), 'task trigger t1 --wait'));
      expect(mockedGet).toHaveBeenCalledTimes(1);
      expect(mockedGet).toHaveBeenCalledWith('/tasks/executions/x1');
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('success 终态同样立即返回（回归护栏）', async () => {
    vi.useFakeTimers();
    try {
      mockedPost.mockResolvedValueOnce({ id: 'x2', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      mockedGet.mockResolvedValue({ id: 'x2', status: 'success', duration: 123, createdAt: '2026-01-01T00:00:00Z' });
      await drain(run(tasksCommand(), 'task trigger t1 --wait'));
      expect(mockedGet).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('running→killed：非终态时继续轮询，命中 killed 后退出', async () => {
    vi.useFakeTimers();
    try {
      mockedPost.mockResolvedValueOnce({ id: 'x3', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      mockedGet
        .mockResolvedValueOnce({ id: 'x3', status: 'running', createdAt: '2026-01-01T00:00:00Z' })
        .mockResolvedValueOnce({ id: 'x3', status: 'killed', createdAt: '2026-01-01T00:00:00Z' });
      await drain(run(tasksCommand(), 'task trigger t1 --wait'));
      expect(mockedGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  // U11: 失败终态必须透出执行器回调记录的 exitCode / failureReason /
  // errorMessage，不再只依赖 aiAnalysis。
  it('失败终态输出 exitCode/failureReason/errorMessage', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockedPost.mockResolvedValueOnce({ id: 'x4', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      mockedGet.mockResolvedValue({
        id: 'x4', status: 'failed', createdAt: '2026-01-01T00:00:00Z',
        exitCode: 3, failureReason: 'script_error', errorMessage: 'boom',
      });
      await drain(run(tasksCommand(), 'task trigger t1 --wait'));
      const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toMatch(/Exit code\s*:\s*3/);
      expect(out).toMatch(/Failure reason\s*:\s*script_error/);
      expect(out).toMatch(/Error\s*:\s*boom/);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  }, 30_000);

  it('exitCode/failureReason 缺失时不打印对应行（旧数据不显示 undefined）', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockedPost.mockResolvedValueOnce({ id: 'x5', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' });
      mockedGet.mockResolvedValue({ id: 'x5', status: 'timeout', createdAt: '2026-01-01T00:00:00Z' });
      await drain(run(tasksCommand(), 'task trigger t1 --wait'));
      const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).not.toMatch(/Exit code/);
      expect(out).not.toMatch(/Failure reason/);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  }, 30_000);
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
  it('reads accessToken (camelCase) from the login response', async () => {
    const { setToken } = await import('../config');
    const spy = vi.mocked(setToken);
    mockedPost.mockResolvedValueOnce({ accessToken: 'jwt-abc', refreshToken: 'r1' });
    await run(loginCommand(), 'login --url http://localhost:9999 --user admin --password secret');
    expect(mockedPost).toHaveBeenCalledWith('/auth/login', {
      username: 'admin',
      password: 'secret',
    });
    expect(spy).toHaveBeenCalledWith('jwt-abc');
  });
});
