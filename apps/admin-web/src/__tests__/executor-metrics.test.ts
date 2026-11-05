import { describe, expect, it } from 'vitest';

import {
  hasInconsistentMetrics,
  hasMeaningfulReservation,
  resolveRunningCount,
} from '../utils/executor-metrics';

/**
 * R18（2026-11-05）：详情页「实际在跑」换算的下限钳制。
 *
 * 背景：R16 之后 `runningTaskCount = max(客户端上报, 服务端在途占坑)`，而 `reservedSlots`
 * 仍是客户端自述值（采纳时只校验「≤ 当时行上的 runningTaskCount」，R16 的下限在写入前才生效）
 * ⇒ **落库状态可能出现 `reservedSlots > runningTaskCount`**。旧实现直接相减，界面会显示负数。
 */
describe('R18 — resolveRunningCount（展示口径：下限钳 0）', () => {
  it('【对照】旧口径直接相减会得到负数（这正是要修的形态）', () => {
    const occupiedSlots = 2; // R16 抬到在途下限
    const reservedSlots = 8; // 客户端此前的自述值（合法存在）
    expect(occupiedSlots - reservedSlots).toBeLessThan(0);
  });

  it('R18：reserved > occupied（不一致态）⇒ 输出 0，绝不显示负数', () => {
    expect(resolveRunningCount(2, 8)).toBe(0);
    expect(resolveRunningCount(0, 5)).toBe(0);
  });

  it('正常预留：occupied − reserved', () => {
    expect(resolveRunningCount(10, 3)).toBe(7);
    expect(resolveRunningCount(10, 0)).toBe(10);
    expect(resolveRunningCount(10, 10)).toBe(0);
  });

  it('旧版执行器 reservedSlots 为 null/undefined ⇒ 回落旧口径（等于 occupied，行为不变）', () => {
    expect(resolveRunningCount(10, null)).toBe(10);
    expect(resolveRunningCount(10, undefined)).toBe(10);
  });

  it('非法/负值输入不把闸门数字带进界面（按 0 处理并钳底）', () => {
    expect(resolveRunningCount(Number.NaN, 3)).toBe(0);
    expect(resolveRunningCount(-5, 0)).toBe(0);
    expect(resolveRunningCount(10, Number.NaN)).toBe(10);
    expect(resolveRunningCount(10, -3)).toBe(10);
  });

  it('hasMeaningfulReservation：只有合理预留才解释差额；不一致态不解释（避免误导）', () => {
    expect(hasMeaningfulReservation(10, 3)).toBe(true);
    expect(hasMeaningfulReservation(10, 0)).toBe(false);
    expect(hasMeaningfulReservation(10, null)).toBe(false);
    expect(hasMeaningfulReservation(2, 8)).toBe(false); // 不一致态
  });

  it('幂等：同一输入多次调用结果一致，且函数是纯函数（不触碰任何落库字段）', () => {
    const first = resolveRunningCount(2, 8);
    const second = resolveRunningCount(2, 8);
    expect(first).toBe(second);
    // 入参是值传递的原始数，函数体内没有任何写操作 ⇒ 调用后"存储值"不可能被改动
    const occupied = { v: 2 };
    resolveRunningCount(occupied.v, 8);
    expect(occupied.v).toBe(2);
  });
});

/**
 * R59（§7.17 P3）：**不一致态的可观测性判据**（纯函数层）。
 *
 * R18 把差额钳到 0，界面不再出现负数——但「钳制」本身是**无声**的：用户无法区分
 * 「确实没在跑」与「后端两个计数打架」。故把「是否自相矛盾」抽成谓词，由 UI 决定
 * 怎么提示（本函数只判真假，不碰任何落库/派发语义）。
 *
 * 语义刻意与 `resolveRunningCount` 对齐：同一套归一化（非有限 ⇒ 0、负数钳 0），
 * 保证「提示出现」与「显示数被钳」严格同源，不会出现「钳了但没提示」或
 * 「提示了但数没被钳」的错位。
 */
describe('R59 — hasInconsistentMetrics（reserved > occupied 的判据）', () => {
  it('【对照】不一致态常见形态：R16 抬高 occupied 后 reserved 仍是旧自述值', () => {
    expect(hasInconsistentMetrics(1, 5)).toBe(true);
    expect(hasInconsistentMetrics(2, 8)).toBe(true);
    // occupied=0 且 reserved>0 同样自相矛盾（一个槽位都没占，却有预留）。
    expect(hasInconsistentMetrics(0, 1)).toBe(true);
  });

  it('合理预留 / 无预留 / 边界相等 ⇒ 不判为不一致（防常显）', () => {
    expect(hasInconsistentMetrics(10, 3)).toBe(false);
    expect(hasInconsistentMetrics(10, 0)).toBe(false);
    expect(hasInconsistentMetrics(2, 2)).toBe(false); // 全部已占都是预留：合法
  });

  it('旧版执行器未上报（null/undefined）⇒ 无从判断，不得判为不一致', () => {
    expect(hasInconsistentMetrics(10, null)).toBe(false);
    expect(hasInconsistentMetrics(10, undefined)).toBe(false);
    expect(hasInconsistentMetrics(0, null)).toBe(false);
  });

  it('非法输入不制造噪音：非有限 reserved / occupied 一律不判不一致', () => {
    expect(hasInconsistentMetrics(10, Number.NaN)).toBe(false);
    expect(hasInconsistentMetrics(Number.NaN, 5)).toBe(false);
    expect(hasInconsistentMetrics(10, Number.POSITIVE_INFINITY)).toBe(false);
    expect(hasInconsistentMetrics(10, -3)).toBe(false); // 负数钳 0，不构成矛盾
  });

  it('与 resolveRunningCount 同源：判为不一致 ⇔ 显示数被钳到 0 且差额为负', () => {
    for (const [occupied, reserved] of [[1, 5], [0, 1], [2, 8], [10, 3], [2, 2]] as const) {
      if (hasInconsistentMetrics(occupied, reserved)) {
        expect(occupied - reserved).toBeLessThan(0);
        expect(resolveRunningCount(occupied, reserved)).toBe(0);
      } else {
        expect(occupied - reserved).toBeGreaterThanOrEqual(0);
        expect(resolveRunningCount(occupied, reserved)).toBe(occupied - reserved);
      }
    }
  });
});
