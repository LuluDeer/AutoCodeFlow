/**
 * 审计缺口落地（本轮）的命令级测试：TOTP 二段登录、任务导入/导出、批量面、
 * API Key 管理、config set-token 告警。与 commands.test.ts 同一套路——跑真实
 * commander action，mock client/config 层，断言请求形状（method/path/body）
 * 与可观察输出（stdout/stderr/退出码）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { PassThrough } from 'node:stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ora mock 记录每个实例：succeed/fail 文案走 spinner 而非 console.log，
// 断言「Task exported to / Task imported: <id> / revoked」时要查最后一个实例。
const { oraInstances } = vi.hoisted(() => ({
  oraInstances: [] as Array<{ start: Mock; succeed: Mock; fail: Mock; stop: Mock; text: string }>,
}));

function lastSpinner(): { start: Mock; succeed: Mock; fail: Mock; stop: Mock; text: string } {
  const s = oraInstances.at(-1);
  expect(s, 'no ora spinner was created for this run').toBeTruthy();
  return s!;
}

vi.mock('ora', () => ({
  default: () => {
    const o: { start: Mock; succeed: Mock; fail: Mock; stop: Mock; text: string } = {
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

// classifyApiError 做成可控状态：TOTP 错码（401）→ auth → 退出码 3 的断言需要它。
const classifyState = { value: 'unknown' as string };

vi.mock('../client.js', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  resetClient: vi.fn(),
  formatApiError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  classifyApiError: () => classifyState.value,
  ANALYZE_TIMEOUT_MS: 120_000,
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
import { loginCommand, resolveTotpCode } from '../commands/login.js';
import { tasksCommand, readStdin } from '../commands/tasks.js';
import { apikeysCommand } from '../commands/apikeys.js';
// index.ts 有 main-guard：import 只构建命令树，不触发 parseAsync（用于 set-token）。
import { program } from '../index.js';

const mockedGet = vi.mocked(get);
const mockedPost = vi.mocked(post);
const mockedDel = vi.mocked(del);

async function run(cmd: { parseAsync?: unknown }, args: string): Promise<void> {
  const { Command } = await import('commander');
  const program = new Command();
  program.addCommand(cmd as never);
  program.exitOverride();
  await program.parseAsync(['node', 'acf', ...args.split(' ').filter(Boolean)], { from: 'node' });
}

function captureStdout(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(' '));
  }) as never);
  return logs;
}

function captureStderr(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(' '));
  }) as never);
  return logs;
}

beforeEach(() => {
  classifyState.value = 'unknown';
  vi.clearAllMocks();
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
// P1: login TOTP 二段流程（SEC-03）
// 契约：POST /auth/login 对启用 TOTP 的用户返回 200 + { totpRequired: true }
//（不发 token）；第二段 POST /auth/totp/verify body={username,password,code}，
// 响应与普通登录同形（accessToken/refreshToken camelCase）。
// ---------------------------------------------------------------------------
describe('acf login TOTP 二段流程', () => {
  it('totpRequired:true → --code 走 /auth/totp/verify，双 token 落库与普通 login 相同', async () => {
    const { setToken, setRefreshToken } = await import('../config.js');
    mockedPost
      .mockResolvedValueOnce({ totpRequired: true })
      .mockResolvedValueOnce({ accessToken: 'jwt-totp', refreshToken: 'r-totp' });
    await run(
      loginCommand(),
      'login --url http://localhost:9999 --user admin --password secret --code 123456',
    );
    // 第一段：登录请求原样发出（username/password）
    expect(mockedPost).toHaveBeenNthCalledWith(1, '/auth/login', {
      username: 'admin',
      password: 'secret',
    });
    // 第二段：verify 请求形状（TotpVerifyDto 白名单）
    expect(mockedPost).toHaveBeenNthCalledWith(2, '/auth/totp/verify', {
      username: 'admin',
      password: 'secret',
      code: '123456',
    });
    expect(vi.mocked(setToken)).toHaveBeenCalledWith('jwt-totp');
    expect(vi.mocked(setRefreshToken)).toHaveBeenCalledWith('r-totp');
  });

  it('普通登录（无 totpRequired）绝不调用 verify（回归护栏）', async () => {
    mockedPost.mockResolvedValueOnce({ accessToken: 'jwt-plain', refreshToken: 'r1' });
    await run(loginCommand(), 'login --url http://localhost:9999 --user admin --password secret');
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/auth/login', { username: 'admin', password: 'secret' });
  });

  it('verify 失败（错码 → 401）→ 按 Login failed 认证失败退出（码 3），不落 token', async () => {
    classifyState.value = 'auth';
    mockedPost
      .mockResolvedValueOnce({ totpRequired: true })
      .mockRejectedValueOnce(new Error('Unauthorized (401): Invalid TOTP code'));
    await expect(
      run(loginCommand(), 'login --url http://localhost:9999 --user admin --password secret --code 000000'),
    ).rejects.toThrow(/process\.exit\(3\)/);
    const { setToken, setRefreshToken } = await import('../config.js');
    expect(vi.mocked(setToken)).not.toHaveBeenCalled();
    expect(vi.mocked(setRefreshToken)).not.toHaveBeenCalled();
  });

  it('非交互环境（stdin 非 TTY）且未给 --code → 可操作用法错误（码 2），只发出 login 一跳', async () => {
    // vitest 里 process.stdin.isTTY 为 undefined（≠true）→ 走非交互分支
    const err = captureStderr();
    mockedPost.mockResolvedValueOnce({ totpRequired: true });
    await expect(
      run(loginCommand(), 'login --url http://localhost:9999 --user admin --password secret'),
    ).rejects.toThrow(/process\.exit\(2\)/);
    const out = err.join('\n');
    expect(out).toContain('--code');
    expect(out).toContain('TOTP');
    expect(mockedPost).toHaveBeenCalledTimes(1); // 只有 login，绝无 verify
  });

  it('--code 形态非法 → 在发起任何网络请求前报用法错误（码 2），不消耗登录限流', async () => {
    const err = captureStderr();
    await expect(
      run(loginCommand(), 'login --url http://localhost:9999 --user admin --password secret --code 12ab'),
    ).rejects.toThrow(/process\.exit\(2\)/);
    expect(err.join('\n')).toContain('6-digit');
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('resolveTotpCode：--code 优先；TTY 下才走交互 prompt（注入 promptFn 驱动）', async () => {
    expect(await resolveTotpCode({ code: ' 654321 ' })).toBe('654321');
    // 交互路径需要 stdin 是 TTY（vitest worker 里 isTTY 恒为 undefined）；
    // promptFn 已注入，替换 stdin 只为通过 TTY 判据，不读真实输入。
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: { isTTY: true }, configurable: true });
    try {
      let prompted = '';
      const viaPrompt = await resolveTotpCode({}, async (q) => {
        prompted = q;
        return '098765';
      });
      expect(prompted).toContain('TOTP');
      expect(viaPrompt).toBe('098765');
    } finally {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    }
  });
});

// ---------------------------------------------------------------------------
// P2: 任务导入/导出（E-1）。契约：GET /tasks/:id/export 回原始 JSON（不经
// envelope，client.unwrap 判据不命中）；POST /tasks/import body=导出物原样，
// 响应 data={taskId,name,warnings}。CLI 不做任何本地变换。
// ---------------------------------------------------------------------------
describe('acf task export', () => {
  const payload = {
    schemaVersion: '1',
    exportedAt: '2026-10-05T00:00:00.000Z',
    task: { name: 'Nightly sync', triggerType: 'cron', cronExpression: '0 2 * * *', runtime: 'python' },
  };

  it('GET /tasks/:id/export，缺省输出 stdout（JSON.parse 后与导出物逐字节等价）', async () => {
    mockedGet.mockResolvedValueOnce(payload);
    const logs = captureStdout();
    await run(tasksCommand(), 'task export t1');
    expect(mockedGet).toHaveBeenCalledWith('/tasks/t1/export');
    const line = logs.join('\n');
    expect(JSON.parse(line)).toEqual(payload);
    // 导出物红线自查：secrets 键根本不该出现（服务端契约，CLI 原样透传）
    expect(line).not.toContain('secret');
  });

  it('-o file 写文件：内容与导出物一致，stdout 只打确认行', async () => {
    mockedGet.mockResolvedValueOnce(payload);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-cli-export-'));
    const file = path.join(dir, 'task.json');
    try {
      const logs = captureStdout();
      await run(tasksCommand(), `task export t1 -o ${file}`);
      expect(mockedGet).toHaveBeenCalledWith('/tasks/t1/export');
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(payload);
      expect(lastSpinner().succeed).toHaveBeenCalledWith(expect.stringContaining('Task exported to'));
      expect(logs.join('\n')).not.toContain('Nightly sync');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('acf task import', () => {
  const payload = {
    schemaVersion: '1',
    exportedAt: '2026-10-05T00:00:00.000Z',
    task: { name: 'Nightly sync', triggerType: 'cron', cronExpression: '0 2 * * *', runtime: 'python' },
  };
  const result = {
    taskId: 't-new',
    name: 'Nightly sync (imported)',
    warnings: ['Task secrets are never part of the export/import payload (SEC-02 red line) — reconfigure them.'],
  };

  it('从文件读导出物并原样 POST /tasks/import，输出新 taskId 与 warnings', async () => {
    mockedPost.mockResolvedValueOnce(result);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-cli-import-'));
    const file = path.join(dir, 'task.json');
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    try {
      const logs = captureStdout();
      await run(tasksCommand(), `task import ${file}`);
      // body = 导出物原样（不做任何本地变换）
      expect(mockedPost).toHaveBeenCalledWith('/tasks/import', payload);
      expect(lastSpinner().succeed).toHaveBeenCalledWith(expect.stringContaining('Task imported: t-new'));
      const out = logs.join('\n');
      expect(out).toContain('Nightly sync (imported)');
      expect(out).toContain('SEC-02');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('"-" 从 stdin 读导出物（进程 stdin 可注入）', async () => {
    mockedPost.mockResolvedValueOnce(result);
    const logs = captureStdout();
    const realStdin = process.stdin;
    const fake = new PassThrough();
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
    try {
      const pending = run(tasksCommand(), 'task import -');
      fake.write(JSON.stringify(payload));
      fake.end();
      await pending;
      expect(mockedPost).toHaveBeenCalledWith('/tasks/import', payload);
      expect(lastSpinner().succeed).toHaveBeenCalledWith(expect.stringContaining('Task imported: t-new'));
      expect(logs.join('\n')).toContain('Nightly sync (imported)');
    } finally {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    }
  });

  it('坏 JSON 文件 → 用法错误（码 2），请求绝不发出', async () => {
    const err = captureStderr();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-cli-badjson-'));
    const file = path.join(dir, 'task.json');
    fs.writeFileSync(file, '{ not json', 'utf-8');
    try {
      await expect(run(tasksCommand(), `task import ${file}`)).rejects.toThrow(/process\.exit\(2\)/);
      expect(err.join('\n')).toContain('Invalid JSON payload');
      expect(mockedPost).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件读不了 → 用法错误（码 2）而非裸堆栈', async () => {
    const err = captureStderr();
    await expect(run(tasksCommand(), 'task import /nonexistent/payload.json')).rejects.toThrow(
      /process\.exit\(2\)/,
    );
    expect(err.join('\n')).toContain('Cannot read payload file');
    expect(mockedPost).not.toHaveBeenCalled();
  });
});

describe('readStdin（"-" 的底层读取）', () => {
  it('PassThrough 流：聚合数据并在 end 时 resolve', async () => {
    const s = new PassThrough();
    const pending = readStdin(s);
    s.write('{"schemaVersion":"1"}');
    s.end();
    await expect(pending).resolves.toBe('{"schemaVersion":"1"}');
  });

  it('TTY 流（用户手敲 "-" 没给管道）→ 拒绝并给出可操作指引，不挂死', async () => {
    const ttyFake = new PassThrough() as PassThrough & { isTTY: boolean };
    ttyFake.isTTY = true;
    await expect(readStdin(ttyFake)).rejects.toThrow(/pipe the payload|file path/);
  });
});

// ---------------------------------------------------------------------------
// P2: 批量面。契约：POST /tasks/batch/{trigger|pause|resume|delete}，
// body={taskIds:[...]}（1..500 个），逐个执行、失败项以 { id, error } 回传、恒 200。
// ---------------------------------------------------------------------------
describe('acf task batch', () => {
  it('positional ids → POST /tasks/batch/trigger body={taskIds}', async () => {
    mockedPost.mockResolvedValueOnce([{ id: 'e1', taskId: 't1', status: 'running' }, {}]);
    const logs = captureStdout();
    await run(tasksCommand(), 'task batch trigger t1 t2');
    expect(mockedPost).toHaveBeenCalledWith('/tasks/batch/trigger', { taskIds: ['t1', 't2'] });
    expect(logs.join('\n')).toContain('✔ t1');
    expect(logs.join('\n')).toContain('✔ t2');
  });

  it('--ids 逗号分隔与 positional 合并去重', async () => {
    mockedPost.mockResolvedValueOnce([{}, {}, {}]);
    await run(tasksCommand(), 'task batch pause t1 --ids t2,t1,t3');
    expect(mockedPost).toHaveBeenCalledWith('/tasks/batch/pause', { taskIds: ['t1', 't2', 't3'] });
  });

  it('四种 action 各自命中对应端点', async () => {
    for (const action of ['trigger', 'pause', 'resume', 'delete']) {
      mockedPost.mockResolvedValueOnce([{}]);
      await run(tasksCommand(), `task batch ${action} t1`);
      expect(mockedPost).toHaveBeenCalledWith(`/tasks/batch/${action}`, { taskIds: ['t1'] });
    }
  });

  it('未知 action → 用法错误（码 2），请求不发出', async () => {
    const err = captureStderr();
    await expect(run(tasksCommand(), 'task batch frobnicate t1')).rejects.toThrow(/process\.exit\(2\)/);
    expect(err.join('\n')).toContain('trigger | pause | resume | delete');
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('没有任何 id → 用法错误（码 2）', async () => {
    const err = captureStderr();
    await expect(run(tasksCommand(), 'task batch trigger')).rejects.toThrow(/process\.exit\(2\)/);
    expect(err.join('\n')).toContain('--ids');
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('部分失败（{id,error} 行）→ 逐项打 ✗、汇总进 stderr、exitCode=1（对齐 CLI-EXIT-01）', async () => {
    const logs = captureStdout();
    const err = captureStderr();
    mockedPost.mockResolvedValueOnce([{ id: 't1', error: 'task not found' }, { id: 't2', status: 'paused' }]);
    await run(tasksCommand(), 'task batch pause t1 t2');
    expect(logs.join('\n')).toContain('✗ t1: task not found');
    expect(logs.join('\n')).toContain('✔ t2');
    expect(err.join('\n')).toContain('1 failure(s) out of 2');
    expect(process.exitCode).toBe(1);
  });

  it('全部成功 → exitCode 保持 0', async () => {
    captureStdout();
    mockedPost.mockResolvedValueOnce([{}, {}]);
    await run(tasksCommand(), 'task batch delete t1 t2');
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  it('--json 直出原始结果数组（单行，CI 消费）', async () => {
    const raw = [{ id: 'e1', taskId: 't1', status: 'running' }];
    mockedPost.mockResolvedValueOnce(raw);
    const logs = captureStdout();
    await run(tasksCommand(), 'task batch trigger t1 --json');
    const line = logs.find((l) => l.startsWith('['));
    expect(JSON.parse(line as string)).toEqual(raw);
  });
});

// ---------------------------------------------------------------------------
// P2: API Key 管理（AUTH-03）。契约：POST /api-keys body={name,scope,expiresInDays?}
// 响应一次性回显 plaintext；GET /api-keys 脱敏数组；DELETE /api-keys/:id 吊销。
// ---------------------------------------------------------------------------
describe('acf apikey', () => {
  it('create：POST /api-keys body 白名单形状，plaintext 一次性回显 + 只显示一次告警', async () => {
    mockedPost.mockResolvedValueOnce({
      id: 1,
      name: 'ci-deploy',
      keyPrefix: 'acf_ab12',
      scope: 'trigger',
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      plaintext: 'acf_deadbeef',
    });
    const logs = captureStdout();
    await run(apikeysCommand(), 'apikey create --name ci-deploy --scope trigger');
    expect(mockedPost).toHaveBeenCalledWith('/api-keys', { name: 'ci-deploy', scope: 'trigger' });
    const out = logs.join('\n');
    expect(out).toContain('acf_deadbeef');
    expect(out).toContain('only once');
    expect(out).toContain('acf_ab12');
  });

  it('create --expires 映射为 expiresInDays（数字）', async () => {
    mockedPost.mockResolvedValueOnce({ id: 2, name: 'n', keyPrefix: 'p', scope: 'readonly', plaintext: 'acf_x' });
    captureStdout();
    await run(apikeysCommand(), 'apikey create --name n --scope readonly --expires 90');
    expect(mockedPost).toHaveBeenCalledWith('/api-keys', {
      name: 'n',
      scope: 'readonly',
      expiresInDays: 90,
    });
  });

  it('create 未知 scope → 用法错误（码 2），请求不发出', async () => {
    const err = captureStderr();
    await expect(run(apikeysCommand(), 'apikey create --name n --scope root')).rejects.toThrow(
      /process\.exit\(2\)/,
    );
    expect(err.join('\n')).toContain('readonly | trigger | manage');
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it.each(['0', 'abc', '9999'])('create --expires %s 非法 → 参数解析错误，请求不发出', async (bad) => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        run(apikeysCommand(), `apikey create --name n --scope manage --expires ${bad}`),
      ).rejects.toThrow();
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('3650');
    } finally {
      errSpy.mockRestore();
    }
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('list：GET /api-keys，--json 直出脱敏数组', async () => {
    const keys = [{ id: 1, name: 'ci', keyPrefix: 'acf_ab12', scope: 'trigger', revokedAt: null }];
    mockedGet.mockResolvedValueOnce(keys);
    const logs = captureStdout();
    await run(apikeysCommand(), 'apikey list --json');
    expect(mockedGet).toHaveBeenCalledWith('/api-keys');
    const line = logs.find((l) => l.startsWith('['));
    expect(JSON.parse(line as string)).toEqual(keys);
  });

  it('revoke：DELETE /api-keys/:id（数字主键）', async () => {
    mockedDel.mockResolvedValueOnce({ success: true });
    await run(apikeysCommand(), 'apikey revoke 3');
    expect(mockedDel).toHaveBeenCalledWith('/api-keys/3');
    expect(lastSpinner().succeed).toHaveBeenCalledWith('API key 3 revoked');
  });

  it('revoke 非数字 id → 用法错误（码 2），请求不发出', async () => {
    const err = captureStderr();
    await expect(run(apikeysCommand(), 'apikey revoke abc')).rejects.toThrow(/process\.exit\(2\)/);
    expect(err.join('\n')).toContain('acf apikey list');
    expect(mockedDel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P3: config set-token 安全提示（token 进 shell history / 进程列表）
// ---------------------------------------------------------------------------
describe('acf config set-token 安全提示', () => {
  it('落 token 且向 stderr 提示更安全的通路（login / ACF_TOKEN）', async () => {
    const { setToken } = await import('../config.js');
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: unknown) => {
      chunks.push(String(s));
      return true;
    }) as never);
    const logs = captureStdout();
    await program.parseAsync(['node', 'acf', 'config', 'set-token', 'tok_abc'], { from: 'node' });
    expect(vi.mocked(setToken)).toHaveBeenCalledWith('tok_abc');
    expect(logs.join('\n')).toContain('Token saved');
    const warned = chunks.join('');
    expect(warned).toContain('shell history');
    expect(warned).toContain('acf login');
    expect(warned).toContain('ACF_TOKEN');
  });
});
