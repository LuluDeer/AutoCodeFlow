import { ExecutionWakeService } from "../execution-wake.service";

/**
 * OBS/审计（第 6 轮）：等待超时是常态（webhook wait 默认 60s、上限 300s），
 * 空的 waiter 集合与 executionId 键必须回收——否则 Map 随「被等待过的执行数」
 * 单调增长且永不释放。
 */
function makeService(): {
  svc: ExecutionWakeService;
  waiters: Map<string, Set<() => void>>;
} {
  const svc = new ExecutionWakeService({
    get: jest.fn((key: string) =>
      key === "redis.host" ? "127.0.0.1" : undefined,
    ),
  } as never);
  // 不建真实 Redis：等待逻辑只需要 subscriber 非空。
  (svc as unknown as { ensureSubscriber: () => unknown }).ensureSubscriber =
    () => ({});
  return {
    svc,
    waiters: (svc as unknown as { waiters: Map<string, Set<() => void>> })
      .waiters,
  };
}

describe("ExecutionWakeService · waiter 回收", () => {
  it("超时后删除空集与 executionId 键", async () => {
    const { svc, waiters } = makeService();
    await expect(svc.waitWakeup("exec-1", 5)).resolves.toBe(false);
    expect(waiters.has("exec-1")).toBe(false);
    expect(waiters.size).toBe(0);
  });

  it("多个 waiter 共享同一 executionId：最后一个超时后才回收键", async () => {
    const { svc, waiters } = makeService();
    const [a, b] = await Promise.all([
      svc.waitWakeup("exec-2", 30),
      svc.waitWakeup("exec-2", 5),
    ]);
    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(waiters.has("exec-2")).toBe(false);
  });

  it("唤醒路径同样回收（不留空集）", async () => {
    const { svc, waiters } = makeService();
    const pending = svc.waitWakeup("exec-3", 50);
    // 模拟 pub/sub 消息：内部方法名与实现绑定，直接调用私有方法验证清理。
    const onMessage = (svc as unknown as { onMessage?: (id: string) => void })
      .onMessage;
    if (typeof onMessage === "function") onMessage.call(svc, "exec-3");
    else {
      // 兜底：直接遍历 waiter 集合逐个调用（实现可能改名）。
      for (const set of waiters.values()) for (const w of set) w();
    }
    await expect(pending).resolves.toBe(true);
    expect(waiters.has("exec-3")).toBe(false);
  });
});
