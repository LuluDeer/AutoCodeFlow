/**
 * N9 回归测试：TaskWorkerManager 的空闲 worker 惰性回收。
 * workers Map 此前只增不减，长周期执行器上每个历史 taskId 永久驻留。
 */
import { TaskWorkerManager, IDLE_RECYCLE_MS } from './task-worker';

jest.mock('./routes/execute', () => ({
  runTask: jest.fn(),
}));
jest.mock('./callback', () => ({
  pushCallback: jest.fn(),
}));

import { runTask } from './routes/execute';

const mockedRunTask = runTask as jest.MockedFunction<typeof runTask>;

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = (e) => rej(e);
  });
  // 防止 jest 在“稍后手动 resolve”期间报 unhandled rejection
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** 冲刷 fake timers 下的微任务与 setImmediate 链 */
async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

function workerCount(mgr: TaskWorkerManager): number {
  return Object.keys(mgr.getStats()).length;
}

describe('TaskWorkerManager idle recycling (N9)', () => {
  let mgr: TaskWorkerManager;

  beforeEach(() => {
    jest.useFakeTimers();
    mgr = new TaskWorkerManager(1);
    mockedRunTask.mockReset();
  });

  afterEach(() => {
    mgr.stopAll();
    jest.useRealTimers();
  });

  it('回收空闲超过 IDLE_RECYCLE_MS 的 worker（workers 数量回落）', async () => {
    const d = deferred();
    mockedRunTask.mockReturnValueOnce(d.promise as never);

    await mgr.execute('task-a', 'exec-1', {}, {});
    d.resolve();
    await flush();

    // 刚执行完：worker 仍在（getStats 语义不变，含待回收 worker）
    expect(workerCount(mgr)).toBe(1);
    expect(mgr.getStats()['task-a']).toEqual({ running: 0, queueSize: 0 });

    jest.advanceTimersByTime(IDLE_RECYCLE_MS - 1);
    expect(workerCount(mgr)).toBe(1);

    jest.advanceTimersByTime(1);
    expect(workerCount(mgr)).toBe(0);
  });

  it('回收窗口内的新执行取消回收，执行完再重新计时', async () => {
    const d1 = deferred();
    const d2 = deferred();
    mockedRunTask.mockReturnValueOnce(d1.promise as never);
    mockedRunTask.mockReturnValueOnce(d2.promise as never);

    await mgr.execute('task-a', 'exec-1', {}, {});
    d1.resolve();
    await flush();

    // 接近超时但未超时：新执行命中 getWorker，回收被取消
    jest.advanceTimersByTime(IDLE_RECYCLE_MS - 60_000);
    await mgr.execute('task-a', 'exec-2', {}, {});
    jest.advanceTimersByTime(IDLE_RECYCLE_MS);
    expect(workerCount(mgr)).toBe(1); // exec-2 仍在运行，未被回收
    expect(mgr.getStats()['task-a'].running).toBe(1);

    // exec-2 结束后重新安排回收
    d2.resolve();
    await flush();
    jest.advanceTimersByTime(IDLE_RECYCLE_MS);
    expect(workerCount(mgr)).toBe(0);
  });

  it('常驻 busy worker 不被回收', async () => {
    const d = deferred();
    mockedRunTask.mockReturnValueOnce(d.promise as never);

    await mgr.execute('task-a', 'exec-1', {}, {});
    jest.advanceTimersByTime(IDLE_RECYCLE_MS * 10);
    expect(workerCount(mgr)).toBe(1);
    expect(mgr.getStats()['task-a']).toEqual({ running: 1, queueSize: 0 });

    d.resolve();
    await flush();
  });

  it('队列非空（仍有排队执行）时不安排回收', async () => {
    const d1 = deferred();
    const d2 = deferred();
    mockedRunTask.mockReturnValueOnce(d1.promise as never);
    mockedRunTask.mockReturnValueOnce(d2.promise as never);

    await mgr.execute('task-a', 'exec-1', {}, {});
    await mgr.execute('task-a', 'exec-2', {}, {}); // maxConcurrent=1 → 排队

    d1.resolve();
    await flush();
    // exec-1 完成时队列里还有 exec-2 → 不算空闲
    jest.advanceTimersByTime(IDLE_RECYCLE_MS);
    expect(workerCount(mgr)).toBe(1);

    d2.resolve();
    await flush();
    jest.advanceTimersByTime(IDLE_RECYCLE_MS);
    expect(workerCount(mgr)).toBe(0);
  });

  it('stopAll 清空待回收定时器（旧定时器不得误杀重建后的同名 worker）', async () => {
    const d1 = deferred();
    mockedRunTask.mockReturnValueOnce(d1.promise as never);
    await mgr.execute('task-a', 'exec-1', {}, {});
    d1.resolve();
    await flush(); // 此时存在待回收定时器

    mgr.stopAll();
    expect(workerCount(mgr)).toBe(0);

    // 重建同名 worker 并常驻运行；若 stopAll 未清定时器，残留定时器会误删它
    const d2 = deferred();
    mockedRunTask.mockReturnValueOnce(d2.promise as never);
    await mgr.execute('task-a', 'exec-2', {}, {});
    jest.advanceTimersByTime(IDLE_RECYCLE_MS * 2);
    expect(workerCount(mgr)).toBe(1);
    expect(mgr.getStats()['task-a'].running).toBe(1);

    d2.resolve();
    await flush();
  });

  it('stopWorker 显式停止时同步清理回收定时器', async () => {
    const d = deferred();
    mockedRunTask.mockReturnValueOnce(d.promise as never);
    await mgr.execute('task-a', 'exec-1', {}, {});
    d.resolve();
    await flush();

    mgr.stopWorker('task-a');
    expect(workerCount(mgr)).toBe(0);
    // 推进定时器不应抛错（定时器已被清）
    expect(() => jest.advanceTimersByTime(IDLE_RECYCLE_MS * 2)).not.toThrow();
  });
});
