/**
 * UX 统一化（本轮）的结构与语义守卫：
 *
 * 1. help 覆盖守卫 —— 用 index.ts 导出的**真实**命令树（不是测试里复刻的
 *    镜像树，镜像会漂移）断言每个叶子命令的帮助里都有 Examples 块。集中式
 *    示例表在 src/help.ts 的 EXAMPLES，新增命令忘写示例会在这里变红。
 * 2. 缺参 → 可操作用法 —— showHelpAfterError 开启后，缺参报错必须紧跟该命令
 *    的完整 help（含 Examples），而不是裸的一行 error。
 * 3. 退出码表 —— exitCodeFor/emitError/emitUsageError/parseErrorExitCode 的
 *    分类映射（0/1/2/3/4/130），与 ui.ts 顶部注释和 README.md「Exit codes」
 *    是同一张表的三个投影。
 * 4. 密码输入不回显 —— maskEcho 的函数级不回显断言（PK-27 的回归锁）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';

// client/config 用 mock：避免 conf 在测试进程里碰真实用户目录，也让错误分类
// 可控（结构守卫不触发任何 action，mock 只是为了模块图可加载）。
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

import { CommanderError } from 'commander';
// index.ts 有 main-guard：import 只构建命令树，不触发 parseAsync。
import { program, parseErrorExitCode } from '../index.js';
import { EXIT_CODES, exitCodeFor, emitError, emitUsageError, UsageError } from '../ui.js';
import { maskEcho } from '../commands/login.js';

beforeEach(() => {
  classifyState.value = 'unknown';
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

// ---------------------------------------------------------------------------
// 1. help 覆盖守卫：每个叶子命令都有示例
// ---------------------------------------------------------------------------
/**
 * 渲染命令的完整帮助（等价于 `acf <cmd> --help` 的真实出口）：必须走
 * outputHelp() —— afterHelp 事件（Examples 注入点）只在 outputHelp 里派发，
 * 裸调 helpInformation() 看不到 after 文本。
 */
