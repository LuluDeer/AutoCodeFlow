/**
 * NF-07 tests: executor rotate / offline commands — argument parsing
 * (name|id resolution), output shape (one-shot token display), and upstream
 * error passthrough (403 ADMIN / 404).
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
  formatApiError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { get, post } from '../client';
import { executorsCommand } from '../commands/executors';

const mockedGet = vi.mocked(get);
const mockedPost = vi.mocked(post);

async function run(args: string): Promise<void> {
  const { Command } = await import('commander');
  const program = new Command();
  program.addCommand(executorsCommand() as never);
  program.exitOverride();
  // quote-aware split so --reason "multi word" stays one argv token
  const parts = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/"/g, '')) ?? [];
  await program.parseAsync(['node', 'acf', ...parts], { from: 'node' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

const EXECUTOR_ROW = {
  id: '11111111-2222-3333-4444-555555555555',
  appName: 'executor-node',
  address: '10.0.0.5:3002',
  status: 'online',
};

describe('acf executor rotate (NF-07)', () => {
  it('POSTs /executors/:id/rotate-token and prints the new token once', async () => {
    mockedGet.mockResolvedValueOnce(EXECUTOR_ROW); // id resolves directly
    mockedPost.mockResolvedValueOnce({ token: 'raw-token-abcdef' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    try {
      await run('executor rotate 11111111-2222-3333-4444-555555555555');
    } finally {
      spy.mockRestore();
    }
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith(
      '/executors/11111111-2222-3333-4444-555555555555/rotate-token',
      undefined,
    );
    const out = logs.join('\n');
    expect(out).toContain('shown only once');
    expect(out).toContain('raw-token-abcdef');
  });

  it('sends the optional --reason as the request body (AUTH-05 audit trail)', async () => {
    mockedGet.mockResolvedValueOnce(EXECUTOR_ROW);
    mockedPost.mockResolvedValueOnce({ token: 't2' });
    await run('executor rotate 11111111-2222-3333-4444-555555555555 --reason "token suspected leaked"');
    expect(mockedPost).toHaveBeenCalledWith(
      '/executors/11111111-2222-3333-4444-555555555555/rotate-token',
      { reason: 'token suspected leaked' },
    );
  });

  it('resolves an appName to the executor id before rotating', async () => {
    // first GET (id probe) fails → list lookup by appName
    mockedGet.mockRejectedValueOnce(new Error('404'));
    mockedGet.mockResolvedValueOnce([EXECUTOR_ROW, { ...EXECUTOR_ROW, id: 'aaaa0000-0000-0000-0000-000000000000', appName: 'py-exec' }]);
    mockedPost.mockResolvedValueOnce({ token: 't3' });
    await run('executor rotate py-exec');
    expect(mockedGet).toHaveBeenNthCalledWith(1, '/executors/py-exec');
    expect(mockedPost).toHaveBeenCalledWith(
      '/executors/aaaa0000-0000-0000-0000-000000000000/rotate-token',
      undefined,
    );
  });

  it('surfaces the upstream 403 ADMIN error verbatim and exits 1', async () => {
    mockedGet.mockResolvedValueOnce(EXECUTOR_ROW);
    mockedPost.mockRejectedValueOnce(
      new Error('Forbidden (403): Forbidden resource — some endpoints require the ADMIN role'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(run('executor rotate 11111111-2222-3333-4444-555555555555')).rejects.toThrow(/process\.exit\(1\)/);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('acf executor offline (NF-07)', () => {
  it('POSTs /executors/:id/set-offline and prints the resulting status', async () => {
    mockedGet.mockResolvedValueOnce(EXECUTOR_ROW);
    mockedPost.mockResolvedValueOnce({ ...EXECUTOR_ROW, status: 'offline' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    try {
      await run('executor offline 11111111-2222-3333-4444-555555555555');
    } finally {
      spy.mockRestore();
    }
    expect(mockedPost).toHaveBeenCalledWith(
      '/executors/11111111-2222-3333-4444-555555555555/set-offline',
    );
    const out = logs.join('\n');
    expect(out).toContain('offline');
    expect(out).toContain('status: offline');
    expect(out).toContain('address: 10.0.0.5:3002');
  });

  it('resolves a short id prefix against the executor list', async () => {
    mockedGet.mockRejectedValueOnce(new Error('404'));
    mockedGet.mockResolvedValueOnce([EXECUTOR_ROW]);
    mockedPost.mockResolvedValueOnce({ ...EXECUTOR_ROW, status: 'offline' });
    await run('executor offline 11111111');
    expect(mockedGet).toHaveBeenNthCalledWith(2, '/executors');
    expect(mockedPost).toHaveBeenCalledWith(
      '/executors/11111111-2222-3333-4444-555555555555/set-offline',
    );
  });

  it('fails fast with a readable error when no executor matches', async () => {
    mockedGet.mockRejectedValueOnce(new Error('404'));
    mockedGet.mockResolvedValueOnce([EXECUTOR_ROW]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(run('executor offline ghost')).rejects.toThrow(/process\.exit\(1\)/);
      const err = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(err).toContain('Executor "ghost" not found');
    } finally {
      errSpy.mockRestore();
    }
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('surfaces the upstream 404 verbatim when the id lookup fails server-side', async () => {
    mockedGet.mockResolvedValueOnce(EXECUTOR_ROW);
    mockedPost.mockRejectedValueOnce(
      new Error('Not found (404): Executor not found'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(run('executor offline 11111111-2222-3333-4444-555555555555')).rejects.toThrow(/process\.exit\(1\)/);
      const err = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(err).toContain('Not found (404): Executor not found');
    } finally {
      errSpy.mockRestore();
    }
  });
});
