/**
 * 保存筛选视图测试（增 / 删 / 改 / 切换，localStorage 信封，上限 20）。
 *
 * 覆盖点：
 *  1) 保存：视图落盘信封（含 id/name/savedAt/filters）；重挂恢复；激活态随保存设定；
 *  2) 重命名：合法名更新落盘；空名 / 超长名拒绝且不改存量；
 *  3) 删除：条目移除；删中当前激活项 → 激活态清空；
 *  4) 上限：upsert 超 20 条淘汰最旧（保留最新 20）；
 *  5) 坏值降级：非数组 / 缺字段 / 时间戳非法 / filters 形状不符 / id 重复 → 逐条剔除；
 *  6) 切换：activate 记录当前激活视图；clear 清空。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  MAX_SAVED_VIEWS,
  VIEW_NAME_MAX,
  upsertView,
  validateSavedViews,
  type SavedView,
} from '../utils/savedViews';
import { useSavedViews } from '../hooks/useSavedViews';

interface TestFilters {
  q: string;
  status?: string;
  page: number;
}

const isFilters = (f: unknown): f is TestFilters => {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  const e = f as Record<string, unknown>;
  return (
    typeof e.q === 'string' &&
    (e.status === undefined || typeof e.status === 'string') &&
    typeof e.page === 'number' &&
    Number.isInteger(e.page) &&
    e.page > 0
  );
};

const STORAGE_KEY = 'autoflow-test-views:v1';
const FILTERS: TestFilters = { q: 'deploy', status: 'failed', page: 1 };

beforeEach(() => {
  localStorage.clear();
});

describe('validateSavedViews 坏值降级', () => {
  it.each([null, undefined, 'x', 42])('非数组 %p → null', (raw) => {
    expect(validateSavedViews(raw, isFilters)).toBeNull();
  });

  it('非法条目逐条剔除：缺字段 / 时间戳非法 / filters 不符 / id 重复', () => {
    const raw = [
      { id: 'ok', name: 'A', savedAt: 1, filters: FILTERS },
      { id: 'bad-name', name: 5, savedAt: 1, filters: FILTERS },
      { id: 'bad-time', name: 'B', savedAt: 'nope', filters: FILTERS },
      { id: 'bad-filters', name: 'C', savedAt: 1, filters: { q: 1 } },
      { id: 'ok', name: 'A-dup', savedAt: 2, filters: FILTERS },
    ];
    const out = validateSavedViews(raw, isFilters);
    expect(out).toHaveLength(1);
    expect(out![0].id).toBe('ok');
  });
});

describe('upsertView 上限', () => {
  it(`超过 ${MAX_SAVED_VIEWS} 条时淘汰 savedAt 最旧的，保留最新 ${MAX_SAVED_VIEWS} 条`, () => {
    let list: SavedView<TestFilters>[] = [];
    for (let i = 0; i < MAX_SAVED_VIEWS; i++) {
      list = upsertView(list, { id: `v${i}`, name: `V${i}`, savedAt: i, filters: FILTERS });
    }
    expect(list).toHaveLength(MAX_SAVED_VIEWS);
    list = upsertView(list, { id: 'new', name: 'new', savedAt: 999, filters: FILTERS });
    expect(list).toHaveLength(MAX_SAVED_VIEWS);
    expect(list.find((v) => v.id === 'v0')).toBeUndefined();
    expect(list.find((v) => v.id === 'new')).toBeDefined();
  });
});

describe('useSavedViews', () => {
  it('保存落盘信封；重挂恢复；activeId 指向新视图', () => {
    const first = renderHook(() => useSavedViews<TestFilters>(STORAGE_KEY, isFilters));
    let outcome!: { ok: boolean };
    act(() => {
      outcome = first.result.current.save('部署失败', FILTERS);
    });
    expect(outcome.ok).toBe(true);
    expect(first.result.current.views).toHaveLength(1);
    expect(first.result.current.activeId).toBe(first.result.current.views[0].id);

    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    expect(raw.version).toBe(1);
    expect(raw.data[0].name).toBe('部署失败');

    const second = renderHook(() => useSavedViews<TestFilters>(STORAGE_KEY, isFilters));
    expect(second.result.current.views).toHaveLength(1);
    expect(second.result.current.views[0].filters).toEqual(FILTERS);
  });

  it('重命名：合法名更新落盘；空名 / 超长名拒绝', () => {
    const hook = renderHook(() => useSavedViews<TestFilters>(STORAGE_KEY, isFilters));
    act(() => hook.result.current.save('旧名', FILTERS));
    const id = hook.result.current.views[0].id;

    act(() => {
      expect(hook.result.current.rename(id, ' 新名 ').ok).toBe(true);
    });
    expect(hook.result.current.views[0].name).toBe('新名');

    let rejected!: { ok: boolean; reason?: string };
    act(() => {
      rejected = hook.result.current.rename(id, '   ');
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('empty');

    act(() => {
      rejected = hook.result.current.rename(id, 'x'.repeat(VIEW_NAME_MAX + 1));
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('tooLong');
    expect(hook.result.current.views[0].name).toBe('新名');
  });

  it('删除：条目移除；删中激活项清空 activeId', () => {
    const hook = renderHook(() => useSavedViews<TestFilters>(STORAGE_KEY, isFilters));
    act(() => hook.result.current.save('A', FILTERS));
    const id = hook.result.current.views[0].id;
    expect(hook.result.current.activeId).toBe(id);

    act(() => hook.result.current.remove(id));
    expect(hook.result.current.views).toHaveLength(0);
    expect(hook.result.current.activeId).toBeNull();
  });

  it('activate 记录 / 清空激活态（会话内，不持久化）', () => {
    const hook = renderHook(() => useSavedViews<TestFilters>(STORAGE_KEY, isFilters));
    act(() => hook.result.current.save('A', FILTERS));
    const id = hook.result.current.views[0].id;
    act(() => hook.result.current.activate(null));
    expect(hook.result.current.activeId).toBeNull();
    act(() => hook.result.current.activate(id));
    expect(hook.result.current.activeId).toBe(id);
  });

  it('坏信封 → 空列表，不抛错', () => {
    localStorage.setItem(STORAGE_KEY, '###bad-json###');
    const hook = renderHook(() => useSavedViews<TestFilters>(STORAGE_KEY, isFilters));
    expect(hook.result.current.views).toEqual([]);
  });
});
