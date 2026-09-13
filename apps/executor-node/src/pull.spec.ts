jest.mock('./config', () => ({
  EXECUTOR_VERSION: '1.0.0',
  config: {
    executorAddress: 'localhost:8002',
    executorAddressPublic: '',
  },
}));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const postMock = jest.fn().mockResolvedValue({ data: {} });
jest.mock('./admin-client', () => ({ postLong: postMock }));
const acceptExecution = jest.fn().mockReturnValue({ status: 200, payload: { status: 'accepted' } });
const truncateCallbackErrorMessage = (m?: string) => m;
jest.mock('./routes/execute', () => ({
  acceptExecution,
  truncateCallbackErrorMessage,
}));
const pushCallback = jest.fn();
jest.mock('./callback', () => ({ pushCallback }));
const getRunningCount = jest.fn(() => 0);
jest.mock('./scheduler', () => ({ getRunningCount }));

describe('pull loop (ARCH-32)', () => {
  let pullOnce: () => Promise<void>;
  let logger: { warn: jest.Mock; info: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    ({ pullOnce } = require('./pull'));
    ({ logger } = require('./logger'));
  });

  it('取到载荷：acceptExecution 收到 body（剥离 traceparent）与 traceparent', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'ok',
        data: {
          task: {
            executionId: 'exec-9',
            task: { id: 't1' },
            params: {},
            traceparent: '00-trace-span-01',
          },
        },
      },
    });

    await pullOnce();

    expect(postMock).toHaveBeenCalledWith(
      '/api/executors/pull',
      expect.objectContaining({ address: 'localhost:8002', waitMs: 25_000 }),
    );
    expect(acceptExecution).toHaveBeenCalledWith(
      { executionId: 'exec-9', task: { id: 't1' }, params: {} },
      '00-trace-span-01',
    );
    expect(pushCallback).not.toHaveBeenCalled();
  });

  it('领取被拒（非 200）：补发 failed 回调，不留僵尸 RUNNING 行', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'ok',
        data: { task: { executionId: 'exec-10', task: {} } },
      },
    });
    acceptExecution.mockReturnValueOnce({
      status: 400,
      payload: { error: 'Executor is at capacity' },
    });

    await pullOnce();

    expect(pushCallback).toHaveBeenCalledTimes(1);
    const cb = pushCallback.mock.calls[0][0];
    expect(cb).toMatchObject({
      executionId: 'exec-10',
      status: 'failed',
    });
    expect(String(cb.errorMessage)).toContain('Executor is at capacity');
  });

  it('空载荷（窗口耗尽）与 malformed 载荷：不领取不回调', async () => {
    postMock.mockResolvedValueOnce({ data: { code: 0, data: { task: null } } });
    await pullOnce();
    expect(acceptExecution).not.toHaveBeenCalled();

    postMock.mockResolvedValueOnce({ data: {} });
    await pullOnce();
    expect(acceptExecution).not.toHaveBeenCalled();
    expect(pushCallback).not.toHaveBeenCalled();
  });

  it('pull 请求失败：warn 且不向上抛（下一轮重试）', async () => {
    postMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(pullOnce()).resolves.toBeUndefined();
    expect(logger.warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('Pull failed'))).toBe(true);
  });
});
