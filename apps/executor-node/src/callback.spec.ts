import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallbackRequest } from './callback';

type CallbackModule = typeof import('./callback');

function loadCallbackModule(mockWorkDir: string, fingerprint: string | null = 'a'.repeat(64)): CallbackModule {
  jest.resetModules();
  jest.mock('./admin-client');
  jest.doMock('./config', () => ({
    config: {
      workDir: mockWorkDir,
      executorAddress: 'internal-executor:8002',
      executorAddressPublic: 'public-executor:8002',
    },
  }));
  // 本轮回调行身份补口：把指纹**钉死**（与 middleware/auth.spec.ts 同款做法）。
  // 真实 getDeviceFingerprint() 依赖 workDir 下的盐文件与机器身份探测，单测环境
  // 两者都取不到 → 恒 null → 「覆盖全部回调载荷」的断言会因**环境**而非**代码**
  // 空转；钉死后断言只度量本文件负责的事：载荷字段是否被盖上。采集算法本身由
  // device-identity.spec.ts 独立度量。resetModules 会重建模块注册表，故此处的
  // mock 必须在每次 require('./callback') 之前重新登记。
  jest.mock('./device-identity', () => ({
    getDeviceFingerprint: () => fingerprint,
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

  // 回调的**唯一**盖章点 withExecutorAddress 的两个产物：executorAddress 取
  // public 优先，deviceFingerprint 取钉死的 64×'a'（ADR-017 阶段 3 / 协议 v6）。
  // 所有既有断言经此收敛，盖章一旦丢失即整片红——不必逐用例重复。
  const FINGERPRINT = 'a'.repeat(64);
  const addressed = (request: CallbackRequest) => ({
    executorAddress: 'public-executor:8002',
    deviceFingerprint: FINGERPRINT,
    ...request,
  });

  it('adds a new entry to the queue', () => {
    cb.pushCallback({ executionId: 'exec-1', status: 'success' });
    expect(cb.getPendingCallbackCount()).toBe(1);
  });

  it('warns (but still enqueues) when a payload drifts from protocol.json CallbackPayload', () => {
    // 本轮协议 SSOT 补全：pushCallback 的对账闸（warn-only，载荷照发）。反证
    // 有牙：删掉 callback.ts 的 warnIfCallbackPayloadDrifted 调用，本用例即红。
    const loggerMock = jest.requireMock('./logger') as {
      logger: { warn: jest.Mock };
    };

    // 合法载荷（真实构造点形态）：零协议 warn
    cb.pushCallback({ executionId: 'exec-ok', status: 'success' });
    expect(loggerMock.logger.warn).not.toHaveBeenCalled();

    // 漂移一：status 不是终态二值（回调通道只承载终态）
    cb.pushCallback({
      executionId: 'exec-drift-1',
      status: 'running',
    } as unknown as CallbackRequest);
    // 漂移二：未知顶层键（CallbackPayload 是 strictObject——新增字段必须先落
    // protocol.json 再落实现，否则本闸当场红）
    cb.pushCallback({
      executionId: 'exec-drift-2',
      status: 'failed',
      newTopLevelKey: 1,
    } as unknown as CallbackRequest);

    const drifted = loggerMock.logger.warn.mock.calls
      .map(c => String(c[0]))
      .filter(c => c.includes('CallbackPayload'));
    expect(drifted.length).toBe(2);
    expect(drifted[0]).toContain('status');
    expect(drifted[1]).toContain('newTopLevelKey');
    // warn-only：载荷照常入队（回调是终态唯一通道，绝不因对账失败丢弃）
    expect(cb.getPendingCallbackCount()).toBe(3);
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
    // B-2：回调请求携带 x-executor-address 头（admin 按执行器维度限流）。
    expect(post).toHaveBeenCalledWith('/api/executions/callback', [addressed(latest)], {
      'x-executor-address': 'public-executor:8002',
    });
  });

  it('includes executorAddress when posting callbacks', async () => {
    const request: CallbackRequest = { executionId: 'exec-1', status: 'success', exitCode: 0 };
    cb.pushCallback(request);
    cb.startCallbackThread();
    await cb.stopCallbackThread();
    // B-2：回调请求携带 x-executor-address 头（admin 按执行器维度限流）。
    expect(post).toHaveBeenCalledWith('/api/executions/callback', [addressed(request)], {
      'x-executor-address': 'public-executor:8002',
    });
  });

  it('stamps deviceFingerprint onto every outbound callback body (ADR-017 §3 / protocol v6)', async () => {
    // 反证有牙：删掉 withExecutorAddress 里 `...(fingerprint ? { deviceFingerprint } : {})`
    // 的展开，本用例即红（回调 POST body 缺该键，admin 在「共享令牌 + 同址碰撞」
    // 下无法把回调归到 dispatcher 实际派发的那一行）。
    const request: CallbackRequest = { executionId: 'exec-1', status: 'success', exitCode: 0 };
    cb.pushCallback(request);
    cb.startCallbackThread();
    await cb.stopCallbackThread();
    const body = post.mock.calls[0][1] as CallbackRequest[];
    expect(body[0].deviceFingerprint).toBe(FINGERPRINT);
    expect(body).toEqual([addressed(request)]);
  });

  it('covers callers that never set deviceFingerprint themselves (single choke point)', async () => {
    // 13 个构造点（routes/execute.ts / pull.ts / task-worker.ts）都不自己拼指纹，
    // 全靠 pushCallback → withExecutorAddress 一个口子盖章；这里用「调用方完全
    // 不知道指纹存在」的载荷形态（含终态失败、artifacts、result、traceparent）
    // 证明覆盖面无遗漏。
    const requests: CallbackRequest[] = [
      { executionId: 'plain', status: 'success' },
      { executionId: 'failed', status: 'failed', errorMessage: 'boom', failureReason: 'script_error' },
      {
        executionId: 'rich', status: 'success', durationMs: 12,
        artifacts: [{ name: 'out.txt', size: 3, sha256: 'b'.repeat(64) }],
        result: { interpreter: { requested: '3.12', resolved: null } },
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    ];
    requests.forEach(cb.pushCallback);
    cb.startCallbackThread();
    await cb.stopCallbackThread();
    const body = post.mock.calls[0][1] as CallbackRequest[];
    expect(body.map(r => r.deviceFingerprint)).toEqual([FINGERPRINT, FINGERPRINT, FINGERPRINT]);
    expect(body).toEqual(requests.map(addressed));
  });

  it('omits the deviceFingerprint key entirely when collection failed (null, not undefined)', async () => {
    // 采集失败（探测不到 machine-id 且无可用网卡 MAC / 盐文件不可写）时
    // getDeviceFingerprint() 返回 null：键必须**整个不出现**，绝不能发 null——
    // 显式 null 在 admin 侧会变成「v6 执行器上报了一个空指纹」而不是「未上报」，
    // 回落语义与「行为与引入前逐字节一致」的红线同时被破坏（register / heartbeat
    // 用 `?? undefined` 是同一规则）。
    const nullCb = loadCallbackModule(dir, null);
    // resetModules 会重建 admin-client 的 automock：必须重新取回新的 post/logger
    // 实例（文件顶部 beforeEach 拿到的那两个指向上一代注册表）。
    const nullPost = (jest.requireMock('./admin-client') as { post: jest.Mock }).post;
    nullPost.mockReset().mockResolvedValue({ status: 200 });
    const loggerMock = jest.requireMock('./logger') as {
      logger: { warn: jest.Mock };
    };
    const request: CallbackRequest = { executionId: 'exec-null', status: 'success' };
    nullCb.pushCallback(request);
    // 键缺失 ⇒ 载荷仍满足 CallbackPayload（字段可选）⇒ 零协议漂移 warn。
    expect(loggerMock.logger.warn).not.toHaveBeenCalled();
    nullCb.startCallbackThread();
    await nullCb.stopCallbackThread();
    const body = nullPost.mock.calls[0][1] as CallbackRequest[];
    expect(body).toEqual([{ executorAddress: 'public-executor:8002', ...request }]);
    expect('deviceFingerprint' in body[0]).toBe(false);
    expect(Object.keys(body[0])).toEqual(['executorAddress', 'executionId', 'status']);
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
    // B-2：回调请求携带 x-executor-address 头（admin 按执行器维度限流）。
    expect(post).toHaveBeenCalledWith('/api/executions/callback', [addressed(request)], {
      'x-executor-address': 'public-executor:8002',
    });
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
    // B-2：回调请求携带 x-executor-address 头（admin 按执行器维度限流）。
    expect(post).toHaveBeenCalledWith('/api/executions/callback', [addressed(request)], {
      'x-executor-address': 'public-executor:8002',
    });
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

  it('E-05: dead-letters a persisted callback only after CALLBACK_FILE_MAX_RETRIES rounds (lifetime budget)', async () => {
    // 轮数上限 150（毒丸文件防护）；真正的保护是时长型预算——指数退避门控
    // （base 5s/cap 600s）让重发周期约 24h 量级覆盖 admin 滚动升级窗口，
    // 而非无限每秒重发占满磁盘。
    expect(cb.CALLBACK_FILE_MAX_RETRIES).toBe(150);
    expect(cb.CALLBACK_REPLAY_BACKOFF_BASE_MS).toBe(5_000);
    expect(cb.CALLBACK_REPLAY_BACKOFF_MAX_MS).toBe(600_000);
    // 时长预算推导守卫：base/cap/轮数 ⇒ ≈24h（任一常量单改而注释未同步时先红）。
    const budgetMs = Array.from({ length: cb.CALLBACK_FILE_MAX_RETRIES }, (_, k) =>
      Math.min(cb.CALLBACK_REPLAY_BACKOFF_BASE_MS * 2 ** k, cb.CALLBACK_REPLAY_BACKOFF_MAX_MS),
    ).reduce((a, b) => a + b, 0);
    expect(budgetMs).toBeGreaterThanOrEqual(23 * 3_600_000);
    expect(budgetMs).toBeLessThanOrEqual(25 * 3_600_000);
    const callbackDir = path.join(dir, 'callbacks');
    fs.mkdirSync(callbackDir, { recursive: true });
    const fname = path.join(callbackDir, `callback-${Date.now()}-0.json`);
    fs.writeFileSync(fname, JSON.stringify([{ executionId: 'poison', status: 'failed', errorMessage: 'x' }]));
    // 轮数接近阈值（149），updatedAt 回退足够久使指数退避门控（cap 600s）必然
    // 通过 → 重发一次后达到 150 即死信（验证不会无限重发）。
    fs.writeFileSync(`${fname}.meta`, JSON.stringify({ retries: 149, updatedAt: Date.now() - 700_000 }));
    post.mockRejectedValue(new Error('admin down'));
    cb.startCallbackThread();
    // 先停下（drain 边界尽快退出），再推进足够假时间：首轮回放即死信该文件。
    const stopping = cb.stopCallbackThread();
    await jest.advanceTimersByTimeAsync(3_000);
    await stopping;
    const deadDir = path.join(callbackDir, 'dead-letter');
    const dead = fs.existsSync(deadDir) ? fs.readdirSync(deadDir).filter(f => f.endsWith('.json')) : [];
    expect(dead.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(fname)).toBe(false);
  });

  it('E-44: live callback backoff multiplies by (0.5 + rng) jitter coefficient', () => {
    // rng=0 → 0.5×；rng=1 → 1.5×（范围对齐 python _callback_retry_sleep_seconds，
    // 避免多 executor 在同一 admin 恢复窗口后同步重试惊群）。
    expect(cb.computeRetryBackoffMs(0, () => 0)).toBeCloseTo(1_000 * 0.5);
    expect(cb.computeRetryBackoffMs(0, () => 1)).toBeCloseTo(1_000 * 1.5);
    expect(cb.computeRetryBackoffMs(2, () => 0)).toBeCloseTo(1_000 * 4 * 0.5);
    expect(cb.computeRetryBackoffMs(2, () => 1)).toBeCloseTo(1_000 * 4 * 1.5);
  });
});
