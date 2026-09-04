jest.mock('./config', () => ({
  config: {
    heartbeatIntervalSeconds: 12,
    executorAddress: 'localhost:8002',
    executorAddressPublic: '',
  },
}));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('./admin-client', () => ({ post: jest.fn() }));

describe('scheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('uses configured heartbeat interval when starting heartbeat', () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const { startHeartbeat } = require('./scheduler');
    const timer = startHeartbeat();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 12_000);
    clearInterval(timer);
  });
});
