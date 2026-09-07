import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallbackRequest } from './callback';

type CallbackModule = typeof import('./callback');

function loadCallbackModule(mockWorkDir: string): CallbackModule {
  jest.resetModules();
  jest.mock('./admin-client');
  jest.doMock('./config', () => ({
    config: {
      workDir: mockWorkDir,
      executorAddress: 'internal-executor:8002',
      executorAddressPublic: 'public-executor:8002',
    },
  }));
  jest.mock('./logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  return require('./callback') as CallbackModule;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('callbacks', () => {
  let cb: CallbackModule;
  let dir: string;
  let post: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-drain-'));
    cb = loadCallbackModule(dir);
    post = (jest.requireMock('./admin-client') as { post: jest.Mock }).post;
    post.mockReset().mockResolvedValue({ status: 200 });
  });

  afterEach(async () => {
    // Finish the consumer before deleting its directory or restoring timers.
    const stopping = cb.stopCallbackThread();
    await jest.advanceTimersByTimeAsync(10_000);
    await stopping;
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function files(): string[] {
    const callbackDir = path.join(dir, 'callbacks');
    return fs.existsSync(callbackDir) ? fs.readdirSync(callbackDir).sort() : [];
  }

  function persisted(): CallbackRequest[] {
    return files().filter(f => f.endsWith('.json')).flatMap(file => {
      const fullPath = path.join(dir, 'callbacks', file);
      const items = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as CallbackRequest[];
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(100);
      expect(JSON.parse(fs.readFileSync(`${fullPath}.meta`, 'utf8'))).toEqual({
        retries: 0, persistedAt: expect.any(Number),
      });
      return items;
    });
  }

  const addressed = (request: CallbackRequest) => ({
    executorAddress: 'public-executor:8002', ...request,
  });

  it('adds a new entry to the queue', () => {
    cb.pushCallback({ executionId: 'exec-1', status: 'success' });
    expect(cb.getPendingCallbackCount()).toBe(1);
  });

  it('overwrites duplicate executionId instead of adding a second entry', () => {
    cb.pushCallback({ executionId: 'exec-1', status: 'success' });
    cb.pushCallback({ executionId: 'exec-1', status: 'failed', errorMessage: 'err' });
    expect(cb.getPendingCallbackCount()).toBe(1);
  });

  it('keeps separate entries for different executionIds', () => {
    cb.pushCallback({ executionId: 'exec-1', status: 'success' });
    cb.pushCallback({ executionId: 'exec-2', status: 'failed' });
    expect(cb.getPendingCallbackCount()).toBe(2);
  });

  it('overwrites earlier entry with later status for same executionId', async () => {
    cb.pushCallback({ executionId: 'exec-1', status: 'success', exitCode: 0 });
    const latest: CallbackRequest = { executionId: 'exec-1', status: 'failed', errorMessage: 'crash' };
    cb.pushCallback(latest);
    cb.startCallbackThread();
    await cb.stopCallbackThread();
    expect(post).toHaveBeenCalledWith('/api/executions/callback', [addressed(latest)], {});
  });

  it('includes executorAddress when posting callbacks', async () => {
    const request: CallbackRequest = { executionId: 'exec-1', status: 'success', exitCode: 0 };
    cb.pushCallback(request);
    cb.startCallbackThread();
    await cb.stopCallbackThread();
    expect(post).toHaveBeenCalledWith('/api/executions/callback', [addressed(request)], {});
  });

  it('returns 0 for an empty queue', () => {
    expect(cb.getPendingCallbackCount()).toBe(0);
  });

  it('increments with each unique callback', () => {
    for (let i = 0; i < 5; i++) cb.pushCallback({ executionId: `exec-${i}`, status: 'success' });
    expect(cb.getPendingCallbackCount()).toBe(5);
  });

  it('drains entries queued at stop, leaving no persistence files', async () => {
    cb.startCallbackThread();
    await jest.advanceTimersByTimeAsync(0);
    const request: CallbackRequest = { executionId: 'queued', status: 'success', exitCode: 0 };
    cb.pushCallback(request);
    expect(cb.getPendingCallbackCount()).toBe(1);
    const stopping = cb.stopCallbackThread();
    await jest.advanceTimersByTimeAsync(1_000);
    await stopping;
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/executions/callback', [addressed(request)], {});
    expect(cb.getPendingCallbackCount()).toBe(0);
    expect(files()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('delivers task completion enqueued while drain is waiting for a send', async () => {
    const flight = deferred<{ status: number }>();
    post.mockReturnValueOnce(flight.promise);
    cb.pushCallback({ executionId: 'first', status: 'success' });
    cb.startCallbackThread();
    const stopping = cb.stopCallbackThread();
    // Keep the first POST pending so this is genuinely during drain, not after it.
    await jest.advanceTimersByTimeAsync(100);
    const completion: CallbackRequest = { executionId: 'completed', status: 'success', exitCode: 0, durationMs: 100 };
    cb.pushCallback(completion);
    flight.resolve({ status: 200 });
    await stopping;
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.flatMap(c => c[1])).toEqual([
      addressed({ executionId: 'first', status: 'success' }), addressed(completion),
    ]);
    expect(cb.getPendingCallbackCount()).toBe(0);
    expect(files()).toEqual([]);
  });

  it.each(['reject', 'non-2xx'])('persists complete payloads in 100-item chunks when admin returns %s', async failure => {
    if (failure === 'reject') post.mockRejectedValue(new Error('offline'));
    else post.mockResolvedValue({ status: 503 });
    const requests: CallbackRequest[] = Array.from({ length: 201 }, (_, i) => ({
      executionId: `failed-${i}`, status: 'failed', exitCode: 1, errorMessage: `failure ${i}`,
    }));
    requests.forEach(cb.pushCallback);
    cb.startCallbackThread();
    const stopping = cb.stopCallbackThread();
    await jest.advanceTimersByTimeAsync(10_000);
    await stopping;
    expect(post.mock.calls.length).toBeGreaterThan(1);
    expect(post.mock.calls.every(c => c[1].length <= 100)).toBe(true);
    expect(persisted()).toEqual(requests.map(addressed));
    expect(files()).toHaveLength(6);
    expect(cb.getPendingCallbackCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits for the in-flight batch without duplicate sends; concurrent stops share completion', async () => {
    const flight = deferred<{ status: number }>();
    post.mockReturnValueOnce(flight.promise);
    const request: CallbackRequest = { executionId: 'flight', status: 'success' };
    cb.pushCallback(request);
    cb.startCallbackThread();
    const stopping = cb.stopCallbackThread();
    expect(cb.stopCallbackThread()).toBe(stopping);
    let done = false;
    void stopping.then(() => { done = true; });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    flight.resolve({ status: 200 });
    await stopping;
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/executions/callback', [addressed(request)], {});
    expect(cb.getPendingCallbackCount()).toBe(0);
    expect(files()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
    await cb.stopCallbackThread();
  });

  it('persists both in-flight and queued results at the hard deadline and ignores late rejection', async () => {
    const flight = deferred<{ status: number }>();
    post.mockReturnValueOnce(flight.promise);
    const first: CallbackRequest = { executionId: 'unconfirmed', status: 'success' };
    const queued: CallbackRequest = { executionId: 'queued', status: 'failed', errorMessage: 'cancelled' };
    cb.pushCallback(first);
    cb.startCallbackThread();
    cb.pushCallback(queued);
    const stopping = cb.stopCallbackThread();
    let done = false;
    void stopping.then(() => { done = true; });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await stopping;
    expect(done).toBe(true);
    expect(persisted()).toEqual([addressed(first), addressed(queued)]);
    expect(files()).toHaveLength(4);
    expect(cb.getPendingCallbackCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    flight.reject(new Error('late network error'));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(persisted()).toEqual([addressed(first), addressed(queued)]);
  });

  it('resolves immediately before start and on repeated stop without timers', async () => {
    await expect(cb.stopCallbackThread()).resolves.toBeUndefined();
    await expect(cb.stopCallbackThread()).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
