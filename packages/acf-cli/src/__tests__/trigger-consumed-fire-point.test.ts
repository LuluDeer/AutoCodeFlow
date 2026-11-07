/**
 * R143：`acf task trigger --consume-next-fire-point`（CLI 侧唯一新增入口）。
 *
 * 后端语义（trigger-task.dto.ts:61 / task.controller.ts:963 用 `=== true` /
 * task.service.ts:3012-3026）：**仅 cron 任务**可用 —— 本次立即执行，并让
 * **下一个** cron 计划点被跳过（只跳一次，不是暂停）。非 cron ⇒ 400；已有
 * 未消耗登记 ⇒ 409。
 *
 * 本文件锁三件事（任务书 ①②③）：
 *   ① 带旗标 ⇒ body 含 `consumeNextFirePoint: true`；
 *   ② 不带旗标 ⇒ body 与改动前**逐字节一致**（连 params 都没有时干脆不发
 *      body —— 断言 post 只收到**一个**实参，这是「恒发 false」的回归闸）；
 *   ③ params + 旗标 ⇒ 两个键都在。
 *
 * 为什么独立成文件而不是塞进 commands.test.ts：那个文件已顶到
 * scripts/source-size-baseline.json 的 maxLines 上限（只减不增），再塞 70 行
 * 会让 `node scripts/check-size-caps.mjs` 变红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ora', () => ({
  default: () => {
    const o: Record<string, unknown> = { succeed: vi.fn(), fail: vi.fn(), stop: vi.fn(), text: '' };
    o.start = vi.fn(() => o);
    return o;
  },
}));

vi.mock('chalk', () => ({
  default: {
    green: (s: unknown) => String(s),
    gray: (s: unknown) => String(s),
    red: (s: unknown) => String(s),
    yellow: (s: unknown) => String(s),
    cyan: (s: unknown) => String(s),
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

import { post } from '../client.js';
import { tasksCommand } from '../commands/tasks.js';

const mockedPost = vi.mocked(post);
const EXEC = { id: 'x9', taskId: 't1', status: 'running', createdAt: '2026-01-01T00:00:00Z' };

async function run(args: string): Promise<void> {
  const { Command } = await import('commander');
  const program = new Command();
  program.addCommand(tasksCommand() as never);
  program.exitOverride();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  try {
    await program.parseAsync(['node', 'acf', ...args.split(' ').filter(Boolean)], { from: 'node' });
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

describe('acf task trigger --consume-next-fire-point', () => {
  it('① 带旗标 → body 含 consumeNextFirePoint: true', async () => {
    mockedPost.mockResolvedValueOnce(EXEC);
    await run('task trigger t1 --consume-next-fire-point');
    expect(mockedPost).toHaveBeenCalledWith('/tasks/t1/trigger', { consumeNextFirePoint: true });
    expect((mockedPost.mock.calls.at(-1)![1] as Record<string, unknown>).consumeNextFirePoint).toBe(true);
  });

  it('② 不带旗标 → 与改动前一致：无该键，且无 params 时压根不发 body', async () => {
    mockedPost.mockResolvedValueOnce(EXEC);
    await run('task trigger t1');
    expect(mockedPost).toHaveBeenCalledWith('/tasks/t1/trigger');
    // 只传 path 一个实参 ⇒ 请求体不存在（恒发 `{consumeNextFirePoint:false}` 会让这条红）
    expect(mockedPost.mock.calls.at(-1)).toHaveLength(1);
  });

  it('②b 只带 --params → body 仅有 params（仍不含 consumeNextFirePoint 键）', async () => {
    mockedPost.mockResolvedValueOnce(EXEC);
    await run('task trigger t1 --params {"RETRIES":3}');
    expect(mockedPost).toHaveBeenCalledWith('/tasks/t1/trigger', { params: { RETRIES: 3 } });
    expect(mockedPost.mock.calls.at(-1)![1] as Record<string, unknown>).not.toHaveProperty('consumeNextFirePoint');
  });

  it('③ params + 旗标 → 两个键都在', async () => {
    mockedPost.mockResolvedValueOnce(EXEC);
    await run('task trigger t1 --params {"RETRIES":3} --consume-next-fire-point');
    expect(mockedPost).toHaveBeenCalledWith('/tasks/t1/trigger', {
      params: { RETRIES: 3 },
      consumeNextFirePoint: true,
    });
  });

  it('帮助文案写清语义（仅 cron / 400 / 409 / 只跳一次、非暂停）', () => {
    const trigger = tasksCommand().commands.find((c) => c.name() === 'trigger')!;
    const help = trigger.options.find((o) => o.long === '--consume-next-fire-point')!.description;
    expect(help).toMatch(/cron/i);
    expect(help).toContain('400');
    expect(help).toContain('409');
    expect(help).toMatch(/one-shot/i);
    expect(help).toMatch(/NOT a pause/i);
  });
});
