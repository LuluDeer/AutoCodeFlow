import { describe, expect, it } from 'vitest';
import { parseUrlState, serializeUrlState } from '../hooks/useUrlStateSync';

/**
 * URL-SYNC-02（审计 P2，2026-10-17）：列表页「筛选/分页 ⇄ URL」双向同步。
 *
 * 缺陷现场：URL-SYNC-01 只做了单向（初始值读 URL + 状态回写 URL）。组件
 * **已挂载**时从外部改 URL（通知铃铛「查看失败」、Dashboard「全部失败」、
 * 浏览器前进后退）→ searchParams 变了但 state 不变，紧接着回写 effect 又把
 * URL 覆盖回旧 state。净效果是深链完全失效（地址栏闪过 ?status=failed 随即
 * 被抹掉，列表仍是全量）。
 *
 * 本 spec 覆盖纯函数层（序列化/解析）；双向 effect 的行为由页面级测试
 * （executions-deeplink / task-list-url-sync / user-management-url-sync）覆盖。
 */
describe('serializeUrlState（URL-SYNC-02）', () => {
  it('默认值不写入 URL（保持深链干净）', () => {
    const qs = serializeUrlState(
      { page: 1, pageSize: 20, status: undefined, q: '' },
      { page: 1, pageSize: 20, status: undefined, q: '' },
    );
    expect(qs.toString()).toBe('');
  });

  it('偏离默认值才写入', () => {
    const qs = serializeUrlState(
      { page: 3, pageSize: 50, status: 'failed', q: 'backup' },
      { page: 1, pageSize: 20, status: undefined, q: '' },
    );
    expect(qs.get('page')).toBe('3');
    expect(qs.get('pageSize')).toBe('50');
    expect(qs.get('status')).toBe('failed');
    expect(qs.get('q')).toBe('backup');
  });

  it('undefined 与空串都不写入（清空筛选后 URL 回到裸路径）', () => {
    const qs = serializeUrlState(
      { page: 1, status: undefined, executor: '' },
      { page: 1, status: undefined, executor: '' },
    );
    expect(qs.toString()).toBe('');
  });

  it('数字一律 String()（URL 只存字符串）', () => {
    const qs = serializeUrlState({ page: 7 }, { page: 1 });
    expect(qs.get('page')).toBe('7');
  });
});

describe('parseUrlState（URL-SYNC-02）', () => {
  const defaults = {
    page: 1,
    pageSize: 20,
    status: undefined,
    q: '',
  } as const;

  it('缺失的键回落默认值', () => {
    const parsed = parseUrlState(new URLSearchParams(''), defaults);
    expect(parsed).toEqual({ page: 1, pageSize: 20, status: undefined, q: '' });
  });

  it('合法深链正确解析（这是本修复的核心场景）', () => {
    const parsed = parseUrlState(
      new URLSearchParams('status=failed&page=2'),
      defaults,
    );
    expect(parsed.status).toBe('failed');
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(20); // 未指定 → 默认
  });

  it('非法数字深链回落默认（不抛错、不空屏）', () => {
    for (const bad of ['abc', '-3', '0', '1.5', '']) {
      const parsed = parseUrlState(
        new URLSearchParams(`page=${bad}`),
        defaults,
      );
      expect({ bad, page: parsed.page }).toEqual({ bad, page: 1 });
    }
  });

  it('字符串字段原样返回（含空串→回落默认）', () => {
    expect(parseUrlState(new URLSearchParams('q=x'), defaults).q).toBe('x');
    expect(parseUrlState(new URLSearchParams('q='), defaults).q).toBe('');
  });

  it('未知参数被忽略（不污染 state）', () => {
    const parsed = parseUrlState(
      new URLSearchParams('status=running&bogus=1'),
      defaults,
    );
    expect(Object.keys(parsed).sort()).toEqual(
      ['page', 'pageSize', 'q', 'status'].sort(),
    );
  });
});

describe('serialize/parse 往返（URL-SYNC-02）', () => {
  const defaults = {
    page: 1,
    pageSize: 20,
    status: undefined,
    q: '',
    executor: '',
  } as const;

  it('序列化再解析得到等价 state（双向同步的不动点）', () => {
    const state = {
      page: 4,
      pageSize: 50,
      status: 'failed',
      q: 'nightly',
      executor: 'host:8002',
    };
    const roundTrip = parseUrlState(serializeUrlState(state, defaults), defaults);
    expect(roundTrip).toEqual(state);
  });

  it('默认态往返后仍是默认态', () => {
    const state = { ...defaults };
    const roundTrip = parseUrlState(serializeUrlState(state, defaults), defaults);
    expect(roundTrip).toEqual(state);
  });
});
