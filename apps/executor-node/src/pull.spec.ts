jest.mock('./config', () => ({
  EXECUTOR_VERSION: '1.0.0',
  config: {
    executorAddress: 'localhost:8002',
    executorAddressPublic: '',
    maxConcurrentTasks: 2,
  },
}));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

// E-01: 与 pull.ts / acceptExecution 共享的并发账本替身——预留/释放语义
// 直接对真实 Int32Array 计数断言，而不是只看调用关系。
const ledger = new Int32Array(new SharedArrayBuffer(4));
const postMock = jest.fn().mockResolvedValue({ data: {} });
const requestMock = jest.fn().mockResolvedValue({ data: {} });
jest.mock('./admin-client', () => ({ postLong: postMock, request: requestMock }));
const acceptExecution = jest.fn().mockReturnValue({ status: 200, payload: { status: 'accepted' } });
const truncateCallbackErrorMessage = (m?: string) => m;
jest.mock('./routes/execute', () => ({
  acceptExecution,
  truncateCallbackErrorMessage,
}));
const pushCallback = jest.fn();
jest.mock('./callback', () => ({ pushCallback }));
const getRunningCount = jest.fn(() => Atomics.load(ledger, 0));
jest.mock('./scheduler', () => ({
  getRunningCount,
  getRunningCountArray: () => ledger,
}));

