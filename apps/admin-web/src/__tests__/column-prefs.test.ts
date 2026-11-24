/**
 * 列自定义偏好（显隐 + 顺序 + 重置默认）测试。
 *
 * 覆盖点（每条对应真实故障形态）：
 *  1) 缺省：注册表缺省隐藏态 + 注册顺序；
 *  2) 坏值降级：非对象 / hidden/order 非数组 / 未知键 / 重复顺序键 → 归一回落；
 *  3) 显隐切换：隐藏 / 取消隐藏不可变更新；只剩一列时拒绝继续隐藏（防死面）；
 *  4) 顺序移动：相邻交换；边界不动作；
 *  5) 信封持久化：切换落盘信封（version/data）；重挂恢复；重置删信封回落缺省；
 *  6) 坏信封（坏 JSON / 版本不符形状）→ 缺省，不抛错；
 *  7) 旧版纯隐藏数组存量一次性迁移读取。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  defaultColumnPrefs,
  parseColumnPrefs,
  resolveColumnPrefs,
  toggleColumnHidden,
  moveColumn,
  type ColumnRegistryItem,
} from '../utils/columnPrefs';
import { useColumnPrefs } from '../hooks/useColumnPrefs';

const REGISTRY: ColumnRegistryItem[] = [
  { key: 'a', defaultHidden: false },
  { key: 'b', defaultHidden: false },
  { key: 'c', defaultHidden: true },
  { key: 'd', defaultHidden: true },
];
const STORAGE_KEY = 'autoflow-test-columns:v1';
const LEGACY_KEY = 'legacy.columns.v1';

beforeEach(() => {
  localStorage.clear();
});

describe('defaultColumnPrefs / resolveColumnPrefs', () => {
  it('缺省隐藏注册表 defaultHidden 项，顺序为注册表顺序', () => {
    const prefs = defaultColumnPrefs(REGISTRY);
    expect(prefs.hidden).toEqual(['c', 'd']);
    expect(prefs.order).toEqual(['a', 'b', 'c', 'd']);
    const resolved = resolveColumnPrefs(REGISTRY, prefs);
    expect(resolved.orderedVisible).toEqual(['a', 'b']);
    expect([...resolved.hidden]).toEqual(['c', 'd']);
  });
});

describe('parseColumnPrefs 坏值降级', () => {
  it.each([null, undefined, [1, 2], 'string', 42])('非对象输入 %p → null', (raw) => {
    expect(parseColumnPrefs(raw, REGISTRY)).toBeNull();
  });

  it('hidden/order 非数组 → null', () => {
    expect(parseColumnPrefs({ hidden: 'x', order: [] }, REGISTRY)).toBeNull();
    expect(parseColumnPrefs({ hidden: [], order: 'x' }, REGISTRY)).toBeNull();
  });

  it('未知键剔除；order 缺失的注册表键按注册顺序补尾；重复键去重', () => {
    const parsed = parseColumnPrefs(
      { hidden: ['zz', 'b'], order: ['a', 'a', 'zz', 'd'] },
      REGISTRY,
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.hidden).toEqual(['b']);
    expect(parsed!.order).toEqual(['a', 'd', 'b', 'c']);
  });
});

describe('toggleColumnHidden', () => {
  it('隐藏未隐藏列；取消已隐藏列', () => {
    let prefs = defaultColumnPrefs(REGISTRY);
    prefs = toggleColumnHidden(prefs, 'a');
    expect(prefs.hidden).toEqual(['c', 'd', 'a']);
    prefs = toggleColumnHidden(prefs, 'c');
    expect(prefs.hidden).toEqual(['d', 'a']);
  });

  it('只剩一个可见列时拒绝继续隐藏（防死面）', () => {
    const prefs = { hidden: ['b', 'c', 'd'], order: ['a', 'b', 'c', 'd'] };
    const next = toggleColumnHidden(prefs, 'a');
    expect(next).toBe(prefs);
  });
});

describe('moveColumn', () => {
  it('下移相邻交换；上移相邻交换', () => {
    const prefs = defaultColumnPrefs(REGISTRY);
    const down = moveColumn(prefs, 'a', 1);
    expect(down.order).toEqual(['b', 'a', 'c', 'd']);
    const up = moveColumn(prefs, 'd', -1);
    expect(up.order).toEqual(['a', 'b', 'd', 'c']);
  });

  it('边界位置返回原偏好（不可变）', () => {
    const prefs = defaultColumnPrefs(REGISTRY);
    expect(moveColumn(prefs, 'a', -1)).toBe(prefs);
    expect(moveColumn(prefs, 'd', 1)).toBe(prefs);
  });
});

describe('useColumnPrefs 信封持久化', () => {
  it('切换显隐落盘信封；重挂恢复；重置删信封回落缺省', () => {
    const first = renderHook(() => useColumnPrefs(STORAGE_KEY, REGISTRY));
    act(() => first.result.current.toggle('a'));
    expect(first.result.current.hidden.has('a')).toBe(true);

    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    expect(raw.version).toBe(1);
    expect(raw.data.hidden).toContain('a');

    // 重挂：从信封恢复，而不是缺省
    const second = renderHook(() => useColumnPrefs(STORAGE_KEY, REGISTRY));
    expect(second.result.current.hidden.has('a')).toBe(true);

    act(() => second.result.current.reset());
    expect(second.result.current.orderedVisible).toEqual(['a', 'b']);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('坏信封（坏 JSON / 形状不符）→ 缺省，不抛错', () => {
    localStorage.setItem(STORAGE_KEY, '{not-json');
    const badJson = renderHook(() => useColumnPrefs(STORAGE_KEY, REGISTRY));
    expect(badJson.result.current.orderedVisible).toEqual(['a', 'b']);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, savedAt: 1, data: { hidden: 'x', order: [] } }));
    const badShape = renderHook(() => useColumnPrefs(STORAGE_KEY, REGISTRY));
    expect(badShape.result.current.orderedVisible).toEqual(['a', 'b']);
  });

  it('双切换：隐藏 → 恢复 → 再隐藏，隐藏集合回到缺省', () => {
    const hook = renderHook(() => useColumnPrefs(STORAGE_KEY, REGISTRY));
    act(() => hook.result.current.toggle('c'));
    expect([...hook.result.current.hidden].sort()).toEqual(['d']);
    act(() => hook.result.current.toggle('c'));
    expect([...hook.result.current.hidden].sort()).toEqual(['c', 'd']);
  });

  it('旧版纯隐藏数组存量一次性迁移读取（不回写旧键）', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(['a', 'c']));
    const hook = renderHook(() =>
      useColumnPrefs(STORAGE_KEY, REGISTRY, { legacyHiddenKey: LEGACY_KEY }),
    );
    expect([...hook.result.current.hidden]).toEqual(['a', 'c']);
    // 新信封尚未写入（惰性迁移，首次变更才落盘新键）
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
