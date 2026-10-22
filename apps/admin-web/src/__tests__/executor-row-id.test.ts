import { describe, it, expect } from 'vitest';
import { shortExecutorRowId } from '../utils/executorRowId';

/**
 * §8.3 工单 10：行 id 短形态的边界（只做截断，绝不编造）。
 */
describe('shortExecutorRowId', () => {
  it('取前 8 位', () => {
    expect(shortExecutorRowId('aaaa1111-2222-3333-4444-555566667777')).toBe('aaaa1111');
  });

  it('裁剪首尾空白后截断（避免渲染出带空格的前缀）', () => {
    expect(shortExecutorRowId('  bbbb8888-rest  ')).toBe('bbbb8888');
  });

  it('短于 8 位 → 原样返回（不补零、不编造）', () => {
    expect(shortExecutorRowId('abc')).toBe('abc');
  });

  it.each([['null', null], ['undefined', undefined], ['空串', ''], ['纯空白', '   ']])(
    '缺省形态返回 null：%s',
    (_label, value) => {
      expect(shortExecutorRowId(value as string | null | undefined)).toBeNull();
    },
  );
});
