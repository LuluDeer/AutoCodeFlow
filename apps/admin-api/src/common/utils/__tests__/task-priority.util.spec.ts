import { toBullPriority } from "../task-priority.util";
import { TaskPriority } from "../../../modules/task/entities/task.entity";

describe("toBullPriority（A4：DB 优先级 → BullMQ 出队优先级方向换算）", () => {
  it("CRITICAL(4) 映射为 BullMQ 1（最高出队优先级）", () => {
    // BullMQ 数值越小越先出队：DB 语义的紧急(4)必须最先出队。
    expect(toBullPriority(TaskPriority.CRITICAL)).toBe(1);
  });

  it("HIGH(3)/NORMAL(2)/LOW(1) 保持相对次序并整体翻转", () => {
    expect(toBullPriority(TaskPriority.HIGH)).toBe(2);
    expect(toBullPriority(TaskPriority.NORMAL)).toBe(3);
    expect(toBullPriority(TaskPriority.LOW)).toBe(4);
    // 次序不变式：DB 优先级越高 → BullMQ 数值越小（越先出队）。
    expect(toBullPriority(TaskPriority.CRITICAL)).toBeLessThan(
      toBullPriority(TaskPriority.HIGH),
    );
    expect(toBullPriority(TaskPriority.HIGH)).toBeLessThan(
      toBullPriority(TaskPriority.NORMAL),
    );
    expect(toBullPriority(TaskPriority.NORMAL)).toBeLessThan(
      toBullPriority(TaskPriority.LOW),
    );
  });

  it("恒等式：toBullPriority 恰为 5 - dbPriority", () => {
    for (const p of [
      TaskPriority.LOW,
      TaskPriority.NORMAL,
      TaskPriority.HIGH,
      TaskPriority.CRITICAL,
    ]) {
      expect(toBullPriority(p)).toBe(5 - p);
    }
  });

  it("小数四舍五入到整数（BullMQ lua 校验拒绝非整数）", () => {
    expect(toBullPriority(2.4)).toBe(3); // round(2.4)=2 → 5-2
    expect(toBullPriority(2.6)).toBe(2); // round(2.6)=3 → 5-3
  });

  it("越界与非有限值兜底，绝不产生 0/负数/NaN", () => {
    expect(toBullPriority(0)).toBe(4); // 钳到 LOW(1) → 4
    expect(toBullPriority(-3)).toBe(4);
    expect(toBullPriority(99)).toBe(1); // 钳到 CRITICAL(4) → 1
    expect(toBullPriority(NaN)).toBe(3); // 兜底 NORMAL(2) → 3
    // Infinity/NaN 均非有限值 → 同走 NORMAL 兜底（Number.isFinite 口径）。
    expect(toBullPriority(Infinity)).toBe(3);
    expect(Number.isInteger(toBullPriority(NaN))).toBe(true);
  });
});