describe('pull loop (ARCH-32 + E-01 预留槽位)', () => {
  let pullOnce: () => Promise<void>;
  let resetConfigPullThrottleForTest: () => void;
  let logger: { warn: jest.Mock; info: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    Atomics.store(ledger, 0, 0);
    ({ pullOnce, resetConfigPullThrottleForTest } = require('./pull'));
    resetConfigPullThrottleForTest(); // NETOPT-9-6: 节流是粘性模块状态，跨用例重置
    ({ logger } = require('./logger'));
  });

  it('取到载荷：预留槽位后发起 pull，acceptExecution 收到 body（剥离 traceparent）与 traceparent', async () => {
    // E-01: 捕获长轮询【进行中】的账本值——预留必须发生在发起 pull 之前。
    let countDuringPull: number | null = null;
    postMock.mockImplementationOnce(async () => {
      countDuringPull = Atomics.load(ledger, 0);
      return {
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
      };
    });

    await pullOnce();

    expect(postMock).toHaveBeenCalledWith(
      '/api/executors/pull',
      expect.objectContaining({ address: 'localhost:8002', waitMs: 25_000 }),
      40_000,
      // E-07: 每轮长轮询带自己的中止句柄（停机时 abort 在飞窗口）
      expect.any(AbortSignal),
    );
    // 预留即占位：pull 请求在账本 +1 的状态下发出（心跳 runningTaskCount
    // 同源，长轮询窗口内 admin 不会再往最后一个空槽 push 派发）。
    expect(countDuringPull).toBe(1);
    expect(acceptExecution).toHaveBeenCalledWith(
      { executionId: 'exec-9', task: { id: 't1' }, params: {} },
      '00-trace-span-01',
      { slotPreReserved: true },
    );
    expect(pushCallback).not.toHaveBeenCalled();
  });

  it('accept 200：预留转为正式占用，pull 循环不重复释放', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'ok',
        data: { task: { executionId: 'exec-own', task: {} } },
      },
    });

    await pullOnce();

    expect(acceptExecution).toHaveBeenCalledTimes(1);
    // 完成路径（entry.release）负责归还这个槽位——pull 循环侧账本仍 +1。
    expect(Atomics.load(ledger, 0)).toBe(1);
    expect(pushCallback).not.toHaveBeenCalled();
  });

  it('accept 400（校验失败，真失败）：释放预留 + 维持 failed 回调语义', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'ok',
        data: { task: { executionId: 'exec-10', task: {} } },
      },
    });
    acceptExecution.mockReturnValueOnce({
      status: 400,
      payload: { error: 'Invalid npm package name: @@bad' },
    });

    await pullOnce();

    expect(pushCallback).toHaveBeenCalledTimes(1);
    const cb = pushCallback.mock.calls[0][0];
    expect(cb).toMatchObject({
      executionId: 'exec-10',
      status: 'failed',
      // E-42（DEEP_REVIEW 0ef3bbe）parity：拒绝发生在 accept 之前的校验阶段，
      // 显式上报 'unknown'（枚举成员）而非留空让 admin 从 errorMessage 猜。
      failureReason: 'unknown',
    });
    expect(String(cb.errorMessage)).toContain('Invalid npm package name');
    // 预留已释放，账本归零
    expect(Atomics.load(ledger, 0)).toBe(0);
  });

  it('accept 429（防御路径，账本异常/竞态残余）：释放预留 + warn 但绝不回调 failed', async () => {
    // 正常流程不可达（预留模式下 accept 容量检查必然通过）；固化的是「即
    // 使防御路径被触发也不得把瞬态容量问题补发成 admin 侧永久失败」。
    postMock.mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'ok',
        data: { task: { executionId: 'exec-429', task: {} } },
      },
    });
    acceptExecution.mockReturnValueOnce({
      status: 429,
      payload: { error: 'Executor is at capacity' },
    });

    await pullOnce();

    expect(pushCallback).not.toHaveBeenCalled();
    expect(
      logger.warn.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes('429 despite pre-reserved slot'),
      ),
    ).toBe(true);
    // 预留已释放，账本归零（admin 侧 stale sweep 兜底收敛孤儿 RUNNING 行）
    expect(Atomics.load(ledger, 0)).toBe(0);
  });

  it('空载荷（窗口耗尽）与 malformed 载荷：不领取、释放预留、不回调', async () => {
    postMock.mockResolvedValueOnce({ data: { code: 0, data: { task: null } } });
    await pullOnce();
    expect(acceptExecution).not.toHaveBeenCalled();
    expect(Atomics.load(ledger, 0)).toBe(0);

    postMock.mockResolvedValueOnce({ data: {} });
    await pullOnce();
    expect(acceptExecution).not.toHaveBeenCalled();
    expect(pushCallback).not.toHaveBeenCalled();
    expect(Atomics.load(ledger, 0)).toBe(0);
  });

  it('pull 请求失败：warn、释放预留且不向上抛（下一轮重试）', async () => {
    postMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(pullOnce()).resolves.toBeUndefined();
    expect(logger.warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('Pull failed'))).toBe(true);
    expect(Atomics.load(ledger, 0)).toBe(0);
  });

  it('满载（账本已达 maxConcurrentTasks）：不预留不发 pull', async () => {
    Atomics.store(ledger, 0, 2);
    await pullOnce();
    expect(postMock).not.toHaveBeenCalled();
    // 未凭空预留/释放——账本保持原值
    expect(Atomics.load(ledger, 0)).toBe(2);
    expect(acceptExecution).not.toHaveBeenCalled();
  });

  // E-07 残差收口：旧实现只 clearInterval，已发出的那轮长轮询（服务端阻塞至多
  // 25s）仍在飞——窗口末端带回的任务照样会被领取执行，与「停机第一步停止取件」
  // 相悖，进程也因 socket 未关多挂至多 25s。本用例固化「abort 立即结束窗口」。
  it('NETOPT-9-6: 有任务轮——任务先 accept 落地，配置拉取在其后（fire-and-forget）', async () => {
    const events: string[] = [];
    acceptExecution.mockImplementationOnce(() => {
      events.push('accept');
      return { status: 200, payload: { status: 'accepted' } };
    });
    requestMock.mockImplementationOnce(async () => {
      events.push('config-fetch');
      // 非对象载荷 → maybePullConfig 提前返回，不触发本地 /config/reload
      return { data: { data: 'not-an-object' } };
    });
    postMock.mockImplementationOnce(async () => {
      events.push('post');
      return {
        data: {
          code: 0,
          message: 'ok',
          data: {
            configVersion: 'cfg-1',
            task: { executionId: 'exec-order', task: {} },
          },
        },
      };
    });

    await pullOnce();
    await new Promise((r) => setImmediate(r)); // flush fire-and-forget config fetch

    expect(acceptExecution).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
    // 顺序：长轮询返回 → accept 领取 → 配置拉取（领取不被配置拉取延迟）
    expect(events).toEqual(['post', 'accept', 'config-fetch']);
  });

  it('NETOPT-9-6: 空闲轮（无任务）才同步拉配置；请求失败被吞掉、下一轮受节流', async () => {
    requestMock.mockImplementationOnce(async () => {
      throw new Error('admin unreachable');
    });
    postMock.mockImplementationOnce(async () => ({
      data: { code: 0, message: 'ok', data: { configVersion: 'cfg-1' } },
    }));

    await pullOnce(); // 空闲轮：await maybePullConfig → 请求失败被 catch 吞掉

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(acceptExecution).not.toHaveBeenCalled();
  });

  it('NETOPT-9-6: 指纹持续不一致且 reload 失败时，重试被 30s 节流（不每轮轰炸）', async () => {
    postMock.mockResolvedValueOnce({
      data: { code: 0, message: 'ok', data: { configVersion: 'cfg-1' } },
    });
    requestMock.mockResolvedValue({ data: { data: 'not-an-object' } });

    await pullOnce(); // 第一次尝试（节流窗口开启）
    await pullOnce(); // 第二次：距上次 <30s → 跳过

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('E-07：停机 abort 在飞长轮询——窗口立即结束、释放预留、不记 warn', async () => {
    let capturedSignal: AbortSignal | null = null;
    postMock.mockImplementationOnce(
      (_path: string, _data: unknown, _timeout: number, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal;
          // 复刻 axios 的取消语义：signal abort → reject(ERR_CANCELED)
          const cancel = () =>
            reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
          // 兜底定时器：即便 abort 未生效也让 promise 落定——否则 pullInFlight
          // 会永久为 true，把后续用例一并拖红（真实有牙断言在 signal.aborted 上）。
          const fallback = setTimeout(cancel, 500);
          signal.addEventListener('abort', () => {
            clearTimeout(fallback);
            cancel();
          });
        }),
    );
    const pullModule = require('./pull');

    const pending = pullOnce();
    // 让 pullOnce 推进到 await postLong（预留已完成、请求已发出）
    await new Promise(resolve => setImmediate(resolve));

    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(false);
    // 预留已占位（长轮询窗口内心跳诚实计入）
    expect(Atomics.load(ledger, 0)).toBe(1);

    pullModule.stopPullLoop();

    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true);
    await expect(pending).resolves.toBeUndefined();
    // 预留释放、账本归零、无任务被领取（admin 侧孤儿 RUNNING 由 stale sweep 收敛）
    expect(Atomics.load(ledger, 0)).toBe(0);
    expect(acceptExecution).not.toHaveBeenCalled();
    expect(pushCallback).not.toHaveBeenCalled();
    // 预期中止记 info，不得污染成 warn（运维告警需保持可行动信号）
    expect(
      logger.info.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes('aborted during shutdown'),
      ),
    ).toBe(true);
    expect(
      logger.warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('Pull failed')),
    ).toBe(false);
  });
});

// E-07: 优雅停机必须停止 pull 取件循环——否则 drain/关机阶段仍会领取新任务。
describe('pull loop start/stop (E-07)', () => {
  let pull: { startPullLoop: () => NodeJS.Timeout; stopPullLoop: () => void };
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    Atomics.store(ledger, 0, 0);
    pull = require('./pull');
  });
  afterEach(() => {
    pull.stopPullLoop();
    jest.useRealTimers();
  });

  it('stopPullLoop stops the interval so no further tasks are pulled during shutdown', async () => {
    const interval = pull.startPullLoop();
    expect(interval).toBeDefined();
    await jest.advanceTimersByTimeAsync(1_100);
    const callsAfterStart = postMock.mock.calls.length;
    expect(callsAfterStart).toBeGreaterThanOrEqual(1); // 至少领取了一次
    pull.stopPullLoop();
    await jest.advanceTimersByTimeAsync(2_200);
    expect(postMock.mock.calls.length).toBe(callsAfterStart); // 停机后不再领取
  });
});
