/**
 * N24 slots/streams 双限流纯状态机单测（零 Nest / DB / IO）。
 * 断言的是 acquire/release 的 token 语义、超限状态不变、流恢复到非法参数 fail-closed。
 */
import { createBackpressure } from "../backpressure";

describe("backpressure slots（有限槽位 + token 归还）", () => {
  it("上限内 acquire 成功；release 后可再 acquire", () => {
    const bp = createBackpressure({ maxSlots: 2, maxStreams: 2 });
    expect(bp.acquireSlot("a")).toBe("a");
    expect(bp.acquireSlot("b")).toBe("b");
    expect(bp.state.slots).toEqual(["a", "b"]);

    expect(bp.releaseSlot("a")).toBe(true);
    expect(bp.state.slots).toEqual(["b"]);
    expect(bp.acquireSlot("c")).toBe("c");
    expect(bp.state.slots).toEqual(["b", "c"]);
    expect(bp.releaseSlot("c")).toBe(true);
    expect(bp.releaseSlot("c")).toBe(false);
  });

  it("超额 acquire 返回 null 且状态逐字不变", () => {
    const bp = createBackpressure({ maxSlots: 1, maxStreams: 1 });
    expect(bp.acquireSlot("a")).toBe("a");
    const before = bp.state;
    expect(bp.acquireSlot("b")).toBeNull();
    expect(bp.state).toEqual(before);
    expect(bp.releaseSlot("b")).toBe(false);
    expect(bp.state).toEqual(before);
  });

  it("省略 token 时生成确定性 token，可归还", () => {
    const bp = createBackpressure({ maxSlots: 1, maxStreams: 1 });
    const token = bp.acquireSlot();
    expect(token).toBe("slot:1");
    expect(bp.acquireSlot()).toBeNull();
    expect(bp.releaseSlot(token as string)).toBe(true);
    expect(bp.state.slots).toEqual([]);
  });
});

describe("backpressure streams（并发计数）", () => {
  it("达上限后拒绝，释放后恢复；拒绝不改计数", () => {
    const bp = createBackpressure({ maxSlots: 1, maxStreams: 2 });
    expect(bp.enterStream()).toBe(true);
    expect(bp.enterStream()).toBe(true);
    expect(bp.state.streams).toBe(2);
    expect(bp.enterStream()).toBe(false);
    expect(bp.state.streams).toBe(2);
    expect(bp.leaveStream()).toBe(true);
    expect(bp.state.streams).toBe(1);
    expect(bp.enterStream()).toBe(true);
    expect(bp.state.streams).toBe(2);
    expect(bp.leaveStream()).toBe(true);
    expect(bp.leaveStream()).toBe(true);
    expect(bp.leaveStream()).toBe(false);
    expect(bp.state.streams).toBe(0);
  });
});

describe("backpressure 非法参数 fail-closed", () => {
  it("负上限 / NaN / 空 token 不崩且一律拒绝", () => {
    const bad = [
      createBackpressure({ maxSlots: -1, maxStreams: 2 }),
      createBackpressure({ maxSlots: 2, maxStreams: NaN }),
      createBackpressure({ maxSlots: 1.5, maxStreams: 2 }),
      createBackpressure(null),
    ];
    for (const bp of bad) {
      expect(bp.acquireSlot("x")).toBeNull();
      expect(bp.acquireSlot("")).toBeNull();
      expect(bp.enterStream()).toBe(false);
      expect(bp.releaseSlot("x")).toBe(false);
      expect(bp.releaseSlot("")).toBe(false);
      expect(bp.leaveStream()).toBe(false);
      expect(bp.state).toEqual({ slots: [], streams: 0 });
    }
  });

  it("畸形 initial 不进状态；合法 initial 被采纳", () => {
    const rejected = createBackpressure(
      { maxSlots: 1, maxStreams: 1 },
      { slots: ["a", "b"], streams: 0 },
    );
    expect(rejected.state).toEqual({ slots: [], streams: 0 });
    const accepted = createBackpressure(
      { maxSlots: 2, maxStreams: 2 },
      { slots: ["a"], streams: 1 },
    );
    expect(accepted.state).toEqual({ slots: ["a"], streams: 1 });
  });
});
