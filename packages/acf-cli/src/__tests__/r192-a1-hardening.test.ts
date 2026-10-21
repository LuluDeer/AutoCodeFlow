/**
 * R192-A1：acf-cli 命令实现的健壮性审计（三轴的行为层守卫）。
 *
 * 本文件只钉**实现面**的契约（命令地图 vs 代码的一致性由 check-cli-doc.mjs 守）：
 *
 * 轴 2（破坏性操作）：`kill` / `webhook rotate|enable|disable` / `apikey revoke`
 *   与既有的 7 个确认门（app delete / task delete / deploy remove / task batch delete /
 *   app upgrade-all(all) / executor rotate / mutex delete）同属「不可逆 × 一次性别密」，
 *   必须共用同一套 `confirmDestructive` 语义：非 TTY 且无 --yes → 退出码 2 且
 *   **请求不发出**（不静默执行，也不静默取消）。
 *
 * 轴 1（错误面/退出码）：本地数值参数写错必须报用法错误（码 2），不能被
 *   `parseInt(x) || 默认值` 静默吞成默认值——那会让 `acf task logs --tail 5o`
 *   静默退回 50 行，CI 以为拿到的是「最后 5 行」。
 *
 * 轴 3（输出契约）：`--json` 的 stdout 必须能被整体 JSON.parse（人类可读行不得
 *   混入管道）；失败时 stdout 保持空、stderr 是单行结构化 JSON、退出码与
 *   `exitCode` 字段同源。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

const { oraInstances } = vi.hoisted(() => ({
  oraInstances: [] as Array<{ start: Mock; succeed: Mock; fail: Mock; stop: Mock; text: string }>,
}));

vi.mock('ora', () => ({
  default: () => {
    const o = {
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn(),
      text: '',
    };
    o.start.mockImplementation(() => o);
    oraInstances.push(o);
    return o;
  },
}));

vi.mock('cli-table3', () => ({
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
}));

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

vi.mock('../client.js', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  resetClient: vi.fn(),
  formatApiError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  classifyApiError: () => 'unknown',
  ANALYZE_TIMEOUT_MS: 120_000,
  UPLOAD_TIMEOUT_MS: 300_000,
}));

vi.mock('../config.js', () => ({
  getApiUrl: () => 'http://localhost:3105',
  getToken: () => '',
  getRefreshToken: () => '',
  setApiUrl: vi.fn(),
  setToken: vi.fn(),
  setRefreshToken: vi.fn(),
  clearAuth: vi.fn(),
  showConfig: vi.fn(),
}));

import { get, post, del } from '../client.js';
import { tasksCommand } from '../commands/tasks.js';
import { apikeysCommand } from '../commands/apikeys.js';
import { appsCommand } from '../commands/apps.js';
import { executorsCommand } from '../commands/executors.js';
import { deployCommand } from '../commands/deploy.js';
import { mutexCommand } from '../commands/mutex.js';
import { sopCommand } from '../commands/sop.js';
import { auditCommand } from '../commands/audit.js';
import { approvalCommand } from '../commands/approval.js';
import { projectsCommand } from '../commands/projects.js';

const mockedGet = vi.mocked(get);
const mockedPost = vi.mocked(post);
const mockedDel = vi.mocked(del);

function applyExitOverride(command: import('commander').Command): void {
  command.exitOverride();
  for (const sub of command.commands) applyExitOverride(sub);
}

/**
 * 与 dist/index.js 的入口同一条解析期路径：整棵树 exitOverride（index.ts 的
 * applyParseErrorBehavior 就是这么做的），CommanderError 再经 parseErrorExitCode
 * 映射成进程退出码。少了这一步，commander 的「非法取值」会在子命令层直接
 * process.exit(1)，测到的就不是**发布物**的退出码了。
 */
async function run(cmd: { parseAsync?: unknown }, args: string): Promise<void> {
  const { Command, CommanderError } = await import('commander');
  const { parseErrorExitCode } = await import('../index.js');
  const program = new Command();
  program.addCommand(cmd as never);
  applyExitOverride(program);
  try {
    await program.parseAsync(['node', 'acf', ...args.split(' ').filter(Boolean)], { from: 'node' });
  } catch (e) {
    if (e instanceof CommanderError) {
      throw new Error(`process.exit(${parseErrorExitCode(e)})`);
    }
    throw e;
  }
}

/** 同时抓 console.log 与裸 process.stdout.write（后者是 exec tail 的出口）。 */
function captureStdout(): string[] {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
    out.push(a.map((x) => String(x)).join(' '));
  }) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
  return out;
}

function captureStderr(): string[] {
  const out: string[] = [];
  vi.spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
    out.push(a.map((x) => String(x)).join(' '));
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
  return out;
}

/** vitest worker 里 stdin.isTTY 恒为 undefined（= 非交互），这里显式表态。 */
function forceStdin(isTTY: boolean): () => void {
  const real = process.stdin;
  Object.defineProperty(process, 'stdin', {
    value: { isTTY, on: () => undefined },
    configurable: true,
  });
  return () => Object.defineProperty(process, 'stdin', { value: real, configurable: true });
}

