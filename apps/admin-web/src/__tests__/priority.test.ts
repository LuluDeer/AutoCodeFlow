/**
 * CORE-01: 任务优先级双形态契约（DTO 数字 / PG enum label 字符串）。
 */
import { describe, it, expect } from 'vitest';
import { toPriorityValue, priorityTag, TASK_PRIORITY_OPTIONS } from '../utils/priority';

describe('toPriorityValue', () => {
  it('maps PG label strings case-insensitively', () => {
    expect(toPriorityValue('low')).toBe(1);
    expect(toPriorityValue('NORMAL')).toBe(2);
    expect(toPriorityValue('High')).toBe(3);
    expect(toPriorityValue('critical')).toBe(4);
  });

  it('passes valid numbers through', () => {
    expect(toPriorityValue(1)).toBe(1);
    expect(toPriorityValue(4)).toBe(4);
  });

  it('accepts integer strings ("1".."4")', () => {
    expect(toPriorityValue('3')).toBe(3);
  });

  it('falls back to NORMAL(2) on unknown/missing values (parity with normalizeTaskPriority)', () => {
    expect(toPriorityValue(undefined)).toBe(2);
    expect(toPriorityValue(null)).toBe(2);
    expect(toPriorityValue('urgent')).toBe(2);
    expect(toPriorityValue(99)).toBe(2);
  });
});

describe('priorityTag', () => {
  it('maps both shapes to the same tag', () => {
    expect(priorityTag('critical')).toEqual({ label: '紧急', color: 'red' });
    expect(priorityTag(4)).toEqual({ label: '紧急', color: 'red' });
    expect(priorityTag(undefined)).toEqual({ label: '普通', color: 'blue' });
  });

  it('keeps form options and tag labels in sync (1..4, no gaps)', () => {
    expect(TASK_PRIORITY_OPTIONS.map((o) => o.value)).toEqual([1, 2, 3, 4]);
  });
});
