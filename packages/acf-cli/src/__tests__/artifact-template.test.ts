/** Route-level tests for `acf artifact` and `acf template` commands. */
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
  getRaw: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  formatApiError: (e: unknown) => String(e),
  classifyApiError: () => 'unknown',
}));

import { get, getRaw, post } from '../client.js';
import { artifactCommand } from '../commands/artifact.js';
import { templateCommand } from '../commands/template.js';

const mockedGet = vi.mocked(get);
const mockedGetRaw = vi.mocked(getRaw);
const mockedPost = vi.mocked(post);

async function run(rootName: string, factory: () => unknown, parts: string[]) {
  const { Command } = await import('commander');
  const program = new Command();
  program.addCommand(factory() as never);
  program.exitOverride();
  await program.parseAsync(['node', 'acf', rootName, ...parts], { from: 'node' });
}

beforeEach(() => {
  mockedGet.mockReset();
  mockedGetRaw.mockReset();
  mockedPost.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

describe('acf artifact', () => {
  it('list --execution reads the per-execution manifest', async () => {
    mockedGet.mockResolvedValue([{ name: 'report.csv', size: 12 }]);
    await run('artifact', artifactCommand, ['list', '--execution', 'exec-1', '--json']);
    expect(mockedGet).toHaveBeenCalledWith('/tasks/executions/exec-1/artifacts');
  });

  it('list with filters reads the cross-execution index', async () => {
    mockedGet.mockResolvedValue({ items: [], total: 0 });
    await run('artifact', artifactCommand, [
      'list',
      '--task',
      'task-1',
      '--ext',
      'csv',
      '--mine',
      '--json',
    ]);
    expect(mockedGet).toHaveBeenCalledWith('/artifacts', {
      page: '1',
      pageSize: '20',
      taskId: 'task-1',
      applicationId: undefined,
      q: undefined,
      ext: 'csv',
      from: undefined,
      to: undefined,
      mine: 'true',
    });
  });

  it('preview uses the bounded JSON preview endpoint', async () => {
    mockedGet.mockResolvedValue({
      name: 'run.log',
      mimeType: 'text/plain',
      size: 3,
      truncated: false,
      kind: 'text',
      content: 'abc',
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await run('artifact', artifactCommand, [
        'preview',
        'exec-1',
        'run.log',
        '--max-bytes',
        '1024',
      ]);
      expect(mockedGet).toHaveBeenCalledWith(
        '/tasks/executions/exec-1/artifacts/run.log/preview',
        { maxBytes: '1024' },
      );
      expect(write).toHaveBeenCalledWith('abc');
    } finally {
      write.mockRestore();
    }
  });

  it('download writes raw bytes and surfaces the sha256 header', async () => {
    mockedGetRaw.mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      headers: { 'x-sha256': 'deadbeef' },
    });
    const fs = await import('node:fs/promises');
    const writeFile = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    try {
      await run('artifact', artifactCommand, [
        'download',
        'exec-1',
        'report.csv',
        '-o',
        '/tmp/report.csv',
      ]);
      expect(mockedGetRaw).toHaveBeenCalledWith(
        '/tasks/executions/exec-1/artifacts/report.csv',
      );
      expect(writeFile).toHaveBeenCalledWith(
        '/tmp/report.csv',
        Buffer.from([1, 2, 3]),
      );
    } finally {
      writeFile.mockRestore();
    }
  });
});

describe('acf template', () => {
  it('list reads /task-templates', async () => {
    mockedGet.mockResolvedValue([{ id: 't1', key: 'backup', name: 'Backup' }]);
    await run('template', templateCommand, ['list', '--json']);
    expect(mockedGet).toHaveBeenCalledWith('/task-templates');
  });

  it('use instantiates with name taking precedence over --body', async () => {
    mockedPost.mockResolvedValue({ id: 'task-1', name: 'nightly', status: 'paused' });
    await run('template', templateCommand, [
      'use',
      'tpl-1',
      '--name',
      'nightly',
      '--body',
      '{"name":"ignored","params":{"KEY":"v"}}',
      '--json',
    ]);
    expect(mockedPost).toHaveBeenCalledWith('/task-templates/tpl-1/instantiate', {
      params: { KEY: 'v' },
      name: 'nightly',
    });
  });
});
