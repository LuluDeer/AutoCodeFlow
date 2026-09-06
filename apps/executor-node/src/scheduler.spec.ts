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
    // STALE-01: 无 provider 注册（execute.ts 未加载）时心跳体携带默认空值
    expect(post.mock.calls[0][1].runningExecutionIds).toEqual([]);
    expect(post.mock.calls[0][1].deadLetterCount).toBe(0);
    const callsBeforeReload = post.mock.calls.length;

    config.heartbeatIntervalSeconds = 6;
    await jest.advanceTimersByTimeAsync(6_000);
    expect(post.mock.calls.length).toBeGreaterThan(callsBeforeReload);

    clearInterval(timer);
  });

  it('reports registered running execution ids (capped) and dead-letter count in the heartbeat body', async () => {
    jest.useFakeTimers();
    const {
      startHeartbeat,
      registerRunningExecutionIdsProvider,
      registerDeadLetterCountProvider,
    } = require('./scheduler');
    registerRunningExecutionIdsProvider(() => [
      'exec-1',
      'exec-2',
      ...Array.from({ length: 250 }, (_, i) => `exec-${i}`),
    ]);
    registerDeadLetterCountProvider(() => 7);
    const timer = startHeartbeat();

    await jest.advanceTimersByTimeAsync(12_000);
    expect(post.mock.calls.length).toBeGreaterThan(0);
    const body = post.mock.calls.at(-1)![1];
    expect(body.runningExecutionIds).toHaveLength(200);
    expect(body.deadLetterCount).toBe(7);

    // Providers may be re-registered (module reload) — latest wins.
    registerRunningExecutionIdsProvider(() => []);
    await jest.advanceTimersByTimeAsync(12_000);
    expect(post.mock.calls.at(-1)![1].runningExecutionIds).toEqual([]);

    clearInterval(timer);
  });
});
