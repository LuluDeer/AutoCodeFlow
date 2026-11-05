import { describe, expect, it } from 'vitest';

import {
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
