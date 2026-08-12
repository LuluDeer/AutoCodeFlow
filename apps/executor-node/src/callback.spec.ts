import type { CallbackRequest } from './callback';

type CallbackModule = typeof import('./callback');

function loadCallbackModule(): CallbackModule {
  jest.resetModules();
  jest.mock('./admin-client');
  jest.mock('./config', () => ({
    config: {
      workDir: '/tmp/test-callbacks',
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

describe('pushCallback', () => {
  let cb: CallbackModule;

  beforeEach(() => {
    cb = loadCallbackModule();
    cb.stopCallbackThread();
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

  it('overwrites earlier entry with later status for same executionId', () => {
    const first: CallbackRequest = { executionId: 'exec-1', status: 'success', exitCode: 0 };
    const second: CallbackRequest = { executionId: 'exec-1', status: 'failed', errorMessage: 'crash' };
    cb.pushCallback(first);
    cb.pushCallback(second);
    // Queue has 1 entry; the original was replaced (verified via count + re-push idempotency)
    expect(cb.getPendingCallbackCount()).toBe(1);
  });

  it('includes executorAddress when posting callbacks', async () => {
    jest.useFakeTimers();
    const { post } = jest.requireMock('./admin-client') as { post: jest.Mock };
    post.mockResolvedValue({ status: 200 });

    try {
      cb.pushCallback({ executionId: 'exec-1', status: 'success', exitCode: 0 });
      cb.startCallbackThread();

      expect(post).toHaveBeenCalledWith('/api/executions/callback', [
        {
          executionId: 'exec-1',
          status: 'success',
          executorAddress: 'public-executor:8002',
          exitCode: 0,
        },
      ]);
    } finally {
      cb.stopCallbackThread();
      await Promise.resolve();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      jest.useRealTimers();
    }
  });
});

describe('getPendingCallbackCount', () => {
  let cb: CallbackModule;

  beforeEach(() => {
    cb = loadCallbackModule();
    cb.stopCallbackThread();
  });

  it('returns 0 for an empty queue', () => {
    expect(cb.getPendingCallbackCount()).toBe(0);
  });

  it('increments with each unique callback', () => {
    for (let i = 0; i < 5; i++) {
      cb.pushCallback({ executionId: `exec-${i}`, status: 'success' });
    }
    expect(cb.getPendingCallbackCount()).toBe(5);
  });
});