beforeEach(() => {
  // resetAllMocks（不是 clearAllMocks）：一次性的 mockResolvedValueOnce 队列
  // 必须被丢弃，否则前一个用例排下的队列会被下一个用例的第一次调用吃掉
  // （实测把「404 → 退出码 1」误判成「删除成功」）。
  vi.resetAllMocks();
  oraInstances.length = 0;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// 轴 2：破坏性动作的确认门
// ---------------------------------------------------------------------------
describe('R192-A1 轴2：kill / webhook / apikey revoke 的确认门', () => {
  it('task kill：非交互 + 无 --yes → 码 2，kill 请求不发出', async () => {
    const restore = forceStdin(false);
    const err = captureStderr();
    try {
      await expect(run(tasksCommand(), 'task kill t1 e1')).rejects.toThrow(/process\.exit\(2\)/);
      expect(mockedPost).not.toHaveBeenCalled();
      expect(err.join('\n')).toContain('--yes');
    } finally {
      restore();
    }
  });

  it('task kill --yes：直通到 POST /tasks/:id/executions/:id/kill', async () => {
    const restore = forceStdin(false);
    mockedPost.mockResolvedValueOnce({ success: true, message: 'Execution marked as terminated' });
    try {
      await run(tasksCommand(), 'task kill t1 e1 --yes');
      expect(mockedPost).toHaveBeenCalledWith('/tasks/t1/executions/e1/kill');
    } finally {
      restore();
    }
  });

  it('task webhook rotate：非交互 + 无 --yes → 码 2，rotate 请求不发出', async () => {
    const restore = forceStdin(false);
    const err = captureStderr();
    try {
      await expect(run(tasksCommand(), 'task webhook rotate t1')).rejects.toThrow(
        /process\.exit\(2\)/,
      );
      expect(mockedPost).not.toHaveBeenCalled();
      expect(err.join('\n')).toContain('--yes');
    } finally {
      restore();
    }
  });

  it('task webhook enable：对已启用任务等价轮换（旧 secret 立即失效）→ 同样要确认', async () => {
    const restore = forceStdin(false);
    try {
      await expect(run(tasksCommand(), 'task webhook enable t1')).rejects.toThrow(
        /process\.exit\(2\)/,
      );
      expect(mockedPost).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('task webhook disable：非交互 + 无 --yes → 码 2，disable 请求不发出', async () => {
    const restore = forceStdin(false);
    try {
      await expect(run(tasksCommand(), 'task webhook disable t1')).rejects.toThrow(
        /process\.exit\(2\)/,
      );
      expect(mockedPost).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('task webhook status 是只读面，不需要 --yes（回归护栏）', async () => {
    const restore = forceStdin(false);
    mockedGet.mockResolvedValueOnce({ enabled: true, url: 'http://api/webhooks/tasks/t1' });
    try {
      await run(tasksCommand(), 'task webhook status t1');
      expect(mockedGet).toHaveBeenCalledWith('/tasks/t1/webhook');
    } finally {
      restore();
    }
  });

  it('apikey revoke：非交互 + 无 --yes → 码 2，DELETE 不发出（撤销不可逆）', async () => {
    const restore = forceStdin(false);
    const err = captureStderr();
    try {
      await expect(run(apikeysCommand(), 'apikey revoke 3')).rejects.toThrow(/process\.exit\(2\)/);
      expect(mockedDel).not.toHaveBeenCalled();
      expect(err.join('\n')).toContain('--yes');
    } finally {
      restore();
    }
  });

  it('apikey revoke --yes：直通到 DELETE /api-keys/:id', async () => {
    const restore = forceStdin(false);
    mockedDel.mockResolvedValueOnce({ success: true });
    try {
      await run(apikeysCommand(), 'apikey revoke 3 --yes');
      expect(mockedDel).toHaveBeenCalledWith('/api-keys/3');
    } finally {
      restore();
    }
  });
});

describe('R192-A1 轴2：删除不存在的东西必须是失败（幂等语义）', () => {
  it('app delete --yes 打 404 → 退出码 1（不静默成功）', async () => {
    const restore = forceStdin(false);
    const err = captureStderr();
    const e404 = Object.assign(new Error('Not found (404): resource does not exist'), {
      response: { status: 404, data: { statusCode: 404, message: 'Application not found' } },
    });
    mockedDel.mockRejectedValueOnce(e404);
    try {
      await expect(run(appsCommand(), 'app delete a1 --yes')).rejects.toThrow(
        /process\.exit\(1\)/,
      );
      // 服务端文案经 formatApiError 呈现（本文件把 client 层整体 mock 了，
      // 故这里只断言 404 面确实透出、且不是静默成功）。
      expect(err.join('\n')).toContain('404');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 轴 1：本地数值参数写错必须报用法错误（码 2），不得静默退回默认值
// ---------------------------------------------------------------------------
describe('R192-A1 轴1：task logs 的数值参数不在本地静默兜底', () => {
  it('--tail abc → 码 2，日志请求不发出', async () => {
    const err = captureStderr();
    await expect(run(tasksCommand(), 'task logs x1 --tail abc')).rejects.toThrow(
      /process\.exit\(2\)/,
    );
    expect(mockedGet).not.toHaveBeenCalled();
    expect(err.join('\n')).toMatch(/--tail/);
  });

  it('--from-line 1O0（字母 O 打错）→ 码 2，不静默从第 0 行拉', async () => {
    await expect(run(tasksCommand(), 'task logs x1 --from-line 1O0')).rejects.toThrow(
      /process\.exit\(2\)/,
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('--limit 0 → 码 2（不是「拿 0 行」也不是「静默用 200」）', async () => {
    await expect(run(tasksCommand(), 'task logs x1 --limit 0')).rejects.toThrow(
      /process\.exit\(2\)/,
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('合法值仍然照旧（--from-line 5 --limit 20 → 请求参数原样）', async () => {
    mockedGet.mockResolvedValueOnce({ lines: [], totalLines: 0, hasMore: false });
    await run(tasksCommand(), 'task logs x1 --from-line 5 --limit 20');
    expect(mockedGet).toHaveBeenCalledWith('/tasks/executions/x1/logs', {
      fromLine: 5,
      limit: 20,
    });
  });
});

// ---------------------------------------------------------------------------
// 轴 3：--json 的 stdout 契约
// ---------------------------------------------------------------------------
describe('R192-A1 轴3：--json 的 stdout 是一个可整体解析的 JSON 文档', () => {
  it('task list --json', async () => {
    mockedGet.mockResolvedValueOnce({ list: [], total: 0, page: 1, pageSize: 20 });
    const out = captureStdout();
    await run(tasksCommand(), 'task list --json');
    expect(JSON.parse(out.join('\n'))).toEqual({ list: [], total: 0, page: 1, pageSize: 20 });
  });

  it('task get --json', async () => {
    mockedGet.mockResolvedValueOnce({ id: 't1', name: 'demo', runtime: 'python', status: 'active' });
    const out = captureStdout();
    await run(tasksCommand(), 'task get t1 --json');
    expect(JSON.parse(out.join('\n')).id).toBe('t1');
  });

  it('executor list --json', async () => {
    mockedGet.mockResolvedValueOnce([{ id: 'e1', appName: 'x', address: 'a', status: 'online' }]);
    const out = captureStdout();
    await run(executorsCommand(), 'executor list --json');
    expect(JSON.parse(out.join('\n'))).toEqual([
      { id: 'e1', appName: 'x', address: 'a', status: 'online' },
    ]);
  });

  it('deploy list --json', async () => {
    mockedGet.mockResolvedValueOnce({ data: [], total: 0 });
    const out = captureStdout();
    await run(deployCommand(), 'deploy list --json');
    expect(JSON.parse(out.join('\n'))).toEqual({ data: [], total: 0 });
  });

  it('mutex list --json', async () => {
    mockedGet.mockResolvedValueOnce([]);
    const out = captureStdout();
    await run(mutexCommand(), 'mutex list --json');
    expect(JSON.parse(out.join('\n'))).toEqual([]);
  });

  it('sop list --json', async () => {
    mockedGet.mockResolvedValueOnce({ items: [], total: 0 });
    const out = captureStdout();
    await run(sopCommand(), 'sop list --json');
    expect(JSON.parse(out.join('\n'))).toEqual({ items: [], total: 0 });
  });

  it('audit list --json', async () => {
    mockedGet.mockResolvedValueOnce({ data: [], total: 0 });
    const out = captureStdout();
    await run(auditCommand(), 'audit list --json');
    expect(JSON.parse(out.join('\n'))).toEqual({ data: [], total: 0 });
  });

  it('approval list --json', async () => {
    mockedGet.mockResolvedValueOnce({ data: [], total: 0 });
    const out = captureStdout();
    await run(approvalCommand(), 'approval list --json');
    expect(JSON.parse(out.join('\n'))).toEqual({ data: [], total: 0 });
  });

  it('project list --json', async () => {
    mockedGet.mockResolvedValueOnce([]);
    const out = captureStdout();
    await run(projectsCommand(), 'project list --json');
    expect(JSON.parse(out.join('\n'))).toEqual([]);
  });
});

describe('R192-A1 轴3：--json 调用失败时 stdout 保持干净、stderr 是单行 JSON', () => {
  it('task list --json 打 500 → stdout 为空、stderr 单行 JSON、退出码 1 且与 exitCode 字段同源', async () => {
    const realArgv = process.argv.slice();
    process.argv.push('--json');
    const out = captureStdout();
    const err = captureStderr();
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error('boom'), {
        response: { status: 500, data: { statusCode: 500, message: 'internal' } },
      }),
    );
    try {
      await expect(run(tasksCommand(), 'task list --json')).rejects.toThrow(/process\.exit\(1\)/);
    } finally {
      process.argv.length = 0;
      process.argv.push(...realArgv);
    }
    expect(out.join('')).toBe('');
    expect(err).toHaveLength(1);
    const payload = JSON.parse(err[0]);
    expect(payload).toMatchObject({ ok: false, code: 500, message: 'internal', exitCode: 1 });
  });
});
