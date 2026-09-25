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

  it('请求失败：退出码置 1 并输出格式化错误', async () => {
    mockedGet.mockRejectedValue(new Error('HTTP 403'));
    // 错误在 action 内消费（formatApiError + exitCode=1），parseAsync 不 reject
    await run(['project', 'list']);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
