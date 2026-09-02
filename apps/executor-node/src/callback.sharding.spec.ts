import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallbackRequest } from './callback';

type CallbackModule = typeof import('./callback');

function loadCallbackModule(callbackDir: string): CallbackModule {
  const mockCallbackDir = callbackDir;
  jest.resetModules();
  jest.mock('./admin-client');
  jest.mock('./config', () => ({
    config: {
      workDir: mockCallbackDir,
      executorAddress: 'internal-executor:8002',
      executorAddressPublic: 'public-executor:8002',
    },
  }));
  jest.mock('./logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./callback') as CallbackModule;
}

// The background loop sleeps 1s between iterations; advancing fake timers
// once triggers one full drain/retry sweep.
async function sweep(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await jest.runOnlyPendingTimersAsync();
  await Promise.resolve();
  await Promise.resolve();
}

describe('callback persistence — batch sharding and dead-letter', () => {
  let dir: string;
  let cb: CallbackModule;
  let post: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-cb-'));
    cb = loadCallbackModule(dir);
    post = (jest.requireMock('./admin-client') as { post: jest.Mock }).post;
    post.mockReset();
  });

  afterEach(() => {
    cb.stopCallbackThread();
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const liveCallbackFiles = (): string[] => {
    const callbackDir = path.join(dir, 'callbacks');
    return fs.existsSync(callbackDir)
      ? fs.readdirSync(callbackDir).filter(f => f.startsWith('callback-'))
      : [];
  };

  const deadLetterFiles = (): string[] => {
    const deadDir = path.join(dir, 'callbacks', 'dead-letter');
    return fs.existsSync(deadDir) ? fs.readdirSync(deadDir) : [];
  };

  it('processes a queue of 101 in chunks of at most 100 per POST', async () => {
    post.mockResolvedValue({ status: 200 });
    for (let i = 0; i < 101; i++) {
      cb.pushCallback({ executionId: `exec-${i}`, status: 'success' });
    }
    cb.startCallbackThread();
    await sweep();

    expect(post).toHaveBeenCalledTimes(2);
    const firstBatch = post.mock.calls[0][1] as CallbackRequest[];
    const secondBatch = post.mock.calls[1][1] as CallbackRequest[];
    expect(firstBatch).toHaveLength(100);
    expect(secondBatch).toHaveLength(1);
    // Nothing left in memory or on disk after success
    expect(cb.getPendingCallbackCount()).toBe(0);
    expect(liveCallbackFiles()).toHaveLength(0);
    expect(deadLetterFiles()).toHaveLength(0);
  });

  it('persists each failed chunk as its own file within the 100-item admin limit', async () => {
    post.mockResolvedValue({ status: 500 });
    for (let i = 0; i < 150; i++) {
      cb.pushCallback({ executionId: `exec-${i}`, status: 'failed' });
    }
    cb.startCallbackThread();

    // After the in-memory backoff gives up, the two chunks must be persisted
    // (live) or, once the retry cap is reached, dead-lettered — never lost.
    let persisted: Array<{ file: string; items: CallbackRequest[] }> = [];
    for (let i = 0; i < 40 && persisted.length < 2; i++) {
      await sweep();
      persisted = [
        ...liveCallbackFiles().filter(f => f.endsWith('.json')),
        ...deadLetterFiles().filter(f => f.endsWith('.json')),
      ].map(file => {
        const base = liveCallbackFiles().includes(file)
          ? path.join(dir, 'callbacks', file)
          : path.join(dir, 'callbacks', 'dead-letter', file);
        return { file, items: JSON.parse(fs.readFileSync(base, 'utf-8')) as CallbackRequest[] };
      });
    }

    expect(persisted).toHaveLength(2);
    const sizes = persisted.map(p => p.items.length).sort((a, b) => b - a);
    expect(sizes).toEqual([100, 50]);
    for (const p of persisted) {
      expect(p.items.every(item => item.executionId.startsWith('exec-'))).toBe(true);
    }
  });

  it('stops re-sending a persistently failing file after the retry cap (dead-letter)', async () => {
    post.mockResolvedValue({ status: 500 });
    cb.startCallbackThread();
    cb.pushCallback({ executionId: 'exec-poison', status: 'failed', errorMessage: 'x' });

    let deadLetterFile: string | undefined;
    for (let i = 0; i < 80 && !deadLetterFile; i++) {
      await sweep();
      deadLetterFile = deadLetterFiles().find(f => f.endsWith('.json'));
    }
    expect(deadLetterFile).toBeDefined();

    // Once dead-lettered the file is no longer re-sent every second.
    const callsAfterDead = post.mock.calls.length;
    await sweep();
    await sweep();
    await sweep();
    expect(post.mock.calls.length).toBe(callsAfterDead);

    const items = JSON.parse(
      fs.readFileSync(path.join(dir, 'callbacks', 'dead-letter', deadLetterFile!), 'utf-8'),
    );
    expect(items[0].executionId).toBe('exec-poison');
    expect(liveCallbackFiles()).toHaveLength(0);
  });

  it('records retries in the .meta counter and cleans both files when a retry succeeds', async () => {
    post.mockResolvedValue({ status: 500 });
    cb.startCallbackThread();
    cb.pushCallback({ executionId: 'exec-retry-ok', status: 'success' });

    // Wait until the file is persisted and at least one retry round counted.
    let meta: { retries: number } | undefined;
    for (let i = 0; i < 40 && !meta; i++) {
      await sweep();
      const json = liveCallbackFiles().find(f => f.endsWith('.json'));
      const metaPath = path.join(dir, 'callbacks', `${json ?? ''}.meta`);
      if (json && fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      }
    }
    expect(meta?.retries).toBeGreaterThanOrEqual(1);

    // Admin recovers — the next sweep must deliver and clean json + meta up.
    post.mockResolvedValue({ status: 200 });
    for (let i = 0; i < 3; i++) await sweep();

    expect(liveCallbackFiles()).toHaveLength(0);
  });

  it('dead-letters a corrupt (unparseable) callback file instead of retrying forever', async () => {
    fs.mkdirSync(path.join(dir, 'callbacks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'callbacks', 'callback-123.json'), '{not json');
    post.mockResolvedValue({ status: 200 });

    cb.startCallbackThread();
    await sweep();

    expect(deadLetterFiles()).toContain('callback-123.json');
    expect(fs.existsSync(path.join(dir, 'callbacks', 'callback-123.json'))).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
