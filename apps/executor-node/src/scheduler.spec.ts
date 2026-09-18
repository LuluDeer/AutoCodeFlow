jest.mock('./config', () => ({
  EXECUTOR_VERSION: '1.0.0',
  config: {
    heartbeatIntervalSeconds: 12,
    maxConcurrentTasks: 10,
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
    // E9: 心跳体上报当前并发上限（与 admin 侧心跳白名单字段名配套）
    expect(post.mock.calls[0][1].maxConcurrentTasks).toBe(10);
    const callsBeforeReload = post.mock.calls.length;

    config.heartbeatIntervalSeconds = 6;
    config.maxConcurrentTasks = 4;
    await jest.advanceTimersByTimeAsync(6_000);
    expect(post.mock.calls.length).toBeGreaterThan(callsBeforeReload);
    // E9: /config/reload 热更后下个心跳即回传新值
    expect(post.mock.calls.at(-1)![1].maxConcurrentTasks).toBe(4);

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

  // EXE-VER-1: 心跳体携带版本 + 版本漂移提醒（versionCompliant=false 时
  // 节流 warn，10 分钟一条；合规后自然静默）。
  it('reports EXECUTOR_VERSION in the heartbeat body', async () => {
    jest.useFakeTimers();
    const { startHeartbeat } = require('./scheduler');
    const timer = startHeartbeat();

    await jest.advanceTimersByTimeAsync(12_000);
    expect(post.mock.calls.at(-1)![1].version).toBe('1.0.0');

    clearInterval(timer);
  });

  // 注：本用例需推进 >10 分钟假时钟（心跳间隔 1s → 600+ 拍异步 tick），
  // 单机空闲时 <1s，但在 CI 2 核/并发跑测时实测会突破 jest 默认 5s 上限
  // （表现：Exceeded timeout，而非断言失败）。故显式给足预算，避免假红。
  it('warns on versionCompliant=false (throttled to one per 10 min) and stays silent once compliant', async () => {
    jest.useFakeTimers();
    const { startHeartbeat, resetVersionDriftWarnStateForTest } = require('./scheduler');
    const { logger } = require('./logger');
    resetVersionDriftWarnStateForTest();
    post.mockResolvedValue({ data: { versionCompliant: false, minVersion: '1.3.0' } });
    const driftWarns = () =>
      logger.warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('Version drift')).length;
    const timer = startHeartbeat();

    await jest.advanceTimersByTimeAsync(12_000);
    expect(driftWarns()).toBe(1);
    const firstWarn = logger.warn.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('Version drift'),
    )![0];
    expect(firstWarn).toContain('1.3.0');

    // 仍在节流窗内的心跳不重复告警
    await jest.advanceTimersByTimeAsync(60_000);
    expect(driftWarns()).toBe(1);

    // 超过 10 分钟节流窗 → 允许下一条
    await jest.advanceTimersByTimeAsync(10 * 60_000 + 15_000);
    expect(driftWarns()).toBe(2);

    // 响应恢复合规（versionCompliant 缺省/true）→ 不再告警
    post.mockResolvedValue({ data: {} });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(driftWarns()).toBe(2);

    clearInterval(timer);
  }, 30_000);

  // FR-13/FR-14（CONTRACT.md §2.3）：心跳体**始终**携带 interpreters 字段，
  // `[]` = 已上报且池为空，字段缺席 = 旧执行器（admin 按 ["3.12"] 兜底）。
  // 这个区分是调度的正确性前提：一个声明 3.12 的任务不得被派到池里没有 3.12
  // 的执行器上——若上报方"池空时干脆不报"，admin 的兜底值会把它伪装成有 3.12。
  it('always sends interpreters (empty array, never absent) — admin fallback semantics', async () => {
    jest.useFakeTimers();
    const { startHeartbeat } = require('./scheduler');

    // 无 provider 注册（池未探测/探测失败）→ 仍必须是空数组，而非 undefined。
    const timer = startHeartbeat();
    await jest.advanceTimersByTimeAsync(12_000);
    const body = post.mock.calls.at(-1)![1];
    expect(body).toHaveProperty('interpreters');
    expect(body.interpreters).toEqual([]);
    clearInterval(timer);
  });

  it('drops malformed interpreter entries instead of poisoning the whole inventory', async () => {
    jest.useFakeTimers();
    const { startHeartbeat, registerInterpretersProvider } = require('./scheduler');
    registerInterpretersProvider(async () => [
      {
        version: '3.12.1',
        path: '/pool/cpython-3.12.1/bin/python',
        available: true,
        discoveredAt: 't',
      },
      // 脏项：缺 version —— 若不过滤，admin 侧会因一项坏数据废掉整份清单
      { path: '/pool/whatever', available: true, discoveredAt: 't' },
      // 脏项：version 不是 X.Y[.Z]
      { version: 'v3.11', path: '/pool/x', available: true, discoveredAt: 't' },
    ]);
    const timer = startHeartbeat();
    await jest.advanceTimersByTimeAsync(12_000);
    const body = post.mock.calls.at(-1)![1];
    expect(body.interpreters).toHaveLength(1);
    expect(body.interpreters[0].version).toBe('3.12.1');
    clearInterval(timer);
    registerInterpretersProvider(async () => []);
  });
});
