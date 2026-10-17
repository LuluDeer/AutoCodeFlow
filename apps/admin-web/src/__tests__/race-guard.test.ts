import { describe, expect, it } from 'vitest';
import { createRaceGuard } from '../utils/raceGuard';

/**
 * RACE-GUARD（审计 P2，2026-10-17）：列表页请求乱序的判据。
 *
 * 两个缺陷共享同一形态：
 *   · ApplicationDetailPage.ReleasesTab 分页竞态——快速翻页时旧页响应后到，
 *     覆盖新页数据；
 *   · AgentSessionsPage 轮询与筛选竞态——15s 静默轮询（旧筛选）在筛选变化
 *     触发的新请求之后返回，把列表覆盖回旧结果。
 *
 * 共同根因：**并发请求 + 无「谁是最新」判据 = 后到者赢**，而「后到」与
 * 「更新」没有任何关系（网络抖动足以让旧请求后到）。
 *
 * 本 spec 覆盖判据本身（纯逻辑）；页面接线由各自的页面测试覆盖。
 */
describe('createRaceGuard（RACE-GUARD）', () => {
  it('next() 单调递增，从 1 开始', () => {
    const guard = createRaceGuard();
    expect(guard.next()).toBe(1);
    expect(guard.next()).toBe(2);
    expect(guard.current()).toBe(2);
  });

  it('只有最新一发 isLatest 为 true（核心判据）', () => {
    const guard = createRaceGuard();
    const first = guard.next();
    expect(guard.isLatest(first)).toBe(true);

    const second = guard.next();
    // 关键：新请求发出后，旧序号立刻失效——这正是「旧响应不得落地」的依据
    expect(guard.isLatest(first)).toBe(false);
    expect(guard.isLatest(second)).toBe(true);
  });

  it('乱序到达：后发先至时，先发的响应被判定过期', () => {
    const guard = createRaceGuard();
    // 模拟：发 A（慢）、发 B（快）；B 先返回、A 后返回
    const seqA = guard.next(); // page 1
    const seqB = guard.next(); // page 2

    // B 先到 → 采纳
    expect(guard.isLatest(seqB)).toBe(true);
    // A 后到 → 丢弃（否则旧页覆盖新页）
    expect(guard.isLatest(seqA)).toBe(false);
  });

  it('连续 N 发后只有最后一发有效', () => {
    const guard = createRaceGuard();
    const seqs = Array.from({ length: 10 }, () => guard.next());
    const latest = seqs[seqs.length - 1];
    for (const s of seqs) {
      expect({ s, latest: guard.isLatest(s) }).toEqual({
        s,
        latest: s === latest,
      });
    }
  });

  it('守卫实例相互独立（多页面/多列表互不干扰）', () => {
    const a = createRaceGuard();
    const b = createRaceGuard();
    const seqA = a.next();
    b.next();
    b.next();
    // b 的推进不影响 a 的判据
    expect(a.isLatest(seqA)).toBe(true);
  });

  it('未发出的序号（0 / 负数 / 未来值）不是最新', () => {
    const guard = createRaceGuard();
    expect(guard.isLatest(0)).toBe(false);
    expect(guard.isLatest(-1)).toBe(false);
    const seq = guard.next();
    expect(guard.isLatest(seq + 1)).toBe(false);
  });

  it('尚未发出任何请求时，哨兵 0 不是最新（防「忘了赋值就判 latest」）', () => {
    const guard = createRaceGuard();
    // 典型误用：`let seq = 0` 初始化后某条分支没走到 `guard.next()` 就调
    // isLatest(seq) —— 必须得到 false（丢弃），而不是错误的「最新」。
    expect(guard.isLatest(0)).toBe(false);
    expect(guard.isLatest(-5)).toBe(false);
  });

  it('真实时序复现：分页竞态（旧页后到不得覆盖新页）', () => {
    const guard = createRaceGuard();
    // 用户快速点：下一页 → 上一页
    const reqPage2 = guard.next();
    const reqPage1 = guard.next();

    // 假设 page1 的响应先到（网络抖动），page2 后到
    // 无论到达顺序如何，最终只应采纳「最后发出的那一个」（page1）
    expect(guard.isLatest(reqPage1)).toBe(true);
    expect(guard.isLatest(reqPage2)).toBe(false);
  });

  it('真实时序复现：轮询竞态（旧筛选的轮询后到不得覆盖新筛选结果）', () => {
    const guard = createRaceGuard();
    // 15s 轮询发出（旧筛选 status=running）
    const poll = guard.next();
    // 用户改筛选 → 新请求发出（status=failed）
    const filterChange = guard.next();

    // 新请求先返回并渲染；旧轮询随后返回
    expect(guard.isLatest(filterChange)).toBe(true);
    // 旧轮询必须被丢弃——否则用户看到「筛选没生效」
    expect(guard.isLatest(poll)).toBe(false);
  });
});
