import {
  drainAtStepBoundary,
  emptyInbox,
  parkIntent,
  shouldWake,
  type SteerInbox,
  type SteerIntent,
} from "../steer-inbox";

/**
 * N8 · steer inbox 纯状态机规格。反证有牙：
 *   · 死意图被 shouldWake 判 true        ⇒ 「终态」用例转红；
 *   · 非步边界 drain 出意图              ⇒ 「非步边界」用例转红；
 *   · 未知/缺失目标状态被判 true         ⇒ fail-closed 用例转红；
 *   · 同 id 二次 park 产生第二份 / 改旧值 ⇒ 幂等用例转红。
 * 控制组（活跃态放行 / 边界取出 / FIFO）证明不是「一律拒绝」的平凡实现。
 */

function intent(id: string, step: number): SteerIntent {
  return { id, content: `steer:${id}`, parkedAtStep: step };
}

function withIntents(...items: SteerIntent[]): SteerInbox {
  return items.reduce(parkIntent, emptyInbox());
}

describe("N8 · parkIntent：审批期入队，不改既有意图", () => {
  it("空 inbox 入队一条 ⇒ 仅此一条，FIFO 追加", () => {
    const a = intent("a", 3);
    const b = intent("b", 3);
    const afterA = parkIntent(emptyInbox(), a);
    const afterB = parkIntent(afterA, b);
    expect(afterB.intents).toEqual([a, b]);
  });

  it("不修改入参（不可变：原 inbox 引用不受影响）", () => {
    const a = intent("a", 3);
    const original = withIntents(a);
    const next = parkIntent(original, intent("b", 3));
    expect(original.intents).toEqual([a]);
    expect(next).not.toBe(original);
  });

  it("同 id 二次 park ⇒ 幂等，既不新增也不覆盖既有时机", () => {
    const a = intent("a", 3);
    const original = withIntents(a);
    const next = parkIntent(original, intent("a", 99));
    expect(next.intents).toHaveLength(1);
    expect(next.intents[0]).toEqual(a);
  });

  it("只存意图与时机，不夹带审批语义字段（无四眼/TTL/指纹）", () => {
    const a = intent("a", 3);
    const parked = parkIntent(emptyInbox(), a).intents[0];
    expect(Object.keys(parked).sort()).toEqual([
      "content",
      "id",
      "parkedAtStep",
    ]);
  });
});

describe("N8 · drainAtStepBoundary：只在模型步边界取出", () => {
  it("步边界取出全部意图，剩余 inbox 为空（控制组）", () => {
    const a = intent("a", 1);
    const b = intent("b", 2);
    const box = withIntents(a, b);
    const drained = drainAtStepBoundary(box, 3);
    expect(drained.intents).toEqual([a, b]);
    expect(drained.inbox.intents).toEqual([]);
  });

  it("按入队 FIFO 顺序 drain，不重排", () => {
    const box = withIntents(intent("first", 1), intent("second", 1));
    expect(drainAtStepBoundary(box, 2).intents.map((i) => i.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("非步边界（currentStep=null）⇒ 一条都不取出，inbox 原样", () => {
    const box = withIntents(intent("a", 1), intent("b", 2));
    const drained = drainAtStepBoundary(box, null);
    expect(drained.intents).toEqual([]);
    expect(drained.inbox).toBe(box);
    expect(drained.inbox.intents).toEqual(box.intents);
  });

  it("非步边界不消费：随后到边界仍能完整取出", () => {
    const a = intent("a", 1);
    const box = withIntents(a);
    drainAtStepBoundary(box, null);
    expect(drainAtStepBoundary(box, 2).intents).toEqual([a]);
  });

  it("空 inbox 在任何 currentStep 都安全返回空", () => {
    expect(drainAtStepBoundary(emptyInbox(), 5).intents).toEqual([]);
    expect(drainAtStepBoundary(emptyInbox(), null).intents).toEqual([]);
  });

  it("drain 不修改入参 inbox", () => {
    const a = intent("a", 1);
    const box = withIntents(a);
    drainAtStepBoundary(box, 3);
    expect(box.intents).toEqual([a]);
  });
});

describe("N8 · shouldWake：pendingWake 不复活死意图（fail-closed）", () => {
  const wake = { targetId: "session-1", intentId: "a" };

  it.each(["succeeded", "failed", "aborted", "budget_exceeded"])(
    "终态目标 %s ⇒ false（死意图绝不唤醒）",
    (terminal) => {
      expect(shouldWake(wake, terminal)).toBe(false);
    },
  );

  it.each(["running", "waiting_input"])(
    "活跃态目标 %s ⇒ true（控制组：非平凡实现）",
    (active) => {
      expect(shouldWake(wake, active)).toBe(true);
    },
  );

  it("pending 目标（尚未进入运行/等待）⇒ false", () => {
    expect(shouldWake(wake, "pending")).toBe(false);
  });

  it("未知状态字符串 ⇒ false（新枚举默认拒绝）", () => {
    expect(shouldWake(wake, "brand_new_status")).toBe(false);
  });

  it("目标状态缺失（null / undefined）⇒ false", () => {
    expect(shouldWake(wake, null)).toBe(false);
    expect(shouldWake(wake, undefined)).toBe(false);
  });

  it("pendingWake 缺席（null / undefined）⇒ false", () => {
    expect(shouldWake(null, "waiting_input")).toBe(false);
    expect(shouldWake(undefined, "waiting_input")).toBe(false);
  });

  it("大小写敏感：非精确活跃态 token ⇒ false", () => {
    expect(shouldWake(wake, "RUNNING")).toBe(false);
  });
});
