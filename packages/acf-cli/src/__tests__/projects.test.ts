/**
 * AUTH-02-B（R18）：acf project 只读命令测试——list/members 的 GET 路径、
 * 表格与 --json 输出、错误处理。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  formatApiError: vi.fn((e: unknown) => String(e)),
  // ui.emitError 依赖 client 层的错误分类映射退出码;本文件只关心未知类(→1)。
  classifyApiError: vi.fn(() => 'unknown'),
}));

import { get } from '../client.js';
import { projectsCommand } from '../commands/projects.js';

const mockedGet = vi.mocked(get);

async function makeProgram() {
  const { Command } = await import('commander');
  const program = new Command();
  program.addCommand(projectsCommand() as never);
  program.exitOverride();
  return program;
}

async function run(parts: string[]) {
  const program = await makeProgram();
  await program.parseAsync(['node', 'acf', ...parts], { from: 'node' });
}

beforeEach(() => {
  mockedGet.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('acf project (AUTH-02-B)', () => {
  it('list：GET /projects 并输出表格（默认非 JSON）', async () => {
    mockedGet.mockResolvedValue([
      {
        id: 'p1',
        name: 'Default',
        description: null,
        createdAt: '2026-09-01T00:00:00Z',
        myRole: null,
      },
      {
        id: 'p2',
        name: 'Alpha',
        description: 'demo',
        createdAt: '2026-09-02T00:00:00Z',
        myRole: 'editor',
      },
    ]);
    await run(['project', 'list']);
    expect(mockedGet).toHaveBeenCalledWith('/projects');
  });

  it('list --json：原样输出 JSON', async () => {
    mockedGet.mockResolvedValue([{ id: 'p1', name: 'Default', myRole: null }]);
    const log = vi.spyOn(console, 'log');
    await run(['project', 'list', '--json']);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"myRole": null'),
    );
  });

  it('members <projectId>：GET /projects/:id/members', async () => {
    mockedGet.mockResolvedValue([
      {
        id: 'm1',
        projectId: 'p1',
        userId: 7,
        role: 'editor',
        createdAt: '2026-09-02T00:00:00Z',
      },
    ]);
    await run(['project', 'members', 'p1']);
    expect(mockedGet).toHaveBeenCalledWith('/projects/p1/members');
  });

  it('请求失败：统一错误出口以退出码 1 结束并输出格式化错误', async () => {
    mockedGet.mockRejectedValue(new Error('HTTP 403'));
    // emitError 走 process.exit(1)（测试桩抛错），错误文案经 formatApiError 到 stderr
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // vitest 默认把 process.exit 钉成「抛错」桩，报错文案带退出码：
      // "process.exit unexpectedly called with \"1\" (...)" —— 断言码即断言文案
      await expect(run(['project', 'list'])).rejects.toThrow(/process\.exit unexpectedly called with "1"/);
      expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('HTTP 403');
    } finally {
      errSpy.mockRestore();
    }
  });
});
