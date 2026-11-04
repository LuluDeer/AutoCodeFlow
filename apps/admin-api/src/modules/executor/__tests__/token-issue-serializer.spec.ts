import {
  classifyTokenCacheMiss,
  KeyedSerializer,
} from "../token-issue-serializer.util";

/**
 * R12（2026-11-05）：按 key 串行化的**确定性**判据。
 *
 * 背景（真机实证）：`issueToken` 的幂等判断是「同步读缓存 → await 轮换」，
 * 并发请求都能在写入前读到 miss ⇒ 4 并发 / 6 轮**每轮 4 次轮换**，先返回的令牌
 * 立刻被下一次轮换覆盖。本 spec 用可控的延迟函数把这个交错**确定性**地摆出来：
 * 不用起服务、不靠时序运气。
 */
describe("R12 — KeyedSerializer（按身份串行化）", () => {
  it("同一 key 的并发调用必须串行：同时进入 critical section 的并发度恒为 1", async () => {
    const s = new KeyedSerializer();
    let inside = 0;
    let maxInside = 0;
    const task = () =>
      s.run("k", async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 20));
        inside -= 1;
        return "ok";
      });
    await Promise.all([task(), task(), task(), task()]);
    expect(maxInside).toBe(1); // 并发进入 ≤1 = 串行
  });

  it("不同 key 之间互不阻塞（并发度不降）", async () => {
    const s = new KeyedSerializer();
    let inside = 0;
    let maxInside = 0;
    const task = (key: string) =>
      s.run(key, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 20));
        inside -= 1;
      });
    await Promise.all([task("a"), task("b"), task("c"), task("d")]);
    expect(maxInside).toBeGreaterThan(1);
  });

  it("前一个失败不阻塞后一个（异常不毒化队列）", async () => {
    const s = new KeyedSerializer();
    const first = s.run("k", async () => {
      throw new Error("boom");
    });
    const second = s.run("k", async () => "second-ok");
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("second-ok");
  });

  it("队列清空后不残留 key（长跑进程不涨内存）", async () => {
    const s = new KeyedSerializer();
    await Promise.all([s.run("x", async () => 1), s.run("y", async () => 2)]);
    expect(s.inFlightKeys).toBe(0);
  });

  it("【R12 回归】模拟 issueToken：并发 4 次「读缓存→未命中→轮换」在串行化后只轮换 1 次", async () => {
    const s = new KeyedSerializer();
    const cache = new Map<string, string>();
    let rotations = 0;
    const issue = () =>
      s.run("identity", async () => {
        const hit = cache.get("identity");
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10)); // 轮换是 await（真实路径如此）
        rotations += 1;
        const token = `tok-${rotations}`;
        cache.set("identity", token);
        return token;
      });
    const tokens = await Promise.all([issue(), issue(), issue(), issue()]);
    expect(new Set(tokens).size).toBe(1); // 四发拿到同一枚
    expect(rotations).toBe(1); // 只轮换一次
  });

  /**
   * **对照（有本事失败）**：同一条流水线**不加串行器**时必须是 4 次轮换。
   * 没有这条，「串行化后只轮换 1 次」可能只是测试自己写得不对（永远绿）；
   * 有了它，才证明上一条真的在测「锁」这一件事 —— 也复现了真机日志里的缺陷形态
   * （`artifacts/autonomy/R12/token-race-before.log`：4 并发 → 4 枚不同令牌）。
   */
  it("【对照】不加串行器 → 4 并发 = 4 次轮换（证明上一条确实在测锁）", async () => {
    const cache = new Map<string, string>();
    let rotations = 0;
    const issue = async () => {
      const hit = cache.get("identity");
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10)); // 轮换是 await ⇒ 四发都能在写入前读到 miss
      rotations += 1;
      const token = `tok-${rotations}`;
      cache.set("identity", token);
      return token;
    };
    const tokens = await Promise.all([issue(), issue(), issue(), issue()]);
    expect(new Set(tokens).size).toBe(4);
    expect(rotations).toBe(4);
  });
});

/**
 * R13（ADR-030 §7.2）：缓存命中却复核失败时的**归因**——纯函数，可确定性验证。
 *
 * 为什么单独成函数：这条判据决定「要不要把『疑似另一实例轮换』打成 WARN」。
 * 归因错了会制造噪音（把重启当跨实例）或掩盖缺陷（把跨实例当重启），
 * 所以它必须可单测，而不是埋在 `issueToken` 的 if 里。
 */
describe("R13 — classifyTokenCacheMiss（跨实例双轮换的症状归因）", () => {
  const base = {
    cachedStartupId: "life-A",
    incomingStartupId: "life-A",
    rowStartupId: "life-A",
    plaintextVerifies: false,
  };

  it("复核通过 ⇒ verified（正常复用，不该告警）", () => {
    expect(classifyTokenCacheMiss({ ...base, plaintextVerifies: true })).toBe("verified");
  });

  it("复核失败但 startupId 未变 ⇒ foreign-rotation（ADR-030 症状 ⇒ 打 WARN）", () => {
    expect(classifyTokenCacheMiss(base)).toBe("foreign-rotation");
  });

  it("复核失败且行上 startupId 已变（重启/新进程生命）⇒ stale-own-rotation（不打 WARN）", () => {
    expect(classifyTokenCacheMiss({ ...base, rowStartupId: "life-B" })).toBe(
      "stale-own-rotation",
    );
    expect(classifyTokenCacheMiss({ ...base, incomingStartupId: "life-B" })).toBe(
      "stale-own-rotation",
    );
  });

  it("legacy（无 startupId 两侧）⇒ 不判为 foreign（无法证明同一进程生命）", () => {
    expect(
      classifyTokenCacheMiss({
        cachedStartupId: null,
        incomingStartupId: null,
        rowStartupId: null,
        plaintextVerifies: false,
      }),
    ).toBe("stale-own-rotation");
  });
});
