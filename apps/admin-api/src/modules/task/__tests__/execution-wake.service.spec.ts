import {
  EXECUTION_WAKE_CHANNEL,
  ExecutionWakeService,
} from "../execution-wake.service";

/**
 * OBS/审计（第 6 轮 P3）：`waiters`（executionId → 等待回调集合）的条目必须被
 * 回收。等待超时是常态（webhook wait 默认 60s、上限 300s），如果只在超时时
 * reject Promise 而不摘除条目，Map 就随「被等待过的执行数」单调增长且永不释放
 * （长跑实例里每个等过超时的执行 id 都留一条）。
 *
 * 三条离开路径都要回收，且都精确到「最后一个离开者」：
 *   · 超时（定时器触发）；
 *   · 正常唤醒（pub/sub 消息到达）；
 *   · 调用方放弃等待（没有取消 API，等价于等到超时）。
 *
 * 下面用**真实**的订阅端 `message` 处理器驱动（替身只实现 ioredis 的
 * `on/status/subscribe` 三个成员），不走「直接调 waiter 回调」的旁路——否则
 * 处理器里「先摘键再触发」的语义根本没被覆盖。
 */
type MessageHandler = (channel: string, message: string) => void;

/** 最小 ioredis 订阅端替身：只覆盖 ensureSubscriber 会用到的成员。 */
class FakeSubscriber {
  readonly status = "ready";
  readonly subscribe = jest.fn(() => Promise.resolve(1));
  private readonly messageHandlers: MessageHandler[] = [];

  on(event: string, handler: MessageHandler): this {
    if (event === "message") this.messageHandlers.push(handler);
    return this;
  }

  /** 模拟一条 pub/sub 消息到货。 */
  emit(executionId: string, channel: string = EXECUTION_WAKE_CHANNEL): void {
    for (const handler of [...this.messageHandlers])
      handler(channel, executionId);
  }
}

function makeService(): {
  svc: ExecutionWakeService;
  waiters: Map<string, Set<() => void>>;
  sub: FakeSubscriber;
} {
  const svc = new ExecutionWakeService({
    get: jest.fn(() => undefined),
  } as never);
  const sub = new FakeSubscriber();
  // 不建真实 Redis：把客户端工厂换成替身，ensureSubscriber 因此注册的是**真实**
  // 的 message 处理器（测试里再通过 sub.emit 触发它）。
  (svc as unknown as { createClient: () => unknown }).createClient = () => sub;
  return {
    svc,
    waiters: (svc as unknown as { waiters: Map<string, Set<() => void>> })
      .waiters,
    sub,
  };
}

describe("ExecutionWakeService · waiter 回收", () => {
  it("超时后删除空集与 executionId 键", async () => {
    const { svc, waiters } = makeService();
    await expect(svc.waitWakeup("exec-1", 5)).resolves.toBe(false);
    expect(waiters.has("exec-1")).toBe(false);
    expect(waiters.size).toBe(0);
  });

  it("多个 waiter 共享同一 executionId：一个超时、一个被唤醒，不误删另一个", async () => {
    const { svc, waiters, sub } = makeService();
    // 长超时那个必须先注册：它是「还在等」的一方，超时那个离开时绝不能把它
    // 的条目一起删掉（删了它就永远收不到唤醒）。
    const slow = svc.waitWakeup("exec-2", 3_000);
    const fast = svc.waitWakeup("exec-2", 5);

    await expect(fast).resolves.toBe(false);
    expect(waiters.get("exec-2")?.size).toBe(1);

    sub.emit("exec-2");
    await expect(slow).resolves.toBe(true);
    expect(waiters.has("exec-2")).toBe(false);
    expect(waiters.size).toBe(0);
  });

  it("唤醒路径同样回收（消息处理器：先摘键再触发）", async () => {
    const { svc, waiters, sub } = makeService();
    const pending = svc.waitWakeup("exec-3", 3_000);

    // 别的频道不该唤醒它（处理器只认 EXECUTION_WAKE_CHANNEL）。
    sub.emit("exec-3", "acf:some-other-channel");
    expect(waiters.get("exec-3")?.size).toBe(1);

    sub.emit("exec-3");
    await expect(pending).resolves.toBe(true);
    expect(waiters.has("exec-3")).toBe(false);
    expect(waiters.size).toBe(0);
  });

  it("唤醒只摘除目标 executionId，不波及其他等待中的执行", async () => {
    const { svc, waiters, sub } = makeService();
    const a = svc.waitWakeup("exec-a", 3_000);
    const b = svc.waitWakeup("exec-b", 3_000);

    sub.emit("exec-a");
    await expect(a).resolves.toBe(true);
    expect([...waiters.keys()]).toEqual(["exec-b"]);

    sub.emit("exec-b");
    await expect(b).resolves.toBe(true);
    expect(waiters.size).toBe(0);
  });

  it("N 次超时后 size 不增长（长跑实例不累积）", async () => {
    const { svc, waiters } = makeService();
    for (const round of [0, 1, 2]) {
      const ids = Array.from({ length: 40 }, (_, i) => `exec-r${round}-${i}`);
      const results = await Promise.all(ids.map((id) => svc.waitWakeup(id, 5)));
      expect(results.every((woken) => woken === false)).toBe(true);
      expect(waiters.size).toBe(0);
    }
  });

  it("调用方放弃等待（不 await、无取消通道）→ 超时仍回收条目", async () => {
    const { svc, waiters } = makeService();
    void svc.waitWakeup("exec-orphan", 5);
    expect(waiters.size).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waiters.size).toBe(0);
  });
});