function helpText(cmd: { outputHelp(): void }): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: unknown) => {
    chunks.push(String(s));
    return true;
  }) as never);
  try {
    cmd.outputHelp();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('help 覆盖守卫（集中式 EXAMPLES × 真实命令树）', () => {
  /** 收集叶子命令（有 action 且无子命令；commander 内建的 help 除外）。 */
  function leafCommands(root: typeof program): Array<{ path: string; cmd: ReturnType<typeof program.addCommand> }> {
    const leaves: Array<{ path: string; cmd: ReturnType<typeof program.addCommand> }> = [];
    const walk = (cmd: typeof program, path: string): void => {
      const subs = cmd.commands.filter((c) => c.name() !== 'help');
      if (subs.length === 0 && path) {
        leaves.push({ path, cmd });
        return;
      }
      for (const sub of subs) walk(sub, path ? `${path} ${sub.name()}` : sub.name());
    };
    walk(root, '');
    return leaves;
  }

  it('顶层 acf 的帮助里有示例块', () => {
    expect(helpText(program)).toContain('Examples:');
  });

  it('每个叶子命令的帮助里都有 Examples 块（新增命令必须补示例）', () => {
    const missing = leafCommands(program)
      .filter(({ cmd }) => !helpText(cmd).includes('Examples:'))
      .map(({ path }) => path);
    expect(missing).toEqual([]);
  });

  it('命令树规模护栏：叶子命令数量符合预期（防止守卫意外失效/空转）', () => {
    // 44 个叶子 = login(1)+task(18)+app(9)+executor(4)+deploy(2)+audit(1)
    //            +exec(1)+project(2)+sop(2)+agent(1)+config(3)
    const leaves = leafCommands(program);
    expect(leaves.length).toBe(44);
  });
});

// ---------------------------------------------------------------------------
// 2. 缺参 → error 行 + 完整 help（含示例）
// ---------------------------------------------------------------------------
describe('showHelpAfterError：缺参时给可操作用法', () => {
  it('acf task get（缺 id）：报错行之后必须出现该命令的完整 help 与示例', async () => {
    const captured: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: unknown) => {
      captured.push(String(s));
      return true;
    }) as never);
    try {
      await expect(
        program.parseAsync(['node', 'acf', 'task', 'get'], { from: 'node' }),
      ).rejects.toBeInstanceOf(CommanderError);
      const out = captured.join('');
      expect(out).toContain("missing required argument 'id'");
      expect(out).toContain('Usage: acf task get');
      expect(out).toContain('Examples:');
      expect(out).toContain('acf task get <taskId>');
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 退出码表（0/1/2/3/4/130）
// ---------------------------------------------------------------------------
describe('exitCodeFor：错误分类 → 退出码', () => {
  it('UsageError → 2（本地用法错误，不经过 client 分类）', () => {
    expect(exitCodeFor(new UsageError('bad payload'))).toBe(EXIT_CODES.USAGE);
  });

  it.each([
    ['auth', EXIT_CODES.AUTH],
    ['network', EXIT_CODES.NETWORK],
    ['server', EXIT_CODES.GENERIC],
    ['unknown', EXIT_CODES.GENERIC],
  ] as const)('classifyApiError=%s → %i', (cls, expected) => {
    classifyState.value = cls;
    expect(exitCodeFor(new Error('x'))).toBe(expected);
  });
});

describe('emitError：统一错误出口', () => {
  it('有 spinner 时 fail(scope) 并以分类退出码退出', () => {
    classifyState.value = 'auth';
    const spinner = { fail: vi.fn() };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => emitError('Failed to do x', new Error('Unauthorized (401)'), { spinner })).toThrow(
        /process\.exit\(3\)/,
      );
      expect(spinner.fail).toHaveBeenCalledWith('Failed to do x');
      expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('Unauthorized (401)');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('无 spinner 时打 ✗ scope 行，网络类 → 退出码 4', () => {
    classifyState.value = 'network';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => emitError('Login failed', new Error('Network error'))).toThrow(/process\.exit\(4\)/);
      expect(errSpy.mock.calls[0]?.[0]).toContain('✗ Login failed');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('emitUsageError → 退出码 2，并提示 --help', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => emitUsageError('Cannot read file: x.js')).toThrow(/process\.exit\(2\)/);
      const out = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toContain('Cannot read file: x.js');
      expect(out).toContain("--help");
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('parseErrorExitCode：commander 解析结果 → 退出码', () => {
  it('--help/--version 属正常出口 → 0', () => {
    expect(parseErrorExitCode(new CommanderError(0, 'commander.help', 'help'))).toBe(0);
    expect(parseErrorExitCode(new CommanderError(0, 'commander.version', 'v'))).toBe(0);
  });

  it.each([
    ['commander.missingArgument'],
    ['commander.unknownCommand'],
    ['commander.unknownOption'],
    ['commander.invalidArgument'],
  ])('%s → 用法错误 2', (code) => {
    expect(parseErrorExitCode(new CommanderError(1, code, 'error'))).toBe(EXIT_CODES.USAGE);
  });

  it('非 commander 的 action 异常 → 1', () => {
    expect(parseErrorExitCode(new Error('boom'))).toBe(EXIT_CODES.GENERIC);
  });
});

// ---------------------------------------------------------------------------
// 4. 密码输入不回显（PK-27 回归锁）
// ---------------------------------------------------------------------------
describe('maskEcho：readline 密码回显遮蔽', () => {
  function fakeRl(): { rl: readline.Interface; chunks: string[] } {
    const chunks: string[] = [];
    const output = new PassThrough();
    output.on('data', (d: Buffer) => chunks.push(d.toString('utf-8')));
    const rl = readline.createInterface({ input: new PassThrough(), output });
    return { rl, chunks };
  }

  it('TTY 下：键入字符不落输出，换行放行（不回显断言）', () => {
    const { rl, chunks } = fakeRl();
    maskEcho(rl, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const write = (s: string) => (rl as any)._writeToOutput(s);
    write('p@ssw0rd'); // 键入的每个字符都会经 _writeToOutput 回显——必须被吞掉
    write('\r'); // 回车确认 → 提示符换行
    expect(chunks.join('')).toBe('\n');
    rl.close();
  });

  it('非 TTY（CI/管道）时不接管回显', () => {
    const { rl } = fakeRl();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before = (rl as any)._writeToOutput;
    maskEcho(rl, false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((rl as any)._writeToOutput).toBe(before);
    rl.close();
  });
});
