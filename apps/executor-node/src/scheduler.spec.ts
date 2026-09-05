jest.mock('./config', () => ({
  config: {
    heartbeatIntervalSeconds: 12,
    executorAddress: 'localhost:8002',
    executorAddressPublic: '',
  },
}));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const post = jest.fn().mockResolvedValue({ data: {} });
jest.mock('./admin-client', () => ({ post }));

describe('scheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('uses the hot-reloaded interval on the next tick', async () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const { config } = require('./config');
    const { startHeartbeat } = require('./scheduler');
    const timer = startHeartbeat();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);

    config.heartbeatIntervalSeconds = 5;
    await jest.advanceTimersByTimeAsync(4_000);
    expect(post).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(12_000);
    expect(post).toHaveBeenCalled();
    const callsBeforeReload = post.mock.calls.length;

    config.heartbeatIntervalSeconds = 6;
    await jest.advanceTimersByTimeAsync(6_000);
    expect(post.mock.calls.length).toBeGreaterThan(callsBeforeReload);

    clearInterval(timer);
  });
});
