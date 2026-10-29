/**
 * WEB-4（P2）：`utils/toolArgs` 纯逻辑单测。
 *
 * 页面级只是「接线」（审批行 ↔ 工具调用行 ↔ 只读视图），这里钉住判据本身：
 * 值怎么显示、长值何时折叠、摘要如何截到 3 项、以及非对象/循环引用这类脏输入
 * 不能把审批视图带崩（旧数据/上游写坏时仍要能看到「有什么」）。
 */
import { describe, it, expect } from 'vitest';
import {
  ARGS_LONG_VALUE_CHARS,
  ARGS_SUMMARY_VALUE_CHARS,
  argsEntries,
  argsSummary,
  argValueText,
} from '../utils/toolArgs';

describe('WEB-4：工具入参的可读化判据', () => {
  it('字符串原样输出（不加 JSON 引号），对象/数字走 JSON', () => {
    expect(argValueText('/srv/app/service.yaml')).toBe('/srv/app/service.yaml');
    expect(argValueText(0)).toBe('0');
    expect(argValueText(false)).toBe('false');
    expect(argValueText(null)).toBe('null');
    expect(argValueText({ a: 1 })).toBe('{"a":1}');
    expect(argValueText(['x', 'y'])).toBe('["x","y"]');
  });

  it('脏输入不崩：循环引用退化为 String()，非对象/空值 → 空表', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(argValueText(circular)).toBe('[object Object]');
    expect(argsEntries(null)).toEqual([]);
    expect(argsEntries(undefined)).toEqual([]);
    // 后端 argsJson 类型是 Record，但历史数据可能存成数组/标量——一律当「无入参」
    expect(argsEntries([] as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('长值才标记折叠（阈值边界：120 字符折叠、120 以内平铺）', () => {
    const entries = argsEntries({
      short: 'x'.repeat(ARGS_LONG_VALUE_CHARS),
      long: 'y'.repeat(ARGS_LONG_VALUE_CHARS + 1),
    });
    expect(entries.find((e) => e.key === 'short')?.long).toBe(false);
    expect(entries.find((e) => e.key === 'long')?.long).toBe(true);
    // 全文都在（折叠是渲染层的事，判据不切断文本）
    expect(entries.find((e) => e.key === 'long')?.text).toHaveLength(ARGS_LONG_VALUE_CHARS + 1);
  });

  it('摘要取前 3 项并给溢出计数；单值按 40 字符截短', () => {
    const { pairs, rest } = argsSummary({
      taskId: 't-42',
      reason: 'r'.repeat(ARGS_SUMMARY_VALUE_CHARS + 10),
      dryRun: false,
      notify: 'ops',
      extra: 1,
    });
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toBe('taskId=t-42');
    expect(pairs[1]).toBe(`reason=${'r'.repeat(ARGS_SUMMARY_VALUE_CHARS)}…`);
    expect(pairs[2]).toBe('dryRun=false');
    expect(rest).toBe(2);
  });

  it('少于/等于 limit 时没有溢出计数；零参数摘要为空', () => {
    expect(argsSummary({ a: 1, b: 2 }).rest).toBe(0);
    expect(argsSummary({ a: 1, b: 2 }).pairs).toEqual(['a=1', 'b=2']);
    expect(argsSummary(null)).toEqual({ pairs: [], rest: 0 });
  });
});
