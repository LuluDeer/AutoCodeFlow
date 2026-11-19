/**
 * P1-4 收件箱聚合层回归：
 * - 计数汇总的诚实口径：任一源读不到（null）⇒ 总数 null，不用局部和谎报；
 *   最近失败是只读参考项，不计入总数；
 * - 等待时长排序：有时间的在前（越久越靠前），无时间信息的排末尾；
 * - 第二人规则：提交者本人不能审批自己的部署请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { client } from '../api/client';
import {
  loadInboxCounts,
  summarizeInboxCounts,
  sortInboxItemsByWaitingSince,
  isSelfDeployment,
  type InboxCountMap,
  type InboxItem,
} from '../api/inbox';

const emptyCounts = (): InboxCountMap => ({
  deployments: 0,
  agentApprovals: null,
  agentWaiting: 0,
  agentFailures: 0,
  stalled: 0,
  backlogged: 0,
  queueStall: 0,
  recentFailures: 0,
});

afterEach(() => vi.restoreAllMocks());

describe('summarizeInboxCounts 总数口径', () => {
  it('R278/U1：一次 inbox/counts 拿全；审批单数与会话数各自成值，但只有会话进入求和', async () => {
    const get = vi.spyOn(client, 'get').mockImplementation(async (url) => {
      if (url === '/agent/inbox/counts') {
        return {
          pendingApprovals: 4, // 审批单数：独立显示，**不参与**会话求和
          waitingSessions: 3,
          stalled: 1,
          backlogged: 0,
          backlogTruncated: false,
          deployments: 2,
          queueStall: 0,
          degraded: false,
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const counts = await loadInboxCounts();
    expect(counts.agentApprovals).toBe(4);
    expect(counts.agentWaiting).toBe(3);
    // 2（部署）+ 3（等待会话）+ 1（卡住）+ 0（积压）+ 0（停摆）= 6；审批单 4 不重复计入。
    expect(summarizeInboxCounts(counts)).toBe(6);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('全部读到：汇总可处置待办（不含最近失败）', () => {
    const counts = emptyCounts();
    counts.deployments = 2;
    counts.agentWaiting = 1;
    counts.stalled = 3;
    counts.recentFailures = 99; // 只读参考，不计入
    expect(summarizeInboxCounts(counts)).toBe(6);
  });

  it('任一源读不到（null）⇒ 总数 null，不用局部和谎报', () => {
    const counts = emptyCounts();
    counts.deployments = 2;
    counts.backlogged = null;
    expect(summarizeInboxCounts(counts)).toBeNull();
  });

  it('仅最近失败为 null 不影响总数（只读参考项不参与汇总）', () => {
    const counts = emptyCounts();
    counts.deployments = 1;
    counts.recentFailures = null;
    expect(summarizeInboxCounts(counts)).toBe(1);
  });

  it('全 0 ⇒ 总数 0（可安全隐藏入口）', () => {
    expect(summarizeInboxCounts(emptyCounts())).toBe(0);
  });
});

describe('sortInboxItemsByWaitingSince 等待时长排序', () => {
  const item = (id: string, waitingSince: string | null): InboxItem => ({
    id,
    section: 'stalled',
    title: id,
    waitingSince,
  });

  it('时间越早排越前', () => {
    const sorted = sortInboxItemsByWaitingSince([
      item('a', '2026-01-02T00:00:00Z'),
      item('b', '2026-01-01T00:00:00Z'),
      item('c', '2026-01-03T00:00:00Z'),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('无时间信息的排末尾，且不互相挤掉有时间的项', () => {
    const sorted = sortInboxItemsByWaitingSince([
      item('a', null),
      item('b', '2026-01-01T00:00:00Z'),
      item('c', null),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('不修改入参数组', () => {
    const arr = [item('a', null), item('b', '2026-01-01T00:00:00Z')];
    sortInboxItemsByWaitingSince(arr);
    expect(arr.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('isSelfDeployment 第二人规则', () => {
  it('提交者本人 ⇒ true（前端禁用审批按钮）', () => {
    expect(
      isSelfDeployment(
        { id: 'dep-1', approvalMeta: { requestedBy: 7, requestedByName: 'alice' } } as never,
        7,
      ),
    ).toBe(true);
  });

  it('他人提交 ⇒ false', () => {
    expect(
      isSelfDeployment(
        { id: 'dep-1', approvalMeta: { requestedBy: 7, requestedByName: 'alice' } } as never,
        3,
      ),
    ).toBe(false);
  });

  it('缺审批元数据 / 缺用户 id ⇒ false（不误禁用）', () => {
    expect(isSelfDeployment({ id: 'dep-1' } as never, 7)).toBe(false);
    expect(isSelfDeployment(undefined, 7)).toBe(false);
  });
});
